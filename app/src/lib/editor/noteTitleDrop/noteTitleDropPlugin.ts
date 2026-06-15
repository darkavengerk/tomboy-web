import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * Drop-to-link: a note title dragged from a title bar lands as plain text at
 * the drop point. The drag source (NoteDragHandle) writes the title under this
 * MIME; this plugin's `handleDrop` reads it and inserts.
 *
 * Insert rules (per design 2026-06-15):
 *  - default: insert at the drop point.
 *  - if the drop point abuts a non-whitespace char, pad that side with a space
 *    (left / right / both) so the title doesn't glue onto an existing word.
 *  - dead-space drop (dropped well below the last line — caret can't reach):
 *    insert a newline at the editor's current selection, then the title.
 *
 * Plain text (not a link mark) by design — the deferred auto-link plugin marks
 * it if it matches a title.
 */
export const NOTE_TITLE_DND_MIME = 'application/x-tomboy-note-title';
export const noteTitleDropPluginKey = new PluginKey('tomboyNoteTitleDrop');

/** Character immediately before `pos` within a text block, or '' at a block edge. */
function charBefore(state: EditorState, pos: number): string {
	const before = state.doc.resolve(pos).nodeBefore;
	if (before && before.isText && before.text) return before.text.slice(-1);
	return '';
}

/** Character immediately after `pos` within a text block, or '' at a block edge. */
function charAfter(state: EditorState, pos: number): string {
	const after = state.doc.resolve(pos).nodeAfter;
	if (after && after.isText && after.text) return after.text[0];
	return '';
}

/**
 * Insert `title` as plain text at `pos`, padding with a single space on
 * whichever side(s) abut a non-whitespace character. Caret lands right after
 * the inserted title (before any trailing space).
 */
export function buildTitleInsertTr(state: EditorState, pos: number, title: string): Transaction {
	const b = charBefore(state, pos);
	const a = charAfter(state, pos);
	const needBefore = b !== '' && !/\s/.test(b);
	const needAfter = a !== '' && !/\s/.test(a);
	const text = (needBefore ? ' ' : '') + title + (needAfter ? ' ' : '');
	const tr = state.tr.insertText(text, pos);
	const caret = pos + (needBefore ? 1 : 0) + title.length;
	tr.setSelection(TextSelection.create(tr.doc, caret));
	return tr;
}

/**
 * Dead-space fallback: split the block at the current selection (= press Enter)
 * and drop `title` onto the new line. Caret lands after the title.
 */
export function buildFallbackInsertTr(state: EditorState, title: string): Transaction {
	const { from } = state.selection;
	const tr = state.tr.split(from);
	const at = tr.mapping.map(from);
	tr.insertText(title, at);
	tr.setSelection(TextSelection.create(tr.doc, at + title.length));
	return tr;
}

/** True when the pointer dropped clearly below the line resolved from coords. */
function isDeadSpaceDrop(view: EditorView, pos: number, dropTop: number): boolean {
	try {
		const caret = view.coordsAtPos(pos);
		return dropTop > caret.bottom + 4;
	} catch {
		return false;
	}
}

export function createNoteTitleDropPlugin(): Plugin {
	return new Plugin({
		key: noteTitleDropPluginKey,
		props: {
			handleDrop(view, event) {
				const dt = (event as DragEvent).dataTransfer;
				if (!dt) return false;
				const title = dt.getData(NOTE_TITLE_DND_MIME);
				if (!title) return false; // not our drag — let PM handle images/slices
				event.preventDefault();
				const dropTop = (event as DragEvent).clientY;
				const found = view.posAtCoords({
					left: (event as DragEvent).clientX,
					top: dropTop
				});
				const tr =
					found && !isDeadSpaceDrop(view, found.pos, dropTop)
						? buildTitleInsertTr(view.state, found.pos, title)
						: buildFallbackInsertTr(view.state, title);
				view.dispatch(tr.scrollIntoView());
				view.focus();
				return true;
			}
		}
	});
}
