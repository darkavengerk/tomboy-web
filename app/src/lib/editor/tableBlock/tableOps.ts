/**
 * Row/column structural edits for the table-block plugin's "ctrl-mode"
 * editing UI. All four operations return a `Transaction` (or `null` for
 * out-of-range arguments) that the caller dispatches; none mutate state
 * directly.
 *
 * Conventions:
 *  - "row" indices match `region.cells` (0 = header, 1+ = body rows).
 *  - Deletion preserves separator hygiene: removing a middle/last column
 *    drops the *leading* separator with the cell; removing the first
 *    column drops the *trailing* separator. So "a, b, c" minus column 1
 *    becomes "a, c", not "a,, c" or "a, , c".
 *  - Append operations always insert empty cells. CSV emits ", " between
 *    cells (a single space after the comma) to match the convention used
 *    elsewhere in the parser; TSV uses a single tab.
 *  - Markdown-format regions additionally keep the `| --- |` separator row
 *    column-synced on column add/remove. Note that markdown's
 *    `bodyParaRanges` includes the header row (index 0), so row inserts must
 *    account for the separator that sits between the header and any data rows.
 */

import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { TableRegion } from './findTableRegions.js';
import { markdownRowLayout } from './parseTable.js';

/**
 * Delete the body paragraph at `rowIdx`. Removes the entire paragraph
 * including its `<p>` open / close, so the surrounding doc structure
 * stays valid.
 */
export function deleteRowOp(
	state: EditorState,
	region: TableRegion,
	rowIdx: number
): Transaction | null {
	const para = region.bodyParaRanges[rowIdx];
	if (!para) return null;
	return state.tr.delete(para.from, para.to);
}

/**
 * Delete column `colIdx` from every body paragraph in the region.
 * Operates back-to-front through the doc so earlier paragraph
 * positions don't shift while later ones are still being processed.
 */
export function deleteColOp(
	state: EditorState,
	region: TableRegion,
	colIdx: number
): Transaction | null {
	if (colIdx < 0) return null;
	if (region.format === 'markdown') {
		const tr = state.tr;
		let touched = false;
		const targets = [...region.bodyParaRanges];
		if (region.separatorParaRange) targets.push(region.separatorParaRange);
		targets.sort((a, b) => a.from - b.from);
		// Reverse order so earlier deletions don't invalidate later positions.
		for (let r = targets.length - 1; r >= 0; r--) {
			const para = targets[r];
			const text = state.doc.textBetween(para.textFrom, para.textTo, '');
			const layout = markdownRowLayout(text);
			if (colIdx >= layout.cells.length) continue;
			let startChar: number;
			let endChar: number;
			if (colIdx > 0) {
				// the '|' before this cell sits at the previous cell's `end`.
				startChar = layout.cells[colIdx - 1].end;
				endChar = layout.cells[colIdx].end;
			} else if (layout.cells.length > 1) {
				startChar = layout.cells[0].start;
				endChar = layout.cells[1].start; // include the '|' after cell 0
			} else {
				startChar = layout.cells[0].start;
				endChar = layout.cells[0].end;
			}
			tr.delete(para.textFrom + startChar, para.textFrom + endChar);
			touched = true;
		}
		return touched ? tr : null;
	}
	const sep = region.format === 'csv' ? ',' : '\t';
	const tr = state.tr;
	let touched = false;

	// Walk paragraphs in reverse so earlier deletions don't invalidate
	// later from/to positions.
	for (let r = region.bodyParaRanges.length - 1; r >= 0; r--) {
		const para = region.bodyParaRanges[r];
		const text = state.doc.textBetween(para.textFrom, para.textTo, '');
		const cells = text.split(sep);
		if (colIdx >= cells.length) continue;

		// Compute the slice to delete:
		//   colIdx > 0: drop the LEADING separator + the cell
		//   colIdx === 0 with at least one more cell: drop the cell + the TRAILING separator
		//   colIdx === 0 in a single-cell row: drop the cell only
		let startChar: number;
		let endChar: number;
		if (colIdx > 0) {
			let prefix = 0;
			for (let i = 0; i < colIdx; i++) prefix += cells[i].length + sep.length;
			// prefix points to the first char OF the separator before this cell.
			startChar = prefix - sep.length;
			endChar = prefix + cells[colIdx].length;
		} else {
			startChar = 0;
			endChar = cells[0].length + (cells.length > 1 ? sep.length : 0);
		}

		tr.delete(para.textFrom + startChar, para.textFrom + endChar);
		touched = true;
	}

	return touched ? tr : null;
}

/**
 * Append an empty row at the end of the region's body, just before the
 * closing fence. Column count matches the widest existing row (so a
 * ragged source still gets a sensibly-shaped new row).
 */
export function appendRowOp(
	state: EditorState,
	region: TableRegion
): Transaction {
	if (region.format === 'markdown') {
		const colCount = Math.max(1, region.cells.reduce((m, r) => Math.max(m, r.length), 0));
		const text = '|' + '  |'.repeat(colCount); // 2 cols → "|  |  |"
		// bodyParaRanges always includes the header for markdown, so use the
		// max of (last content row, separator) — when there are no data rows
		// the separator sits below the header and must win.
		const lastBody =
			region.bodyParaRanges.length > 0
				? region.bodyParaRanges[region.bodyParaRanges.length - 1].to
				: region.openFromPos + 1;
		const sepTo = region.separatorParaRange?.to ?? 0;
		const insertAt = Math.max(lastBody, sepTo);
		const tr = state.tr;
		const para = state.schema.nodes.paragraph.create(null, state.schema.text(text));
		tr.insert(insertAt, para);
		return tr;
	}
	const sep = region.format === 'csv' ? ', ' : '\t';
	const colCount = Math.max(
		1,
		region.cells.reduce((m, r) => Math.max(m, r.length), 0)
	);
	// Single empty paragraph with `colCount - 1` separator chars (csv: ", ",
	// tsv: "\t"). For colCount === 1 we still create the paragraph but
	// with empty content so the new row is editable.
	const text = new Array(colCount).fill('').join(sep);
	const insertAt = region.bodyParaRanges.length > 0
		? region.bodyParaRanges[region.bodyParaRanges.length - 1].to
		: region.openFromPos + 1; // empty body — insert right after open-fence
	const tr = state.tr;
	const para = state.schema.nodes.paragraph.create(
		null,
		text.length > 0 ? state.schema.text(text) : null
	);
	tr.insert(insertAt, para);
	return tr;
}

/**
 * Append an empty cell to every body paragraph in the region.
 * Reverse-order traversal as in `deleteColOp`.
 */
export function appendColOp(
	state: EditorState,
	region: TableRegion
): Transaction {
	if (region.format === 'markdown') {
		const tr = state.tr;
		const targets = [...region.bodyParaRanges];
		if (region.separatorParaRange) targets.push(region.separatorParaRange);
		targets.sort((a, b) => a.from - b.from);
		// Reverse order so earlier insert positions stay valid.
		for (let r = targets.length - 1; r >= 0; r--) {
			const para = targets[r];
			const text = state.doc.textBetween(para.textFrom, para.textTo, '');
			const isSep =
				region.separatorParaRange !== undefined &&
				para.from === region.separatorParaRange.from;
			const layout = markdownRowLayout(text);
			const ins = isSep
				? layout.hasTrail
					? ' --- |'
					: ' | --- |'
				: layout.hasTrail
					? '  |'
					: ' |  |';
			tr.insertText(ins, para.textTo);
		}
		return tr;
	}
	const sep = region.format === 'csv' ? ', ' : '\t';
	const tr = state.tr;
	for (let r = region.bodyParaRanges.length - 1; r >= 0; r--) {
		const para = region.bodyParaRanges[r];
		// Insert at the very end of the paragraph's text content.
		tr.insertText(sep, para.textTo);
	}
	return tr;
}
