import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { TomboyMonospace } from '$lib/editor/extensions/TomboyMonospace.js';
import type { TitleEntry } from '$lib/editor/autoLink/findTitleMatches.js';
import { autoLinkPluginKey } from '$lib/editor/autoLink/autoLinkPlugin.js';

function entry(title: string, guid = `guid-${title}`): TitleEntry {
	return { title, guid };
}

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(titles: TitleEntry[], currentGuid: string | null): Editor {
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

function collectLinks(editor: Editor): { text: string; target: string }[] {
	const out: { text: string; target: string }[] = [];
	editor.state.doc.descendants((node) => {
		if (!node.isText) return;
		for (const m of node.marks) {
			if (m.type.name === 'tomboyInternalLink') {
				out.push({ text: node.text ?? '', target: m.attrs.target as string });
			}
		}
	});
	return out;
}

describe('autoLinkPlugin — title-line protection (regression)', () => {
	it('does NOT auto-link the current note\'s own title when a duplicate-titled note exists', () => {
		// Scenario: user has TWO notes titled "File-Box::start-here" (duplicate).
		// When they open one, the plugin sees the other as a candidate.
		// Excluding only by guid wouldn't help — the other entry survives.
		// The first paragraph (title line) of the current note must never be
		// auto-linked to a duplicate-named note.
		const currentGuid = 'this-note';
		const duplicateGuid = 'other-note';
		const titles = [
			entry('File-Box::start-here', currentGuid),
			entry('File-Box::start-here', duplicateGuid)
		];

		const editor = makeEditor(titles, currentGuid);
		editor.commands.setContent(
			'<p>File-Box::start-here</p><p></p><p>body text here</p>'
		);

		// Force the plugin to scan (refresh meta simulates titles loading late).
		editor.view.dispatch(
			editor.state.tr.setMeta(autoLinkPluginKey, { refresh: true })
		);

		const links = collectLinks(editor);
		// No link should have been added to the title line.
		expect(links.filter((l) => l.text === 'File-Box::start-here')).toHaveLength(0);
	});

	it('still allows auto-linking the SAME text in a later paragraph (not the title line)', () => {
		const currentGuid = 'this-note';
		const otherGuid = 'linked-note';
		const titles = [
			entry('Apple', currentGuid),
			entry('Apple', otherGuid) // duplicate title, different note
		];

		const editor = makeEditor(titles, currentGuid);
		editor.commands.setContent('<p>Apple</p><p>I like Apple a lot</p>');

		editor.view.dispatch(
			editor.state.tr.setMeta(autoLinkPluginKey, { refresh: true })
		);

		const links = collectLinks(editor);
		// Title line "Apple" (first paragraph) must NOT be linked.
		// Body "Apple" (in "I like Apple a lot") is fine to link.
		const bodyLinks = links.filter((l) => l.target === 'Apple');
		expect(bodyLinks.length).toBeGreaterThanOrEqual(1);

		// Check specifically: the FIRST paragraph's "Apple" text should have no link.
		let titleLineHasLink = false;
		let blockIdx = 0;
		editor.state.doc.forEach((block) => {
			if (blockIdx === 0) {
				block.descendants((node) => {
					if (!node.isText) return;
					if (node.marks.some((m) => m.type.name === 'tomboyInternalLink')) {
						titleLineHasLink = true;
					}
				});
			}
			blockIdx++;
		});
		expect(titleLineHasLink).toBe(false);
	});

	it('does not break typing auto-link when there is only one paragraph', () => {
		// Guard: when doc has only a single paragraph, treating it as "title line"
		// and suppressing all auto-links would break the basic feature.
		const editor = makeEditor([entry('Foo Bar', 'other-guid')], 'current-guid');
		editor.commands.insertContent('I saw Foo Bar today.');

		const links = collectLinks(editor);
		// Single-paragraph docs typically represent work-in-progress before a
		// user has split content — the plugin should still auto-link matches
		// within them.
		expect(links.some((l) => l.target === 'Foo Bar')).toBe(true);
	});
});
