import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { parseDataNote } from '../../../src/lib/chart/parseDataNote';

/** Helper: build a doc of plain paragraphs from text lines. */
function doc(lines: string[]): JSONContent {
	return {
		type: 'doc',
		content: lines.map((text) => ({
			type: 'paragraph',
			content: text === '' ? [] : [{ type: 'text', text }]
		}))
	};
}

describe('parseDataNote', () => {
	it('parses a single csv block, ignoring placeholder line', () => {
		const d = doc(['DATA::예제', '', '```csv', '월,매출', '1월,100', '2월,200', '```']);
		const tables = parseDataNote(d);
		expect(tables).toHaveLength(1);
		expect(tables[0]).toEqual({
			format: 'csv',
			columns: ['월', '매출'],
			rows: [
				['1월', '100'],
				['2월', '200']
			]
		});
	});

	it('parses tsv with tab separators', () => {
		const d = doc(['DATA::t', '', '```tsv', 'a\tb', 'x\t1', '```']);
		const tables = parseDataNote(d);
		expect(tables[0].format).toBe('tsv');
		expect(tables[0].columns).toEqual(['a', 'b']);
		expect(tables[0].rows).toEqual([['x', '1']]);
	});

	it('returns multiple tables for multiple blocks', () => {
		const d = doc(['DATA::m', '', '```csv', 'a', '1', '```', '중간 텍스트', '```csv', 'b', '2', '```']);
		expect(parseDataNote(d)).toHaveLength(2);
	});

	it('skips an unclosed fence', () => {
		const d = doc(['```csv', 'a', '1']);
		expect(parseDataNote(d)).toEqual([]);
	});
});
