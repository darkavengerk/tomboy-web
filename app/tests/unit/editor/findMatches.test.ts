import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { Node as PMNode } from '@tiptap/pm/model';
import { findMatches } from '$lib/editor/find/findMatches.js';

let currentEditor: Editor | null = null;

/** Build a ProseMirror doc from content HTML via a throwaway editor. */
function docOf(content: string): PMNode {
	currentEditor?.destroy();
	const editor = new Editor({ extensions: [StarterKit], content });
	currentEditor = editor;
	return editor.state.doc;
}

/** Map each match back to the verbatim (original-case) document text. */
function textsOf(doc: PMNode, query: string): string[] {
	return findMatches(doc, query).map((m) => doc.textBetween(m.from, m.to));
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

describe('findMatches', () => {
	it('empty query → no matches', () => {
		expect(findMatches(docOf('<p>hello</p>'), '')).toEqual([]);
	});

	it('finds a single match and reports its text', () => {
		expect(textsOf(docOf('<p>hello world</p>'), 'world')).toEqual(['world']);
	});

	it('finds multiple matches in one block', () => {
		expect(textsOf(docOf('<p>na na na</p>'), 'na')).toEqual(['na', 'na', 'na']);
	});

	it('is case-insensitive and maps back to original case', () => {
		const doc = docOf('<p>Apple APPLE apple</p>');
		expect(findMatches(doc, 'apple').length).toBe(3);
		expect(textsOf(doc, 'apple')).toEqual(['Apple', 'APPLE', 'apple']);
	});

	it('matches a word split across a mark boundary', () => {
		const doc = docOf('<p>hel<strong>lo</strong> there</p>');
		expect(textsOf(doc, 'hello')).toEqual(['hello']);
	});

	it('does not match across a paragraph boundary', () => {
		expect(findMatches(docOf('<p>foo</p><p>bar</p>'), 'foobar')).toEqual([]);
	});

	it('does not match across a hard break', () => {
		const doc = docOf('<p>foo<br>bar</p>');
		expect(findMatches(doc, 'foobar')).toEqual([]);
		expect(textsOf(doc, 'foo')).toEqual(['foo']);
		expect(textsOf(doc, 'bar')).toEqual(['bar']);
	});

	it('scans headings, not just paragraphs', () => {
		expect(textsOf(docOf('<h1>Heading text</h1><p>body</p>'), 'heading')).toEqual([
			'Heading'
		]);
	});

	it('returns matches in ascending document order', () => {
		const matches = findMatches(docOf('<p>x</p><p>x</p><p>x</p>'), 'x');
		expect(matches.length).toBe(3);
		expect(matches[0].from).toBeLessThan(matches[1].from);
		expect(matches[1].from).toBeLessThan(matches[2].from);
	});

	it('finds matches inside list items', () => {
		const doc = docOf('<ul><li><p>target one</p></li><li><p>target two</p></li></ul>');
		expect(textsOf(doc, 'target')).toEqual(['target', 'target']);
	});
});
