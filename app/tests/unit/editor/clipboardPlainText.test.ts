import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import {
	handleClipboardCopy,
	handleClipboardCut
} from '$lib/editor/clipboardPlainText.js';
import type { JSONContent } from '@tiptap/core';

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(doc: JSONContent): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
			TomboyParagraph,
			TomboyListItem
		],
		content: doc,
		editorProps: {
			handleDOMEvents: {
				copy: handleClipboardCopy,
				cut: handleClipboardCut
			}
		}
	});
	currentEditor = editor;
	return editor;
}

/**
 * jsdom doesn't populate `event.clipboardData` on synthetic ClipboardEvents
 * so we stub a minimal DataTransfer-shaped object and attach it via
 * defineProperty. PM's handleDOMEvents reads the property exactly once when
 * its handler runs.
 */
function dispatchClipboardEvent(
	editor: Editor,
	type: 'copy' | 'cut'
): { text: string; html: string } {
	const data: Record<string, string> = {};
	const clipboardData = {
		setData(k: string, v: string) {
			data[k] = v;
		},
		getData(k: string) {
			return data[k] ?? '';
		},
		clearData() {
			for (const k of Object.keys(data)) delete data[k];
		}
	};
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'clipboardData', { value: clipboardData });
	editor.view.dom.dispatchEvent(event);
	return { text: data['text/plain'] ?? '', html: data['text/html'] ?? '' };
}

function docJson(...children: JSONContent[]): JSONContent {
	return { type: 'doc', content: children };
}
function p(text: string): JSONContent {
	return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}

describe('handleClipboardCopy', () => {
	it('copies multiple paragraphs as single-newline-joined plain text', () => {
		const editor = makeEditor(docJson(p('첫 줄'), p('두 번째 줄'), p('세 번째 줄')));
		editor.commands.selectAll();
		const { text } = dispatchClipboardEvent(editor, 'copy');
		expect(text).toBe('첫 줄\n두 번째 줄\n세 번째 줄');
	});

	it('does not emit double newlines between paragraphs (regression guard)', () => {
		const editor = makeEditor(docJson(p('a'), p('b')));
		editor.commands.selectAll();
		const { text } = dispatchClipboardEvent(editor, 'copy');
		expect(text).not.toContain('\n\n');
	});

	it('skips empty paragraphs but still keeps the surrounding newlines', () => {
		const editor = makeEditor(docJson(p('a'), p(''), p('b')));
		editor.commands.selectAll();
		const { text } = dispatchClipboardEvent(editor, 'copy');
		// Three blocks produce two newlines total — the middle empty paragraph
		// contributes an empty line, so the result is "a\n\nb". The guarantee
		// is "one newline per block separator", not "no blank lines ever".
		expect(text).toBe('a\n\nb');
	});

	it('copies a single paragraph verbatim', () => {
		const editor = makeEditor(docJson(p('안녕하세요')));
		editor.commands.selectAll();
		const { text } = dispatchClipboardEvent(editor, 'copy');
		expect(text).toBe('안녕하세요');
	});

	it('copies a partial selection within a paragraph', () => {
		const editor = makeEditor(docJson(p('hello world')));
		// Select "hello" (positions 1-6 inside the single paragraph).
		editor.commands.setTextSelection({ from: 1, to: 6 });
		const { text } = dispatchClipboardEvent(editor, 'copy');
		expect(text).toBe('hello');
	});

	it('copies a bullet list using "- " markers (one per line)', () => {
		const editor = makeEditor(
			docJson({
				type: 'bulletList',
				content: [
					{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
					{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }
				]
			})
		);
		editor.commands.selectAll();
		const { text } = dispatchClipboardEvent(editor, 'copy');
		expect(text).toBe('- one\n- two');
	});

	it('does NOT write text/html — only text/plain (the user asked for clean text copies)', () => {
		const editor = makeEditor(docJson(p('only text')));
		editor.commands.selectAll();
		const { text, html } = dispatchClipboardEvent(editor, 'copy');
		expect(text).toBe('only text');
		expect(html).toBe('');
	});

	it('does nothing when the selection is empty', () => {
		const editor = makeEditor(docJson(p('hello')));
		editor.commands.setTextSelection(1); // caret only
		const { text } = dispatchClipboardEvent(editor, 'copy');
		expect(text).toBe('');
	});
});

describe('handleClipboardCut', () => {
	it('writes the same clean plain text as copy', () => {
		const editor = makeEditor(docJson(p('a'), p('b')));
		editor.commands.selectAll();
		const { text } = dispatchClipboardEvent(editor, 'cut');
		expect(text).toBe('a\nb');
	});

	it('deletes the selected range from the doc', () => {
		const editor = makeEditor(docJson(p('first'), p('second'), p('third')));
		// Select "second" paragraph text.
		editor.commands.setTextSelection({ from: 8, to: 14 });
		dispatchClipboardEvent(editor, 'cut');
		const after = editor.getJSON();
		const text = (after.content ?? [])
			.flatMap((b) =>
				(b.content ?? []).flatMap((c) => {
					const node = c as { type?: string; text?: string };
					return node.type === 'text' ? [node.text ?? ''] : [];
				})
			)
			.join('|');
		expect(text).toBe('first|third');
	});

	it('does nothing when the selection is empty', () => {
		const editor = makeEditor(docJson(p('hello')));
		editor.commands.setTextSelection(1);
		const before = JSON.stringify(editor.getJSON());
		const { text } = dispatchClipboardEvent(editor, 'cut');
		expect(text).toBe('');
		expect(JSON.stringify(editor.getJSON())).toBe(before);
	});

	it('does NOT write text/html on cut', () => {
		const editor = makeEditor(docJson(p('x')));
		editor.commands.selectAll();
		const { html } = dispatchClipboardEvent(editor, 'cut');
		expect(html).toBe('');
	});
});
