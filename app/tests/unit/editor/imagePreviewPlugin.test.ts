import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { DecorationSet } from '@tiptap/pm/view';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import {
	findImageUrlRanges,
	createImagePreviewPlugin,
	imagePreviewPluginKey
} from '$lib/editor/imagePreview/imagePreviewPlugin.js';

let currentEditor: Editor | null = null;

function makeEditor(content: unknown = '<p></p>'): Editor {
	const editor = new Editor({
		extensions: [
			Document,
			Paragraph,
			Text,
			TomboyUrlLink,
			createImagePreviewExt()
		],
		content: content as string
	});
	currentEditor = editor;
	return editor;
}

// TipTap-wrapper for the bare PM plugin so we can attach it to an Editor.
import { Extension } from '@tiptap/core';
function createImagePreviewExt() {
	return Extension.create({
		name: 'tomboyImagePreview',
		addProseMirrorPlugins() {
			return [createImagePreviewPlugin()];
		}
	});
}

beforeEach(() => {
	currentEditor = null;
});

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

describe('findImageUrlRanges — scanning', () => {
	it('returns no ranges for an empty doc', () => {
		const editor = makeEditor('<p></p>');
		expect(findImageUrlRanges(editor.state.doc)).toEqual([]);
	});

	it('returns no ranges when there are no url links', () => {
		const editor = makeEditor('<p>just some text</p>');
		expect(findImageUrlRanges(editor.state.doc)).toEqual([]);
	});

	it('returns no ranges for a non-image url link', () => {
		const editor = makeEditor();
		editor.commands.insertContent({
			type: 'text',
			text: 'https://example.com/page.html',
			marks: [{ type: 'tomboyUrlLink', attrs: { href: 'https://example.com/page.html' } }]
		});
		expect(findImageUrlRanges(editor.state.doc)).toEqual([]);
	});

	it('returns one range for a single image url link', () => {
		const editor = makeEditor();
		const url = 'https://example.com/cat.png';
		editor.commands.insertContent({
			type: 'text',
			text: url,
			marks: [{ type: 'tomboyUrlLink', attrs: { href: url } }]
		});

		const ranges = findImageUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].href).toBe(url);
		// Position should be right after the text (1 = paragraph open, + text length).
		expect(ranges[0].pos).toBe(1 + url.length);
	});

	it('returns one range per distinct image link when several exist', () => {
		const editor = makeEditor();
		editor.commands.insertContent([
			{
				type: 'text',
				text: 'https://a.com/a.png',
				marks: [{ type: 'tomboyUrlLink', attrs: { href: 'https://a.com/a.png' } }]
			},
			{ type: 'text', text: ' and ' },
			{
				type: 'text',
				text: 'https://b.com/b.jpg',
				marks: [{ type: 'tomboyUrlLink', attrs: { href: 'https://b.com/b.jpg' } }]
			}
		]);

		const ranges = findImageUrlRanges(editor.state.doc);
		expect(ranges.map((r) => r.href)).toEqual([
			'https://a.com/a.png',
			'https://b.com/b.jpg'
		]);
	});

	it('ignores non-image links mixed with image links', () => {
		const editor = makeEditor();
		editor.commands.insertContent([
			{
				type: 'text',
				text: 'https://example.com/page.html',
				marks: [
					{ type: 'tomboyUrlLink', attrs: { href: 'https://example.com/page.html' } }
				]
			},
			{ type: 'text', text: ' and ' },
			{
				type: 'text',
				text: 'https://example.com/pic.png',
				marks: [{ type: 'tomboyUrlLink', attrs: { href: 'https://example.com/pic.png' } }]
			}
		]);

		const ranges = findImageUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].href).toBe('https://example.com/pic.png');
	});

	it('merges adjacent text nodes sharing the same anchor instance', () => {
		// A URL marked run split by an inner mark (e.g. bold over part of it)
		// parses to two adjacent text nodes with the same tomboyUrlLink
		// mark (same instanceId). We want ONE image preview, not two.
		const editor = makeEditor();
		const href = 'https://example.com/cat.png';
		editor.commands.insertContent([
			{
				type: 'text',
				text: 'https://example.com',
				marks: [{ type: 'tomboyUrlLink', attrs: { href, instanceId: 'p0' } }]
			},
			{
				type: 'text',
				text: '/cat.png',
				marks: [{ type: 'tomboyUrlLink', attrs: { href, instanceId: 'p0' } }]
			}
		]);

		const ranges = findImageUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].href).toBe(href);
	});

	it('keeps separate ranges when two links have the same href but different instances', () => {
		const editor = makeEditor();
		const href = 'https://example.com/cat.png';
		editor.commands.insertContent([
			{
				type: 'text',
				text: href,
				marks: [{ type: 'tomboyUrlLink', attrs: { href, instanceId: 'p0' } }]
			},
			{ type: 'text', text: ' then again ' },
			{
				type: 'text',
				text: href,
				marks: [{ type: 'tomboyUrlLink', attrs: { href, instanceId: 'p1' } }]
			}
		]);

		const ranges = findImageUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(2);
		expect(ranges[0].href).toBe(href);
		expect(ranges[1].href).toBe(href);
	});
});

describe('imagePreviewPlugin — decoration set', () => {
	function decoCount(editor: Editor): number {
		const set = imagePreviewPluginKey.getState(editor.state);
		if (!set) return 0;
		return set.find().length;
	}

	it('produces a DecorationSet from initial doc state', () => {
		const editor = makeEditor();
		const set = imagePreviewPluginKey.getState(editor.state);
		expect(set).toBeInstanceOf(DecorationSet);
	});

	it('emits one decoration per image url link', () => {
		const editor = makeEditor();
		const url = 'https://example.com/cat.png';
		editor.commands.insertContent({
			type: 'text',
			text: url,
			marks: [{ type: 'tomboyUrlLink', attrs: { href: url } }]
		});
		expect(decoCount(editor)).toBe(1);
	});

	it('updates decorations when the doc changes', () => {
		const editor = makeEditor();
		expect(decoCount(editor)).toBe(0);

		editor.commands.insertContent({
			type: 'text',
			text: 'https://a.com/a.png',
			marks: [{ type: 'tomboyUrlLink', attrs: { href: 'https://a.com/a.png' } }]
		});
		expect(decoCount(editor)).toBe(1);

		editor.commands.insertContent([
			{ type: 'text', text: ' + ' },
			{
				type: 'text',
				text: 'https://b.com/b.jpg',
				marks: [{ type: 'tomboyUrlLink', attrs: { href: 'https://b.com/b.jpg' } }]
			}
		]);
		expect(decoCount(editor)).toBe(2);
	});

	it('renders an <img> element with the href as src', () => {
		const editor = makeEditor();
		const url = 'https://example.com/cat.png';
		editor.commands.insertContent({
			type: 'text',
			text: url,
			marks: [{ type: 'tomboyUrlLink', attrs: { href: url } }]
		});

		const set = imagePreviewPluginKey.getState(editor.state);
		const decos = set!.find();
		expect(decos).toHaveLength(1);
		// @ts-expect-error — toDOM() is the internal widget factory
		const dom = (decos[0].type as { toDOM: (view: unknown) => HTMLElement }).toDOM({
			root: document
		});
		expect(dom.tagName).toBe('IMG');
		expect((dom as HTMLImageElement).src).toBe(url);
	});
});
