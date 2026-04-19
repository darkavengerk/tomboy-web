/**
 * DOM-level copy / cut handlers that replace ProseMirror's default with a
 * Tomboy-shaped plain-text serialization. The default serializer joins
 * block boundaries with `\n\n`, which doesn't match how the .note XML
 * stores paragraph breaks (single `\n`) — the user sees the doubled
 * newlines as "extra line breaks" after pasting elsewhere.
 *
 * These handlers only set `text/plain` on the clipboard. No `text/html`
 * is emitted: the user's asked-for behavior is "plain text only, always",
 * which also sidesteps round-tripping rich formatting into other editors
 * that may interpret it unpredictably.
 */

import type { EditorView } from '@tiptap/pm/view';
import type { Slice } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';
import { tiptapToPlainText } from './copyFormatted.js';

/** Convert a PM selection slice to Tomboy-style plain text (one \n per block). */
function sliceToPlainText(slice: Slice): string {
	const raw = slice.content.toJSON() as JSONContent[] | undefined;
	if (!raw || raw.length === 0) return '';
	const nodes = [...raw];
	// ProseMirror places an auto-inserted empty paragraph after a top-level
	// list so the cursor can live past the list's end — same drop logic as
	// noteContentArchiver.ts's serializeContent. Without this, copying a
	// list via selectAll leaves a dangling trailing newline.
	if (nodes.length >= 2) {
		const last = nodes[nodes.length - 1];
		const secondLast = nodes[nodes.length - 2];
		const isEmptyPara =
			last.type === 'paragraph' && (!last.content || last.content.length === 0);
		if (
			isEmptyPara &&
			(secondLast.type === 'bulletList' || secondLast.type === 'orderedList')
		) {
			nodes.pop();
		}
	}
	const json: JSONContent = { type: 'doc', content: nodes };
	return tiptapToPlainText(json);
}

export function handleClipboardCopy(view: EditorView, event: ClipboardEvent): boolean {
	const sel = view.state.selection;
	if (sel.empty) return false;
	const clipboardData = event.clipboardData;
	if (!clipboardData) return false;
	event.preventDefault();
	clipboardData.setData('text/plain', sliceToPlainText(sel.content()));
	return true;
}

export function handleClipboardCut(view: EditorView, event: ClipboardEvent): boolean {
	const sel = view.state.selection;
	if (sel.empty) return false;
	const clipboardData = event.clipboardData;
	if (!clipboardData) return false;
	event.preventDefault();
	clipboardData.setData('text/plain', sliceToPlainText(sel.content()));
	view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
	return true;
}
