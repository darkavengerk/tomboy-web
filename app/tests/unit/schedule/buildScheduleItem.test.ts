import { describe, it, expect } from 'vitest';
import { buildScheduleItem } from '$lib/schedule/buildScheduleItem.js';
import type { ParsedScheduleEntry } from '$lib/schedule/parseSchedule.js';

function entry(overrides: Partial<ParsedScheduleEntry> = {}): ParsedScheduleEntry {
	return {
		year: 2026,
		month: 4,
		day: 15,
		time: { h: 19, m: 0 },
		label: '등산',
		rawLine: '15(금) 등산 7시',
		...overrides
	};
}

describe('buildScheduleItem', () => {
	describe('eventAt and fireAt', () => {
		it('time present: fireAt = eventAt - 30 min', () => {
			const item = buildScheduleItem(entry());
			const event = new Date(item.eventAt);
			const fire = new Date(item.fireAt);
			expect(event.getFullYear()).toBe(2026);
			expect(event.getMonth()).toBe(3);
			expect(event.getDate()).toBe(15);
			expect(event.getHours()).toBe(19);
			expect(event.getMinutes()).toBe(0);
			expect(fire.getTime()).toBe(event.getTime() - 30 * 60_000);
		});

		it('date only: fireAt = that day 07:00, eventAt = that day 00:00', () => {
			const item = buildScheduleItem(
				entry({ time: null, label: '빨래', rawLine: '16(토) 빨래', day: 16 })
			);
			const event = new Date(item.eventAt);
			const fire = new Date(item.fireAt);
			expect(event.getDate()).toBe(16);
			expect(event.getHours()).toBe(0);
			expect(event.getMinutes()).toBe(0);
			expect(fire.getDate()).toBe(16);
			expect(fire.getHours()).toBe(7);
			expect(fire.getMinutes()).toBe(0);
		});

		it('hasTime flag is set correctly', () => {
			expect(buildScheduleItem(entry()).hasTime).toBe(true);
			expect(buildScheduleItem(entry({ time: null })).hasTime).toBe(false);
		});

		it('PM late time: 23:59 produces correct fireAt at 23:29', () => {
			const item = buildScheduleItem(
				entry({ time: { h: 23, m: 59 }, day: 15, label: 'late', rawLine: '15 late 23시 59분' })
			);
			const event = new Date(item.eventAt);
			const fire = new Date(item.fireAt);
			expect(event.getHours()).toBe(23);
			expect(event.getMinutes()).toBe(59);
			expect(fire.getHours()).toBe(23);
			expect(fire.getMinutes()).toBe(29);
		});
	});

	describe('id stability', () => {
		it('same date|time|label → same id', () => {
			const a = buildScheduleItem(entry());
			const b = buildScheduleItem(entry());
			expect(a.id).toBe(b.id);
		});

		it('label change → different id', () => {
			const a = buildScheduleItem(entry({ label: '등산' }));
			const b = buildScheduleItem(entry({ label: '하이킹' }));
			expect(a.id).not.toBe(b.id);
		});

		it('time change → different id', () => {
			const a = buildScheduleItem(entry({ time: { h: 19, m: 0 } }));
			const b = buildScheduleItem(entry({ time: { h: 18, m: 30 } }));
			expect(a.id).not.toBe(b.id);
		});

		it('time present vs absent (same label/date) → different id', () => {
			const a = buildScheduleItem(entry({ time: { h: 19, m: 0 } }));
			const b = buildScheduleItem(entry({ time: null }));
			expect(a.id).not.toBe(b.id);
		});

		it('day change → different id', () => {
			const a = buildScheduleItem(entry({ day: 15 }));
			const b = buildScheduleItem(entry({ day: 16 }));
			expect(a.id).not.toBe(b.id);
		});

		it('id is a 16-char hex string', () => {
			const id = buildScheduleItem(entry()).id;
			expect(id).toMatch(/^[0-9a-f]{16}$/);
		});
	});

	describe('payload fields', () => {
		it('includes label and date components', () => {
			const item = buildScheduleItem(entry());
			expect(item.label).toBe('등산');
			expect(item.year).toBe(2026);
			expect(item.month).toBe(4);
			expect(item.day).toBe(15);
		});
	});
});
