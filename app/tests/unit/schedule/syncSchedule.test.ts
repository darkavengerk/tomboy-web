import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { syncScheduleFromNote } from '$lib/schedule/syncSchedule.js';
import {
	setScheduleNote,
	_resetScheduleCacheForTest
} from '$lib/core/schedule.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { loadPendingScheduleState } from '$lib/schedule/schedulePending.js';
import {
	saveScheduleSnapshot,
	loadScheduleSnapshot
} from '$lib/schedule/scheduleSnapshot.js';
import { serializeContent } from '$lib/core/noteContentArchiver.js';
import type { NoteData } from '$lib/core/note.js';
import type { JSONContent } from '@tiptap/core';

const April25 = new Date(2026, 3, 25);

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	_resetScheduleCacheForTest();
});

function p(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function li(text: string): JSONContent {
	return { type: 'listItem', content: [p(text)] };
}
function ul(...items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}
function makeNote(guid: string, doc: JSONContent): NoteData {
	return {
		uri: `note://tomboy/${guid}`,
		guid,
		title: '일정',
		xmlContent: serializeContent(doc),
		createDate: '2026-04-01T00:00:00.0000000+09:00',
		changeDate: '2026-04-25T00:00:00.0000000+09:00',
		metadataChangeDate: '2026-04-25T00:00:00.0000000+09:00',
		cursorPosition: 0,
		selectionBoundPosition: -1,
		width: 450,
		height: 360,
		x: 0,
		y: 0,
		tags: [],
		openOnStartup: false,
		localDirty: false,
		deleted: false
	};
}

const noteDoc = (lines: string[]) => {
	const items = lines.map((l) => li(l));
	return { type: 'doc', content: [p('일정'), p('4월'), ul(...items)] } as JSONContent;
};

describe('syncScheduleFromNote', () => {
	it('noop when no schedule note is configured', async () => {
		const note = makeNote('some-guid', noteDoc(['15(금) 등산 7시']));
		const result = await syncScheduleFromNote(note, April25);
		expect(result).toEqual({ added: 0, removed: 0, isScheduleNote: false });
		expect(await loadPendingScheduleState()).toBeNull();
	});

	it('noop when the saved note is not the schedule note', async () => {
		await setScheduleNote('other-guid');
		const note = makeNote('some-guid', noteDoc(['15(금) 등산 7시']));
		const result = await syncScheduleFromNote(note, April25);
		expect(result.isScheduleNote).toBe(false);
		expect(await loadPendingScheduleState()).toBeNull();
	});

	it('first save with fresh snapshot: all parsed items go to pending as added', async () => {
		await setScheduleNote('sched-guid');
		const note = makeNote('sched-guid', noteDoc([
			'15(금) 등산 7시',
			'16(토) 빨래'
		]));
		const result = await syncScheduleFromNote(note, April25);
		expect(result.isScheduleNote).toBe(true);
		expect(result.added).toBe(2);
		expect(result.removed).toBe(0);

		const pending = await loadPendingScheduleState();
		expect(pending?.noteGuid).toBe('sched-guid');
		expect(pending?.added.map((x) => x.label).sort()).toEqual(['등산', '빨래']);
		expect(pending?.removed).toEqual([]);
		expect(pending?.curr).toHaveLength(2);
	});

	it('identical content: no diff, no pending written, no pending cleared', async () => {
		await setScheduleNote('sched-guid');
		const note = makeNote('sched-guid', noteDoc(['15(금) 등산 7시']));
		// First save: creates pending AND snapshot would be updated only after flush.
		// Seed snapshot manually to simulate post-flush state.
		const firstResult = await syncScheduleFromNote(note, April25);
		const pending = await loadPendingScheduleState();
		await saveScheduleSnapshot('sched-guid', pending!.curr);
		// Emulate flush completing; snapshot now matches curr.

		// Second save with identical content → no diff.
		const result = await syncScheduleFromNote(note, April25);
		expect(result.added).toBe(0);
		expect(result.removed).toBe(0);
		expect(firstResult.added).toBe(1);
	});

	it('after snapshot seeded: edit produces add+remove in pending', async () => {
		await setScheduleNote('sched-guid');
		// Seed snapshot with one item: "등산 7시"
		const oldNote = makeNote('sched-guid', noteDoc(['15(금) 등산 7시']));
		await syncScheduleFromNote(oldNote, April25);
		const p1 = await loadPendingScheduleState();
		await saveScheduleSnapshot('sched-guid', p1!.curr);

		// Now user edits: change to "등산 8시"
		const newNote = makeNote('sched-guid', noteDoc(['15(금) 등산 8시']));
		const result = await syncScheduleFromNote(newNote, April25);
		expect(result.added).toBe(1);
		expect(result.removed).toBe(1);

		const pending = await loadPendingScheduleState();
		expect(pending?.added[0].label).toBe('등산');
		expect(pending?.added[0].hasTime).toBe(true);
		expect(pending?.removed[0].label).toBe('등산');
	});

	it('deleting an item: diff shows only remove', async () => {
		await setScheduleNote('sched-guid');
		const oldNote = makeNote('sched-guid', noteDoc(['15 등산 7시', '16 빨래']));
		await syncScheduleFromNote(oldNote, April25);
		await saveScheduleSnapshot(
			'sched-guid',
			(await loadPendingScheduleState())!.curr
		);

		const newNote = makeNote('sched-guid', noteDoc(['15 등산 7시']));
		const result = await syncScheduleFromNote(newNote, April25);
		expect(result.added).toBe(0);
		expect(result.removed).toBe(1);
		expect((await loadPendingScheduleState())?.removed[0].label).toBe('빨래');
	});

	it('does NOT update snapshot itself (that is the flusher\'s job)', async () => {
		await setScheduleNote('sched-guid');
		const note = makeNote('sched-guid', noteDoc(['15(금) 등산 7시']));
		await syncScheduleFromNote(note, April25);
		// Snapshot untouched — only pending has the curr.
		expect(await loadScheduleSnapshot('sched-guid')).toEqual([]);
	});
});
