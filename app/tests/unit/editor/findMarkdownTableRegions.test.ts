import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { findMarkdownTableRegions } from '$lib/editor/tableBlock/findTableRegions.js';

function makeEditor(lines: string[]): Editor {
	return new Editor({
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
}

describe('findMarkdownTableRegions', () => {
	it('returns nothing for plain text', () => {
		const ed = makeEditor(['hello', 'world']);
		expect(findMarkdownTableRegions(ed.state.doc)).toEqual([]);
	});

	it('detects a header + separator + data table', () => {
		const ed = makeEditor([
			'intro',
			'| 이름 | 값 |',
			'| --- | --- |',
			'| 1 | 가 |',
			'| 2 | 나 |',
			'after'
		]);
		const r = findMarkdownTableRegions(ed.state.doc);
		expect(r).toHaveLength(1);
		expect(r[0].format).toBe('markdown');
		expect(r[0].rows).toEqual([
			['이름', '값'],
			['1', '가'],
			['2', '나']
		]);
		expect(r[0].bodyParaRanges).toHaveLength(3);
		expect(r[0].separatorParaRange).toBeTruthy();
	});

	it('parses alignment from the separator', () => {
		const ed = makeEditor(['| a | b | c |', '| :--- | :--: | ---: |', '| 1 | 2 | 3 |']);
		const r = findMarkdownTableRegions(ed.state.doc);
		expect(r[0].align).toEqual(['left', 'center', 'right']);
	});

	it('detects a header-only table (no data rows)', () => {
		const ed = makeEditor(['| a | b |', '| --- | --- |']);
		const r = findMarkdownTableRegions(ed.state.doc);
		expect(r).toHaveLength(1);
		expect(r[0].rows).toEqual([['a', 'b']]);
		expect(r[0].bodyParaRanges).toHaveLength(1);
	});

	it('does NOT treat a bare --- line as a table (hrSplit, not a table)', () => {
		const ed = makeEditor(['heading', '---', 'body']);
		expect(findMarkdownTableRegions(ed.state.doc)).toEqual([]);
	});

	it('ignores pipe lines inside a csv fence', () => {
		const ed = makeEditor(['```csv', '| not | a | md table |', '| --- | --- | --- |', '```']);
		expect(findMarkdownTableRegions(ed.state.doc)).toEqual([]);
	});

	it('separates two consecutive tables split by a blank line', () => {
		const ed = makeEditor([
			'| a | b |',
			'| --- | --- |',
			'| 1 | 2 |',
			'',
			'| c | d |',
			'| --- | --- |',
			'| 3 | 4 |'
		]);
		expect(findMarkdownTableRegions(ed.state.doc)).toHaveLength(2);
	});
});
