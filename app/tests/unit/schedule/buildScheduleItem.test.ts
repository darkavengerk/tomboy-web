import { describe, it, expect } from 'vitest';
import { buildScheduleItems } from '$lib/schedule/buildScheduleItem.js';
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

describe('buildScheduleItems', () => {
	describe('time-bearing entry', () => {
		it('emits 3 slots: morning / pre1h / at', () => {
			const items = buildScheduleItems(entry());
			expect(items).toHaveLength(3);
			expect(items.map((i) => i.kind).sort()).toEqual(['at', 'morning', 'pre1h']);
		});

		it('morning slot fires at 07:00 local on the event day', () => {
			const items = buildScheduleItems(entry());
			const morning = items.find((i) => i.kind === 'morning')!;
			const fire = new Date(morning.fireAt);
			expect(fire.getFullYear()).toBe(2026);
			expect(fire.getMonth()).toBe(3); // April (0-based)
			expect(fire.getDate()).toBe(15);
			expect(fire.getHours()).toBe(7);
			expect(fire.getMinutes()).toBe(0);
		});

		it('pre1h slot fires exactly 1 hour before event time', () => {
			const items = buildScheduleItems(entry());
			const pre1h = items.find((i) => i.kind === 'pre1h')!;
			const event = new Date(pre1h.eventAt);
			const fire = new Date(pre1h.fireAt);
			expect(fire.getTime()).toBe(event.getTime() - 60 * 60_000);
		});

		it('at slot fires exactly at event time', () => {
			const items = buildScheduleItems(entry());
			const at = items.find((i) => i.kind === 'at')!;
			expect(at.fireAt).toBe(at.eventAt);
		});

		it('eventAt is the same wall time across all 3 slots', () => {
			const items = buildScheduleItems(entry());
			const eventTimes = new Set(items.map((i) => i.eventAt));
			expect(eventTimes.size).toBe(1);
		});

		it('hasTime is true on every slot', () => {
			expect(buildScheduleItems(entry()).every((i) => i.hasTime)).toBe(true);
		});

		it('PM late time: pre1h at 22:59, at at 23:59', () => {
			const items = buildScheduleItems(
				entry({ time: { h: 23, m: 59 }, label: 'late', rawLine: '15 late 23시 59분' })
			);
			const pre1h = items.find((i) => i.kind === 'pre1h')!;
			const at = items.find((i) => i.kind === 'at')!;
			const pf = new Date(pre1h.fireAt);
			const af = new Date(at.fireAt);
			expect(pf.getHours()).toBe(22);
			expect(pf.getMinutes()).toBe(59);
			expect(af.getHours()).toBe(23);
			expect(af.getMinutes()).toBe(59);
		});

		it('early-morning event: pre1h crosses into the previous day', () => {
			const items = buildScheduleItems(
				entry({ time: { h: 0, m: 30 }, label: '심야', rawLine: '15 심야 오전 12시 30분' })
			);
			const pre1h = items.find((i) => i.kind === 'pre1h')!;
			const fire = new Date(pre1h.fireAt);
			expect(fire.getDate()).toBe(14); // previous day
			expect(fire.getHours()).toBe(23);
			expect(fire.getMinutes()).toBe(30);
		});
	});

	describe('date-only entry', () => {
		it('emits exactly 1 slot of kind morning', () => {
			const items = buildScheduleItems(
				entry({ time: null, label: '빨래', rawLine: '16 빨래', day: 16 })
			);
			expect(items).toHaveLength(1);
			expect(items[0].kind).toBe('morning');
			expect(items[0].hasTime).toBe(false);
		});

		it('morning fires at 07:00, eventAt is 00:00 of the same day', () => {
			const items = buildScheduleItems(
				entry({ time: null, label: '빨래', rawLine: '16 빨래', day: 16 })
			);
			const event = new Date(items[0].eventAt);
			const fire = new Date(items[0].fireAt);
			expect(event.getDate()).toBe(16);
			expect(event.getHours()).toBe(0);
			expect(event.getMinutes()).toBe(0);
			expect(fire.getDate()).toBe(16);
			expect(fire.getHours()).toBe(7);
			expect(fire.getMinutes()).toBe(0);
		});
	});

	describe('id stability', () => {
		it('same date|time|label → same ids per kind', () => {
			const a = buildScheduleItems(entry());
			const b = buildScheduleItems(entry());
			const byKindA = new Map(a.map((i) => [i.kind, i.id]));
			const byKindB = new Map(b.map((i) => [i.kind, i.id]));
			for (const k of byKindA.keys()) {
				expect(byKindA.get(k)).toBe(byKindB.get(k));
			}
		});

		it('all 3 slots have distinct ids (kind participates in hash)', () => {
			const ids = new Set(buildScheduleItems(entry()).map((i) => i.id));
			expect(ids.size).toBe(3);
		});

		it('label change → all slot ids change', () => {
			const a = buildScheduleItems(entry({ label: '등산' }));
			const b = buildScheduleItems(entry({ label: '하이킹' }));
			const aIds = new Set(a.map((i) => i.id));
			const bIds = new Set(b.map((i) => i.id));
			for (const id of aIds) expect(bIds.has(id)).toBe(false);
		});

		it('time change → all slot ids change (incl. morning, since time is in hash)', () => {
			const a = buildScheduleItems(entry({ time: { h: 19, m: 0 } }));
			const b = buildScheduleItems(entry({ time: { h: 18, m: 30 } }));
			const aMorning = a.find((i) => i.kind === 'morning')!.id;
			const bMorning = b.find((i) => i.kind === 'morning')!.id;
			expect(aMorning).not.toBe(bMorning);
		});

		it('time present vs absent (same label/date) → morning ids differ', () => {
			const a = buildScheduleItems(entry({ time: { h: 19, m: 0 } }));
			const b = buildScheduleItems(entry({ time: null }));
			const aMorning = a.find((i) => i.kind === 'morning')!.id;
			const bMorning = b.find((i) => i.kind === 'morning')!.id;
			expect(aMorning).not.toBe(bMorning);
		});

		it('day change → all slot ids change', () => {
			const a = buildScheduleItems(entry({ day: 15 }));
			const b = buildScheduleItems(entry({ day: 16 }));
			const aIds = new Set(a.map((i) => i.id));
			const bIds = new Set(b.map((i) => i.id));
			for (const id of aIds) expect(bIds.has(id)).toBe(false);
		});

		it('every id is a 16-char hex string', () => {
			for (const item of buildScheduleItems(entry())) {
				expect(item.id).toMatch(/^[0-9a-f]{16}$/);
			}
		});
	});

	describe('payload fields', () => {
		it('every slot carries the same label and date components', () => {
			const items = buildScheduleItems(entry());
			for (const item of items) {
				expect(item.label).toBe('등산');
				expect(item.year).toBe(2026);
				expect(item.month).toBe(4);
				expect(item.day).toBe(15);
			}
		});
	});
});
