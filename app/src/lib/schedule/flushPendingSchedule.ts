/**
 * Apply the pending schedule diff to Firestore via a `ScheduleRemoteClient`,
 * then promote `curr` to the snapshot and clear the pending slot.
 *
 * Failures leave both pending and snapshot intact so the next flush retries
 * the full diff (Firestore upsert/delete are idempotent).
 */
import { saveScheduleSnapshot } from './scheduleSnapshot.js';
import {
	clearPendingScheduleState,
	loadPendingScheduleState
} from './schedulePending.js';
import type { ScheduleRemoteClient } from './scheduleClient.js';

export interface FlushResult {
	flushed: boolean;
	added: number;
	removed: number;
}

export async function flushPendingScheduleState(
	client: ScheduleRemoteClient
): Promise<FlushResult> {
	const pending = await loadPendingScheduleState();
	if (!pending) return { flushed: false, added: 0, removed: 0 };

	try {
		if (pending.added.length > 0) {
			await client.upsertScheduleItems(pending.added);
		}
		if (pending.removed.length > 0) {
			await client.deleteScheduleItems(pending.removed.map((r) => r.id));
		}
	} catch (err) {
		console.warn('[schedule] flush failed; pending preserved for retry', err);
		return { flushed: false, added: 0, removed: 0 };
	}
	await saveScheduleSnapshot(pending.noteGuid, pending.curr);
	await clearPendingScheduleState();
	return { flushed: true, added: pending.added.length, removed: pending.removed.length };
}
