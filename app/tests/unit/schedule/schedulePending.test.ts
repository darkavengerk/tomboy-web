import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import {
	loadPendingScheduleState,
	clearPendingScheduleState,
	savePendingScheduleState
} from '$lib/schedule/schedulePending.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import type { ScheduleItem } from '$lib/schedule/buildScheduleItem.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

function item(id: string): ScheduleItem {
	return {
		id,
		year: 2026,
		month: 4,
		day: 15,
		hasTime: true,
		label: 'x',
		eventAt: '2026-04-15T10:00:00.000Z',
		fireAt: '2026-04-15T09:30:00.000Z'
	};
}

describe('schedulePending', () => {
	it('returns null when nothing pending', async () => {
		expect(await loadPendingScheduleState()).toBeNull();
	});

	it('save then load round-trips', async () => {
		const state = {
			noteGuid: 'g1',
			computedAt: '2026-04-25T00:00:00.000Z',
			curr: [item('a')],
			added: [item('a')],
			removed: []
		};
		await savePendingScheduleState(state);
		expect(await loadPendingScheduleState()).toEqual(state);
	});

	it('save overwrites previous state (single global slot)', async () => {
		await savePendingScheduleState({
			noteGuid: 'g1',
			computedAt: 't1',
			curr: [item('a')],
			added: [item('a')],
			removed: []
		});
		await savePendingScheduleState({
			noteGuid: 'g1',
			computedAt: 't2',
			curr: [item('b')],
			added: [item('b')],
			removed: [item('a')]
		});
		const loaded = await loadPendingScheduleState();
		expect(loaded?.computedAt).toBe('t2');
		expect(loaded?.added.map((x) => x.id)).toEqual(['b']);
	});

	it('clear removes pending state', async () => {
		await savePendingScheduleState({
			noteGuid: 'g1',
			computedAt: 't',
			curr: [],
			added: [],
			removed: []
		});
		await clearPendingScheduleState();
		expect(await loadPendingScheduleState()).toBeNull();
	});
});
