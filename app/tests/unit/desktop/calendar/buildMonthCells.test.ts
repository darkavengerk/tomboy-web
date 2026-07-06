import { describe, it, expect } from 'vitest';
import { buildMonthCells } from '$lib/desktop/calendar/monthGrid.js';

describe('buildMonthCells', () => {
	it('always returns 42 cells (6 weeks)', () => {
		expect(buildMonthCells(2026, 6, '', new Map()).length).toBe(42);
	});

	it('places the 1st of the month at the correct weekday offset', () => {
		// 2026-07-01 is a Wednesday → getDay() === 3.
		const cells = buildMonthCells(2026, 6, '', new Map());
		expect(cells[0].date.getDay()).toBe(0); // grid starts on Sunday
		expect(cells[3].day).toBe(1);
		expect(cells[3].inMonth).toBe(true);
	});

	it('marks leading days from the previous month as out-of-month', () => {
		const cells = buildMonthCells(2026, 6, '', new Map());
		expect(cells[0].inMonth).toBe(false);
		expect(cells[2].inMonth).toBe(false); // still June
	});

	it('flags the cell whose key matches todayKey', () => {
		const cells = buildMonthCells(2026, 6, '2026-07-06', new Map());
		const today = cells.find((c) => c.isToday);
		expect(today?.day).toBe(6);
		expect(today?.inMonth).toBe(true);
		expect(cells.filter((c) => c.isToday).length).toBe(1);
	});

	it('pulls per-day counts from the provided day map', () => {
		const map = new Map<string, unknown[]>([['2026-07-06', [{}, {}, {}]]]);
		const cells = buildMonthCells(2026, 6, '', map as Map<string, never[]>);
		const c = cells.find((cell) => cell.key === '2026-07-06');
		expect(c?.count).toBe(3);
		const empty = cells.find((cell) => cell.key === '2026-07-07');
		expect(empty?.count).toBe(0);
	});
});
