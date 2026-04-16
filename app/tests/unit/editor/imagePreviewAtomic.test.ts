import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { DecorationSet } from '@tiptap/pm/view';
import { TextSelection } from '@tiptap/pm/state';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import {
	findImageUrlRanges,
	createImagePreviewPlugin,
	imagePreviewPluginKey,
	handleAtomicKey
} from '$lib/editor/imagePreview/imagePreviewPlugin.js';

let currentEditor: Editor | null = null;

function makeEditor(content: unknown = '<p></p>'): Editor {
	const editor = new Editor({
		extensions: [
			Document,
			Paragraph,
			Text,
			TomboyUrlLink,
			Extension.create({
				name: 'tomboyImagePreview',
				addProseMirrorPlugins() {
					return [createImagePreviewPlugin()];
				}
			})
		],
		content: content as string
	});
	currentEditor = editor;
	return editor;
}

beforeEach(() => {
	currentEditor = null;
});

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

describe('findImageUrlRanges — returns from/to', () => {
	it('reports both from and to for plain-text URLs', () => {
		const editor = makeEditor('<p>https://example.com/cat.png</p>');
		const url = 'https://example.com/cat.png';
		const ranges = findImageUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(1);
		// inside a paragraph: pos of first text char is 1
		expect(ranges[0].from).toBe(1);
		expect(ranges[0].to).toBe(1 + url.length);
		expect(ranges[0].href).toBe(url);
	});
});

describe('imagePreviewPlugin — URL is hidden + image shown', () => {
	function getDecorations(editor: Editor) {
		return imagePreviewPluginKey.getState(editor.state)!.decorations;
	}
	function findInlineHidden(editor: Editor) {
		return getDecorations(editor)
			.find()
			.filter(
				(d) =>
					// PM inline decorations expose `attrs.class`; widget
					// decorations don't. Use presence of the hidden class as the
					// distinguishing signal.
					(d as unknown as { type: { attrs?: { class?: string } } }).type?.attrs?.class ===
					'tomboy-image-url-hidden'
			);
	}
	function findWidgets(editor: Editor) {
		return getDecorations(editor)
			.find()
			.filter(
				(d) =>
					(d as unknown as { type: { toDOM?: unknown } }).type?.toDOM !== undefined &&
					(d as unknown as { type: { attrs?: { class?: string } } }).type?.attrs?.class !==
						'tomboy-image-url-hidden'
			);
	}

	it('emits an inline hidden decoration covering the URL', () => {
		const editor = makeEditor('<p>https://example.com/cat.png</p>');
		const hidden = findInlineHidden(editor);
		expect(hidden).toHaveLength(1);
		// Range should cover the URL text (1..1+len)
		expect(hidden[0].from).toBe(1);
		expect(hidden[0].to).toBe(1 + 'https://example.com/cat.png'.length);
	});

	it('emits a widget image decoration at the URL end position', () => {
		const editor = makeEditor('<p>https://example.com/cat.png</p>');
		const widgets = findWidgets(editor);
		expect(widgets).toHaveLength(1);
		expect(widgets[0].from).toBe(1 + 'https://example.com/cat.png'.length);
	});

	it('emits NO decorations for non-image URLs', () => {
		const editor = makeEditor('<p>https://example.com/page.html</p>');
		const set = getDecorations(editor);
		expect(set).toBeInstanceOf(DecorationSet);
		expect(set.find()).toHaveLength(0);
	});
});

describe('handleAtomicKey — delete', () => {
	const url = 'https://example.com/cat.png';

	it('Backspace at the URL end position deletes the whole URL', () => {
		const editor = makeEditor(`<p>before ${url}</p>`);
		const ranges = findImageUrlRanges(editor.state.doc);
		// Put cursor at `to` (right after the URL)
		editor.commands.setTextSelection(ranges[0].to);
		const tr = handleAtomicKey(editor.state, ranges, 'Backspace');
		expect(tr).not.toBeNull();
		editor.view.dispatch(tr!);
		expect(editor.state.doc.textContent).toBe('before ');
	});

	it('Delete at the URL start position deletes the whole URL', () => {
		const editor = makeEditor(`<p>${url} after</p>`);
		const ranges = findImageUrlRanges(editor.state.doc);
		editor.commands.setTextSelection(ranges[0].from);
		const tr = handleAtomicKey(editor.state, ranges, 'Delete');
		expect(tr).not.toBeNull();
		editor.view.dispatch(tr!);
		expect(editor.state.doc.textContent).toBe(' after');
	});

	it('Backspace away from the URL end does nothing special', () => {
		const editor = makeEditor(`<p>before ${url} after</p>`);
		const ranges = findImageUrlRanges(editor.state.doc);
		// Cursor well before the URL.
		editor.commands.setTextSelection(3);
		const tr = handleAtomicKey(editor.state, ranges, 'Backspace');
		expect(tr).toBeNull();
	});

	it('does nothing when the selection is not collapsed', () => {
		const editor = makeEditor(`<p>${url}</p>`);
		const ranges = findImageUrlRanges(editor.state.doc);
		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, ranges[0].from, ranges[0].to)
			)
		);
		const tr = handleAtomicKey(editor.state, ranges, 'Backspace');
		expect(tr).toBeNull();
	});
});

describe('handleAtomicKey — arrow key skip', () => {
	const url = 'https://example.com/cat.png';

	it('ArrowLeft at the URL end jumps to the URL start', () => {
		const editor = makeEditor(`<p>before ${url} after</p>`);
		const ranges = findImageUrlRanges(editor.state.doc);
		editor.commands.setTextSelection(ranges[0].to);
		const tr = handleAtomicKey(editor.state, ranges, 'ArrowLeft');
		expect(tr).not.toBeNull();
		editor.view.dispatch(tr!);
		expect(editor.state.selection.from).toBe(ranges[0].from);
	});

	it('ArrowRight at the URL start jumps to the URL end', () => {
		const editor = makeEditor(`<p>before ${url} after</p>`);
		const ranges = findImageUrlRanges(editor.state.doc);
		editor.commands.setTextSelection(ranges[0].from);
		const tr = handleAtomicKey(editor.state, ranges, 'ArrowRight');
		expect(tr).not.toBeNull();
		editor.view.dispatch(tr!);
		expect(editor.state.selection.from).toBe(ranges[0].to);
	});

	it('ArrowLeft elsewhere is unhandled', () => {
		const editor = makeEditor(`<p>before ${url} after</p>`);
		const ranges = findImageUrlRanges(editor.state.doc);
		editor.commands.setTextSelection(3);
		const tr = handleAtomicKey(editor.state, ranges, 'ArrowLeft');
		expect(tr).toBeNull();
	});
});
