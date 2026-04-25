import { describe, it, expect } from 'vitest';
import { parseDayLine } from '$lib/schedule/parseSchedule.js';

const Y = 2026;
const M = 4;

describe('parseDayLine', () => {
	describe('valid lines', () => {
		it('15(금) 등산 7시 → day 15, time 19:00, label "등산"', () => {
			expect(parseDayLine('15(금) 등산 7시', Y, M)).toEqual({
				day: 15,
				time: { h: 19, m: 0 },
				label: '등산'
			});
		});

		it('16(토) 빨래 → day 16, no time, label "빨래"', () => {
			expect(parseDayLine('16(토) 빨래', Y, M)).toEqual({
				day: 16,
				time: null,
				label: '빨래'
			});
		});

		it('16(토) 친구 만나기 6시 반 집앞 → time stripped from middle', () => {
			expect(parseDayLine('16(토) 친구 만나기 6시 반 집앞', Y, M)).toEqual({
				day: 16,
				time: { h: 18, m: 30 },
				label: '친구 만나기 집앞'
			});
		});

		it('17(일) 쓰레기 버리기 7시 20분 → trailing time', () => {
			expect(parseDayLine('17(일) 쓰레기 버리기 7시 20분', Y, M)).toEqual({
				day: 17,
				time: { h: 19, m: 20 },
				label: '쓰레기 버리기'
			});
		});
	});

	describe('weekday annotation is optional', () => {
		it('15 등산 7시 → no (요일) marker', () => {
			expect(parseDayLine('15 등산 7시', Y, M)).toEqual({
				day: 15,
				time: { h: 19, m: 0 },
				label: '등산'
			});
		});

		it('15(금)등산 7시 → no space after (요일)', () => {
			expect(parseDayLine('15(금)등산 7시', Y, M)).toEqual({
				day: 15,
				time: { h: 19, m: 0 },
				label: '등산'
			});
		});
	});

	describe('lines that should be ignored (return null)', () => {
		it('plain text without day prefix → null', () => {
			expect(parseDayLine('노트 열심히 만드는 달', Y, M)).toBeNull();
		});

		it('empty string → null', () => {
			expect(parseDayLine('', Y, M)).toBeNull();
		});

		it('day out of range (32) → null', () => {
			expect(parseDayLine('32(?) 불가능', Y, M)).toBeNull();
		});

		it('day 0 → null', () => {
			expect(parseDayLine('0 invalid', Y, M)).toBeNull();
		});

		it('Feb 30 (invalid date for given month) → null', () => {
			expect(parseDayLine('30 어떤 일정', 2026, 2)).toBeNull();
		});

		it('Apr 31 (invalid for April) → null', () => {
			expect(parseDayLine('31 어떤 일정', 2026, 4)).toBeNull();
		});
	});

	describe('label cleanup', () => {
		it('collapses multiple spaces left after removing time', () => {
			// "친구 만나기  집앞" (double space) → "친구 만나기 집앞"
			expect(parseDayLine('16 친구  만나기   6시 반   집앞', Y, M)).toEqual({
				day: 16,
				time: { h: 18, m: 30 },
				label: '친구 만나기 집앞'
			});
		});

		it('trims label whitespace', () => {
			expect(parseDayLine('16    빨래   ', Y, M)).toEqual({
				day: 16,
				time: null,
				label: '빨래'
			});
		});

		it('label-only with day produces empty string label is allowed but null-label not', () => {
			// "16(토)" alone → no label, return null (we don't notify a blank entry)
			expect(parseDayLine('16(토)', Y, M)).toBeNull();
		});
	});
});
