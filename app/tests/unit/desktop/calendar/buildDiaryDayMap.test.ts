import { describe, it, expect } from 'vitest';
import { buildDiaryDayMap } from '$lib/desktop/calendar/diaryEntries.js';
import type { ParsedScheduleEntry } from '$lib/schedule/parseSchedule.js';

function entry(over: Partial<ParsedScheduleEntry>): ParsedScheduleEntry {
	return {
		year: 2026,
		month: 7,
		day: 6,
		time: null,
		label: 'x',
		rawLine: 'x',
		...over
	};
}

describe('buildDiaryDayMap', () => {
	it('keeps only entries matching the target year+month', () => {
		const sched = [
			entry({ month: 7, day: 6, label: 'keep' }),
			entry({ month: 8, day: 6, label: 'wrong month' }),
			entry({ year: 2025, month: 7, day: 6, label: 'wrong year' })
		];
		const map = buildDiaryDayMap(sched, [], 2026, 7);
		expect(map.get(6)?.map((e) => e.label)).toEqual(['keep']);
	});

	it('groups by day-of-month', () => {
		const sched = [entry({ day: 6, label: 'a' }), entry({ day: 20, label: 'b' })];
		const map = buildDiaryDayMap(sched, [], 2026, 7);
		expect(map.get(6)?.length).toBe(1);
		expect(map.get(20)?.length).toBe(1);
	});

	it('tags entries by source and merges schedule + history into one day', () => {
		const sched = [entry({ day: 6, label: 's' })];
		const hist = [entry({ day: 6, label: 'h' })];
		const map = buildDiaryDayMap(sched, hist, 2026, 7);
		const day6 = map.get(6) ?? [];
		expect(day6.map((e) => `${e.source}:${e.label}`).sort()).toEqual(['history:h', 'schedule:s']);
	});

	it('sorts a day by time ascending, untimed entries last', () => {
		const sched = [
			entry({ day: 6, label: 'noon', time: { h: 12, m: 0 } }),
			entry({ day: 6, label: 'untimed', time: null }),
			entry({ day: 6, label: 'morning', time: { h: 9, m: 30 } })
		];
		const map = buildDiaryDayMap(sched, [], 2026, 7);
		expect(map.get(6)?.map((e) => e.label)).toEqual(['morning', 'noon', 'untimed']);
	});

	it('returns an empty map when nothing matches', () => {
		expect(buildDiaryDayMap([], [], 2026, 7).size).toBe(0);
	});
});
