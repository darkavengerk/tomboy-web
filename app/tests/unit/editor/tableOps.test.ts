import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { findTableRegions } from '$lib/editor/tableBlock/findTableRegions.js';
import {
	deleteRowOp,
	deleteColOp,
	appendRowOp,
	appendColOp
} from '$lib/editor/tableBlock/tableOps.js';

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

describe('deleteRowOp', () => {
	it('deletes a middle body row, leaving header and other body rows intact', () => {
		const ed = makeEditor(['```csv', 'a, b', 'c, d', 'e, f', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const tr = deleteRowOp(ed.state, region, 1); // delete "c, d"
		expect(tr).not.toBeNull();
		ed.view.dispatch(tr!);
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([
			['a', 'b'],
			['e', 'f']
		]);
	});

	it('deletes the first body row (the header)', () => {
		const ed = makeEditor(['```csv', 'a, b', 'c, d', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const tr = deleteRowOp(ed.state, region, 0);
		ed.view.dispatch(tr!);
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([['c', 'd']]);
	});

	it('deletes the last body row', () => {
		const ed = makeEditor(['```csv', 'a, b', 'c, d', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const tr = deleteRowOp(ed.state, region, 1);
		ed.view.dispatch(tr!);
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([['a', 'b']]);
	});

	it('returns null for an out-of-bounds row', () => {
		const ed = makeEditor(['```csv', 'a, b', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		expect(deleteRowOp(ed.state, region, 9)).toBeNull();
		expect(deleteRowOp(ed.state, region, -1)).toBeNull();
	});
});

describe('deleteColOp', () => {
	it('deletes a middle column from every row', () => {
		const ed = makeEditor(['```csv', 'a, b, c', 'd, e, f', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const tr = deleteColOp(ed.state, region, 1); // delete "b"/"e"
		ed.view.dispatch(tr!);
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([
			['a', 'c'],
			['d', 'f']
		]);
	});

	it('deletes the first column', () => {
		const ed = makeEditor(['```csv', 'a, b, c', 'd, e, f', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const tr = deleteColOp(ed.state, region, 0);
		ed.view.dispatch(tr!);
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([
			['b', 'c'],
			['e', 'f']
		]);
	});

	it('deletes the last column', () => {
		const ed = makeEditor(['```csv', 'a, b, c', 'd, e, f', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const tr = deleteColOp(ed.state, region, 2);
		ed.view.dispatch(tr!);
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([
			['a', 'b'],
			['d', 'e']
		]);
	});

	it('deletes from a TSV table preserving the tab separator structure', () => {
		const ed = makeEditor(['```tsv', 'a\tb\tc', 'd\te\tf', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const tr = deleteColOp(ed.state, region, 1);
		ed.view.dispatch(tr!);
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([
			['a', 'c'],
			['d', 'f']
		]);
	});

	it('returns null for an out-of-bounds column', () => {
		const ed = makeEditor(['```csv', 'a, b', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		expect(deleteColOp(ed.state, region, 9)).toBeNull();
		expect(deleteColOp(ed.state, region, -1)).toBeNull();
	});
});

describe('appendRowOp', () => {
	it('adds an empty row matching the column count of the existing rows', () => {
		const ed = makeEditor(['```csv', 'a, b, c', 'd, e, f', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const tr = appendRowOp(ed.state, region);
		ed.view.dispatch(tr!);
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toHaveLength(3);
		expect(after.rows[2]).toEqual(['', '', '']);
	});

	it('uses the right separator for TSV (tabs)', () => {
		const ed = makeEditor(['```tsv', 'a\tb', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const tr = appendRowOp(ed.state, region);
		ed.view.dispatch(tr!);
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toHaveLength(2);
		expect(after.rows[1]).toEqual(['', '']);
	});
});

describe('appendColOp', () => {
	it('adds an empty cell to every row', () => {
		const ed = makeEditor(['```csv', 'a, b', 'c, d', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const tr = appendColOp(ed.state, region);
		ed.view.dispatch(tr!);
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([
			['a', 'b', ''],
			['c', 'd', '']
		]);
	});

	it('uses the right separator for TSV', () => {
		const ed = makeEditor(['```tsv', 'a\tb', '```']);
		const region = findTableRegions(ed.state.doc)[0];
		const tr = appendColOp(ed.state, region);
		ed.view.dispatch(tr!);
		const after = findTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([['a', 'b', '']]);
	});
});
