import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPendingScheduleState } from '$lib/schedule/flushPendingSchedule.js';
import {
	loadPendingScheduleState,
	savePendingScheduleState
} from '$lib/schedule/schedulePending.js';
import { loadScheduleSnapshot } from '$lib/schedule/scheduleSnapshot.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import type { ScheduleItem } from '$lib/schedule/buildScheduleItem.js';
import type { ScheduleRemoteClient } from '$lib/schedule/scheduleClient.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

function item(id: string, label = 'x'): ScheduleItem {
	return {
		id,
		year: 2026,
		month: 4,
		day: 15,
		hasTime: true,
		label,
		kind: 'at',
		eventAt: '2026-04-15T10:00:00.000Z',
		fireAt: '2026-04-15T09:30:00.000Z'
	};
}

function fakeClient(): ScheduleRemoteClient & {
	upserts: ScheduleItem[];
	deletes: string[];
	failNext: boolean;
} {
	const c = {
		upserts: [] as ScheduleItem[],
		deletes: [] as string[],
		failNext: false,
		async upsertScheduleItems(items: ScheduleItem[]) {
			if (c.failNext) throw new Error('fake-upsert-fail');
			c.upserts.push(...items);
		},
		async deleteScheduleItems(ids: string[]) {
			if (c.failNext) throw new Error('fake-delete-fail');
			c.deletes.push(...ids);
		},
		async registerDevice() {
			/* unused here */
		}
	};
	return c;
}

describe('flushPendingScheduleState', () => {
	it('noop when nothing pending', async () => {
		const client = fakeClient();
		const result = await flushPendingScheduleState(client);
		expect(result).toEqual({ flushed: false, added: 0, removed: 0 });
		expect(client.upserts).toEqual([]);
		expect(client.deletes).toEqual([]);
	});

	it('happy path: applies adds + removes, then promotes snapshot and clears pending', async () => {
		const curr = [item('a', '등산'), item('b', '빨래')];
		await savePendingScheduleState({
			noteGuid: 'g1',
			computedAt: 't',
			curr,
			added: curr,
			removed: [item('old', '옛것')]
		});
		const client = fakeClient();
		const result = await flushPendingScheduleState(client);
		expect(result).toEqual({ flushed: true, added: 2, removed: 1 });
		expect(client.upserts.map((x) => x.id).sort()).toEqual(['a', 'b']);
		expect(client.deletes).toEqual(['old']);
		expect(await loadPendingScheduleState()).toBeNull();
		expect((await loadScheduleSnapshot('g1')).map((x) => x.id).sort()).toEqual([
			'a',
			'b'
		]);
	});

	it('client failure leaves pending and snapshot unchanged', async () => {
		const curr = [item('a')];
		await savePendingScheduleState({
			noteGuid: 'g1',
			computedAt: 't',
			curr,
			added: curr,
			removed: []
		});
		const client = fakeClient();
		client.failNext = true;
		const result = await flushPendingScheduleState(client);
		expect(result.flushed).toBe(false);
		expect(await loadPendingScheduleState()).not.toBeNull();
		expect(await loadScheduleSnapshot('g1')).toEqual([]);
	});

	it('skips Firestore call when both added and removed are empty (still promotes snapshot to track curr)', async () => {
		// Edge: pending exists with curr matching snapshot but neither added nor
		// removed (defensive — shouldn't normally happen since syncSchedule clears
		// in that case). Behaviour: just clear pending, no remote calls.
		await savePendingScheduleState({
			noteGuid: 'g1',
			computedAt: 't',
			curr: [item('a')],
			added: [],
			removed: []
		});
		const client = fakeClient();
		const upsertSpy = vi.spyOn(client, 'upsertScheduleItems');
		const deleteSpy = vi.spyOn(client, 'deleteScheduleItems');
		const result = await flushPendingScheduleState(client);
		expect(result.flushed).toBe(true);
		expect(upsertSpy).not.toHaveBeenCalled();
		expect(deleteSpy).not.toHaveBeenCalled();
		expect(await loadPendingScheduleState()).toBeNull();
	});
});
