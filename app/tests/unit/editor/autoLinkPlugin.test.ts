import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
	return { titleLower: title.toLocaleLowerCase(), original: title, guid };
}

interface MakeEditorOpts {
	titles: TitleEntry[];
	currentGuid?: string | null;
	content?: string;
}

let currentEditor: Editor | null = null;

function makeEditor(opts: MakeEditorOpts): Editor {
	const titles: TitleEntry[] = [...opts.titles];
	let currentGuid: string | null = opts.currentGuid ?? null;

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
		content: opts.content ?? '<p></p>'
	});
	currentEditor = editor;
	return editor;
}

/** Collect all `tomboyInternalLink` mark ranges as {from, to, target} tuples. */
function collectLinks(editor: Editor): { from: number; to: number; target: string }[] {
	const out: { from: number; to: number; target: string }[] = [];
	editor.state.doc.descendants((node, pos) => {
		if (!node.isText) return;
		for (const mark of node.marks) {
			if (mark.type.name === 'tomboyInternalLink') {
				const from = pos;
				const to = pos + node.nodeSize;
				// Merge adjacent ranges with same target
				const last = out[out.length - 1];
				if (last && last.to === from && last.target === (mark.attrs.target as string)) {
					last.to = to;
				} else {
					out.push({ from, to, target: mark.attrs.target as string });
				}
			}
		}
	});
	return out;
}

function typeAtEnd(editor: Editor, str: string): void {
	const end = editor.state.doc.content.size;
	editor.commands.insertContentAt(end - 1, str);
}

beforeEach(() => {
	currentEditor = null;
});

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

describe('autoLinkPlugin — typing auto-links', () => {
	it('applies the mark when text matches an existing title', () => {
		const editor = makeEditor({ titles: [entry('Foo Bar')] });
		typeAtEnd(editor, 'I saw Foo Bar today.');

		const links = collectLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0].target).toBe('Foo Bar');
	});

	it('does not link non-matching text', () => {
		const editor = makeEditor({ titles: [entry('Foo Bar')] });
		typeAtEnd(editor, 'Foobar is different.');
		expect(collectLinks(editor)).toHaveLength(0);
	});

	it('removes the mark when edits break the match', () => {
		const editor = makeEditor({ titles: [entry('Foo Bar')] });
		typeAtEnd(editor, 'see Foo Bar!');
		expect(collectLinks(editor)).toHaveLength(1);

		// Break the title by inserting a character in the middle of "Bar".
		const textOnly = editor.state.doc.textContent;
		const idxOfBar = textOnly.indexOf('Bar');
		// +1 because prosemirror doc positions are 1-based inside the top node.
		editor.commands.setTextSelection({ from: idxOfBar + 2, to: idxOfBar + 2 });
		editor.commands.insertContent('X');

		expect(editor.state.doc.textContent).toContain('BXar');
		expect(collectLinks(editor)).toHaveLength(0);
	});
});

describe('autoLinkPlugin — longest match', () => {
	it('prefers the longer title when both match', () => {
		const editor = makeEditor({ titles: [entry('Foo'), entry('Foo Bar')] });
		typeAtEnd(editor, 'I like Foo Bar today.');

		const links = collectLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0].target).toBe('Foo Bar');
	});

	it('falls back to the shorter title when the longer one does not match', () => {
		const editor = makeEditor({ titles: [entry('Foo'), entry('Foo Bar')] });
		typeAtEnd(editor, 'just Foo here');

		const links = collectLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0].target).toBe('Foo');
	});
});

describe('autoLinkPlugin — exclusion', () => {
	it('does not auto-link to the current note itself', () => {
		const editor = makeEditor({
			titles: [entry('Self', 'self-guid'), entry('Other', 'other-guid')],
			currentGuid: 'self-guid'
		});
		typeAtEnd(editor, 'Self and Other.');

		const links = collectLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0].target).toBe('Other');
	});
});

describe('autoLinkPlugin — inside other marks', () => {
	it('does not auto-link inside a tomboyUrlLink mark', () => {
		const editor = makeEditor({ titles: [entry('Foo Bar')] });
		// Insert "Foo Bar" already wrapped in a url link mark.
		editor.commands.insertContent({
			type: 'text',
			text: 'Foo Bar',
			marks: [{ type: 'tomboyUrlLink', attrs: { href: 'https://x' } }]
		});

		const links = collectLinks(editor);
		expect(links).toHaveLength(0);
	});

	it('does not auto-link inside a tomboyMonospace mark', () => {
		const editor = makeEditor({ titles: [entry('Foo Bar')] });
		editor.commands.insertContent({
			type: 'text',
			text: 'Foo Bar',
			marks: [{ type: 'tomboyMonospace' }]
		});

		const links = collectLinks(editor);
		expect(links).toHaveLength(0);
	});
});

describe('autoLinkPlugin — regex-special characters', () => {
	it('handles titles with regex-special characters', () => {
		const editor = makeEditor({ titles: [entry('C++')] });
		typeAtEnd(editor, 'learn C++ today');

		const links = collectLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0].target).toBe('C++');
	});
});

describe('autoLinkPlugin — idempotence / loop safety', () => {
	it('does not re-apply marks in a loop after stabilising', () => {
		const editor = makeEditor({ titles: [entry('Foo')] });
		typeAtEnd(editor, 'Foo here');
		const before = editor.getJSON();
		// Dispatch an empty transaction; the plugin should not produce any further updates.
		editor.view.dispatch(editor.state.tr);
		const after = editor.getJSON();
		expect(after).toEqual(before);
	});
});

describe('autoLinkPlugin — CJK text', () => {
	it('links a Korean title surrounded by spaces', () => {
		const editor = makeEditor({ titles: [entry('서울')] });
		typeAtEnd(editor, '나는 서울 에 간다');

		const links = collectLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0].target).toBe('서울');
	});

	it('does not link a Korean title inside a larger Korean word', () => {
		const editor = makeEditor({ titles: [entry('서울')] });
		typeAtEnd(editor, '서울시에 간다');

		expect(collectLinks(editor)).toHaveLength(0);
	});
});

describe('autoLinkPlugin — refresh meta', () => {
	it('re-scans when titles change and the refresh meta is dispatched', async () => {
		// Start with no titles, type text, expect no link.
		const titles: TitleEntry[] = [];
		let currentGuid: string | null = null;
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

		editor.commands.insertContent('hi Foo here');
		expect(collectLinks(editor)).toHaveLength(0);

		// Now add "Foo" to the title list and dispatch a refresh.
		titles.push(entry('Foo'));
		const { autoLinkPluginKey } = await import(
			'$lib/editor/autoLink/autoLinkPlugin.js'
		);
		editor.view.dispatch(
			editor.state.tr.setMeta(autoLinkPluginKey, { refresh: true })
		);

		const links = collectLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0].target).toBe('Foo');
	});
});

describe('autoLinkPlugin — paste', () => {
	it('auto-links pasted text that contains a matching title', () => {
		const editor = makeEditor({ titles: [entry('Foo Bar')] });
		// Simulate paste by inserting multi-word content at once.
		editor.commands.insertContent('see Foo Bar in action');

		const links = collectLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0].target).toBe('Foo Bar');
	});
});

describe('autoLinkPlugin — deferred mode', () => {
	it('does NOT auto-link on ordinary doc changes when deferred:true', () => {
		const titles: TitleEntry[] = [entry('Foo Bar')];
		const editor = new Editor({
			extensions: [
				Document,
				Paragraph,
				Text,
				TomboyMonospace,
				TomboyUrlLink,
				TomboyInternalLink.configure({
					getTitles: () => titles,
					getCurrentGuid: () => null,
					deferred: true
				})
			],
			content: '<p></p>'
		});
		currentEditor = editor;

		editor.commands.insertContent('I saw Foo Bar today.');
		// In deferred mode the plugin stays out of the hot path.
		expect(collectLinks(editor)).toHaveLength(0);
	});

	it('applies marks in deferred mode when {refresh:true} is dispatched', () => {
		const titles: TitleEntry[] = [entry('Foo Bar')];
		const editor = new Editor({
			extensions: [
				Document,
				Paragraph,
				Text,
				TomboyMonospace,
				TomboyUrlLink,
				TomboyInternalLink.configure({
					getTitles: () => titles,
					getCurrentGuid: () => null,
					deferred: true
				})
			],
			content: '<p></p>'
		});
		currentEditor = editor;

		editor.commands.insertContent('I saw Foo Bar today.');
		expect(collectLinks(editor)).toHaveLength(0);

		editor.view.dispatch(
			editor.state.tr.setMeta(autoLinkPluginKey, { refresh: true })
		);

		const links = collectLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0].target).toBe('Foo Bar');
	});
});
