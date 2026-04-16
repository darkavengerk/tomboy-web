/**
 * ProseMirror plugin that auto-applies / removes the `tomboyInternalLink`
 * mark based on whether text matches the title of an existing note.
 *
 * Exposed as a factory so the extension can inject its options (title
 * provider and current-note guid) at configure time.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { MarkType, Node as PMNode } from '@tiptap/pm/model';
import { findTitleMatches, isWordChar, type TitleEntry } from './findTitleMatches.js';
import { markNoteOpenPerf } from '$lib/utils/noteOpenPerfLog.js';

export const autoLinkPluginKey = new PluginKey<AutoLinkMeta>('tomboyAutoLink');

interface AutoLinkMeta {
	skip?: boolean;
	refresh?: boolean;
	/**
	 * When set together with `refresh: true`, forces a full-document scan
	 * instead of scanning just the accumulated dirty ranges. Used when the
	 * title list changes (rename / create / delete somewhere in the app) —
	 * any previously-unchanged text might newly match or stop matching.
	 */
	full?: boolean;
	/**
	 * Drop any accumulated dirty-range state. Dispatched by the editor
	 * component right after `setContent()` swaps the whole document: the
	 * ranges it had collected for the OLD doc's edits are meaningless for
	 * the freshly loaded one, and the stored XML already carries the
	 * persisted `<link:internal>` marks so no rescan is needed.
	 */
	clearDirty?: boolean;
}

export interface AutoLinkPluginOptions {
	markType: MarkType;
	getTitles: () => TitleEntry[];
	getCurrentGuid: () => string | null;
	/**
	 * Marks whose presence should *suppress* auto-linking (e.g. URL links and
	 * monospace). Names are checked against each `Node.marks[i].type.name`.
	 */
	suppressMarks?: string[];
	/**
	 * When true, the plugin does NOT scan on ordinary document changes. It
	 * only runs when a `{refresh: true}` meta is dispatched on the transaction.
	 * This moves the scan out of the typing hot path — the consumer is expected
	 * to schedule refreshes at idle / debounced intervals.
	 *
	 * Defaults to false (legacy: scan on every doc change).
	 */
	deferred?: boolean;
}

const DEFAULT_SUPPRESS = ['tomboyUrlLink', 'tomboyMonospace', 'code'];

export function createAutoLinkPlugin(opts: AutoLinkPluginOptions): Plugin {
	const suppress = new Set(opts.suppressMarks ?? DEFAULT_SUPPRESS);
	const deferred = opts.deferred ?? false;

	// Accumulated dirty ranges in deferred mode. Each entry is in the doc
	// coordinate space of the most recently seen state; we map existing
	// entries through new transactions as they come in so the ranges stay
	// valid between debounced refreshes. Cleared on every scan.
	let dirtyRanges: { from: number; to: number }[] = [];

	return new Plugin<AutoLinkMeta>({
		key: autoLinkPluginKey,
		appendTransaction(transactions, _oldState, newState) {
			const isRefresh = transactions.some(
				(tr) => tr.getMeta(autoLinkPluginKey)?.refresh === true
			);
			const isFull = transactions.some(
				(tr) => tr.getMeta(autoLinkPluginKey)?.full === true
			);
			const skip = transactions.some(
				(tr) => tr.getMeta(autoLinkPluginKey)?.skip === true
			);
			const clearDirty = transactions.some(
				(tr) => tr.getMeta(autoLinkPluginKey)?.clearDirty === true
			);
			if (clearDirty) dirtyRanges = [];
			if (skip) return null;

			const docChanged = transactions.some((tr) => tr.docChanged);
			if (!docChanged && !isRefresh) return null;

			const doc = newState.doc;
			const docSize = doc.content.size;

			// In deferred mode, doc changes don't trigger a scan — they
			// merely extend the dirty-range set, to be scanned on the next
			// refresh dispatch.
			if (deferred) {
				if (docChanged) {
					// Map any existing dirty ranges through the incoming
					// transactions so they stay addressable in the new coord
					// space, then record the newly changed ranges too.
					for (const tr of transactions) {
						if (!tr.docChanged) continue;
						if (dirtyRanges.length > 0) {
							const mapping = tr.mapping;
							dirtyRanges = dirtyRanges.map((r) => ({
								from: mapping.map(r.from, -1),
								to: mapping.map(r.to, 1)
							}));
						}
						for (const map of tr.mapping.maps) {
							map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
								dirtyRanges.push({ from: newStart, to: newEnd });
							});
						}
					}
				}
				if (!isRefresh) return null;
			}

			const titles = opts.getTitles();
			const currentGuid = opts.getCurrentGuid();
			const markType = opts.markType;
			const scanStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
			markNoteOpenPerf(
				'autoLinkPlugin.scan:enter',
				{
					guid: currentGuid,
					refresh: isRefresh,
					full: isFull,
					deferred,
					docSize,
					titles: titles.length,
					dirty: dirtyRanges.length
				},
				'*'
			);

			interface Range { from: number; to: number; }
			let ranges: Range[];
			let expandFn: (doc: PMNode, from: number, to: number) => Range;

			if (deferred) {
				if (isFull) {
					ranges = [{ from: 0, to: docSize }];
					expandFn = (_d, f, t) => ({ from: f, to: t });
				} else {
					// No accumulated edits since the last refresh — nothing
					// new to look at.
					if (dirtyRanges.length === 0) return null;
					ranges = dirtyRanges;
					// Narrow expansion: the mapping-derived range covers the
					// actual insert/replace, so we only need a word-boundary
					// pad on each side to pick up the neighbouring
					// characters that matter for \b checks. Scanning the
					// whole enclosing paragraph is wasteful for short edits.
					expandFn = expandToWordBoundary;
				}
				// Reset before running — if applyInRange emits marks that
				// re-enter us, we don't want to re-scan the same ranges.
				dirtyRanges = [];
			} else {
				// Sync (non-deferred) mode preserves the legacy behaviour
				// used by unit tests and any legacy caller: scan on every
				// doc change, expanding to enclosing block bounds.
				ranges = [];
				if (isRefresh) {
					ranges.push({ from: 0, to: docSize });
				} else {
					for (const tr of transactions) {
						if (!tr.docChanged) continue;
						for (const map of tr.mapping.maps) {
							map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
								ranges.push({ from: newStart, to: newEnd });
							});
						}
					}
				}
				if (ranges.length === 0) return null;
				expandFn = expandToBlock;
			}

			const expanded: Range[] = ranges.map((r) => expandFn(doc, r.from, r.to));
			const merged = mergeRanges(expanded);

			const tr = newState.tr;
			let changed = false;

			for (const range of merged) {
				changed = applyInRange(
					doc,
					tr,
					range.from,
					range.to,
					titles,
					currentGuid,
					markType,
					suppress
				) || changed;
			}

			const scanEnd = (typeof performance !== 'undefined' ? performance.now() : Date.now());
			markNoteOpenPerf(
				'autoLinkPlugin.scan:exit',
				{
					guid: currentGuid,
					ranges: merged.length,
					rangeChars: merged.reduce((s, r) => s + (r.to - r.from), 0),
					changed,
					durMs: +(scanEnd - scanStart).toFixed(1)
				},
				'*'
			);

			if (!changed) return null;
			tr.setMeta(autoLinkPluginKey, { skip: true });
			return tr;
		}
	});
}

function expandToBlock(doc: PMNode, from: number, to: number): { from: number; to: number } {
	const clampedFrom = Math.max(0, Math.min(from, doc.content.size));
	const clampedTo = Math.max(clampedFrom, Math.min(to, doc.content.size));
	const $from = doc.resolve(clampedFrom);
	const $to = doc.resolve(clampedTo);
	const start = $from.start($from.depth);
	const end = $to.end($to.depth);
	return { from: start, to: end };
}

/**
 * Expand a range outward until we hit a non-word character on each side,
 * but never crossing the enclosing block boundaries. Much narrower than
 * `expandToBlock` for small edits — when the user types one character, the
 * scanned region is just the surrounding word instead of the whole
 * paragraph, which keeps `findTitleMatches` work bounded by edit size
 * rather than block size.
 */
function expandToWordBoundary(doc: PMNode, from: number, to: number): { from: number; to: number } {
	const clampedFrom = Math.max(0, Math.min(from, doc.content.size));
	const clampedTo = Math.max(clampedFrom, Math.min(to, doc.content.size));
	const $from = doc.resolve(clampedFrom);
	const $to = doc.resolve(clampedTo);
	const blockStart = $from.start($from.depth);
	const blockEnd = $to.end($to.depth);

	// Leaf / non-text nodes return '\uFFFC' (object replacement char) via
	// textBetween, which is not a word char — that's what we want, so we
	// stop expanding when we hit them.
	let start = clampedFrom;
	while (start > blockStart) {
		const ch = doc.textBetween(start - 1, start, '\uFFFC');
		if (!isWordChar(ch)) break;
		start--;
	}
	let end = clampedTo;
	while (end < blockEnd) {
		const ch = doc.textBetween(end, end + 1, '\uFFFC');
		if (!isWordChar(ch)) break;
		end++;
	}
	return { from: start, to: end };
}

function mergeRanges(rs: { from: number; to: number }[]): { from: number; to: number }[] {
	if (rs.length <= 1) return rs;
	const sorted = [...rs].sort((a, b) => a.from - b.from);
	const out: { from: number; to: number }[] = [sorted[0]];
	for (let i = 1; i < sorted.length; i++) {
		const last = out[out.length - 1];
		const cur = sorted[i];
		if (cur.from <= last.to) {
			last.to = Math.max(last.to, cur.to);
		} else {
			out.push(cur);
		}
	}
	return out;
}

/**
 * Within [from, to], for each text node:
 *   - if it sits inside a suppressed mark, only remove stale internal links.
 *   - else, compute matches and reconcile the internal-link marks.
 *
 * Returns true iff at least one mark add/remove was emitted on `tr`.
 */
function applyInRange(
	doc: PMNode,
	tr: import('@tiptap/pm/state').Transaction,
	from: number,
	to: number,
	titles: TitleEntry[],
	currentGuid: string | null,
	markType: MarkType,
	suppress: Set<string>
): boolean {
	let changed = false;

	// Walk text nodes. For each block, concatenate consecutive text children
	// into a single string so that matches spanning mark boundaries still work
	// (e.g. "Foo" + " Bar" that happen to be two adjacent text nodes).
	interface Run {
		/** Absolute start position of the run in the doc. */
		start: number;
		/** Concatenated plain text. */
		text: string;
		/** Per-char entries: [absPos, suppressed]. Index i refers to text[i]. */
		charMeta: { pos: number; suppressed: boolean; hasInternalLink: boolean; internalTarget: string | null }[];
	}

	// The first block of the document is Tomboy's "title line" — it IS the
	// note's own title. Auto-linking there is almost always wrong (self-link
	// or, worse, linking to a duplicate-named note). Skip it, but only if
	// the doc has more than one block; a single-paragraph doc represents
	// early-stage content where the user hasn't split a body yet, and we
	// shouldn't suppress matches there.
	const firstBlock = doc.firstChild;
	const hasBody = doc.childCount > 1;

	const runs: Run[] = [];
	doc.nodesBetween(from, to, (node, pos) => {
		if (!node.isTextblock) return true;

		if (hasBody && node === firstBlock) {
			// Title line — don't scan or modify.
			return false;
		}

		// One run per textblock; split within the block if positions are
		// non-contiguous (e.g. hard break or other non-text inline child).
		let current: Run = { start: pos + 1, text: '', charMeta: [] };
		const commit = () => {
			if (current.text.length > 0) runs.push(current);
		};

		node.descendants((child, childOffset) => {
			if (!child.isText) return;
			const absStart = pos + 1 + childOffset;
			const text = child.text ?? '';
			const isSuppressed = child.marks.some((m) => suppress.has(m.type.name));
			const internalMark = child.marks.find(
				(m) => m.type.name === markType.name
			);
			const internalTarget = internalMark
				? (internalMark.attrs.target as string)
				: null;

			// If this text node isn't contiguous with the previous one (hard
			// break / other inline non-text in between), commit the current
			// run and start a fresh one.
			if (
				current.charMeta.length > 0 &&
				current.charMeta[current.charMeta.length - 1].pos + 1 !== absStart
			) {
				commit();
				current = { start: absStart, text: '', charMeta: [] };
			}

			for (let i = 0; i < text.length; i++) {
				current.text += text[i];
				current.charMeta.push({
					pos: absStart + i,
					suppressed: isSuppressed,
					hasInternalLink: internalMark !== undefined,
					internalTarget
				});
			}
		});

		commit();
		// Don't recurse further (we already walked descendants).
		return false;
	});

	// Precompute a set of lower-cased titles for fast membership check in
	// Pass 1's preservation logic.
	const knownTitlesLower = new Set<string>();
	for (const t of titles) {
		const trimmed = t.titleLower.trim();
		if (trimmed) knownTitlesLower.add(trimmed);
	}
	const titlesKnown = knownTitlesLower.size > 0;

	for (const run of runs) {
		// Build a "desired" array: for each char index, what target should the
		// internal-link mark have? `null` means no mark.
		const desired: (string | null)[] = new Array(run.text.length).fill(null);
		// `locked[i]` = char i carries an existing mark we want to preserve
		// (its span text still matches the mark's own `target` AND that
		// target is a real loaded note title). New matches from findTitleMatches
		// never overwrite locked regions — this keeps existing links stable
		// even when the titles list is momentarily empty (e.g. right after
		// setContent() while titles are still loading).
		const locked: boolean[] = new Array(run.text.length).fill(false);

		// Pass 1: preserve existing link spans whose text still matches their
		// target (case-insensitive, with word-boundary check). Stale spans
		// (text diverged from target via user editing) are left unlocked and
		// with desired=null so they will be removed.
		//
		// An additional safety rule: if the title list IS loaded (non-empty),
		// we also require the mark's `target` to match a known note title.
		// This cleans up legacy "broken" marks whose target was polluted by
		// earlier serialization bugs (e.g. `target="Title123"` where the real
		// note is just "Title"). When titles are not yet loaded we skip the
		// check so existing marks aren't wrongly stripped during async boot.
		{
			let p = 0;
			while (p < run.text.length) {
				const cm = run.charMeta[p];
				if (!cm.hasInternalLink) {
					p++;
					continue;
				}
				const target = cm.internalTarget;
				let q = p;
				while (
					q < run.text.length &&
					run.charMeta[q].hasInternalLink &&
					run.charMeta[q].internalTarget === target
				) {
					q++;
				}
				const spanText = run.text.slice(p, q);
				const before = p > 0 ? run.text[p - 1] : undefined;
				const after = q < run.text.length ? run.text[q] : undefined;
				const targetTrimmed = (target ?? '').trim();
				const targetLower = targetTrimmed.toLocaleLowerCase();
				const stillValid =
					targetTrimmed.length > 0 &&
					spanText.toLocaleLowerCase() === targetLower &&
					!isWordChar(before) &&
					!isWordChar(after) &&
					(!titlesKnown || knownTitlesLower.has(targetLower));
				if (stillValid) {
					for (let k = p; k < q; k++) {
						desired[k] = target;
						locked[k] = true;
					}
				}
				p = q;
			}
		}

		// Pass 2: scan for new auto-link matches, skipping suppressed marks
		// and locked regions.
		const matches = findTitleMatches(run.text, titles, { excludeGuid: currentGuid });
		for (const m of matches) {
			let skip = false;
			for (let i = m.from; i < m.to; i++) {
				if (run.charMeta[i].suppressed || locked[i]) {
					skip = true;
					break;
				}
			}
			if (skip) continue;
			for (let i = m.from; i < m.to; i++) desired[i] = m.target;
		}

		// Walk runs of identical `desired` value; emit add/remove as needed.
		let i = 0;
		while (i < run.text.length) {
			const want = desired[i];
			let j = i;
			while (j < run.text.length && desired[j] === want) j++;
			// Now [i, j) in run has desired target === want.
			// Check existing marks over the same absolute range.
			const absFrom = run.charMeta[i].pos;
			const absTo = run.charMeta[j - 1].pos + 1;

			if (want === null) {
				// Want no internal link. Remove any internal-link marks found here.
				let hasLink = false;
				for (let k = i; k < j; k++) {
					if (run.charMeta[k].hasInternalLink) {
						hasLink = true;
						break;
					}
				}
				if (hasLink) {
					tr.removeMark(absFrom, absTo, markType);
					changed = true;
				}
			} else {
				// Want an internal link with `target === want`.
				// If every char in [i,j) already has that exact target, skip.
				let allMatch = true;
				for (let k = i; k < j; k++) {
					if (
						!run.charMeta[k].hasInternalLink ||
						run.charMeta[k].internalTarget !== want
					) {
						allMatch = false;
						break;
					}
				}
				if (!allMatch) {
					tr.removeMark(absFrom, absTo, markType);
					tr.addMark(absFrom, absTo, markType.create({ target: want }));
					changed = true;
				}
			}
			i = j;
		}
	}

	return changed;
}
