import { describe, it, expect } from 'vitest';
import { lineDiff } from '$lib/sync/diffNote.js';

describe('lineDiff', () => {
	it('returns all-equal when both inputs are identical', () => {
		const ops = lineDiff('a\nb\nc', 'a\nb\nc');
		expect(ops.every((o) => o.type === 'equal')).toBe(true);
		expect(ops.map((o) => o.text)).toEqual(['a', 'b', 'c']);
	});

	it('detects a single removed line', () => {
		const ops = lineDiff('a\nb\nc', 'a\nc');
		const kinds = ops.map((o) => `${o.type}:${o.text}`);
		expect(kinds).toEqual(['equal:a', 'removed:b', 'equal:c']);
	});

	it('detects a single added line', () => {
		const ops = lineDiff('a\nc', 'a\nb\nc');
		const kinds = ops.map((o) => `${o.type}:${o.text}`);
		expect(kinds).toEqual(['equal:a', 'added:b', 'equal:c']);
	});

	it('detects a changed line as a removed+added pair', () => {
		const ops = lineDiff('a\nb\nc', 'a\nB\nc');
		expect(ops.some((o) => o.type === 'removed' && o.text === 'b')).toBe(true);
		expect(ops.some((o) => o.type === 'added' && o.text === 'B')).toBe(true);
		expect(ops.filter((o) => o.type === 'equal').map((o) => o.text)).toEqual(['a', 'c']);
	});

	it('handles completely different inputs', () => {
		const ops = lineDiff('x\ny', 'a\nb');
		expect(ops.filter((o) => o.type === 'removed').map((o) => o.text)).toEqual(['x', 'y']);
		expect(ops.filter((o) => o.type === 'added').map((o) => o.text)).toEqual(['a', 'b']);
	});

	it('handles empty inputs', () => {
		expect(lineDiff('', '')).toEqual([{ type: 'equal', text: '' }]);
		expect(lineDiff('', 'a').filter((o) => o.type === 'added')).toHaveLength(1);
		expect(lineDiff('a', '').filter((o) => o.type === 'removed')).toHaveLength(1);
	});

	it('detects trailing-whitespace differences', () => {
		const ops = lineDiff('hello', 'hello ');
		expect(ops.some((o) => o.type === 'removed' && o.text === 'hello')).toBe(true);
		expect(ops.some((o) => o.type === 'added' && o.text === 'hello ')).toBe(true);
	});

	it('detects trailing newline difference', () => {
		// "a\n" splits into ["a", ""], "a" into ["a"] — the empty trailing line differs.
		const ops = lineDiff('a\n', 'a');
		expect(ops.some((o) => o.type === 'removed' && o.text === '')).toBe(true);
	});
});
