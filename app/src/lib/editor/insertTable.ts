/**
 * Insert an empty 2×2 markdown table at the cursor. "2×2" = a header row plus
 * one data row (the separator row is structural). The native markdown table
 * detector renders it immediately; the user fills cells via double-click.
 *
 * Bound to Alt+T in TomboyEditor.
 */
import type { Editor } from '@tiptap/core';

const TABLE_LINES = ['|  |  |', '| --- | --- |', '|  |  |'];

export function insertTable(editor: Editor): boolean {
	const nodes = TABLE_LINES.map((line) => ({
		type: 'paragraph',
		content: [{ type: 'text', text: line }]
	}));
	return editor.chain().focus().insertContent(nodes).run();
}
