import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { findMarkdownTableRegions } from '$lib/editor/tableBlock/findTableRegions.js';
import { appendRowOp, appendColOp, deleteColOp } from '$lib/editor/tableBlock/tableOps.js';

function makeEditor(lines: string[]): Editor {
	return new Editor({
		extensions: [Document, Paragraph, Text],
		content: {
			type: 'doc',
			content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
		}
	});
}
function lines(ed: Editor): string[] {
	const out: string[] = [];
	ed.state.doc.forEach((n) => out.push(n.textContent));
	return out;
}

describe('tableOps — markdown', () => {
	it('appendRow adds an empty row after the last data row', () => {
		const ed = makeEditor(['| a | b |', '| --- | --- |', '| 1 | 2 |']);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		ed.view.dispatch(appendRowOp(ed.state, region));
		expect(lines(ed)).toEqual(['| a | b |', '| --- | --- |', '| 1 | 2 |', '|  |  |']);
	});

	it('appendCol adds a cell to every data row AND the separator', () => {
		const ed = makeEditor(['| a | b |', '| --- | --- |', '| 1 | 2 |']);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		ed.view.dispatch(appendColOp(ed.state, region));
		const out = lines(ed);
		// every header/data row gains an empty cell (3 internal+outer pipes → 4 pipes)
		expect(out[0].split('|').length).toBe(5); // "| a | b |  |" → ["","a","b","",""]
		expect(out[1]).toContain('---');
		expect(out[1].match(/---/g)!.length).toBe(3);
	});

	it('deleteCol removes the column from data rows and the separator', () => {
		const ed = makeEditor(['| a | b | c |', '| --- | --- | --- |', '| 1 | 2 | 3 |']);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		ed.view.dispatch(deleteColOp(ed.state, region, 1)!);
		const after = findMarkdownTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([
			['a', 'c'],
			['1', '3']
		]);
		expect(after.align).toHaveLength(2);
	});
});
