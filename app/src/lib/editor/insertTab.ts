/**
 * insertTab.ts — `insertTabAtCursor(editor)`
 *
 * Inserts a literal tab character at the cursor. Used by Ctrl-less Tab in
 * the editor's `handleKeyDown` so notes behave like a regular text editor
 * (browser default would yank focus to the next focusable element).
 *
 * No-op inside lists: returns `false` so the caller can defer to TipTap's
 * default `sinkListItem` Tab keymap (and the surgical Alt+Arrow variant
 * in `listItemDepth.ts`).
 */

import type { Editor } from '@tiptap/core';

import { isInList } from './listItemDepth.js';

export function insertTabAtCursor(editor: Editor): boolean {
	if (isInList(editor)) return false;
	editor.chain().focus().insertContent('\t').run();
	return true;
}
