/**
 * Per-cell edit helpers for the table-block plugin.
 *
 * The plugin keeps tables as a render-time view over plain source
 * paragraphs. Cell-edit support is built on top of that contract: a
 * cell's "edit range" is the exact slice of the source paragraph that
 * the user's edit should replace. CSV editing trims whitespace from the
 * cell's edges (so typing into "alpha, beta" — cell 1 — replaces just
 * "beta", keeping the leading space); TSV editing replaces the whole
 * between-tab chunk verbatim.
 *
 * Marks on the row's other cells survive a single-cell commit because
 * the transaction only rewrites the one cell's range, not the entire
 * paragraph.
 */

import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { TableRegion } from './findTableRegions.js';

export interface CellRange {
	from: number;
	to: number;
}

/**
 * Locate the absolute doc-position range for editing cell `(rowIdx,
 * colIdx)` of `region`. Returns null if either index is out of bounds.
 *
 * Returned range:
 *  - CSV: trimmed (leading/trailing whitespace within the cell are
 *    excluded so re-typing replaces only the meaningful text).
 *  - TSV: untrimmed (whitespace is data).
 *
 * For a fully-whitespace CSV cell we return a zero-width range whose
 * `from === to` lands right after the previous separator's whitespace
 * — i.e. the spot the user wants the caret to appear when they
 * double-click an empty cell.
 */
export function findCellEditRange(
	doc: PMNode,
	region: TableRegion,
	rowIdx: number,
	colIdx: number
): CellRange | null {
	const para = region.bodyParaRanges[rowIdx];
	if (!para) return null;
	const text = doc.textBetween(para.textFrom, para.textTo, '');
	const sep = region.format === 'csv' ? ',' : '\t';
	const cells = text.split(sep);
	if (colIdx < 0 || colIdx >= cells.length) return null;

	let charOffset = 0;
	for (let i = 0; i < colIdx; i++) {
		charOffset += cells[i].length + sep.length;
	}
	let cellStart = charOffset;
	let cellEnd = charOffset + cells[colIdx].length;

	if (region.format === 'csv') {
		const cell = cells[colIdx];
		const leading = cell.length - cell.replace(/^\s+/, '').length;
		const trailingTrimmed = cell.replace(/\s+$/, '');
		const trailing = cell.length - trailingTrimmed.length;
		// All-whitespace cell collapses to a zero-width range at the
		// "logical" caret slot (just after the leading whitespace).
		if (trailingTrimmed.length === 0) {
			cellStart = charOffset + leading;
			cellEnd = cellStart;
		} else {
			cellStart = charOffset + leading;
			cellEnd = charOffset + cell.length - trailing;
		}
	}

	return {
		from: para.textFrom + cellStart,
		to: para.textFrom + cellEnd
	};
}

/**
 * Build a transaction that replaces cell `(rowIdx, colIdx)` of `region`
 * with `newText` (plain text). Returns null if the range can't be
 * resolved.
 *
 * Empty `newText` deletes the range (PM text nodes can't be empty so
 * we use `tr.delete` rather than insertText).
 */
export function commitCellEdit(
	state: EditorState,
	region: TableRegion,
	rowIdx: number,
	colIdx: number,
	newText: string
): Transaction | null {
	const range = findCellEditRange(state.doc, region, rowIdx, colIdx);
	if (!range) return null;
	const tr = state.tr;
	if (newText.length === 0) {
		if (range.from !== range.to) tr.delete(range.from, range.to);
		return tr;
	}
	if (range.from === range.to) {
		tr.insertText(newText, range.from);
	} else {
		tr.insertText(newText, range.from, range.to);
	}
	return tr;
}
