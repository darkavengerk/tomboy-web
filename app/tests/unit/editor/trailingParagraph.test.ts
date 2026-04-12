import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { TomboyMonospace } from '$lib/editor/extensions/TomboyMonospace.js';
import { TomboySize } from '$lib/editor/extensions/TomboySize.js';
import {
	deserializeContent,
	serializeContent
} from '$lib/core/noteContentArchiver.js';

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(initialDoc: ReturnType<typeof deserializeContent>): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false }),
			TomboySize,
			TomboyMonospace,
			TomboyInternalLink.configure({
				getTitles: () => [],
				getCurrentGuid: () => null
			}),
			TomboyUrlLink
		],
		content: initialDoc
	});
	currentEditor = editor;
	return editor;
}

describe('trailing paragraph after a list (regression)', () => {
	const xmlEndingInList =
		'<note-content version="0.1">Title\nbody\n' +
		'<list><list-item dir="ltr">a\n</list-item>' +
		'<list-item dir="ltr">b</list-item></list></note-content>';

	it('serializing an editor that was loaded with a list-terminated doc is idempotent', () => {
		const doc = deserializeContent(xmlEndingInList);
		const editor = makeEditor(doc);
		const out = serializeContent(editor.getJSON());
		expect(out).toBe(xmlEndingInList);
	});

	it('after space + backspace inside the last list item, the doc round-trips to the original XML', () => {
		const doc = deserializeContent(xmlEndingInList);
		const editor = makeEditor(doc);

		// Find the position at the end of the "b" text — i.e. inside the last
		// list item's paragraph, not after the list.
		const pmDoc = editor.state.doc;
		let bPos = -1;
		pmDoc.descendants((node, pos) => {
			if (node.isText && node.text === 'b') {
				bPos = pos + (node.text?.length ?? 0);
			}
		});
		expect(bPos).toBeGreaterThan(0);

		editor.commands.setTextSelection(bPos);
		editor.commands.insertContent(' ');
		const curEnd = editor.state.selection.to;
		editor.commands.deleteRange({ from: curEnd - 1, to: curEnd });

		const out = serializeContent(editor.getJSON());
		expect(out).toBe(xmlEndingInList);
	});

	it('serializer strips a trailing empty paragraph that sits after a list', () => {
		// Simulate the PM state where the editor has inserted a cursor-
		// positioning empty paragraph after a list. The serializer should
		// treat that terminal empty paragraph as a no-op so round-trip is
		// preserved.
		const docJson = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							content: [
								{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }
							]
						}
					]
				},
				{ type: 'paragraph' } // ← PM-inserted terminal empty para
			]
		};
		const xml = serializeContent(docJson);
		expect(xml).toBe(
			'<note-content version="0.1">Title\n<list><list-item dir="ltr">x</list-item></list></note-content>'
		);
	});
});
