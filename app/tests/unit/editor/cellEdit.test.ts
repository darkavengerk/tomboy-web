import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { findTableRegions } from '$lib/editor/tableBlock/findTableRegions.js';
import {
	findCellEditRange,
	commitCellEdit
} from '$lib/editor/tableBlock/cellEdit.js';
import type { JSONContent } from '@tiptap/core';

let currentEditor: Editor | null = null;

function makeEditor(lines: string[]): Editor {
	const editor = new Editor({
		extensions: [Document, Paragraph, Text],
		content: {
			type: 'doc',
			content: lines.map((line) =>
				line.length === 0
					? { type: 'paragraph' }
					: { type: 'paragraph', content: [{ type: 'text', text: line }] }
			)
		}
	});
	currentEditor = editor;
	return editor;
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function rangeText(editor: Editor, range: { from: number; to: number }): string {
	return editor.state.doc.textBetween(range.from, range.to, '');
}

describe('findCellEditRange — CSV (trims edge whitespace)', () => {
	it('returns the range of the first cell, trimmed', () => {
		const ed = makeEditor(['```csv', 'alpha, beta', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const r = findCellEditRange(ed.state.doc, region, 0, 0);
		expect(r).not.toBeNull();
		expect(rangeText(ed, r!)).toBe('alpha');
	});

	it('returns the range of a middle cell, trimmed (excludes the leading space)', () => {
		const ed = makeEditor(['```csv', 'alpha, beta, gamma', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const r = findCellEditRange(ed.state.doc, region, 0, 1);
		expect(rangeText(ed, r!)).toBe('beta');
	});

	it('returns the range of the last cell, trimmed', () => {
		const ed = makeEditor(['```csv', 'alpha, beta', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const r = findCellEditRange(ed.state.doc, region, 0, 1);
		expect(rangeText(ed, r!)).toBe('beta');
	});

	it('uses the right body row for multi-row tables', () => {
		const ed = makeEditor(['```csv', 'a, b', 'c, d', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const r = findCellEditRange(ed.state.doc, region, 1, 0);
		expect(rangeText(ed, r!)).toBe('c');
	});

	it('handles a fully-whitespace cell as a zero-width range at its slot', () => {
		// "a, , b" → middle cell is empty (whitespace only). Range is a
		// caret position the user can type into, not a 0-length nowhere.
		const ed = makeEditor(['```csv', 'a, , b', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const r = findCellEditRange(ed.state.doc, region, 0, 1);
		expect(r).not.toBeNull();
		expect(r!.from).toBe(r!.to);
		expect(rangeText(ed, r!)).toBe('');
	});

	it('returns null for an out-of-bounds row', () => {
		const ed = makeEditor(['```csv', 'a, b', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		expect(findCellEditRange(ed.state.doc, region, 5, 0)).toBeNull();
	});

	it('returns null for an out-of-bounds column', () => {
		const ed = makeEditor(['```csv', 'a, b', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		expect(findCellEditRange(ed.state.doc, region, 0, 9)).toBeNull();
	});
});

describe('findCellEditRange — TSV (preserves whitespace)', () => {
	it('returns the full chunk between tabs (no trim)', () => {
		const ed = makeEditor(['```tsv', ' a \t b ', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const r0 = findCellEditRange(ed.state.doc, region, 0, 0);
		const r1 = findCellEditRange(ed.state.doc, region, 0, 1);
		expect(rangeText(ed, r0!)).toBe(' a ');
		expect(rangeText(ed, r1!)).toBe(' b ');
	});

	it('handles single-column TSV (whole text is one cell)', () => {
		const ed = makeEditor(['```tsv', 'whole row', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const r = findCellEditRange(ed.state.doc, region, 0, 0);
		expect(rangeText(ed, r!)).toBe('whole row');
	});
});

describe('commitCellEdit', () => {
	function applyEdit(editor: Editor, rowIdx: number, colIdx: number, newText: string) {
		const region = findTableRegions(editor.state.doc)[0];
		const tr = commitCellEdit(editor.state, region, rowIdx, colIdx, newText);
		if (tr) editor.view.dispatch(tr);
	}

	it('replaces a CSV cell while keeping the surrounding text + separators', () => {
		const ed = makeEditor(['```csv', 'alpha, beta, gamma', '```']);
		applyEdit(ed, 0, 1, 'BETA');
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([['alpha', 'BETA', 'gamma']]);
	});

	it('replaces a TSV cell preserving tab separators', () => {
		const ed = makeEditor(['```tsv', 'a\tb\tc', '```']);
		applyEdit(ed, 0, 1, 'B');
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([['a', 'B', 'c']]);
	});

	it('clearing a CSV cell to empty leaves the separator structure intact', () => {
		const ed = makeEditor(['```csv', 'a, b, c', '```']);
		applyEdit(ed, 0, 1, '');
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([['a', '', 'c']]);
	});

	it('preserves marks on OTHER cells in the same row when editing one cell', async () => {
		const { default: Bold } = await import('@tiptap/extension-bold');
		// Build a doc programmatically with a bold mark on the third cell.
		const editor = new Editor({
			extensions: [Document, Paragraph, Text, Bold],
			content: {
				type: 'doc',
				content: [
					{ type: 'paragraph', content: [{ type: 'text', text: '```csv' }] },
					{
						type: 'paragraph',
						content: [
							{ type: 'text', text: 'alpha, beta, ' },
							{ type: 'text', text: 'GAMMA', marks: [{ type: 'bold' }] }
						]
					},
					{ type: 'paragraph', content: [{ type: 'text', text: '```' }] }
				]
			}
		});
		currentEditor = editor;

		const region = findTableRegions(editor.state.doc)[0];
		const tr = commitCellEdit(editor.state, region, 0, 1, 'BETA');
		editor.view.dispatch(tr!);

		// After the edit, the bold mark on "GAMMA" must still be there.
		const bodyPara = editor.state.doc.child(1);
		const inlines: JSONContent[] = (bodyPara.toJSON() as JSONContent).content ?? [];
		const gamma = inlines.find(
			(n) => n.type === 'text' && n.text === 'GAMMA'
		);
		expect(gamma).toBeDefined();
		expect(gamma!.marks?.[0]?.type).toBe('bold');
	});

	it('returns null when the row/col is out of range', () => {
		const ed = makeEditor(['```csv', 'a, b', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		expect(commitCellEdit(ed.state, region, 7, 0, 'x')).toBeNull();
		expect(commitCellEdit(ed.state, region, 0, 9, 'x')).toBeNull();
	});
});
