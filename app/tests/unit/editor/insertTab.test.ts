import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { insertTabAtCursor } from '$lib/editor/insertTab.js';
import type { JSONContent } from '@tiptap/core';

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(doc: JSONContent): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem
		],
		content: doc
	});
	currentEditor = editor;
	return editor;
}

function placeCursorAt(editor: Editor, needle: string, offset = needle.length): void {
	let pos = -1;
	editor.state.doc.descendants((node, p) => {
		if (pos !== -1) return false;
		if (node.isText && node.text?.includes(needle)) {
			pos = p + needle.indexOf(needle) + offset;
			return false;
		}
		return true;
	});
	if (pos < 0) throw new Error(`needle not found: ${needle}`);
	editor.commands.setTextSelection(pos);
}

function plainText(editor: Editor): string {
	return editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n');
}

describe('insertTabAtCursor', () => {
	it('inserts a literal tab character at the cursor in a paragraph', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ab' }] }]
		});
		placeCursorAt(editor, 'ab', 1); // between 'a' and 'b'
		expect(insertTabAtCursor(editor)).toBe(true);
		expect(plainText(editor)).toBe('a\tb');
	});

	it('inserts at end of paragraph', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }]
		});
		placeCursorAt(editor, 'hello'); // end
		expect(insertTabAtCursor(editor)).toBe(true);
		expect(plainText(editor)).toBe('hello\t');
	});

	it('returns false (no-op) when the cursor is inside a list item', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							content: [
								{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }
							]
						}
					]
				}
			]
		});
		placeCursorAt(editor, 'item', 2); // between 'it' and 'em'
		const before = plainText(editor);
		expect(insertTabAtCursor(editor)).toBe(false);
		expect(plainText(editor)).toBe(before);
	});

	it('inserts in the title block (first paragraph)', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }
			]
		});
		placeCursorAt(editor, 'Title');
		expect(insertTabAtCursor(editor)).toBe(true);
		expect(plainText(editor).split('\n')[0]).toBe('Title\t');
	});

	it('replaces non-empty selection with a tab', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: 'abcdef' }] }]
		});
		// Select "bcd"
		editor.commands.setTextSelection({ from: 2, to: 5 });
		expect(insertTabAtCursor(editor)).toBe(true);
		expect(plainText(editor)).toBe('a\tef');
	});
});
