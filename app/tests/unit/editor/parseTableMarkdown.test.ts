import { describe, it, expect } from 'vitest';
import {
	isSeparatorRow,
	parseAlignments,
	stripOuterPipeInlines,
	markdownRowLayout,
	cellCharRanges,
	parseTableRows,
	parseInlineCells
} from '$lib/editor/tableBlock/parseTable.js';
import type { JSONContent } from '@tiptap/core';

describe('isSeparatorRow', () => {
	it('recognises a pipe-delimited dash row', () => {
		expect(isSeparatorRow('| --- | --- |')).toBe(true);
		expect(isSeparatorRow('| :--- | :--: | ---: |')).toBe(true);
		expect(isSeparatorRow('---|---')).toBe(true);
	});
	it('rejects a bare dash row (that is HR-split, not a table)', () => {
		expect(isSeparatorRow('---')).toBe(false);
		expect(isSeparatorRow('  ---  ')).toBe(false);
	});
	it('rejects a data row', () => {
		expect(isSeparatorRow('| a | b |')).toBe(false);
		expect(isSeparatorRow('| 1 | 2 |')).toBe(false);
	});
	it('rejects an empty / pipe-only row', () => {
		expect(isSeparatorRow('')).toBe(false);
		expect(isSeparatorRow('|  |')).toBe(false);
	});
});

describe('parseAlignments', () => {
	it('maps colon markers to alignment', () => {
		expect(parseAlignments('| :--- | :--: | ---: | --- |')).toEqual([
			'left',
			'center',
			'right',
			null
		]);
	});
	it('handles no outer pipes', () => {
		expect(parseAlignments(':--:|--:')).toEqual(['center', 'right']);
	});
});

describe('stripOuterPipeInlines', () => {
	it('drops one leading and one trailing pipe, single node', () => {
		const out = stripOuterPipeInlines([{ type: 'text', text: '| a | b |' }]);
		expect(out.map((n) => n.text).join('')).toBe(' a | b ');
	});
	it('preserves marks while stripping', () => {
		const inlines: JSONContent[] = [
			{ type: 'text', text: '| ' },
			{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
			{ type: 'text', text: ' |' }
		];
		const out = stripOuterPipeInlines(inlines);
		expect(out[0].text).toBe(' ');
		expect(out[1].marks?.[0].type).toBe('bold');
		expect(out[2].text).toBe(' ');
	});
});

describe('markdownRowLayout', () => {
	it('splits raw chunks and flags outer pipes', () => {
		const l = markdownRowLayout('| a | b |');
		expect(l.hasLead).toBe(true);
		expect(l.hasTrail).toBe(true);
		expect(l.cells).toHaveLength(2);
		expect('| a | b |'.slice(l.cells[0].start, l.cells[0].end)).toBe(' a ');
		expect('| a | b |'.slice(l.cells[1].start, l.cells[1].end)).toBe(' b ');
	});
	it('handles missing outer pipes', () => {
		const l = markdownRowLayout('a | b');
		expect(l.hasLead).toBe(false);
		expect(l.hasTrail).toBe(false);
		expect(l.cells).toHaveLength(2);
	});
});

describe('cellCharRanges — markdown', () => {
	it('returns trimmed content ranges accounting for outer pipes', () => {
		const text = '| alpha | beta |';
		const ranges = cellCharRanges(text, 'markdown');
		expect(text.slice(ranges[0].start, ranges[0].end)).toBe('alpha');
		expect(text.slice(ranges[1].start, ranges[1].end)).toBe('beta');
	});
	it('zero-width range for an empty cell', () => {
		const text = '| a |  |';
		const ranges = cellCharRanges(text, 'markdown');
		expect(ranges[1].start).toBe(ranges[1].end);
	});
});

describe('parseTableRows / parseInlineCells — markdown', () => {
	it('parses rows, stripping outer pipes and trimming', () => {
		expect(parseTableRows(['| a | b |', '| 1 | 2 |'], 'markdown')).toEqual([
			['a', 'b'],
			['1', '2']
		]);
	});
	it('skips a separator row defensively', () => {
		expect(parseTableRows(['| a | b |', '| --- | --- |'], 'markdown')).toEqual([
			['a', 'b']
		]);
	});
	it('preserves marks in inline cells', () => {
		const para: JSONContent = {
			type: 'paragraph',
			content: [
				{ type: 'text', text: '| ' },
				{ type: 'text', text: 'x', marks: [{ type: 'bold' }] },
				{ type: 'text', text: ' | y |' }
			]
		};
		const cells = parseInlineCells([para], 'markdown');
		expect(cells[0][0][0].marks?.[0].type).toBe('bold');
		expect(cells[0][1][0].text).toBe('y');
	});
});
