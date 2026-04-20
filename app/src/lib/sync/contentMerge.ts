/**
 * Line-based 3-way merge for a note's `<note-content>` XML.
 *
 * Used by `syncManager` to automatically resolve sync conflicts where the
 * local and remote sides edited different regions of the same note. Falls
 * back to the existing "pick one side" flow whenever the two sides edited
 * overlapping base lines or either side changed the title line.
 *
 * Algorithm — diff3-style hunk merge:
 *   1. Compute LCS(base, local) and LCS(base, remote). Convert each into a
 *      list of hunks, where a hunk is `{baseStart, baseEnd, replacement}` —
 *      a contiguous range of base lines replaced by some target lines, or a
 *      pure insertion when `baseStart === baseEnd`.
 *   2. Walk `base` in order, interleaving the local and remote hunks. Two
 *      hunks "overlap" iff both modify at least one common base line. If
 *      they do, and the two replacements differ, it's a real conflict.
 *      Non-overlapping modifications and pure insertions on either side
 *      are applied in order.
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

interface Match {
	base: number;
	other: number;
}

interface Hunk {
	/** First base line replaced, inclusive. Equals `baseEnd` for pure inserts. */
	baseStart: number;
	/** Last base line replaced, exclusive. */
	baseEnd: number;
	replacement: string[];
}

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

	const localHunks = buildHunks(baseLines, localLines, lcsMatches(baseLines, localLines));
	const remoteHunks = buildHunks(baseLines, remoteLines, lcsMatches(baseLines, remoteLines));

	const merged = mergeHunks(baseLines, localHunks, remoteHunks);
	if (merged === null) return { clean: false, reason: 'conflict' };
	return { clean: true, merged: merged.join('\n') };
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
 * Derive contiguous edit hunks from an LCS alignment. Regions between two
 * adjacent LCS matches (or before the first / after the last match) where
 * either side has non-matched lines become a single hunk replacing
 * `base[baseStart..baseEnd)` with the corresponding target slice.
 */
function buildHunks(base: string[], target: string[], matches: Match[]): Hunk[] {
	const anchors: Match[] = [
		{ base: -1, other: -1 },
		...matches,
		{ base: base.length, other: target.length }
	];
	const hunks: Hunk[] = [];
	for (let k = 0; k < anchors.length - 1; k++) {
		const cur = anchors[k];
		const next = anchors[k + 1];
		const baseStart = cur.base + 1;
		const baseEnd = next.base;
		const targetStart = cur.other + 1;
		const targetEnd = next.other;
		if (baseStart < baseEnd || targetStart < targetEnd) {
			hunks.push({
				baseStart,
				baseEnd,
				replacement: target.slice(targetStart, targetEnd)
			});
		}
	}
	return hunks;
}

/**
 * Interleave `localHunks` and `remoteHunks` over `base`, returning the
 * merged line array or `null` on conflict. Two hunks conflict when both
 * cover at least one shared base line and their replacements differ.
 */
function mergeHunks(base: string[], localHunks: Hunk[], remoteHunks: Hunk[]): string[] | null {
	const out: string[] = [];
	let baseIdx = 0;
	let i = 0;
	let j = 0;

	while (baseIdx < base.length || i < localHunks.length || j < remoteHunks.length) {
		const local = i < localHunks.length ? localHunks[i] : null;
		const remote = j < remoteHunks.length ? remoteHunks[j] : null;
		const localHere = !!local && local.baseStart === baseIdx;
		const remoteHere = !!remote && remote.baseStart === baseIdx;

		if (localHere && remoteHere) {
			const localModifies = local!.baseEnd > baseIdx;
			const remoteModifies = remote!.baseEnd > baseIdx;

			if (localModifies && remoteModifies) {
				// Both hunks claim at least one base line here. Merge only if
				// they cover the same range with the same replacement — any
				// other form of overlap is a real conflict.
				if (
					local!.baseEnd === remote!.baseEnd &&
					linesEqual(local!.replacement, remote!.replacement)
				) {
					out.push(...local!.replacement);
					baseIdx = local!.baseEnd;
					i++;
					j++;
				} else {
					return null;
				}
			} else if (!localModifies && !remoteModifies) {
				// Both sides insert at this exact position.
				if (linesEqual(local!.replacement, remote!.replacement)) {
					out.push(...local!.replacement);
				} else {
					// Two different insertions at the same cursor — ambiguous
					// ordering, treat as conflict.
					return null;
				}
				i++;
				j++;
			} else if (!localModifies) {
				// Pure local insertion before remote's modify range; apply it
				// first, then continue so remote's hunk fires next iteration.
				out.push(...local!.replacement);
				i++;
			} else {
				out.push(...remote!.replacement);
				j++;
			}
		} else if (localHere) {
			out.push(...local!.replacement);
			baseIdx = local!.baseEnd;
			i++;
		} else if (remoteHere) {
			out.push(...remote!.replacement);
			baseIdx = remote!.baseEnd;
			j++;
		} else if (baseIdx < base.length) {
			out.push(base[baseIdx]);
			baseIdx++;
		} else {
			// No hunk at baseIdx === base.length means we have a stale hunk
			// with baseStart > base.length — shouldn't happen, but guard.
			break;
		}
	}

	return out;
}

function linesEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
