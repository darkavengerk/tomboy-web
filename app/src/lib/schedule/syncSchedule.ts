/**
 * Orchestrator: parse the schedule note, diff against the last-uploaded
 * snapshot, and stash the delta in `schedulePending` for the Phase-7 flusher
 * to push to Firestore. Snapshot promotion happens only on successful flush.
 */
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import type { NoteData } from '$lib/core/note.js';
import { getScheduleNoteGuid } from '$lib/core/schedule.js';
import { buildScheduleItem } from './buildScheduleItem.js';
import { diffSchedules } from './diff.js';
import { parseScheduleNote } from './parseSchedule.js';
import { loadScheduleSnapshot } from './scheduleSnapshot.js';
import {
	clearPendingScheduleState,
	loadPendingScheduleState,
	savePendingScheduleState
} from './schedulePending.js';

export interface SyncScheduleResult {
	isScheduleNote: boolean;
	added: number;
	removed: number;
}

export async function syncScheduleFromNote(
	note: NoteData,
	now: Date
): Promise<SyncScheduleResult> {
	const targetGuid = await getScheduleNoteGuid();
	if (!targetGuid || targetGuid !== note.guid) {
		return { isScheduleNote: false, added: 0, removed: 0 };
	}

	const doc = deserializeContent(note.xmlContent);
	const entries = parseScheduleNote(doc, now);
	const curr = entries.map(buildScheduleItem);
	const prev = await loadScheduleSnapshot(note.guid);
	const diff = diffSchedules(prev, curr);

	if (diff.added.length === 0 && diff.removed.length === 0) {
		// No diff vs snapshot. If a stale pending exists (e.g. user undid the
		// edit before flush), drop it so the flusher doesn't make redundant
		// calls.
		const stale = await loadPendingScheduleState();
		if (stale && stale.noteGuid === note.guid) {
			await clearPendingScheduleState();
		}
		return { isScheduleNote: true, added: 0, removed: 0 };
	}

	await savePendingScheduleState({
		noteGuid: note.guid,
		computedAt: now.toISOString(),
		curr,
		added: diff.added,
		removed: diff.removed
	});

	return {
		isScheduleNote: true,
		added: diff.added.length,
		removed: diff.removed.length
	};
}
