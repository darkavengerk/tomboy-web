import { describe, it, expect } from 'vitest';
import { diffSchedules } from '$lib/schedule/diff.js';
import type { ScheduleItem } from '$lib/schedule/buildScheduleItem.js';

function it_(id: string, label = 'x'): ScheduleItem {
	return {
		id,
		year: 2026,
		month: 4,
		day: 15,
		hasTime: true,
		label,
		eventAt: '2026-04-15T10:00:00.000Z',
		fireAt: '2026-04-15T09:30:00.000Z'
	};
}

describe('diffSchedules', () => {
	it('empty → empty: no changes', () => {
		expect(diffSchedules([], [])).toEqual({ added: [], removed: [] });
	});

	it('empty → 3 items: all added, none removed', () => {
		const r = diffSchedules([], [it_('a'), it_('b'), it_('c')]);
		expect(r.added.map((x) => x.id)).toEqual(['a', 'b', 'c']);
		expect(r.removed).toEqual([]);
	});

	it('identical sets: no changes', () => {
		const items = [it_('a'), it_('b')];
		expect(diffSchedules(items, items)).toEqual({ added: [], removed: [] });
	});

	it('one removed', () => {
		const r = diffSchedules([it_('a'), it_('b')], [it_('a')]);
		expect(r.added).toEqual([]);
		expect(r.removed.map((x) => x.id)).toEqual(['b']);
	});

	it('one added', () => {
		const r = diffSchedules([it_('a')], [it_('a'), it_('c')]);
		expect(r.added.map((x) => x.id)).toEqual(['c']);
		expect(r.removed).toEqual([]);
	});

	it('label change → add new id, remove old id', () => {
		const r = diffSchedules([it_('old', '등산')], [it_('new', '하이킹')]);
		expect(r.added.map((x) => x.id)).toEqual(['new']);
		expect(r.removed.map((x) => x.id)).toEqual(['old']);
	});

	it('handles duplicate ids in input gracefully (dedups)', () => {
		const r = diffSchedules([it_('a'), it_('a')], [it_('a')]);
		expect(r.added).toEqual([]);
		expect(r.removed).toEqual([]);
	});
});
