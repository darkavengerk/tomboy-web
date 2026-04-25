import { describe, it, expect } from 'vitest';
import { parseKoreanTime } from '$lib/schedule/parseSchedule.js';

describe('parseKoreanTime', () => {
	describe('explicit 오전/오후', () => {
		it('오전 7시 → 07:00', () => {
			expect(parseKoreanTime('오전 7시')).toEqual({ h: 7, m: 0 });
		});

		it('오후 7시 → 19:00', () => {
			expect(parseKoreanTime('오후 7시')).toEqual({ h: 19, m: 0 });
		});

		it('오전 12시 → 00:00 (midnight)', () => {
			expect(parseKoreanTime('오전 12시')).toEqual({ h: 0, m: 0 });
		});

		it('오후 12시 → 12:00 (noon)', () => {
			expect(parseKoreanTime('오후 12시')).toEqual({ h: 12, m: 0 });
		});

		it('오전 6시 30분 → 06:30', () => {
			expect(parseKoreanTime('오전 6시 30분')).toEqual({ h: 6, m: 30 });
		});
	});

	describe('PM default (no 오전/오후)', () => {
		it('7시 → 19:00 (PM default)', () => {
			expect(parseKoreanTime('7시')).toEqual({ h: 19, m: 0 });
		});

		it('11시 → 23:00 (PM default)', () => {
			expect(parseKoreanTime('11시')).toEqual({ h: 23, m: 0 });
		});

		it('12시 → 12:00 (noon, not midnight)', () => {
			expect(parseKoreanTime('12시')).toEqual({ h: 12, m: 0 });
		});

		it('1시 → 13:00', () => {
			expect(parseKoreanTime('1시')).toEqual({ h: 13, m: 0 });
		});
	});

	describe('24-hour notation (>= 13)', () => {
		it('13시 → 13:00 (already 24h, no shift)', () => {
			expect(parseKoreanTime('13시')).toEqual({ h: 13, m: 0 });
		});

		it('23시 59분 → 23:59', () => {
			expect(parseKoreanTime('23시 59분')).toEqual({ h: 23, m: 59 });
		});

		it('00시 → 00:00', () => {
			expect(parseKoreanTime('00시')).toEqual({ h: 0, m: 0 });
		});
	});

	describe('minute forms', () => {
		it('6시 반 → 18:30 (PM default)', () => {
			expect(parseKoreanTime('6시 반')).toEqual({ h: 18, m: 30 });
		});

		it('오전 6시 반 → 06:30', () => {
			expect(parseKoreanTime('오전 6시 반')).toEqual({ h: 6, m: 30 });
		});

		it('7시 20분 → 19:20 (PM default)', () => {
			expect(parseKoreanTime('7시 20분')).toEqual({ h: 19, m: 20 });
		});

		it('오후 6시 30분 → 18:30', () => {
			expect(parseKoreanTime('오후 6시 30분')).toEqual({ h: 18, m: 30 });
		});
	});

	describe('embedded in surrounding text', () => {
		it('extracts time from middle of label', () => {
			expect(parseKoreanTime('친구 만나기 6시 반 집앞')).toEqual({ h: 18, m: 30 });
		});

		it('extracts time from end of label', () => {
			expect(parseKoreanTime('등산 7시')).toEqual({ h: 19, m: 0 });
		});

		it('extracts time from start of label', () => {
			expect(parseKoreanTime('7시 등산')).toEqual({ h: 19, m: 0 });
		});
	});

	describe('no time present', () => {
		it('returns null for plain label', () => {
			expect(parseKoreanTime('빨래')).toBeNull();
		});

		it('returns null for empty', () => {
			expect(parseKoreanTime('')).toBeNull();
		});

		it('returns null for label that mentions 시 but not as time (e.g. "시작")', () => {
			expect(parseKoreanTime('시작 준비')).toBeNull();
		});
	});

	describe('whitespace tolerance', () => {
		it('오후7시 (no space) → 19:00', () => {
			expect(parseKoreanTime('오후7시')).toEqual({ h: 19, m: 0 });
		});

		it('7시20분 (no spaces) → 19:20', () => {
			expect(parseKoreanTime('7시20분')).toEqual({ h: 19, m: 20 });
		});
	});
});
