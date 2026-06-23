/**
 * blockReorder.ts
 *
 * Provides moveBlockUp and moveBlockDown — reorder top-level document blocks
 * (paragraphs, blockquotes, code blocks, whole lists, …) by swapping them with
 * the adjacent sibling block. This is the non-list counterpart to
 * listItemReorder.ts: when the cursor is NOT inside a list, Alt+↑/↓ reorders
 * the plain blocks at the document top level.
 *
 * The whole block (with any nested content) moves as a unit; only sibling order
 * changes.
 *
 * Title invariant: the FIRST top-level block is the note title (hidden + cursor-
 * clamped by titleIsolation). It is immovable — no block may swap into index 0,
 * and the title itself never moves. So the lowest movable index is 1.
 */

import type { Editor } from '@tiptap/core';
import { Fragment } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { childAbsStart, SKIP_TRAILING_NODE } from './listItemDepth.js';

/**
 * Index 0 is the note title. Blocks may only live at — and swap into — indices
 * >= 1, so the title is never displaced.
 */
const FIRST_MOVABLE_INDEX = 1;

interface BlockRange {
	startIndex: number;
	endIndex: number;
}

/** Top-level block indices touched by the current selection ([start..end]). */
function selectedBlockRange(editor: Editor): BlockRange {
	const { $from, $to } = editor.state.selection;
	let startIndex = $from.index(0);
	let endIndex = $to.index(0);
	if (startIndex > endIndex) [startIndex, endIndex] = [endIndex, startIndex];
	return { startIndex, endIndex };
}

/**
 * Move the selected top-level block(s) one position up, swapping with the
 * preceding sibling block. Returns false if the first operated block is already
 * at the top of the movable range (index 1) — i.e. directly under the title.
 */
export function moveBlockUp(editor: Editor): boolean {
	const state = editor.state;
	const doc = state.doc;
	const { startIndex, endIndex } = selectedBlockRange(editor);

	// Can't move up past — or into — the title block.
	if (startIndex <= FIRST_MOVABLE_INDEX) return false;

	const prevSibling = doc.child(startIndex - 1);

	const operatedNodes = [];
	for (let i = startIndex; i <= endIndex; i++) operatedNodes.push(doc.child(i));

	// Replace [prevSibling, ...operated] with [...operated, prevSibling].
	const replaceStart = childAbsStart(doc, startIndex - 1, 0);
	const replaceEnd = childAbsStart(doc, endIndex + 1, 0);
	const replacementNodes = [...operatedNodes, prevSibling];

	const { $from, $to } = state.selection;
	const selIsRange = !state.selection.empty;
	const shift = prevSibling.nodeSize;

	const tr = state.tr;
	tr.replaceWith(replaceStart, replaceEnd, Fragment.fromArray(replacementNodes));
	// Don't grow a fresh trailing paragraph if the doc now ends with a list.
	tr.setMeta(SKIP_TRAILING_NODE, true);

	try {
		if (selIsRange) {
			// Whole operated block shifted up by prevSibling.nodeSize.
			const newFrom = $from.pos - shift;
			const newTo = $to.pos - shift;
			const docSize = tr.doc.content.size;
			tr.setSelection(
				TextSelection.create(
					tr.doc,
					Math.max(1, Math.min(newFrom, docSize - 1)),
					Math.max(1, Math.min(newTo, docSize - 1))
				)
			);
		} else {
			const oldBlockStart = childAbsStart(doc, startIndex, 0);
			const cursorOffsetInBlock = $from.pos - oldBlockStart;
			const newPos = replaceStart + cursorOffsetInBlock;
			const docSize = tr.doc.content.size;
			const resolved = tr.doc.resolve(Math.max(1, Math.min(newPos, docSize - 1)));
			tr.setSelection(TextSelection.near(resolved));
		}
	} catch {
		const resolved = tr.doc.resolve(Math.min(replaceStart + 1, tr.doc.content.size - 1));
		tr.setSelection(TextSelection.near(resolved));
	}

	editor.view.dispatch(tr);
	return true;
}

/**
 * Move the selected top-level block(s) one position down, swapping with the
 * following sibling block. Returns false if the last operated block is already
 * at the end of the document, or the selection sits in the title.
 */
export function moveBlockDown(editor: Editor): boolean {
	const state = editor.state;
	const doc = state.doc;
	const { startIndex, endIndex } = selectedBlockRange(editor);

	// The title (index 0) never moves.
	if (startIndex < FIRST_MOVABLE_INDEX) return false;
	// Already last — nothing to swap with.
	if (endIndex >= doc.childCount - 1) return false;

	const nextSibling = doc.child(endIndex + 1);

	const operatedNodes = [];
	for (let i = startIndex; i <= endIndex; i++) operatedNodes.push(doc.child(i));

	// Replace [...operated, nextSibling] with [nextSibling, ...operated].
	const replaceStart = childAbsStart(doc, startIndex, 0);
	const replaceEnd = childAbsStart(doc, endIndex + 2, 0);
	const replacementNodes = [nextSibling, ...operatedNodes];

	const { $from, $to } = state.selection;
	const selIsRange = !state.selection.empty;
	const shift = nextSibling.nodeSize;

	const tr = state.tr;
	tr.replaceWith(replaceStart, replaceEnd, Fragment.fromArray(replacementNodes));
	// Don't grow a fresh trailing paragraph if the doc now ends with a list.
	tr.setMeta(SKIP_TRAILING_NODE, true);

	try {
		if (selIsRange) {
			// Whole operated block shifted down by nextSibling.nodeSize.
			const newFrom = $from.pos + shift;
			const newTo = $to.pos + shift;
			const docSize = tr.doc.content.size;
			tr.setSelection(
				TextSelection.create(
					tr.doc,
					Math.max(1, Math.min(newFrom, docSize - 1)),
					Math.max(1, Math.min(newTo, docSize - 1))
				)
			);
		} else {
			const oldBlockStart = childAbsStart(doc, startIndex, 0);
			const cursorOffsetInBlock = $from.pos - oldBlockStart;
			const newPos = replaceStart + shift + cursorOffsetInBlock;
			const docSize = tr.doc.content.size;
			const resolved = tr.doc.resolve(Math.max(1, Math.min(newPos, docSize - 1)));
			tr.setSelection(TextSelection.near(resolved));
		}
	} catch {
		const resolved = tr.doc.resolve(Math.min(replaceStart + shift + 1, tr.doc.content.size - 1));
		tr.setSelection(TextSelection.near(resolved));
	}

	editor.view.dispatch(tr);
	return true;
}
