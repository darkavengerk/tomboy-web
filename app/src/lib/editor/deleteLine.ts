/**
 * deleteLine.ts — `deleteCurrentLine(editor)`
 *
 * Removes the "current line" at the cursor position:
 *
 *   • Inside a listItem, deletes the entire listItem (with any nested
 *     descendants). When the listItem is the only child of its wrapping
 *     bulletList/orderedList, the wrapping list is collapsed too — and we
 *     keep collapsing up while every successive ancestor is a single-child
 *     list. This guarantees we never leave an empty `<ul>`/`<ol>` behind.
 *
 *   • Inside any other textblock (paragraph, heading, …), deletes that
 *     whole textblock node.
 *
 *   • If deleting would empty the document, replaces the doc with a
 *     single empty paragraph so the editor stays schema-valid.
 *
 * Cursor placement: snaps to the nearest text position at the deletion
 * site (start of the next block when there is one, end of the previous
 * block otherwise).
 */

import type { Editor } from '@tiptap/core';
import { TextSelection } from 'prosemirror-state';

import { SKIP_TRAILING_NODE } from './listItemDepth.js';

export function deleteCurrentLine(editor: Editor): boolean {
	const { state, view } = editor;
	const { $from } = state.selection;

	// Walk up looking for the deepest listItem ancestor of the cursor.
	let liDepth = -1;
	for (let d = $from.depth; d > 0; d--) {
		if ($from.node(d).type.name === 'listItem') {
			liDepth = d;
			break;
		}
	}

	let deleteDepth: number;
	if (liDepth > 0) {
		deleteDepth = liDepth;
		// Collapse single-child wrapping lists upward so an empty
		// <ul>/<ol> is never left in place.
		for (let d = liDepth - 1; d > 0; d--) {
			const parent = $from.node(d);
			const isList =
				parent.type.name === 'bulletList' ||
				parent.type.name === 'orderedList';
			if (!isList) break;
			if (parent.childCount !== 1) break;
			deleteDepth = d;
		}
	} else {
		// Not in a list — find the textblock containing the cursor and
		// delete the whole textblock.
		let d = $from.depth;
		while (d > 0 && !$from.node(d).isTextblock) d--;
		if (d === 0) return false;
		deleteDepth = d;
	}

	const from = $from.before(deleteDepth);
	const to = $from.after(deleteDepth);

	// Empty-doc guard: deleting the only top-level block would leave a
	// schema-invalid empty doc. Replace it with a single empty paragraph
	// instead and place the cursor inside it.
	if (from <= 0 && to >= state.doc.content.size) {
		const para = state.schema.nodes.paragraph.create();
		const tr = state.tr.replaceWith(0, state.doc.content.size, para);
		tr.setSelection(TextSelection.create(tr.doc, 1));
		tr.setMeta(SKIP_TRAILING_NODE, true);
		view.dispatch(tr.scrollIntoView());
		return true;
	}

	const tr = state.tr.delete(from, to);
	tr.setMeta(SKIP_TRAILING_NODE, true);
	const target = Math.max(0, Math.min(from, tr.doc.content.size));
	const $target = tr.doc.resolve(target);
	tr.setSelection(TextSelection.near($target, 1));
	view.dispatch(tr.scrollIntoView());
	return true;
}
