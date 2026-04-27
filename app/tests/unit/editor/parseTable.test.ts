import { describe, it, expect } from 'vitest';
import {
	parseTableRows,
	detectFenceFormat,
	isFenceClose
} from '$lib/editor/tableBlock/parseTable.js';

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
