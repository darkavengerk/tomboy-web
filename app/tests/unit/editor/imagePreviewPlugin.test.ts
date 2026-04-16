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
import { Extension } from '@tiptap/core';

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

describe('findImageUrlRanges — plain-text URL scanning', () => {
	// Plain-text URLs (e.g. freshly pasted, before any auto-link processing)
	// must still produce an image preview. Web-port lacks a URL auto-link
	// plugin so bare URLs never get wrapped in `tomboyUrlLink` — the preview
	// must not rely on that mark.
	it('detects a bare pasted image URL in plain text', () => {
		const editor = makeEditor('<p>https://example.com/cat.png</p>');
		const ranges = findImageUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].href).toBe('https://example.com/cat.png');
	});

	it('detects the real-world Korean CDN URL the user reported', () => {
		const url =
			'https://pimg.mk.co.kr/meet/neds/2017/06/image_readtop_2017_425767_14984355952932772.jpg';
		const editor = makeEditor(`<p>${url}</p>`);
		const ranges = findImageUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].href).toBe(url);
	});

	it('detects a URL embedded inside a sentence', () => {
		const editor = makeEditor(
			'<p>see https://example.com/cat.png here</p>'
		);
		const ranges = findImageUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].href).toBe('https://example.com/cat.png');
	});

	it('trims trailing punctuation from a URL (.,;:!? and brackets)', () => {
		const editor = makeEditor(
			'<p>See https://example.com/cat.png, then continue.</p>'
		);
		const ranges = findImageUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].href).toBe('https://example.com/cat.png');
	});

	it('returns no ranges for a non-image URL in plain text', () => {
		const editor = makeEditor('<p>https://example.com/page.html</p>');
		expect(findImageUrlRanges(editor.state.doc)).toEqual([]);
	});

	it('detects multiple image URLs in one paragraph', () => {
		const editor = makeEditor(
			'<p>https://a.com/a.png and https://b.com/b.jpg side by side</p>'
		);
		const ranges = findImageUrlRanges(editor.state.doc);
		expect(ranges.map((r) => r.href)).toEqual([
			'https://a.com/a.png',
			'https://b.com/b.jpg'
		]);
	});

	it('returns no ranges for plain text without URLs', () => {
		const editor = makeEditor('<p>just some text</p>');
		expect(findImageUrlRanges(editor.state.doc)).toEqual([]);
	});
});

describe('findImageUrlRanges — marked URL scanning', () => {
	// When the URL IS already in a `tomboyUrlLink` mark (e.g. a note loaded
	// from Tomboy XML with `<link:url>...</link:url>`), the URL is the visible
	// text of the mark so the same plain-text scan finds it. No marks are
	// required by the preview logic, but this path must keep working for
	// round-tripped notes.
	it('detects a marked image url link', () => {
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
	});

	it('ignores a marked non-image link', () => {
		const editor = makeEditor();
		editor.commands.insertContent({
			type: 'text',
			text: 'https://example.com/page.html',
			marks: [
				{ type: 'tomboyUrlLink', attrs: { href: 'https://example.com/page.html' } }
			]
		});
		expect(findImageUrlRanges(editor.state.doc)).toEqual([]);
	});

	it('handles a mix of marked and plain-text image URLs', () => {
		const editor = makeEditor();
		editor.commands.insertContent([
			{
				type: 'text',
				text: 'https://a.com/a.png',
				marks: [{ type: 'tomboyUrlLink', attrs: { href: 'https://a.com/a.png' } }]
			},
			{ type: 'text', text: ' and plain https://b.com/b.jpg end' }
		]);
		const ranges = findImageUrlRanges(editor.state.doc);
		expect(ranges.map((r) => r.href)).toEqual([
			'https://a.com/a.png',
			'https://b.com/b.jpg'
		]);
	});

	it('emits one decoration per occurrence when same URL appears twice', () => {
		const url = 'https://example.com/cat.png';
		const editor = makeEditor(`<p>${url} and again ${url}</p>`);
		const ranges = findImageUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(2);
		expect(ranges[0].href).toBe(url);
		expect(ranges[1].href).toBe(url);
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

	it('emits one decoration for a plain-text image URL', () => {
		const editor = makeEditor('<p>https://example.com/cat.png</p>');
		expect(decoCount(editor)).toBe(1);
	});

	it('emits one decoration for a marked image URL', () => {
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

		editor.commands.insertContent('https://a.com/a.png');
		expect(decoCount(editor)).toBe(1);

		editor.commands.insertContent(' + https://b.com/b.jpg');
		expect(decoCount(editor)).toBe(2);
	});

	it('renders an <img> element with the href as src', () => {
		const editor = makeEditor('<p>https://example.com/cat.png</p>');

		const set = imagePreviewPluginKey.getState(editor.state);
		const decos = set!.find();
		expect(decos).toHaveLength(1);
		// @ts-expect-error — toDOM() is the internal widget factory
		const dom = (decos[0].type as { toDOM: (view: unknown) => HTMLElement }).toDOM({
			root: document
		});
		expect(dom.tagName).toBe('IMG');
		expect((dom as HTMLImageElement).src).toBe('https://example.com/cat.png');
	});
});
