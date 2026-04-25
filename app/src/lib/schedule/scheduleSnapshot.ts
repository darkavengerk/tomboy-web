/**
 * Per-note snapshot of the last-uploaded schedule items, persisted to
 * `appSettings`. Used as the `prev` side of `diffSchedules` so the next save
 * only emits add/remove deltas to Firestore.
 */
import { getSetting, setSetting, deleteSetting } from '$lib/storage/appSettings.js';
import type { ScheduleItem } from './buildScheduleItem.js';

const KEY_PREFIX = 'schedule.snapshot.';

function key(noteGuid: string): string {
	return KEY_PREFIX + noteGuid;
}

export async function saveScheduleSnapshot(
	noteGuid: string,
	items: ScheduleItem[]
): Promise<void> {
	await setSetting(key(noteGuid), items);
}

export async function loadScheduleSnapshot(noteGuid: string): Promise<ScheduleItem[]> {
	const v = await getSetting<ScheduleItem[]>(key(noteGuid));
	return v ?? [];
}

export async function clearScheduleSnapshot(noteGuid: string): Promise<void> {
	await deleteSetting(key(noteGuid));
}
