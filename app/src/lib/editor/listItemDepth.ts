/**
 * listItemDepth.ts
 *
 * Provides sinkListItemOnly and liftListItemOnly — surgical list-item depth
 * changes that move ONLY the targeted list item, leaving its descendants at
 * their current absolute visual depth.
 *
 * Both functions build a complete ProseMirror transaction without delegating
 * to TipTap's sinkListItem / liftListItem commands (which can introduce
 * unwanted trailing empty paragraphs and include nested children in the move).
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
const SKIP_TRAILING_NODE = 'skipTrailingNode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True if `node` is a bulletList or orderedList. */
function isList(node: PMNode, editor: Editor): boolean {
	const { bulletList, orderedList } = editor.schema.nodes;
	return node.type === bulletList || node.type === orderedList;
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
function removeTrailingParagraphIfPresent(
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

/**
 * Find the depth of the innermost listItem ancestor of the current selection.
 * Returns -1 if not inside a listItem.
 */
function findListItemDepth(editor: Editor): number {
	const { $from } = editor.state.selection;
	const listItemType: NodeType = editor.schema.nodes.listItem;
	for (let d = $from.depth; d > 0; d--) {
		if ($from.node(d).type === listItemType) return d;
	}
	return -1;
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
function childAbsStart(parent: PMNode, index: number, parentContentStart: number): number {
	let pos = parentContentStart;
	for (let i = 0; i < index; i++) {
		pos += parent.child(i).nodeSize;
	}
	return pos;
}

// ---------------------------------------------------------------------------
// sinkListItemOnly
// ---------------------------------------------------------------------------

/**
 * Move the cursor's list item one level deeper (into the previous sibling's
 * sub-list), but leave the operated item's own children at their CURRENT
 * absolute visual depth — they become siblings of the operated item inside
 * the previous sibling.
 *
 * Returns false if there is no previous sibling (cannot sink).
 */
export function sinkListItemOnly(editor: Editor): boolean {
	const state = editor.state;
	const { listItem: liType } = editor.schema.nodes;

	const liDepth = findListItemDepth(editor);
	if (liDepth < 0) return false;

	const { $from } = state.selection;

	// parent list (one level above the listItem)
	const parentList: PMNode = $from.node(liDepth - 1);
	// absolute position of parent list's content (pos after opening token)
	const parentListContentStart: number = $from.start(liDepth - 1);

	// operated listItem and its index within parent list
	const liNode: PMNode = $from.node(liDepth);
	const liIndex: number = $from.index(liDepth - 1);

	// Must have a previous sibling to sink into
	if (liIndex === 0) return false;

	const prevSibling: PMNode = parentList.child(liIndex - 1);

	// Does the operated listItem have a nested list as its last child?
	const lastChild = liNode.lastChild;
	const hasNestedList = lastChild !== null && isList(lastChild, editor);

	// Build A_stripped: A without its nested list (only the paragraph part)
	let aStripped: PMNode;
	if (hasNestedList) {
		const liChildrenNoList: PMNode[] = [];
		liNode.forEach((_child, _offset, i) => {
			if (i < liNode.childCount - 1) liChildrenNoList.push(liNode.child(i));
		});
		aStripped = liType.create(liNode.attrs, Fragment.fromArray(liChildrenNoList));
	} else {
		aStripped = liNode;
	}

	// Collect children listItems that should become siblings of A after the sink.
	const promotedChildren: PMNode[] = [];
	if (hasNestedList && lastChild) {
		lastChild.forEach((child) => promotedChildren.push(child));
	}

	// All items that should end up inside X's new sub-list: [A_stripped, ...promotedChildren]
	const innerItems = [aStripped, ...promotedChildren];

	// Determine the list type for the wrapper inside X.
	// Use the parent list's type (same as A's current parent) for consistency.
	const wrapperListType = parentList.type;

	// Build X_new: previous sibling X with a sub-list appended.
	// X may already have its own nested list as its last child.
	const xLastChild = prevSibling.lastChild;
	const xHasList = xLastChild !== null && isList(xLastChild, editor);

	let xNewContent: PMNode[];
	if (xHasList && xLastChild) {
		if (promotedChildren.length === 0) {
			// A has no children. A adopts X's existing sub-list items as its own
			// children, so that sink+lift is a round-trip.
			// X's new sub-list = [A(ul(X's existing items))]
			const adoptedList = xLastChild.type.create(
				xLastChild.attrs,
				xLastChild.content
			);
			const aWithAdopted = liType.create(
				aStripped.attrs,
				Fragment.fromArray([...toNodeArray(aStripped), adoptedList])
			);
			xNewContent = [];
			prevSibling.forEach((_child, _offset, i) => {
				if (i < prevSibling.childCount - 1) xNewContent.push(prevSibling.child(i));
			});
			xNewContent.push(
				wrapperListType.create(null, Fragment.from(aWithAdopted))
			);
		} else {
			// A had children that are now being promoted. Merge them with X's
			// existing sub-list items: existing items first, then A + promoted.
			const existingItems: PMNode[] = [];
			xLastChild.forEach((child) => existingItems.push(child));
			const mergedList = xLastChild.type.create(
				xLastChild.attrs,
				Fragment.fromArray([...existingItems, ...innerItems])
			);
			xNewContent = [];
			prevSibling.forEach((_child, _offset, i) => {
				if (i < prevSibling.childCount - 1) xNewContent.push(prevSibling.child(i));
			});
			xNewContent.push(mergedList);
		}
	} else {
		// Create a new sub-list inside X
		const newSubList = wrapperListType.create(null, Fragment.fromArray(innerItems));
		xNewContent = [];
		prevSibling.forEach((_child, _offset, i) => xNewContent.push(prevSibling.child(i)));
		xNewContent.push(newSubList);
	}
	const xNew = liType.create(prevSibling.attrs, Fragment.fromArray(xNewContent));

	// Compute the absolute range [prevSiblingStart, AEnd) to replace with [X_new]
	const prevSibStart = childAbsStart(parentList, liIndex - 1, parentListContentStart);
	const aStart = prevSibStart + prevSibling.nodeSize;
	const aEnd = aStart + liNode.nodeSize;

	// Replace both X and A with X_new (which contains A and promotedChildren inside).
	const tr = state.tr;
	tr.replaceWith(prevSibStart, aEnd, xNew);
	// Remove any trailing empty paragraph that was added by TrailingNode from a
	// prior transaction (e.g. setTextSelection), so the doc stays clean.
	removeTrailingParagraphIfPresent(tr, editor);
	// Prevent TipTap's TrailingNode plugin from appending a new trailing empty paragraph.
	tr.setMeta(SKIP_TRAILING_NODE, true);

	// Place cursor inside A_stripped within the new structure.
	// xNew starts at prevSibStart; its opening token = 1 byte.
	// X's non-list children come first, then the sub-list.
	let subListRelOffset = 1; // 1 for the opening token of xNew (listItem)
	for (let i = 0; i < xNew.childCount - 1; i++) {
		subListRelOffset += xNew.child(i).nodeSize;
	}
	// subList is xNew.lastChild (the wrapperList)
	// A_stripped is the first item in subList
	// Cursor: prevSibStart + subListRelOffset + 1(list open) + 1(li open) + 1(para open)
	const cursorPos = prevSibStart + subListRelOffset + 1 + 1 + 1;
	try {
		const resolvedPos = tr.doc.resolve(Math.min(cursorPos, tr.doc.content.size - 1));
		tr.setSelection(TextSelection.near(resolvedPos));
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
 * Move the cursor's list item one level shallower, but leave the operated
 * item's own children at their CURRENT absolute visual depth — they stay
 * under the operated item's old parent while the operated item lifts out.
 *
 * Returns false if the item is already at the top list level (cannot lift).
 */
export function liftListItemOnly(editor: Editor): boolean {
	const state = editor.state;
	const { listItem: liType } = editor.schema.nodes;

	const liDepth = findListItemDepth(editor);
	if (liDepth < 0) return false;

	// Need at least: doc > list > listItem(X) > list > listItem(A)
	// i.e. liDepth >= 2 and grandparent must be a listItem
	if (liDepth < 2) return false;
	const { $from } = editor.state.selection;
	const grandParent = $from.node(liDepth - 2);
	if (!grandParent || grandParent.type !== liType) return false;

	// The parent list of A (the list that contains A)
	const parentList: PMNode = $from.node(liDepth - 1);
	const parentListContentStart: number = $from.start(liDepth - 1);

	// The listItem A and its index in parentList
	const liNode: PMNode = $from.node(liDepth);
	const liIndex: number = $from.index(liDepth - 1);

	// The grandparent listItem X (contains parentList)
	const xNode: PMNode = $from.node(liDepth - 2);
	const xDepth = liDepth - 2;

	// The great-grandparent list (the list that contains X)
	const grandList: PMNode = $from.node(xDepth - 1);
	const grandListContentStart: number = $from.start(xDepth - 1);
	const xIndex: number = $from.index(xDepth - 1);

	// Does A have a nested list?
	const lastChild = liNode.lastChild;
	const hasNestedList = lastChild !== null && isList(lastChild, editor);

	// Build A_stripped (A without nested list)
	let aStripped: PMNode;
	const promotedChildren: PMNode[] = [];
	if (hasNestedList && lastChild) {
		const liChildrenNoList: PMNode[] = [];
		liNode.forEach((_child, _offset, i) => {
			if (i < liNode.childCount - 1) liChildrenNoList.push(liNode.child(i));
		});
		aStripped = liType.create(liNode.attrs, Fragment.fromArray(liChildrenNoList));
		lastChild.forEach((child) => promotedChildren.push(child));
	} else {
		aStripped = liNode;
	}

	// Build new parentList: replace A with its promoted children.
	// The promoted children stay at the same depth as A was.
	const newParentListItems: PMNode[] = [];
	parentList.forEach((_child, _offset, i) => {
		if (i !== liIndex) {
			newParentListItems.push(parentList.child(i));
		} else {
			// Replace A with its promoted children (if any)
			newParentListItems.push(...promotedChildren);
		}
	});

	// Build new X_node:
	// X keeps all its children except the parentList, which is replaced (or removed if empty).
	let xNewContent: PMNode[];
	if (newParentListItems.length === 0) {
		// Remove the sub-list entirely — keep only X's non-list children
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

	// Compute absolute range of X in the grandList.
	const xAbsStart = childAbsStart(grandList, xIndex, grandListContentStart);
	const xAbsEnd = xAbsStart + xNode.nodeSize;

	// Replacement: [X_new, A_stripped]
	// A_stripped is inserted right after X_new in the grandList.
	const replacementNodes = [xNew, aStripped];

	const tr = state.tr;
	tr.replaceWith(xAbsStart, xAbsEnd, Fragment.fromArray(replacementNodes));
	// Remove any trailing empty paragraph that was added by TrailingNode from a
	// prior transaction (e.g. setTextSelection), so the doc stays clean.
	removeTrailingParagraphIfPresent(tr, editor);
	// Prevent TipTap's TrailingNode plugin from appending a new trailing empty paragraph.
	tr.setMeta(SKIP_TRAILING_NODE, true);

	// Place cursor inside A_stripped.
	// A_stripped starts at: xAbsStart + xNew.nodeSize (mapped through tr.mapping)
	// Cursor: + 1 (listItem open) + 1 (paragraph open) = position of first char
	const aNewStart = tr.mapping.map(xAbsStart) + xNew.nodeSize;
	const cursorPos = aNewStart + 2;
	try {
		const resolvedPos = tr.doc.resolve(Math.min(cursorPos, tr.doc.content.size - 1));
		tr.setSelection(TextSelection.near(resolvedPos));
	} catch {
		// fallback
	}

	editor.view.dispatch(tr);
	return true;
}
