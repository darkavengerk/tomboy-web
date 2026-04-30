import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import {
	saveScheduleSnapshot,
	loadScheduleSnapshot,
	clearScheduleSnapshot
} from '$lib/schedule/scheduleSnapshot.js';
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
		kind: 'at',
		eventAt: '2026-04-15T10:00:00.000Z',
		fireAt: '2026-04-15T09:30:00.000Z'
	};
}

describe('scheduleSnapshot', () => {
	it('round-trips: save then load returns the same items', async () => {
		const items = [item('a'), item('b')];
		await saveScheduleSnapshot('guid-1', items);
		const loaded = await loadScheduleSnapshot('guid-1');
		expect(loaded).toEqual(items);
	});

	it('returns empty array when nothing saved', async () => {
		expect(await loadScheduleSnapshot('guid-fresh')).toEqual([]);
	});

	it('overwrites previous snapshot', async () => {
		await saveScheduleSnapshot('g', [item('a')]);
		await saveScheduleSnapshot('g', [item('b')]);
		const loaded = await loadScheduleSnapshot('g');
		expect(loaded.map((x) => x.id)).toEqual(['b']);
	});

	it('keyed by note guid (separate snapshots per note)', async () => {
		await saveScheduleSnapshot('g1', [item('a')]);
		await saveScheduleSnapshot('g2', [item('b')]);
		expect((await loadScheduleSnapshot('g1')).map((x) => x.id)).toEqual(['a']);
		expect((await loadScheduleSnapshot('g2')).map((x) => x.id)).toEqual(['b']);
	});

	it('clearScheduleSnapshot removes the snapshot', async () => {
		await saveScheduleSnapshot('g', [item('a')]);
		await clearScheduleSnapshot('g');
		expect(await loadScheduleSnapshot('g')).toEqual([]);
	});
});
