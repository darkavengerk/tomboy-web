import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createFindPlugin, findPluginKey, type FindState } from '$lib/editor/find/findPlugin.js';

let currentEditor: Editor | null = null;

function makeEditor(content: string): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit,
			Extension.create({
				name: 'tomboyFindTest',
				addProseMirrorPlugins() {
					return [createFindPlugin()];
				}
			})
		],
		content
	});
	currentEditor = editor;
	return editor;
}

function findState(editor: Editor): FindState {
	const fs = findPluginKey.getState(editor.state);
	if (!fs) throw new Error('find plugin state missing');
	return fs;
}

function setQuery(editor: Editor, query: string): void {
	editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { query }));
}
function nav(editor: Editor, dir: 'next' | 'prev'): void {
	editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { nav: dir }));
}
function close(editor: Editor): void {
	editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { close: true }));
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

describe('findPlugin — query meta', () => {
	it('resolves matches and activates the first', () => {
		const editor = makeEditor('<p>apple banana apple</p>');
		setQuery(editor, 'apple');
		const fs = findState(editor);
		expect(fs.query).toBe('apple');
		expect(fs.matches.length).toBe(2);
		expect(fs.activeIndex).toBe(0);
	});

	it('a query with no matches yields activeIndex -1', () => {
		const editor = makeEditor('<p>apple</p>');
		setQuery(editor, 'zzz');
		const fs = findState(editor);
		expect(fs.matches.length).toBe(0);
		expect(fs.activeIndex).toBe(-1);
	});
});

describe('findPlugin — nav meta', () => {
	it('next advances and wraps around', () => {
		const editor = makeEditor('<p>a a a</p>');
		setQuery(editor, 'a');
		expect(findState(editor).activeIndex).toBe(0);
		nav(editor, 'next');
		expect(findState(editor).activeIndex).toBe(1);
		nav(editor, 'next');
		expect(findState(editor).activeIndex).toBe(2);
		nav(editor, 'next');
		expect(findState(editor).activeIndex).toBe(0);
	});

	it('prev retreats and wraps around', () => {
		const editor = makeEditor('<p>a a a</p>');
		setQuery(editor, 'a');
		nav(editor, 'prev');
		expect(findState(editor).activeIndex).toBe(2);
	});

	it('nav with no matches is a no-op', () => {
		const editor = makeEditor('<p>apple</p>');
		setQuery(editor, 'zzz');
		nav(editor, 'next');
		expect(findState(editor).activeIndex).toBe(-1);
	});
});

describe('findPlugin — close meta', () => {
	it('clears the query and matches', () => {
		const editor = makeEditor('<p>apple apple</p>');
		setQuery(editor, 'apple');
		expect(findState(editor).matches.length).toBe(2);
		close(editor);
		const fs = findState(editor);
		expect(fs.query).toBe('');
		expect(fs.matches).toEqual([]);
		expect(fs.activeIndex).toBe(-1);
	});
});

describe('findPlugin — re-scan on doc change', () => {
	it('editing under an active search re-scans and clamps activeIndex', () => {
		const editor = makeEditor('<p>apple apple apple</p>');
		setQuery(editor, 'apple');
		nav(editor, 'next');
		nav(editor, 'next');
		expect(findState(editor).activeIndex).toBe(2);
		editor.commands.setContent('<p>apple</p>');
		const fs = findState(editor);
		expect(fs.matches.length).toBe(1);
		expect(fs.activeIndex).toBe(0);
	});

	it('a doc change with no active query leaves state untouched', () => {
		const editor = makeEditor('<p>apple</p>');
		editor.commands.setContent('<p>banana</p>');
		const fs = findState(editor);
		expect(fs.query).toBe('');
		expect(fs.matches).toEqual([]);
	});
});
