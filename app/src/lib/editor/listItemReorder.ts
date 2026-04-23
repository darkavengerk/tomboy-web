/**
 * listItemReorder.ts
 *
 * Provides moveListItemUp and moveListItemDown — reorder list items by
 * swapping them with adjacent siblings in the same parent list.
 *
 * Both functions move the entire list item (including nested children) as
 * a unit. Structure is preserved; only sibling order changes.
 */

import type { Editor } from '@tiptap/core';
import { Fragment } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import {
	findOperationRange,
	childAbsStart,
	SKIP_TRAILING_NODE,
	removeTrailingParagraphIfPresent,
	normalizeAdjacentSameTypeLists
} from './listItemDepth.js';

/**
 * Move the selected list item(s) one position up within their parent list.
 * Swaps the operated block [startIndex..endIndex] with the item at startIndex - 1.
 * Returns false if the first operated item is already at index 0, or not in a list.
 */
export function moveListItemUp(editor: Editor): boolean {
	normalizeAdjacentSameTypeLists(editor);
	const range = findOperationRange(editor);
	if (!range) return false;

	const { list, listContentStart, startIndex, endIndex } = range;

	// Already first — cannot move up.
	if (startIndex === 0) return false;

	const prevSibling = list.child(startIndex - 1);

	// Collect operated items.
	const operatedItems = [];
	for (let i = startIndex; i <= endIndex; i++) {
		operatedItems.push(list.child(i));
	}

	// Compute the absolute range to replace: [prevSibling, ...operatedItems]
	const replaceStart = childAbsStart(list, startIndex - 1, listContentStart);
	const lastOperatedEnd = childAbsStart(list, endIndex + 1, listContentStart);

	// Record selection info for cursor preservation.
	const state = editor.state;
	const { $from: selFrom, $to: selTo } = state.selection;
	const selIsRange = !state.selection.empty;
	const fromParentOffset = selFrom.parentOffset;
	const toParentOffset = selTo.parentOffset;

	// Build replacement: [operatedItems..., prevSibling]
	const replacementNodes = [...operatedItems, prevSibling];

	const tr = state.tr;
	tr.replaceWith(replaceStart, lastOperatedEnd, Fragment.fromArray(replacementNodes));
	removeTrailingParagraphIfPresent(tr, editor);
	tr.setMeta(SKIP_TRAILING_NODE, true);

	// Restore cursor: items moved up by prevSibling.nodeSize
	const shift = prevSibling.nodeSize;
	try {
		if (selIsRange) {
			const newFrom = tr.mapping.map(selFrom.pos - shift + shift) - shift;
			const newTo = tr.mapping.map(selTo.pos - shift + shift) - shift;
			const docSize = tr.doc.content.size;
			const clampedFrom = Math.max(1, Math.min(newFrom, docSize - 1));
			const clampedTo = Math.max(1, Math.min(newTo, docSize - 1));
			tr.setSelection(TextSelection.create(tr.doc, clampedFrom, clampedTo));
		} else {
			// Single cursor: compute new position analytically.
			// The operated item started at childAbsStart(list, startIndex, listContentStart)
			// and moved to replaceStart. The cursor offset within the item stays the same.
			const oldItemStart = childAbsStart(list, startIndex, listContentStart);
			const cursorOffsetInItem = selFrom.pos - oldItemStart;
			const newItemStart = replaceStart;
			const newPos = newItemStart + cursorOffsetInItem;
			const docSize = tr.doc.content.size;
			const clamped = Math.max(1, Math.min(newPos, docSize - 1));
			const resolved = tr.doc.resolve(clamped);
			tr.setSelection(TextSelection.near(resolved));
		}
	} catch {
		// Fallback: place cursor at start of first operated item.
		const fallbackPos = replaceStart + 2; // +1 li open, +1 para open
		const resolved = tr.doc.resolve(Math.min(fallbackPos, tr.doc.content.size - 1));
		tr.setSelection(TextSelection.near(resolved));
	}

	editor.view.dispatch(tr);
	return true;
}

/**
 * Move the selected list item(s) one position down within their parent list.
 * Swaps the operated block [startIndex..endIndex] with the item at endIndex + 1.
 * Returns false if the last operated item is already at the end, or not in a list.
 */
export function moveListItemDown(editor: Editor): boolean {
	normalizeAdjacentSameTypeLists(editor);
	const range = findOperationRange(editor);
	if (!range) return false;

	const { list, listContentStart, startIndex, endIndex } = range;

	// Already last — cannot move down.
	if (endIndex >= list.childCount - 1) return false;

	const nextSibling = list.child(endIndex + 1);

	// Collect operated items.
	const operatedItems = [];
	for (let i = startIndex; i <= endIndex; i++) {
		operatedItems.push(list.child(i));
	}

	// Compute the absolute range to replace: [operatedItems..., nextSibling]
	const replaceStart = childAbsStart(list, startIndex, listContentStart);
	const nextSiblingEnd = childAbsStart(list, endIndex + 2, listContentStart);

	// Record selection info for cursor preservation.
	const state = editor.state;
	const { $from: selFrom, $to: selTo } = state.selection;
	const selIsRange = !state.selection.empty;

	// Build replacement: [nextSibling, operatedItems...]
	const replacementNodes = [nextSibling, ...operatedItems];

	const tr = state.tr;
	tr.replaceWith(replaceStart, nextSiblingEnd, Fragment.fromArray(replacementNodes));
	removeTrailingParagraphIfPresent(tr, editor);
	tr.setMeta(SKIP_TRAILING_NODE, true);

	// Restore cursor: items moved down by nextSibling.nodeSize
	const shift = nextSibling.nodeSize;
	try {
		if (selIsRange) {
			const newFrom = selFrom.pos + shift;
			const newTo = selTo.pos + shift;
			const docSize = tr.doc.content.size;
			const clampedFrom = Math.max(1, Math.min(newFrom, docSize - 1));
			const clampedTo = Math.max(1, Math.min(newTo, docSize - 1));
			tr.setSelection(TextSelection.create(tr.doc, clampedFrom, clampedTo));
		} else {
			// Single cursor: shift by nextSibling's nodeSize
			const oldItemStart = childAbsStart(list, startIndex, listContentStart);
			const cursorOffsetInItem = selFrom.pos - oldItemStart;
			const newItemStart = replaceStart + shift;
			const newPos = newItemStart + cursorOffsetInItem;
			const docSize = tr.doc.content.size;
			const clamped = Math.max(1, Math.min(newPos, docSize - 1));
			const resolved = tr.doc.resolve(clamped);
			tr.setSelection(TextSelection.near(resolved));
		}
	} catch {
		// Fallback: place cursor at start of first operated item after the next sibling.
		const fallbackPos = replaceStart + shift + 2;
		const resolved = tr.doc.resolve(Math.min(fallbackPos, tr.doc.content.size - 1));
		tr.setSelection(TextSelection.near(resolved));
	}

	editor.view.dispatch(tr);
	return true;
}
