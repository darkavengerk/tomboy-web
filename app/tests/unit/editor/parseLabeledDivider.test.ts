import { describe, it, expect } from 'vitest';
import { parseLabeledDivider } from '$lib/editor/labeledDivider/parseLabeledDivider.js';

describe('parseLabeledDivider — centered', () => {
	it('parses `-- 회의록 --` as a centered divider', () => {
		const r = parseLabeledDivider('-- 회의록 --');
		expect(r).not.toBeNull();
		expect(r!.align).toBe('center');
		expect(r!.label).toBe('회의록');
		expect(r!.leadMark).toEqual([0, 3]);
		expect(r!.labelRange).toEqual([3, 6]);
		expect(r!.trailMark).toEqual([6, 9]);
	});

	it('accepts long dash runs on either side', () => {
		const r = parseLabeledDivider('-- 회의록 ------------');
		expect(r!.align).toBe('center');
		expect(r!.label).toBe('회의록');
	});

	it('folds extra whitespace into the mark ranges', () => {
		const r = parseLabeledDivider('--   회의록   --');
		expect(r!.align).toBe('center');
		expect(r!.label).toBe('회의록');
		expect(r!.leadMark).toEqual([0, 5]);
		expect(r!.labelRange).toEqual([5, 8]);
		expect(r!.trailMark).toEqual([8, 13]);
	});

	it('keeps internal spaces inside the label', () => {
		const r = parseLabeledDivider('-- 회의 록 --');
		expect(r!.align).toBe('center');
		expect(r!.label).toBe('회의 록');
	});

	it('parses an ASCII label', () => {
		const r = parseLabeledDivider('-- Section --');
		expect(r!.align).toBe('center');
		expect(r!.label).toBe('Section');
	});
});

describe('parseLabeledDivider — left', () => {
	it('parses `회의록 ---` as a left divider', () => {
		const r = parseLabeledDivider('회의록 ---');
		expect(r).not.toBeNull();
		expect(r!.align).toBe('left');
		expect(r!.label).toBe('회의록');
		expect(r!.leadMark).toBeNull();
		expect(r!.labelRange).toEqual([0, 3]);
		expect(r!.trailMark).toEqual([3, 7]);
	});

	it('accepts a long trailing dash run', () => {
		const r = parseLabeledDivider('회의록 ------------------------');
		expect(r!.align).toBe('left');
		expect(r!.label).toBe('회의록');
	});

	it('accepts trailing dashes with no separating space', () => {
		const r = parseLabeledDivider('회의록---');
		expect(r!.align).toBe('left');
		expect(r!.label).toBe('회의록');
		expect(r!.labelRange).toEqual([0, 3]);
		expect(r!.trailMark).toEqual([3, 6]);
	});
});

describe('parseLabeledDivider — precedence', () => {
	it('dashes on both sides resolve to centered', () => {
		const r = parseLabeledDivider('-- 회의록 ---');
		expect(r!.align).toBe('center');
	});
});

describe('parseLabeledDivider — rejected input', () => {
	it.each([
		['---'],
		['-----'],
		['------------'],
		['-- 회의록'],
		['회의록 --'],
		['- 회의록 ---'],
		['--  --'],
		['-- -- --'],
		['hello world'],
		['']
	])('returns null for %j', (input) => {
		expect(parseLabeledDivider(input)).toBeNull();
	});
});
