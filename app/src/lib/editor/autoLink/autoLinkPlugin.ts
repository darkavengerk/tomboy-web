/**
 * ProseMirror plugin that auto-applies / removes the `tomboyInternalLink`
 * mark based on whether text matches the title of an existing note.
 *
 * Exposed as a factory so the extension can inject its options (title
 * provider and current-note guid) at configure time.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { MarkType, Node as PMNode } from '@tiptap/pm/model';
import { findTitleMatches, type TitleEntry } from './findTitleMatches.js';

export const autoLinkPluginKey = new PluginKey<AutoLinkMeta>('tomboyAutoLink');

interface AutoLinkMeta {
	skip?: boolean;
	refresh?: boolean;
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
}

const DEFAULT_SUPPRESS = ['tomboyUrlLink', 'tomboyMonospace', 'code'];

export function createAutoLinkPlugin(opts: AutoLinkPluginOptions): Plugin {
	const suppress = new Set(opts.suppressMarks ?? DEFAULT_SUPPRESS);

	return new Plugin<AutoLinkMeta>({
		key: autoLinkPluginKey,
		appendTransaction(transactions, _oldState, newState) {
			const isRefresh = transactions.some(
				(tr) => tr.getMeta(autoLinkPluginKey)?.refresh === true
			);
			const skip = transactions.some(
				(tr) => tr.getMeta(autoLinkPluginKey)?.skip === true
			);
			if (skip) return null;

			const docChanged = transactions.some((tr) => tr.docChanged);
			if (!docChanged && !isRefresh) return null;

			const titles = opts.getTitles();
			const currentGuid = opts.getCurrentGuid();
			const markType = opts.markType;

			// Collect scan ranges in newState doc coordinates.
			const doc = newState.doc;
			const docSize = doc.content.size;

			interface Range { from: number; to: number; }
			const ranges: Range[] = [];
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

			// Expand each range to enclosing block node bounds so word-boundary
			// checks at range edges see neighboring characters.
			const expanded: Range[] = ranges.map((r) => expandToBlock(doc, r.from, r.to));
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

	const runs: Run[] = [];
	doc.nodesBetween(from, to, (node, pos) => {
		if (node.isTextblock) {
			// Build a run for this block by walking its text children.
			const run: Run = { start: pos + 1, text: '', charMeta: [] };
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
				// If run is not contiguous with the previous char, break into a new run.
				if (
					run.charMeta.length > 0 &&
					run.charMeta[run.charMeta.length - 1].pos + 1 !== absStart
				) {
					if (run.text.length > 0) runs.push(run);
					runs.push({ start: absStart, text: '', charMeta: [] });
				}
				// Extend current run (or new one created just above).
				const target = runs.length > 0 ? runs[runs.length - 1] : run;
				for (let i = 0; i < text.length; i++) {
					target.text += text[i];
					target.charMeta.push({
						pos: absStart + i,
						suppressed: isSuppressed,
						hasInternalLink: internalMark !== undefined,
						internalTarget
					});
				}
			});
			if (run.text.length > 0 && !runs.includes(run)) runs.push(run);
			// Don't recurse further (we already walked descendants).
			return false;
		}
		return true;
	});

	for (const run of runs) {
		// Compute desired matches on the run text.
		const matches = findTitleMatches(run.text, titles, { excludeGuid: currentGuid });

		// Build a "desired" array: for each char index, what target should it have?
		// `null` means no internal-link mark; a string means that target.
		const desired: (string | null)[] = new Array(run.text.length).fill(null);
		for (const m of matches) {
			// Skip matches that fall (even partially) inside a suppressed mark.
			let suppressed = false;
			for (let i = m.from; i < m.to; i++) {
				if (run.charMeta[i].suppressed) {
					suppressed = true;
					break;
				}
			}
			if (suppressed) continue;
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
