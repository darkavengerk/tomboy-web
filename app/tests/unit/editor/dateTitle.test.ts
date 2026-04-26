import { describe, it, expect } from 'vitest';

import {
	findAdjacentDateNotes,
	isDateTitle,
	parseDateTitle
} from '$lib/editor/dateLink/findAdjacentDateNotes.js';

// -------------------------------------------------------------------------
// parseDateTitle — formats
// -------------------------------------------------------------------------

describe('parseDateTitle', () => {
	it('parses yyyy-mm-dd', () => {
		expect(parseDateTitle('2026-04-26')).toEqual({
			y: 2026,
			m: 4,
			d: 26,
			iso: '2026-04-26'
		});
	});

	it('parses zero-padded yyyy년 mm월 dd일', () => {
		expect(parseDateTitle('2026년 04월 26일')).toEqual({
			y: 2026,
			m: 4,
			d: 26,
			iso: '2026-04-26'
		});
	});

	it('parses non-padded yyyy년 m월 d일', () => {
		expect(parseDateTitle('2026년 4월 6일')).toEqual({
			y: 2026,
			m: 4,
			d: 6,
			iso: '2026-04-06'
		});
	});

	it('parses mixed padding (m padded, d not)', () => {
		expect(parseDateTitle('2026년 04월 6일')).toEqual({
			y: 2026,
			m: 4,
			d: 6,
			iso: '2026-04-06'
		});
	});

	it('parses Korean format with no spaces', () => {
		expect(parseDateTitle('2026년4월6일')).toEqual({
			y: 2026,
			m: 4,
			d: 6,
			iso: '2026-04-06'
		});
	});

	it('parses Korean format with multiple spaces', () => {
		expect(parseDateTitle('2026년   4월   6일')).toEqual({
			y: 2026,
			m: 4,
			d: 6,
			iso: '2026-04-06'
		});
	});

	it('parses 12월 31일 (boundary, two-digit values)', () => {
		expect(parseDateTitle('1999년 12월 31일')).toEqual({
			y: 1999,
			m: 12,
			d: 31,
			iso: '1999-12-31'
		});
	});

	it('trims leading/trailing whitespace', () => {
		expect(parseDateTitle('   2026-04-26   ')).toEqual({
			y: 2026,
			m: 4,
			d: 26,
			iso: '2026-04-26'
		});
		expect(parseDateTitle('  2026년 4월 6일  ')).toEqual({
			y: 2026,
			m: 4,
			d: 6,
			iso: '2026-04-06'
		});
	});

	it('rejects month > 12', () => {
		expect(parseDateTitle('2026년 13월 1일')).toBeNull();
		expect(parseDateTitle('2026-13-01')).toBeNull();
	});

	it('rejects month < 1', () => {
		expect(parseDateTitle('2026년 0월 1일')).toBeNull();
		expect(parseDateTitle('2026-00-01')).toBeNull();
	});

	it('rejects day > 31', () => {
		expect(parseDateTitle('2026년 4월 32일')).toBeNull();
		expect(parseDateTitle('2026-04-32')).toBeNull();
	});

	it('rejects day < 1', () => {
		expect(parseDateTitle('2026년 4월 0일')).toBeNull();
		expect(parseDateTitle('2026-04-00')).toBeNull();
	});

	it('rejects year of wrong length', () => {
		expect(parseDateTitle('999년 4월 6일')).toBeNull();
		expect(parseDateTitle('20260년 4월 6일')).toBeNull();
		expect(parseDateTitle('999-04-06')).toBeNull();
	});

	it('rejects when the title contains extra text after the date', () => {
		expect(parseDateTitle('2026-04-26 — diary')).toBeNull();
		expect(parseDateTitle('2026년 4월 6일 일기')).toBeNull();
	});

	it('rejects unrelated text', () => {
		expect(parseDateTitle('Hello World')).toBeNull();
		expect(parseDateTitle('')).toBeNull();
		expect(parseDateTitle('2026/04/26')).toBeNull();
	});
});

describe('isDateTitle', () => {
	it('returns true for any supported format', () => {
		expect(isDateTitle('2026-04-26')).toBe(true);
		expect(isDateTitle('2026년 4월 6일')).toBe(true);
		expect(isDateTitle('  2026년 04월 26일  ')).toBe(true);
		expect(isDateTitle('2026년4월6일')).toBe(true);
	});

	it('returns false for invalid forms', () => {
		expect(isDateTitle('2026-13-01')).toBe(false);
		expect(isDateTitle('not a date')).toBe(false);
		expect(isDateTitle('')).toBe(false);
	});
});

// -------------------------------------------------------------------------
// findAdjacentDateNotes — cross-format adjacency
// -------------------------------------------------------------------------

describe('findAdjacentDateNotes', () => {
	const today = new Date('2026-04-30T12:00:00');

	it('returns null/null when the current title is not a date', () => {
		const out = findAdjacentDateNotes(
			'Random title',
			'gA',
			[
				{ title: '2026-04-25', guid: 'gB' },
				{ title: '2026-04-27', guid: 'gC' }
			],
			today
		);
		expect(out).toEqual({ prev: null, next: null });
	});

	it('finds prev/next within the same format (yyyy-mm-dd)', () => {
		const out = findAdjacentDateNotes(
			'2026-04-26',
			'gA',
			[
				{ title: '2026-04-25', guid: 'gB' },
				{ title: '2026-04-27', guid: 'gC' },
				{ title: '2026-04-20', guid: 'gD' }
			],
			today
		);
		expect(out.prev).toBe('2026-04-25');
		expect(out.next).toBe('2026-04-27');
	});

	it('finds Korean-format neighbors when current is yyyy-mm-dd', () => {
		const out = findAdjacentDateNotes(
			'2026-04-26',
			'gA',
			[
				{ title: '2026년 4월 25일', guid: 'gB' },
				{ title: '2026년 04월 27일', guid: 'gC' }
			],
			today
		);
		expect(out.prev).toBe('2026년 4월 25일');
		expect(out.next).toBe('2026년 04월 27일');
	});

	it('finds yyyy-mm-dd neighbors when current is Korean format', () => {
		const out = findAdjacentDateNotes(
			'2026년 4월 26일',
			'gA',
			[
				{ title: '2026-04-25', guid: 'gB' },
				{ title: '2026-04-27', guid: 'gC' }
			],
			today
		);
		expect(out.prev).toBe('2026-04-25');
		expect(out.next).toBe('2026-04-27');
	});

	it('returns the closest neighbor when many candidates exist (mixed formats)', () => {
		const out = findAdjacentDateNotes(
			'2026년 4월 26일',
			'gA',
			[
				{ title: '2026-04-20', guid: 'gB' },
				{ title: '2026년 4월 25일', guid: 'gC' },
				{ title: '2026년 04월 27일', guid: 'gD' },
				{ title: '2026-04-30', guid: 'gE' }
			],
			today
		);
		expect(out.prev).toBe('2026년 4월 25일');
		expect(out.next).toBe('2026년 04월 27일');
	});

	it('skips future dates beyond today for next', () => {
		const out = findAdjacentDateNotes(
			'2026-04-29',
			'gA',
			[
				{ title: '2026-04-28', guid: 'gB' },
				{ title: '2026년 5월 1일', guid: 'gC' } // future
			],
			today
		);
		expect(out.prev).toBe('2026-04-28');
		expect(out.next).toBe(null);
	});

	it('skips own guid (defensive)', () => {
		const out = findAdjacentDateNotes(
			'2026년 4월 26일',
			'gA',
			[
				{ title: '2026년 4월 26일', guid: 'gA' }, // same guid as current
				{ title: '2026-04-25', guid: 'gB' }
			],
			today
		);
		expect(out.prev).toBe('2026-04-25');
		expect(out.next).toBe(null);
	});

	it('skips entries with non-date titles', () => {
		const out = findAdjacentDateNotes(
			'2026-04-26',
			'gA',
			[
				{ title: 'random', guid: 'gB' },
				{ title: '2026-04-25', guid: 'gC' }
			],
			today
		);
		expect(out.prev).toBe('2026-04-25');
		expect(out.next).toBe(null);
	});
});
