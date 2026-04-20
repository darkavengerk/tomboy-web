/**
 * DOM-level copy / cut handlers that replace ProseMirror's default with a
 * Tomboy-shaped clipboard payload.
 *
 * Two flavors are written to the clipboard on every copy/cut:
 *
 *   - `text/plain` — the user-visible text, no markdown decoration. Block
 *     boundaries (paragraph↔paragraph, list-item↔list-item) become a single
 *     "\n" each. The default PM serializer uses "\n\n" between blocks, which
 *     surfaces as "extra blank lines" after pasting into a text editor.
 *
 *   - `text/html` — minimal semantic HTML from `tiptapToHtml` (<p>, <ul>,
 *     <li>, <strong>, etc; no inline styles or font attributes). Rich
 *     editors prefer this representation and will merge a copied list item
 *     into the destination list as a proper list item instead of inlining
 *     "- " text.
 */

import type { EditorView } from '@tiptap/pm/view';
import type { Slice } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';
import { tiptapToPlainText, tiptapToHtml } from './copyFormatted.js';

/** Convert a PM selection slice to a doc JSON, with trailing empty-paragraph cleanup. */
function sliceToDoc(slice: Slice): JSONContent | null {
	const raw = slice.content.toJSON() as JSONContent[] | undefined;
	if (!raw || raw.length === 0) return null;
	const nodes = [...raw];
	// ProseMirror places an auto-inserted empty paragraph after a top-level
	// list so the cursor can live past the list's end — same drop logic as
	// noteContentArchiver.ts's serializeContent. Without this, copying a
	// list via selectAll leaves a dangling trailing newline / empty <p>.
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
	return { type: 'doc', content: nodes };
}

function writeClipboard(clipboardData: DataTransfer, doc: JSONContent): void {
	clipboardData.setData('text/plain', tiptapToPlainText(doc));
	clipboardData.setData('text/html', tiptapToHtml(doc));
}

export function handleClipboardCopy(view: EditorView, event: ClipboardEvent): boolean {
	const sel = view.state.selection;
	if (sel.empty) return false;
	const clipboardData = event.clipboardData;
	if (!clipboardData) return false;
	const doc = sliceToDoc(sel.content());
	if (!doc) return false;
	event.preventDefault();
	writeClipboard(clipboardData, doc);
	return true;
}

export function handleClipboardCut(view: EditorView, event: ClipboardEvent): boolean {
	const sel = view.state.selection;
	if (sel.empty) return false;
	const clipboardData = event.clipboardData;
	if (!clipboardData) return false;
	const doc = sliceToDoc(sel.content());
	if (!doc) return false;
	event.preventDefault();
	writeClipboard(clipboardData, doc);
	view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
	return true;
}
