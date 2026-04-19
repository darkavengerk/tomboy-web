import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { TomboyMonospace } from '$lib/editor/extensions/TomboyMonospace.js';
import {
	serializeContent,
	deserializeContent
} from '$lib/core/noteContentArchiver.js';
import type { TitleEntry } from '$lib/editor/autoLink/findTitleMatches.js';

function entry(title: string, guid = `guid-${title}`): TitleEntry {
	return { title, guid };
}

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(titles: TitleEntry[]): Editor {
	const editor = new Editor({
		extensions: [
			Document,
			Paragraph,
			Text,
			TomboyMonospace,
			TomboyUrlLink,
			TomboyInternalLink.configure({
				getTitles: () => titles,
				getCurrentGuid: () => null
			})
		],
		content: '<p></p>'
	});
	currentEditor = editor;
	return editor;
}

describe('autoLink roundtrip via noteContentArchiver', () => {
	it('serialises an auto-linked doc into <link:internal> and round-trips back', () => {
		const editor = makeEditor([entry('Foo Bar')]);
		editor.commands.insertContent('see Foo Bar today');

		const xml = serializeContent(editor.getJSON());
		expect(xml).toContain('<link:internal>Foo Bar</link:internal>');

		// Load it back into a fresh editor and confirm the mark survives.
		const reloaded = makeEditor([entry('Foo Bar')]);
		const doc = deserializeContent(xml);
		reloaded.commands.setContent(doc);

		let found = false;
		reloaded.state.doc.descendants((node) => {
			if (!node.isText) return;
			for (const m of node.marks) {
				if (m.type.name === 'tomboyInternalLink' && m.attrs.target === 'Foo Bar') {
					found = true;
				}
			}
		});
		expect(found).toBe(true);
	});

	it('is idempotent — running the plugin on already-linked content adds nothing', () => {
		const editor = makeEditor([entry('Foo')]);
		editor.commands.insertContent('hi Foo there');
		const first = editor.getJSON();
		// Dispatch an empty transaction.
		editor.view.dispatch(editor.state.tr);
		const second = editor.getJSON();
		expect(second).toEqual(first);
	});
});
