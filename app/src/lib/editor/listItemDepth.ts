/**
 * listItemDepth.ts
 *
 * Provides sinkListItemOnly and liftListItemOnly — surgical list-item depth
 * changes that move ONLY the targeted list item(s), leaving their descendants
 * at their current absolute visual depth.
 *
 * Both functions build a complete ProseMirror transaction without delegating
 * to TipTap's sinkListItem / liftListItem commands (which can introduce
 * unwanted trailing empty paragraphs and include nested children in the move).
 *
 * Multi-selection: the "operation range" is the contiguous block of items
 * [startIndex..endIndex] (inclusive) within the deepest common ancestor list.
 */

import type { Editor } from '@tiptap/core';
import type { NodeType, Node as PMNode } from 'prosemirror-model';
import { Fragment } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';

/**
 * Meta key used by TipTap's TrailingNode extension to skip appending a
 * trailing paragraph after a transaction.  We set this on every transaction
 * we dispatch so the editor doesn't gain an unwanted trailing empty paragraph
 * when the doc ends with a list.
 *
 * See: @tiptap/extensions `skipTrailingNodeMeta` export.
 */
export const SKIP_TRAILING_NODE = 'skipTrailingNode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True if `node` is a bulletList or orderedList. */
export function isList(node: PMNode, editor: Editor): boolean {
	const { bulletList, orderedList } = editor.schema.nodes;
	return node.type === bulletList || node.type === orderedList;
}

/** Check if the cursor is currently inside a list (at any depth). */
export function isInList(editor: Editor): boolean {
	const { $from } = editor.state.selection;
	for (let d = $from.depth; d >= 0; d--) {
		if (isList($from.node(d), editor)) return true;
	}
	return false;
}

/**
 * If the doc currently ends with a trailing empty paragraph (added by
 * TipTap's TrailingNode plugin from a prior transaction such as
 * setTextSelection), remove it from the transaction so the final doc
 * is clean.
 *
 * This must be called AFTER the main content changes have been applied to
 * `tr`, so the positions are based on the already-modified `tr.doc`.
 */
export function removeTrailingParagraphIfPresent(
	tr: import('prosemirror-state').Transaction,
	editor: Editor
): void {
	const doc = editor.state.doc; // BEFORE the transaction
	const { paragraph } = editor.schema.nodes;
	const last = doc.lastChild;
	if (!last || last.type !== paragraph || last.childCount > 0) return;
	if (doc.childCount < 2) return; // don't strip the only paragraph
	// The trailing paragraph is at the very end of the doc.
	// Its absolute position: doc.content.size - last.nodeSize to doc.content.size.
	// After the main replaceWith, positions may have shifted. Use tr.mapping to
	// map the original position.
	const origEnd = doc.content.size;
	const origStart = origEnd - last.nodeSize;
	const mappedStart = tr.mapping.map(origStart);
	const mappedEnd = tr.mapping.map(origEnd);
	if (mappedStart < mappedEnd) {
		tr.delete(mappedStart, mappedEnd);
	}
}

/** Collect all children of a node into a plain array. */
function toNodeArray(node: PMNode): PMNode[] {
	const arr: PMNode[] = [];
	node.forEach((child) => arr.push(child));
	return arr;
}

/**
 * Compute the absolute start position of child `index` within `parent` whose
 * content starts at absolute position `parentContentStart`.
 * `parentContentStart` = absolute pos of opening token + 1.
 */
export function childAbsStart(parent: PMNode, index: number, parentContentStart: number): number {
	let pos = parentContentStart;
	for (let i = 0; i < index; i++) {
		pos += parent.child(i).nodeSize;
	}
	return pos;
}

/**
 * Strip the trailing nested list from a listItem (if present), returning the
 * stripped listItem and the promoted children as separate arrays.
 */
function stripNestedList(
	liNode: PMNode,
	liType: NodeType,
	editor: Editor
): { stripped: PMNode; promotedChildren: PMNode[] } {
	const lastChild = liNode.lastChild;
	const hasNestedList = lastChild !== null && isList(lastChild, editor);
	if (!hasNestedList) {
		return { stripped: liNode, promotedChildren: [] };
	}
	const liChildrenNoList: PMNode[] = [];
	liNode.forEach((_child, _offset, i) => {
		if (i < liNode.childCount - 1) liChildrenNoList.push(liNode.child(i));
	});
	const stripped = liType.create(liNode.attrs, Fragment.fromArray(liChildrenNoList));
	const promotedChildren: PMNode[] = [];
	lastChild!.forEach((child) => promotedChildren.push(child));
	return { stripped, promotedChildren };
}

// ---------------------------------------------------------------------------
// Operation range
// ---------------------------------------------------------------------------

export interface OperationRange {
	/** The deepest common ancestor list node */
	list: PMNode;
	/** Depth of the list in the document tree */
	listDepth: number;
	/** Absolute position of the list's content start (after opening token) */
	listContentStart: number;
	/** Index of the first operated item within the list */
	startIndex: number;
	/** Index of the last operated item within the list (inclusive) */
	endIndex: number;
}

/**
 * Determine the operation range for the current selection.
 *
 * Walks up from the deepest shared ancestor of $from and $to looking for the
 * first list-type node. All list items at indices [startIndex..endIndex]
 * within that list form the "operated block".
 *
 * When the selection is a single cursor, $from === $to and the range collapses
 * to startIndex === endIndex (single-item behavior).
 */
export function findOperationRange(editor: Editor): OperationRange | null {
	const { $from, $to } = editor.state.selection;

	const shared = $from.sharedDepth($to.pos);

	for (let d = shared; d >= 0; d--) {
		const node = $from.node(d);
		if (!isList(node, editor)) continue;

		const lastIdx = node.childCount - 1;
		if (lastIdx < 0) return null;

		let startIndex = Math.max(0, Math.min($from.index(d), lastIdx));
		let endIndex = Math.max(0, Math.min($to.index(d), lastIdx));
		if (startIndex > endIndex) [startIndex, endIndex] = [endIndex, startIndex];

		return {
			list: node,
			listDepth: d,
			listContentStart: $from.start(d),
			startIndex,
			endIndex
		};
	}

	return null;
}

// ---------------------------------------------------------------------------
// sinkListItemOnly
// ---------------------------------------------------------------------------

/**
 * Move the selected list item(s) one level deeper (into the previous sibling's
 * sub-list), but leave each operated item's own children at their CURRENT
 * absolute visual depth — they become siblings of the operated items inside
 * the previous sibling.
 *
 * For a single-cursor selection, this is identical to the original single-item
 * behavior. For a range selection, all items at indices [startIndex..endIndex]
 * are moved as a block.
 *
 * Returns false if there is no previous sibling (cannot sink).
 */
export function sinkListItemOnly(editor: Editor): boolean {
	const state = editor.state;
	const { listItem: liType } = editor.schema.nodes;

	const range = findOperationRange(editor);
	if (!range) return false;

	const { list: parentList, listDepth, listContentStart, startIndex, endIndex } = range;

	// Must have a previous sibling to sink into.
	if (startIndex === 0) return false;

	const prevSibling: PMNode = parentList.child(startIndex - 1);

	// Build innerItems: for each operated item I, push I_stripped then I's promoted children.
	// Pattern: [A_stripped, ...A_children, B_stripped, ...B_children, ...]
	const innerItems: PMNode[] = [];
	for (let i = startIndex; i <= endIndex; i++) {
		const item = parentList.child(i);
		const { stripped, promotedChildren } = stripNestedList(item, liType, editor);
		innerItems.push(stripped);
		innerItems.push(...promotedChildren);
	}

	// Determine the list type for the wrapper inside prevSibling.
	const wrapperListType = parentList.type;

	// Build prevSibling_new: previous sibling with a sub-list containing innerItems.
	// If prevSibling already has a nested list as its last child, append to it.
	const xLastChild = prevSibling.lastChild;
	const xHasList = xLastChild !== null && isList(xLastChild, editor);

	let xNewContent: PMNode[];
	let aIndexInSubList: number; // index of the first operated item inside the sub-list
	if (xHasList && xLastChild) {
		const existingItems: PMNode[] = [];
		xLastChild.forEach((child) => existingItems.push(child));
		aIndexInSubList = existingItems.length;
		const mergedList = xLastChild.type.create(
			xLastChild.attrs,
			Fragment.fromArray([...existingItems, ...innerItems])
		);
		xNewContent = [];
		prevSibling.forEach((_child, _offset, i) => {
			if (i < prevSibling.childCount - 1) xNewContent.push(prevSibling.child(i));
		});
		xNewContent.push(mergedList);
	} else {
		aIndexInSubList = 0;
		const newSubList = wrapperListType.create(null, Fragment.fromArray(innerItems));
		xNewContent = [];
		prevSibling.forEach((_child, _offset, i) => xNewContent.push(prevSibling.child(i)));
		xNewContent.push(newSubList);
	}
	const xNew = liType.create(prevSibling.attrs, Fragment.fromArray(xNewContent));

	// Compute the absolute range [prevSiblingStart, lastOperatedItemEnd) to replace with [xNew].
	const prevSibStart = childAbsStart(parentList, startIndex - 1, listContentStart);
	const firstOperatedStart = prevSibStart + prevSibling.nodeSize;
	// End of last operated item:
	let lastOperatedEnd = firstOperatedStart;
	for (let i = startIndex; i <= endIndex; i++) {
		lastOperatedEnd += parentList.child(i).nodeSize;
	}

	// Record selection info BEFORE dispatching for preservation.
	const { $from: selFrom, $to: selTo } = state.selection;
	const selIsRange = !state.selection.empty;

	// For each endpoint, compute (relItemIdx, posInPara) relative to the operated block.
	function getEndpointInfo(
		$end: typeof selFrom
	): { relItemIdx: number | null; posInPara: number } {
		const itemIdx = $end.index(listDepth);
		if (itemIdx < startIndex || itemIdx > endIndex) {
			return { relItemIdx: null, posInPara: 0 };
		}
		return {
			relItemIdx: itemIdx - startIndex,
			posInPara: $end.parentOffset
		};
	}

	const fromInfo = getEndpointInfo(selFrom);
	const toInfo = getEndpointInfo(selTo);

	// Build operatedItemInnerIdx: for each operated item k, its index in innerItems.
	const operatedItemInnerIdx: number[] = [];
	let innerIdx = 0;
	for (let i = startIndex; i <= endIndex; i++) {
		operatedItemInnerIdx.push(innerIdx);
		const item = parentList.child(i);
		const { promotedChildren } = stripNestedList(item, liType, editor);
		innerIdx += 1 + promotedChildren.length;
	}

	const tr = state.tr;
	tr.replaceWith(prevSibStart, lastOperatedEnd, xNew);
	removeTrailingParagraphIfPresent(tr, editor);
	tr.setMeta(SKIP_TRAILING_NODE, true);

	// Place cursor inside the first operated item's paragraph in the new structure.
	// xNew starts at prevSibStart; its opening token = 1 byte.
	// X's non-list children come first, then the sub-list.
	let subListRelOffset = 1; // 1 for the opening token of xNew (listItem)
	for (let i = 0; i < xNew.childCount - 1; i++) {
		subListRelOffset += xNew.child(i).nodeSize;
	}
	// subList is xNew.lastChild (the wrapperList).
	// The first operated item sits at index `aIndexInSubList` within subList.
	const subList = xNew.lastChild;
	let aOffsetInSubList = 1; // open token of subList
	if (subList) {
		for (let i = 0; i < aIndexInSubList; i++) {
			aOffsetInSubList += subList.child(i).nodeSize;
		}
	}
	// Base position: start of subList content.
	const subListContentAbsStart = prevSibStart + subListRelOffset;

	// Helper: absolute position of paragraph content start for operated item k.
	function operatedItemParaStart(k: number): number {
		if (!subList) return subListContentAbsStart + 2;
		const innerItemIdx = aIndexInSubList + operatedItemInnerIdx[k];
		let abs = subListContentAbsStart + 1; // +1 for subList open token
		for (let i = 0; i < innerItemIdx; i++) {
			abs += subList.child(i).nodeSize;
		}
		abs += 2; // +1 li open, +1 para open
		return abs;
	}

	// Cursor: prevSibStart + subListRelOffset + aOffsetInSubList + 1(li open) + 1(para open)
	const cursorPos = prevSibStart + subListRelOffset + aOffsetInSubList + 1 + 1;
	try {
		if (
			selIsRange &&
			fromInfo.relItemIdx !== null &&
			toInfo.relItemIdx !== null
		) {
			const newFrom = operatedItemParaStart(fromInfo.relItemIdx) + fromInfo.posInPara;
			const newTo = operatedItemParaStart(toInfo.relItemIdx) + toInfo.posInPara;
			const docSize = tr.doc.content.size;
			const clampedFrom = Math.max(1, Math.min(newFrom, docSize - 1));
			const clampedTo = Math.max(1, Math.min(newTo, docSize - 1));
			tr.setSelection(TextSelection.create(tr.doc, clampedFrom, clampedTo));
		} else {
			const resolvedPos = tr.doc.resolve(Math.min(cursorPos, tr.doc.content.size - 1));
			tr.setSelection(TextSelection.near(resolvedPos));
		}
	} catch {
		// fallback: leave cursor where it is
	}

	editor.view.dispatch(tr);
	return true;
}

// ---------------------------------------------------------------------------
// liftListItemOnly
// ---------------------------------------------------------------------------

/**
 * Move the selected list item(s) one level shallower, but leave each operated
 * item's own children at their CURRENT absolute visual depth — they stay
 * under the operated items' old parent while the operated items lift out.
 *
 * Returns false if the items are already at the top list level (cannot lift).
 */
export function liftListItemOnly(editor: Editor): boolean {
	const state = editor.state;
	const { listItem: liType } = editor.schema.nodes;

	const range = findOperationRange(editor);
	if (!range) return false;

	const { list: parentList, listDepth, listContentStart, startIndex, endIndex } = range;

	// Need at least: doc > list > listItem(X) > list(parentList) > listItem(A)
	// i.e. listDepth >= 2 and the node at listDepth-1 must be a listItem.
	if (listDepth < 2) return false;
	const { $from } = editor.state.selection;
	const grandParent = $from.node(listDepth - 1);
	if (!grandParent || grandParent.type !== liType) return false;

	// xNode: the grandparent listItem that contains parentList.
	const xNode: PMNode = $from.node(listDepth - 1);
	const xDepth = listDepth - 1;

	// grandList: the list that contains xNode.
	const grandList: PMNode = $from.node(xDepth - 1);
	const grandListContentStart: number = $from.start(xDepth - 1);
	const xIndex: number = $from.index(xDepth - 1);

	// For each operated item, strip its nested list and collect promoted children.
	const operatedItems: Array<{ stripped: PMNode; promotedChildren: PMNode[] }> = [];
	for (let i = startIndex; i <= endIndex; i++) {
		const item = parentList.child(i);
		operatedItems.push(stripNestedList(item, liType, editor));
	}

	// Build new parentList items: original items minus the operated ones,
	// with each operated item's slot replaced by its promoted children.
	const newParentListItems: PMNode[] = [];
	parentList.forEach((_child, _offset, i) => {
		if (i < startIndex || i > endIndex) {
			// Non-operated: keep as-is.
			newParentListItems.push(parentList.child(i));
		} else {
			// Operated: replace with promoted children (if any).
			const { promotedChildren } = operatedItems[i - startIndex];
			newParentListItems.push(...promotedChildren);
		}
	});

	// Build new xNode:
	// X keeps all its children except parentList, which is replaced (or removed if empty).
	let xNewContent: PMNode[];
	if (newParentListItems.length === 0) {
		// Remove the sub-list entirely — keep only X's non-list children.
		xNewContent = [];
		xNode.forEach((_child, _offset, i) => {
			if (i < xNode.childCount - 1) xNewContent.push(xNode.child(i));
		});
	} else {
		const newParentList = parentList.type.create(
			parentList.attrs,
			Fragment.fromArray(newParentListItems)
		);
		xNewContent = [];
		xNode.forEach((_child, _offset, i) => {
			if (i < xNode.childCount - 1) {
				xNewContent.push(xNode.child(i));
			}
		});
		xNewContent.push(newParentList);
	}
	const xNew = liType.create(xNode.attrs, Fragment.fromArray(xNewContent));

	// Replacement at X's slot in grandList: [xNew, strippedA, strippedB, ...]
	const strippedItems = operatedItems.map((o) => o.stripped);
	const replacementNodes = [xNew, ...strippedItems];

	// Compute absolute range of xNode in grandList.
	const xAbsStart = childAbsStart(grandList, xIndex, grandListContentStart);
	const xAbsEnd = xAbsStart + xNode.nodeSize;

	// Record selection info BEFORE dispatching for preservation.
	const { $from: selFrom, $to: selTo } = state.selection;
	const selIsRange = !state.selection.empty;

	function getEndpointInfoLift(
		$end: typeof selFrom
	): { relItemIdx: number | null; posInPara: number } {
		const itemIdx = $end.index(listDepth);
		if (itemIdx < startIndex || itemIdx > endIndex) {
			return { relItemIdx: null, posInPara: 0 };
		}
		return {
			relItemIdx: itemIdx - startIndex,
			posInPara: $end.parentOffset
		};
	}

	const fromInfo = getEndpointInfoLift(selFrom);
	const toInfo = getEndpointInfoLift(selTo);

	const tr = state.tr;
	tr.replaceWith(xAbsStart, xAbsEnd, Fragment.fromArray(replacementNodes));
	removeTrailingParagraphIfPresent(tr, editor);
	tr.setMeta(SKIP_TRAILING_NODE, true);

	// Place cursor inside the first operated item's paragraph (after xNew).
	const aNewStart = tr.mapping.map(xAbsStart) + xNew.nodeSize;
	const cursorPos = aNewStart + 2; // +1 li open, +1 para open

	// Helper: absolute position of paragraph content start for operated item k (after lift).
	// strippedItems[k] is at position aNewStart + sum of sizes of strippedItems[0..k-1].
	function liftedItemParaStart(k: number): number {
		let abs = aNewStart;
		for (let i = 0; i < k; i++) {
			abs += strippedItems[i].nodeSize;
		}
		abs += 2; // +1 li open, +1 para open
		return abs;
	}

	try {
		if (
			selIsRange &&
			fromInfo.relItemIdx !== null &&
			toInfo.relItemIdx !== null
		) {
			const newFrom = liftedItemParaStart(fromInfo.relItemIdx) + fromInfo.posInPara;
			const newTo = liftedItemParaStart(toInfo.relItemIdx) + toInfo.posInPara;
			const docSize = tr.doc.content.size;
			const clampedFrom = Math.max(1, Math.min(newFrom, docSize - 1));
			const clampedTo = Math.max(1, Math.min(newTo, docSize - 1));
			tr.setSelection(TextSelection.create(tr.doc, clampedFrom, clampedTo));
		} else {
			const resolvedPos = tr.doc.resolve(Math.min(cursorPos, tr.doc.content.size - 1));
			tr.setSelection(TextSelection.near(resolvedPos));
		}
	} catch {
		// fallback
	}

	editor.view.dispatch(tr);
	return true;
}
