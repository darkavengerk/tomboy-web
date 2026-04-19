/**
 * Ctrl+Enter: split the current line "as if Enter had been pressed at the
 * end of the line". Preserves the text the user was on; drops a fresh empty
 * block (paragraph or list item) directly below, with the caret on it.
 *
 * Implementation is a two-step chain: move the selection to the end of the
 * current block, then run the appropriate split command — `splitListItem`
 * inside a list (matches TipTap's default Enter-in-list behavior) or plain
 * `splitBlock` everywhere else.
 */

import type { Editor } from '@tiptap/core';

export function ctrlEnterSplit(editor: Editor): boolean {
	const $from = editor.state.selection.$from;
	const endPos = $from.end($from.depth);

	let inListItem = false;
	for (let d = $from.depth; d >= 0; d--) {
		if ($from.node(d).type.name === 'listItem') {
			inListItem = true;
			break;
		}
	}

	const chain = editor.chain().focus().setTextSelection(endPos);
	return inListItem
		? chain.splitListItem('listItem').run()
		: chain.splitBlock().run();
}
