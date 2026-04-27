import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { deleteCurrentLine } from '$lib/editor/deleteLine.js';
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

function placeCursorAt(editor: Editor, needle: string): void {
	let pos = -1;
	editor.state.doc.descendants((node, p) => {
		if (pos !== -1) return false;
		if (node.isText && node.text?.includes(needle)) {
			pos = p + (node.text.indexOf(needle) + 1);
			return false;
		}
		return true;
	});
	if (pos < 0) throw new Error(`needle not found: ${needle}`);
	editor.commands.setTextSelection(pos);
}

function p(text: string): JSONContent {
	return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}
function li(...children: JSONContent[]): JSONContent {
	return { type: 'listItem', content: children };
}
function ul(...items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}
function ol(...items: JSONContent[]): JSONContent {
	return { type: 'orderedList', content: items };
}
function doc(...blocks: JSONContent[]): JSONContent {
	return { type: 'doc', content: blocks };
}

/**
 * Render content as a flat list of `{ type, text }` for readable assertions.
 * Trailing empty paragraphs are dropped — TipTap's TrailingNode plugin
 * auto-appends one whenever the doc ends with a list, which is structural
 * noise that our assertions don't care about.
 */
function flat(json: JSONContent): Array<{ type: string; text: string }> {
	const out: Array<{ type: string; text: string }> = [];
	function visit(node: JSONContent, listType: string | null) {
		if (node.type === 'bulletList') {
			for (const c of node.content ?? []) visit(c, 'bullet');
			return;
		}
		if (node.type === 'orderedList') {
			for (const c of node.content ?? []) visit(c, 'ordered');
			return;
		}
		if (node.type === 'listItem') {
			const text = (node.content?.[0]?.content ?? [])
				.map((n) => (n.type === 'text' ? (n.text ?? '') : ''))
				.join('');
			out.push({ type: `li:${listType}`, text });
			for (const c of (node.content ?? []).slice(1)) visit(c, listType);
			return;
		}
		if (node.type === 'paragraph') {
			const text = (node.content ?? [])
				.map((n) => (n.type === 'text' ? (n.text ?? '') : ''))
				.join('');
			out.push({ type: 'p', text });
			return;
		}
		if (node.type === 'doc') {
			for (const c of node.content ?? []) visit(c, null);
		}
	}
	visit(json, null);
	while (out.length > 1 && out[out.length - 1].type === 'p' && out[out.length - 1].text === '') {
		out.pop();
	}
	return out;
}

describe('deleteCurrentLine — plain paragraphs', () => {
	it('deletes the cursor paragraph and keeps siblings', () => {
		const editor = makeEditor(doc(p('first'), p('second'), p('third')));
		placeCursorAt(editor, 'second');
		expect(deleteCurrentLine(editor)).toBe(true);
		expect(flat(editor.getJSON())).toEqual([
			{ type: 'p', text: 'first' },
			{ type: 'p', text: 'third' }
		]);
	});

	it('deletes the first paragraph', () => {
		const editor = makeEditor(doc(p('first'), p('second')));
		placeCursorAt(editor, 'first');
		deleteCurrentLine(editor);
		expect(flat(editor.getJSON())).toEqual([{ type: 'p', text: 'second' }]);
	});

	it('deletes the last paragraph', () => {
		const editor = makeEditor(doc(p('first'), p('second')));
		placeCursorAt(editor, 'second');
		deleteCurrentLine(editor);
		expect(flat(editor.getJSON())).toEqual([{ type: 'p', text: 'first' }]);
	});

	it('replaces the only paragraph with an empty paragraph', () => {
		const editor = makeEditor(doc(p('only')));
		placeCursorAt(editor, 'only');
		deleteCurrentLine(editor);
		expect(flat(editor.getJSON())).toEqual([{ type: 'p', text: '' }]);
	});
});

describe('deleteCurrentLine — list items', () => {
	it('deletes the targeted bullet item, keeping siblings', () => {
		const editor = makeEditor(
			doc(ul(li(p('one')), li(p('two')), li(p('three'))))
		);
		placeCursorAt(editor, 'two');
		deleteCurrentLine(editor);
		expect(flat(editor.getJSON())).toEqual([
			{ type: 'li:bullet', text: 'one' },
			{ type: 'li:bullet', text: 'three' }
		]);
	});

	it('removes the wrapping list when the only item is deleted', () => {
		const editor = makeEditor(doc(p('before'), ul(li(p('only'))), p('after')));
		placeCursorAt(editor, 'only');
		deleteCurrentLine(editor);
		expect(flat(editor.getJSON())).toEqual([
			{ type: 'p', text: 'before' },
			{ type: 'p', text: 'after' }
		]);
	});

	it('removes ordered lists too when the only item is deleted', () => {
		const editor = makeEditor(doc(p('before'), ol(li(p('only')))));
		placeCursorAt(editor, 'only');
		deleteCurrentLine(editor);
		expect(flat(editor.getJSON())).toEqual([{ type: 'p', text: 'before' }]);
	});

	it('deletes the inner item without touching the parent line', () => {
		const editor = makeEditor(
			doc(ul(li(p('parent'), ul(li(p('child-1')), li(p('child-2'))))))
		);
		placeCursorAt(editor, 'child-1');
		deleteCurrentLine(editor);
		expect(flat(editor.getJSON())).toEqual([
			{ type: 'li:bullet', text: 'parent' },
			{ type: 'li:bullet', text: 'child-2' }
		]);
	});

	it('removes the empty inner list when the only nested item is deleted', () => {
		const editor = makeEditor(
			doc(ul(li(p('parent'), ul(li(p('only-child'))))))
		);
		placeCursorAt(editor, 'only-child');
		deleteCurrentLine(editor);
		expect(flat(editor.getJSON())).toEqual([
			{ type: 'li:bullet', text: 'parent' }
		]);
	});

	it('deletes the parent listItem (with nested children) when cursor is on its first paragraph', () => {
		const editor = makeEditor(
			doc(
				ul(li(p('keep'))),
				ul(li(p('parent'), ul(li(p('nested')))))
			)
		);
		placeCursorAt(editor, 'parent');
		deleteCurrentLine(editor);
		expect(flat(editor.getJSON())).toEqual([
			{ type: 'li:bullet', text: 'keep' }
		]);
	});

	it('replaces the doc with an empty paragraph when the only block is a single-item list', () => {
		const editor = makeEditor(doc(ul(li(p('only')))));
		placeCursorAt(editor, 'only');
		deleteCurrentLine(editor);
		expect(flat(editor.getJSON())).toEqual([{ type: 'p', text: '' }]);
	});
});
