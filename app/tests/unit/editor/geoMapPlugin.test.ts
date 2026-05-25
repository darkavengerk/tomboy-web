import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import {
	findGeoUrlRanges,
	createGeoMapPlugin,
	geoMapPluginKey,
	handleGeoAtomicKey,
	type AtomicKey
} from '$lib/editor/geoMap/geoMapPlugin.js';

vi.mock('$lib/editor/geoMap/renderGeoMap.js', () => ({
	mountGeoMap: vi.fn().mockResolvedValue({ destroy: vi.fn() })
}));

let currentEditor: Editor | null = null;

function makeEditor(content: string = '<p></p>'): Editor {
	const editor = new Editor({
		extensions: [
			Document,
			Paragraph,
			Text,
			TomboyUrlLink,
			Extension.create({
				name: 'tomboyGeoMap',
				addProseMirrorPlugins() {
					return [createGeoMapPlugin()];
				}
			})
		],
		content
	});
	currentEditor = editor;
	return editor;
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

describe('findGeoUrlRanges', () => {
	it('detects a plain-text geo URL', () => {
		const editor = makeEditor('<p>geo:37.5,127.5</p>');
		const ranges = findGeoUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].href).toBe('geo:37.5,127.5');
		expect(ranges[0].coords).toEqual({ lat: 37.5, lon: 127.5 });
	});

	it('detects geo URL inside a tomboyUrlLink mark', () => {
		const editor = makeEditor(
			'<p><a class="tomboy-link-url" href="geo:37.5,127.5">geo:37.5,127.5</a></p>'
		);
		const ranges = findGeoUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].href).toBe('geo:37.5,127.5');
	});

	it('detects geo URL embedded in a sentence', () => {
		const editor = makeEditor('<p>here is geo:37.5,127.5 see map</p>');
		const ranges = findGeoUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].href).toBe('geo:37.5,127.5');
	});

	it('skips invalid coordinates (range out)', () => {
		const editor = makeEditor('<p>geo:91,200</p>');
		expect(findGeoUrlRanges(editor.state.doc)).toHaveLength(0);
	});

	it('skips malformed geo: strings', () => {
		const editor = makeEditor('<p>geo:abc,def</p>');
		expect(findGeoUrlRanges(editor.state.doc)).toHaveLength(0);
	});

	it('finds multiple geo URLs in one note', () => {
		const editor = makeEditor(
			'<p>geo:37.5,127.5</p><p>geo:35.0,135.0</p>'
		);
		const ranges = findGeoUrlRanges(editor.state.doc);
		expect(ranges).toHaveLength(2);
		expect(ranges[0].href).toBe('geo:37.5,127.5');
		expect(ranges[1].href).toBe('geo:35.0,135.0');
	});
});

describe('plugin state — decorations', () => {
	it('emits one widget decoration per geo URL', () => {
		const editor = makeEditor('<p>geo:37.5,127.5</p>');
		const state = geoMapPluginKey.getState(editor.state);
		expect(state).toBeDefined();
		expect(state!.ranges).toHaveLength(1);
		const decoCount = state!.decorations.find().length;
		expect(decoCount).toBe(1);
	});

	it('updates decorations when doc changes', () => {
		const editor = makeEditor('<p>hello</p>');
		expect(geoMapPluginKey.getState(editor.state)!.ranges).toHaveLength(0);
		editor.commands.setContent('<p>geo:37.5,127.5</p>');
		expect(geoMapPluginKey.getState(editor.state)!.ranges).toHaveLength(1);
	});
});

describe('handleGeoAtomicKey', () => {
	function rangeFor(editor: Editor) {
		return geoMapPluginKey.getState(editor.state)!.ranges;
	}

	it('Backspace at URL end deletes the whole URL', () => {
		const editor = makeEditor('<p>geo:37.5,127.5</p>');
		const ranges = rangeFor(editor);
		const endPos = ranges[0].to;
		editor.commands.focus(endPos);
		const tr = handleGeoAtomicKey(editor.state, ranges, 'Backspace');
		expect(tr).not.toBeNull();
		editor.view.dispatch(tr!);
		expect(editor.state.doc.textContent).toBe('');
	});

	it('Delete at URL start deletes the whole URL', () => {
		const editor = makeEditor('<p>geo:37.5,127.5</p>');
		const ranges = rangeFor(editor);
		editor.commands.focus(ranges[0].from);
		const tr = handleGeoAtomicKey(editor.state, ranges, 'Delete');
		expect(tr).not.toBeNull();
		editor.view.dispatch(tr!);
		expect(editor.state.doc.textContent).toBe('');
	});

	it('ArrowLeft at URL end jumps cursor to URL start', () => {
		const editor = makeEditor('<p>geo:37.5,127.5</p>');
		const ranges = rangeFor(editor);
		editor.commands.focus(ranges[0].to);
		const tr = handleGeoAtomicKey(editor.state, ranges, 'ArrowLeft');
		expect(tr).not.toBeNull();
		editor.view.dispatch(tr!);
		expect(editor.state.selection.from).toBe(ranges[0].from);
	});

	it('ArrowRight at URL start jumps cursor to URL end', () => {
		const editor = makeEditor('<p>geo:37.5,127.5</p>');
		const ranges = rangeFor(editor);
		editor.commands.focus(ranges[0].from);
		const tr = handleGeoAtomicKey(editor.state, ranges, 'ArrowRight');
		expect(tr).not.toBeNull();
		editor.view.dispatch(tr!);
		expect(editor.state.selection.from).toBe(ranges[0].to);
	});

	it('returns null when cursor is mid-URL', () => {
		const editor = makeEditor('<p>geo:37.5,127.5</p>');
		const ranges = rangeFor(editor);
		const midPos = ranges[0].from + 3;
		editor.commands.focus(midPos);
		const tr = handleGeoAtomicKey(editor.state, ranges, 'Backspace' as AtomicKey);
		expect(tr).toBeNull();
	});

	it('returns null when no ranges', () => {
		const editor = makeEditor('<p>plain text</p>');
		const tr = handleGeoAtomicKey(editor.state, [], 'Backspace');
		expect(tr).toBeNull();
	});
});
