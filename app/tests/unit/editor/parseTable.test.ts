import { describe, it, expect } from 'vitest';
import {
	parseTableRows,
	detectFenceFormat,
	isFenceClose,
	splitInlinesByChar,
	trimInlines,
	parseInlineCells
} from '$lib/editor/tableBlock/parseTable.js';
import type { JSONContent } from '@tiptap/core';

describe('detectFenceFormat — opening-fence parsing', () => {
	it('recognises ```csv as csv', () => {
		expect(detectFenceFormat('```csv')).toBe('csv');
	});

	it('recognises ```tsv as tsv', () => {
		expect(detectFenceFormat('```tsv')).toBe('tsv');
	});

	it('tolerates leading/trailing whitespace', () => {
		expect(detectFenceFormat('  ```csv  ')).toBe('csv');
		expect(detectFenceFormat('\t```tsv\t')).toBe('tsv');
	});

	it('is case-insensitive on the language identifier', () => {
		expect(detectFenceFormat('```CSV')).toBe('csv');
		expect(detectFenceFormat('```Tsv')).toBe('tsv');
	});

	it('returns null for non-fence text', () => {
		expect(detectFenceFormat('csv')).toBeNull();
		expect(detectFenceFormat('```')).toBeNull();
		expect(detectFenceFormat('``csv')).toBeNull();
		expect(detectFenceFormat('```python')).toBeNull();
		expect(detectFenceFormat('plain text')).toBeNull();
		expect(detectFenceFormat('')).toBeNull();
	});

	it('rejects extra content after the language tag', () => {
		// "```csv extra" is not a valid opening fence — keeps the rule strict
		// so accidental text on a code-fence line doesn't trigger table mode.
		expect(detectFenceFormat('```csv extra')).toBeNull();
	});
});

describe('isFenceClose — closing-fence detection', () => {
	it('recognises a bare ```', () => {
		expect(isFenceClose('```')).toBe(true);
	});

	it('tolerates leading/trailing whitespace', () => {
		expect(isFenceClose('  ```  ')).toBe(true);
	});

	it('rejects fences with anything else on the line', () => {
		expect(isFenceClose('```csv')).toBe(false);
		expect(isFenceClose('``` end')).toBe(false);
		expect(isFenceClose('````')).toBe(false);
		expect(isFenceClose('``')).toBe(false);
		expect(isFenceClose('')).toBe(false);
	});
});

describe('parseTableRows — CSV', () => {
	it('splits a simple CSV body and trims cells', () => {
		const rows = parseTableRows(
			['이름, 내용', '1, 표내용1', '2, 표내용2'],
			'csv'
		);
		expect(rows).toEqual([
			['이름', '내용'],
			['1', '표내용1'],
			['2', '표내용2']
		]);
	});

	it('preserves cell text that contains tabs (csv splits on commas only)', () => {
		const rows = parseTableRows(['a\tb, c'], 'csv');
		expect(rows).toEqual([['a\tb', 'c']]);
	});

	it('skips empty/whitespace-only lines', () => {
		const rows = parseTableRows(['a, b', '', '   ', 'c, d'], 'csv');
		expect(rows).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
	});

	it('handles a single-column CSV', () => {
		const rows = parseTableRows(['only', 'one', 'col'], 'csv');
		expect(rows).toEqual([['only'], ['one'], ['col']]);
	});

	it('keeps ragged rows (different column counts) as-is', () => {
		// Renderer is responsible for padding short rows — parser should not
		// silently lose data.
		const rows = parseTableRows(['a, b, c', 'x, y'], 'csv');
		expect(rows).toEqual([
			['a', 'b', 'c'],
			['x', 'y']
		]);
	});
});

describe('parseTableRows — TSV', () => {
	it('splits a simple TSV body on tabs', () => {
		const rows = parseTableRows(['이름\t내용', '1\t표내용1'], 'tsv');
		expect(rows).toEqual([
			['이름', '내용'],
			['1', '표내용1']
		]);
	});

	it('does NOT trim TSV cells (whitespace inside cells is meaningful)', () => {
		const rows = parseTableRows([' a \t b '], 'tsv');
		expect(rows).toEqual([[' a ', ' b ']]);
	});

	it('does not split a TSV row on commas', () => {
		const rows = parseTableRows(['a, b\tc'], 'tsv');
		expect(rows).toEqual([['a, b', 'c']]);
	});
});

describe('splitInlinesByChar', () => {
	it('splits a single text node by a separator', () => {
		const out = splitInlinesByChar(
			[{ type: 'text', text: 'a,b,c' }],
			','
		);
		expect(out).toEqual([
			[{ type: 'text', text: 'a' }],
			[{ type: 'text', text: 'b' }],
			[{ type: 'text', text: 'c' }]
		]);
	});

	it('preserves marks on each split piece', () => {
		const bold = [{ type: 'bold' as const }];
		const out = splitInlinesByChar(
			[{ type: 'text', text: 'a,b', marks: bold }],
			','
		);
		expect(out).toEqual([
			[{ type: 'text', text: 'a', marks: bold }],
			[{ type: 'text', text: 'b', marks: bold }]
		]);
	});

	it('splits across multiple text nodes with different marks', () => {
		// "alpha[bold]" + ", " + "beta[italic]" → two cells:
		//   cell 0: "alpha[bold]"
		//   cell 1: " " + "beta[italic]"   (the space is between separator and beta)
		const out = splitInlinesByChar(
			[
				{ type: 'text', text: 'alpha', marks: [{ type: 'bold' }] },
				{ type: 'text', text: ', beta', marks: [{ type: 'italic' }] }
			],
			','
		);
		expect(out).toEqual([
			[{ type: 'text', text: 'alpha', marks: [{ type: 'bold' }] }],
			[{ type: 'text', text: ' beta', marks: [{ type: 'italic' }] }]
		]);
	});

	it('keeps separators inside a cell when they sit at a node boundary', () => {
		// Separator is fully inside the second node; the first stays whole.
		const out = splitInlinesByChar(
			[
				{ type: 'text', text: 'a' },
				{ type: 'text', text: 'b,c' }
			],
			','
		);
		expect(out).toEqual([
			[
				{ type: 'text', text: 'a' },
				{ type: 'text', text: 'b' }
			],
			[{ type: 'text', text: 'c' }]
		]);
	});

	it('emits empty cells for adjacent separators', () => {
		const out = splitInlinesByChar([{ type: 'text', text: 'a,,b' }], ',');
		expect(out).toEqual([
			[{ type: 'text', text: 'a' }],
			[],
			[{ type: 'text', text: 'b' }]
		]);
	});

	it('handles tab as a separator (used for TSV)', () => {
		const out = splitInlinesByChar(
			[{ type: 'text', text: 'a\tb\tc' }],
			'\t'
		);
		expect(out.map((cell) => (cell[0] as JSONContent | undefined)?.text)).toEqual(
			['a', 'b', 'c']
		);
	});
});

describe('trimInlines (CSV cell trim)', () => {
	it('trims leading/trailing whitespace on edge text nodes', () => {
		const out = trimInlines([{ type: 'text', text: '  hi  ' }]);
		expect(out).toEqual([{ type: 'text', text: 'hi' }]);
	});

	it('preserves marks while trimming text content', () => {
		const out = trimInlines([
			{ type: 'text', text: '  bold  ', marks: [{ type: 'bold' }] }
		]);
		expect(out).toEqual([
			{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }
		]);
	});

	it('drops fully-whitespace edge nodes', () => {
		const out = trimInlines([
			{ type: 'text', text: '   ' },
			{ type: 'text', text: 'core' },
			{ type: 'text', text: '  ' }
		]);
		expect(out).toEqual([{ type: 'text', text: 'core' }]);
	});

	it('does not collapse whitespace inside the cell', () => {
		const out = trimInlines([{ type: 'text', text: '  a  b  ' }]);
		expect(out).toEqual([{ type: 'text', text: 'a  b' }]);
	});

	it('returns an empty array for an all-whitespace cell', () => {
		const out = trimInlines([{ type: 'text', text: '   ' }]);
		expect(out).toEqual([]);
	});
});

describe('parseInlineCells — high-level row→cells', () => {
	function plainPara(text: string): JSONContent {
		return { type: 'paragraph', content: [{ type: 'text', text }] };
	}

	it('parses CSV body paragraphs into trimmed marked cells', () => {
		const rows = parseInlineCells(
			[plainPara('이름, 내용'), plainPara('1, 표내용1')],
			'csv'
		);
		expect(rows).toEqual([
			[
				[{ type: 'text', text: '이름' }],
				[{ type: 'text', text: '내용' }]
			],
			[
				[{ type: 'text', text: '1' }],
				[{ type: 'text', text: '표내용1' }]
			]
		]);
	});

	it('preserves marks across cell splits in a CSV row', () => {
		const para: JSONContent = {
			type: 'paragraph',
			content: [
				{ type: 'text', text: 'alpha', marks: [{ type: 'bold' }] },
				{ type: 'text', text: ', ' },
				{
					type: 'text',
					text: 'see',
					marks: [
						{ type: 'tomboyInternalLink', attrs: { target: 'Other' } }
					]
				}
			]
		};
		const rows = parseInlineCells([para], 'csv');
		expect(rows[0][0]).toEqual([
			{ type: 'text', text: 'alpha', marks: [{ type: 'bold' }] }
		]);
		expect(rows[0][1]).toEqual([
			{
				type: 'text',
				text: 'see',
				marks: [
					{ type: 'tomboyInternalLink', attrs: { target: 'Other' } }
				]
			}
		]);
	});

	it('parses TSV with no trim', () => {
		const para: JSONContent = {
			type: 'paragraph',
			content: [{ type: 'text', text: ' a \t b ' }]
		};
		const rows = parseInlineCells([para], 'tsv');
		expect(rows).toEqual([
			[
				[{ type: 'text', text: ' a ' }],
				[{ type: 'text', text: ' b ' }]
			]
		]);
	});

	it('skips empty/whitespace-only paragraphs (matches parseTableRows)', () => {
		const rows = parseInlineCells(
			[plainPara('a, b'), { type: 'paragraph' }, plainPara('   '), plainPara('c, d')],
			'csv'
		);
		expect(rows).toHaveLength(2);
		expect(rows[0][0]).toEqual([{ type: 'text', text: 'a' }]);
		expect(rows[1][1]).toEqual([{ type: 'text', text: 'd' }]);
	});
});
