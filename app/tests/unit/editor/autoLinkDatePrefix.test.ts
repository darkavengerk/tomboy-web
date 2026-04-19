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
import {
	findTitleMatches,
	type TitleEntry
} from '$lib/editor/autoLink/findTitleMatches.js';
import { autoLinkPluginKey } from '$lib/editor/autoLink/autoLinkPlugin.js';

function entry(title: string, guid = `guid-${title}`): TitleEntry {
	return { title, guid };
}

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(titles: TitleEntry[], currentGuid: string | null = null): Editor {
	const editor = new Editor({
		extensions: [
			Document,
			Paragraph,
			Text,
			TomboyMonospace,
			TomboyUrlLink,
			TomboyInternalLink.configure({
				getTitles: () => titles,
				getCurrentGuid: () => currentGuid
			})
		],
		content: '<p></p>'
	});
	currentEditor = editor;
	return editor;
}

function hasInternalLink(editor: Editor, text: string): boolean {
	let found = false;
	editor.state.doc.descendants((node) => {
		if (!node.isText) return;
		const nodeText = node.text ?? '';
		if (!nodeText.includes(text)) return;
		for (const m of node.marks) {
			if (m.type.name === 'tomboyInternalLink') {
				found = true;
			}
		}
	});
	return found;
}

describe('auto-link — date-prefixed titles (regression)', () => {
	const title = '2025-11-24 11:04 객관적으로 비판하기';

	it('findTitleMatches finds the title in text that is exactly the title', () => {
		const m = findTitleMatches(title, [entry(title)]);
		expect(m).toHaveLength(1);
		expect(m[0].target).toBe(title);
	});

	it('findTitleMatches finds the title as a standalone line', () => {
		const text = `${title}\n다음 줄`;
		const m = findTitleMatches(text, [entry(title)]);
		expect(m).toHaveLength(1);
	});

	it('preserves a pre-existing internal-link mark when content is loaded from XML', async () => {
		// Serialize a note whose body is "<link:internal>…</link:internal>".
		const xml = `<note-content version="0.1"><link:internal>${title}</link:internal></note-content>`;
		const doc = deserializeContent(xml);

		// Load into an editor whose title list DOES contain the target.
		// The target note is OTHER (not the current one), so it must remain linked.
		const editor = makeEditor([entry(title, 'target-guid')], 'current-guid');
		editor.commands.setContent(doc);

		// Give the plugin a chance to run its refresh-cycle.
		editor.view.dispatch(
			editor.state.tr.setMeta(autoLinkPluginKey, { refresh: true })
		);

		expect(hasInternalLink(editor, title)).toBe(true);
	});

	it('does NOT strip the link when the target title is present in the title list', () => {
		const editor = makeEditor([entry(title, 'target-guid')], 'current-guid');
		// Directly insert text pre-wrapped in a tomboyInternalLink mark.
		editor.commands.insertContent({
			type: 'text',
			text: title,
			marks: [{ type: 'tomboyInternalLink', attrs: { target: title } }]
		});

		expect(hasInternalLink(editor, title)).toBe(true);

		// Force a refresh scan — the mark should still be present.
		editor.view.dispatch(
			editor.state.tr.setMeta(autoLinkPluginKey, { refresh: true })
		);
		expect(hasInternalLink(editor, title)).toBe(true);
	});

	it('round-trips through XML serializer without losing the link', () => {
		const xml = `<note-content version="0.1"><link:internal>${title}</link:internal></note-content>`;
		const doc = deserializeContent(xml);

		const editor = makeEditor([entry(title, 'target-guid')], 'current-guid');
		editor.commands.setContent(doc);

		const out = serializeContent(editor.getJSON());
		expect(out).toContain(`<link:internal>${title}</link:internal>`);
	});

	it('preserves link after typing outside the link (scenario: real editing)', () => {
		// Start with content that already contains a link sandwiched between
		// other paragraphs — regression guard against run-building merging
		// text from different textblocks.
		const xml = `<note-content version="0.1">noteTitle\n\n<link:internal>${title}</link:internal>\n\nafter</note-content>`;
		const doc = deserializeContent(xml);

		const editor = makeEditor([entry(title, 'target-guid')], 'current-guid');
		editor.commands.setContent(doc);
		expect(hasInternalLink(editor, title)).toBe(true);

		// Type a character at the end of the doc. This should NOT strip the link.
		const endPos = editor.state.doc.content.size;
		editor.commands.setTextSelection({ from: endPos - 1, to: endPos - 1 });
		editor.commands.insertContent('x');

		expect(hasInternalLink(editor, title)).toBe(true);
	});

	it('preserves link when the title list loads AFTER content is set', async () => {
		// Simulate the real flow: editor is constructed, content set with an
		// existing link, but the title list is empty at first (still loading).
		const titles: TitleEntry[] = [];
		const editor = new Editor({
			extensions: [
				Document,
				Paragraph,
				Text,
				TomboyMonospace,
				TomboyUrlLink,
				TomboyInternalLink.configure({
					getTitles: () => titles,
					getCurrentGuid: () => 'current-guid'
				})
			],
			content: '<p></p>'
		});
		currentEditor = editor;

		// Content loaded with existing link while titles are empty.
		const xml = `<note-content version="0.1"><link:internal>${title}</link:internal></note-content>`;
		editor.commands.setContent(deserializeContent(xml));
		expect(hasInternalLink(editor, title)).toBe(true);

		// NOW the title provider finishes loading and pushes titles + fires refresh.
		titles.push(entry(title, 'target-guid'));
		editor.view.dispatch(
			editor.state.tr.setMeta(autoLinkPluginKey, { refresh: true })
		);

		expect(hasInternalLink(editor, title)).toBe(true);
	});

	it('REGRESSION: preserves link when content loaded BEFORE titles and user then types', () => {
		// Even trickier: setContent while titles empty, then user types → docChanged
		// fires appendTransaction with titles still empty at that moment.
		const titles: TitleEntry[] = [];
		const editor = new Editor({
			extensions: [
				Document,
				Paragraph,
				Text,
				TomboyMonospace,
				TomboyUrlLink,
				TomboyInternalLink.configure({
					getTitles: () => titles,
					getCurrentGuid: () => 'current-guid'
				})
			],
			content: '<p></p>'
		});
		currentEditor = editor;

		const xml = `<note-content version="0.1"><link:internal>${title}</link:internal> after</note-content>`;
		editor.commands.setContent(deserializeContent(xml));
		expect(hasInternalLink(editor, title)).toBe(true);

		// User types a character at end of doc (title list still empty).
		const endPos = editor.state.doc.content.size;
		editor.commands.setTextSelection({ from: endPos - 1, to: endPos - 1 });
		editor.commands.insertContent('x');

		// This is the real bug scenario — if the plugin scans the link range with
		// empty titles, `findTitleMatches` returns [] and the link is stripped.
		expect(hasInternalLink(editor, title)).toBe(true);
	});
});
