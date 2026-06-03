import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { isEqualsParagraph, findEqBoundary } from '$lib/editor/eqHeader/eqHeaderPlugin.js';

/** Build a doc from an array of paragraph text lines and return its PMNode. */
function docFromLines(lines: string[]) {
	const editor = new Editor({
		extensions: [StarterKit],
		content: {
			type: 'doc',
			content: lines.map((t) => ({
				type: 'paragraph',
				content: t === '' ? [] : [{ type: 'text', text: t }]
			}))
		}
	});
	const doc = editor.state.doc;
	editor.destroy();
	return doc;
}

describe('isEqualsParagraph', () => {
	it('matches 3+ equals', () => {
		expect(isEqualsParagraph(docFromLines(['==='])!.child(0))).toBe(true);
		expect(isEqualsParagraph(docFromLines(['====='])!.child(0))).toBe(true);
		expect(isEqualsParagraph(docFromLines(['  ===  '])!.child(0))).toBe(true);
	});
	it('rejects non-markers', () => {
		expect(isEqualsParagraph(docFromLines(['=='])!.child(0))).toBe(false);
		expect(isEqualsParagraph(docFromLines(['= ='])!.child(0))).toBe(false);
		expect(isEqualsParagraph(docFromLines(['=x='])!.child(0))).toBe(false);
		expect(isEqualsParagraph(docFromLines(['text'])!.child(0))).toBe(false);
	});
});

describe('findEqBoundary', () => {
	it('returns null when no marker', () => {
		expect(findEqBoundary(docFromLines(['제목', 'body', 'more']))).toBe(null);
	});
	it('ignores index 0 (title)', () => {
		expect(findEqBoundary(docFromLines(['===', 'body']))).toBe(null);
	});
	it('returns first marker index >= 1', () => {
		expect(findEqBoundary(docFromLines(['제목', '===', 'body']))).toBe(1);
		expect(findEqBoundary(docFromLines(['제목', '부제', '===', 'body']))).toBe(2);
	});
	it('returns topmost when multiple', () => {
		expect(findEqBoundary(docFromLines(['제목', '===', 'a', '===', 'b']))).toBe(1);
	});
});
