/**
 * Single-slot pending state — the diff a caller has computed but not yet
 * pushed to Firestore. The flusher (Phase 7) reads this, applies it, then
 * promotes `curr` to the snapshot and clears the slot.
 *
 * One slot is enough for v1 because `syncScheduleFromNote` always
 * recomputes the diff against the snapshot before writing here, so a
 * subsequent edit naturally subsumes prior unflushed deltas.
 */
import { getSetting, setSetting, deleteSetting } from '$lib/storage/appSettings.js';
import type { ScheduleItem } from './buildScheduleItem.js';

const KEY = 'schedule.pending';

export interface PendingScheduleState {
	noteGuid: string;
	/** ISO timestamp of when the diff was computed. For diagnostics only. */
	computedAt: string;
	/** Items the schedule note currently parses to — the next snapshot. */
	curr: ScheduleItem[];
	added: ScheduleItem[];
	removed: ScheduleItem[];
}

export async function savePendingScheduleState(state: PendingScheduleState): Promise<void> {
	await setSetting(KEY, state);
}

export async function loadPendingScheduleState(): Promise<PendingScheduleState | null> {
	const v = await getSetting<PendingScheduleState>(KEY);
	return v ?? null;
}

export async function clearPendingScheduleState(): Promise<void> {
	await deleteSetting(KEY);
}
