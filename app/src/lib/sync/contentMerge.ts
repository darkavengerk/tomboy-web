/**
 * Line-based 3-way merge for a note's `<note-content>` XML.
 *
 * Used by `syncManager` to automatically resolve sync conflicts where
 * the local and remote sides edited different regions of the same note.
 * Falls back to the existing "pick one side" flow whenever the two sides
 * edited the same region or either side changed the title line.
 *
 * Algorithm — classic diff3 on lines:
 *   1. Compute LCS(base, local) and LCS(base, remote). The intersection of
 *      the two on the base side gives "stable" anchor lines present and
 *      unchanged on all three sides.
 *   2. Walk the anchors in order. Between each consecutive pair of anchors
 *      we have three segments (the lines in base, local, remote between
 *      the matching anchors):
 *        - local == base   → take remote's segment (only remote edited).
 *        - remote == base  → take local's segment (only local edited).
 *        - local == remote → take either (both sides made the same edit).
 *        - otherwise       → real conflict; abort.
 *   3. Reassemble the merged line array.
 *
 * Title safety: if the derived title (first non-tag content of the first
 * line) differs between base and either side, we decline to merge. Title
 * changes go through the rename cascade and uniqueness checks, which this
 * low-level merge cannot perform.
 */

import { extractTitleFromContent } from '$lib/core/noteArchiver.js';

export type MergeResult =
	| { clean: true; merged: string }
	| { clean: false; reason: 'conflict' | 'title-changed' };

/**
 * 3-way merge the full xmlContent of a note. Line equality is exact.
 */
export function mergeNoteContent(base: string, local: string, remote: string): MergeResult {
	// Fast paths
	if (local === remote) return { clean: true, merged: local };
	if (base === local) return { clean: true, merged: remote };
	if (base === remote) return { clean: true, merged: local };

	const baseTitle = extractTitleFromContent(base);
	const localTitle = extractTitleFromContent(local);
	const remoteTitle = extractTitleFromContent(remote);
	if (localTitle !== baseTitle || remoteTitle !== baseTitle) {
		return { clean: false, reason: 'title-changed' };
	}

	const baseLines = base.split('\n');
	const localLines = local.split('\n');
	const remoteLines = remote.split('\n');

	const localMatches = lcsMatches(baseLines, localLines);
	const remoteMatches = lcsMatches(baseLines, remoteLines);

	// Intersect on base index — these are the stable 3-way anchors.
	const anchors = intersectAnchors(localMatches, remoteMatches);

	// Sentinels so we can treat the regions before the first / after the
	// last anchor uniformly.
	anchors.push({ base: baseLines.length, local: localLines.length, remote: remoteLines.length });

	const out: string[] = [];
	let prev = { base: -1, local: -1, remote: -1 };
	for (const anchor of anchors) {
		const baseSeg = baseLines.slice(prev.base + 1, anchor.base);
		const localSeg = localLines.slice(prev.local + 1, anchor.local);
		const remoteSeg = remoteLines.slice(prev.remote + 1, anchor.remote);

		const localEq = linesEqual(baseSeg, localSeg);
		const remoteEq = linesEqual(baseSeg, remoteSeg);

		if (localEq && remoteEq) {
			// No edits in this region — baseSeg === localSeg === remoteSeg.
			out.push(...baseSeg);
		} else if (localEq) {
			out.push(...remoteSeg);
		} else if (remoteEq) {
			out.push(...localSeg);
		} else if (linesEqual(localSeg, remoteSeg)) {
			out.push(...localSeg);
		} else {
			return { clean: false, reason: 'conflict' };
		}

		if (anchor.base < baseLines.length) {
			out.push(baseLines[anchor.base]);
		}
		prev = anchor;
	}

	return { clean: true, merged: out.join('\n') };
}

interface Match {
	base: number;
	other: number;
}

/**
 * Return the LCS alignment between `base` and `other` as pairs of equal
 * line indices, in ascending order on both axes.
 */
function lcsMatches(base: string[], other: string[]): Match[] {
	const m = base.length;
	const n = other.length;

	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			if (base[i] === other[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
			else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const matches: Match[] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (base[i] === other[j]) {
			matches.push({ base: i, other: j });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return matches;
}

/**
 * Intersect two LCS alignments on their base index to get anchors that
 * survive on all three sides. Returns triples of matching indices.
 */
function intersectAnchors(
	localMatches: Match[],
	remoteMatches: Match[]
): Array<{ base: number; local: number; remote: number }> {
	const remoteByBase = new Map<number, number>();
	for (const m of remoteMatches) remoteByBase.set(m.base, m.other);

	const out: Array<{ base: number; local: number; remote: number }> = [];
	let lastLocal = -1;
	let lastRemote = -1;
	for (const m of localMatches) {
		const remoteIdx = remoteByBase.get(m.base);
		if (remoteIdx === undefined) continue;
		// Enforce ascending order on both other-axes; dropping out-of-order
		// anchors keeps the merge regions well-formed.
		if (m.other <= lastLocal || remoteIdx <= lastRemote) continue;
		out.push({ base: m.base, local: m.other, remote: remoteIdx });
		lastLocal = m.other;
		lastRemote = remoteIdx;
	}
	return out;
}

function linesEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
