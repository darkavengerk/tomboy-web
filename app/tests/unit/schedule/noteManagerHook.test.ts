import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { createNote, updateNoteFromEditor } from '$lib/core/noteManager.js';
import {
	setScheduleNote,
	_resetScheduleCacheForTest
} from '$lib/core/schedule.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { loadPendingScheduleState } from '$lib/schedule/schedulePending.js';
import type { JSONContent } from '@tiptap/core';

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

describe('noteManager.updateNoteFromEditor → schedule sync hook', () => {
	it('writes pending state when editing the configured schedule note', async () => {
		// Make today be in the right month for items to land in the diff.
		const today = new Date();
		const month = today.getMonth() + 1;
		const note = await createNote('일정');
		await setScheduleNote(note.guid);

		const doc: JSONContent = {
			type: 'doc',
			content: [p('일정'), p(`${month}월`), ul(li('15(금) 등산 7시'))]
		};
		// Use a date the month-of-year actually contains. We can use today.
		// 28 is safe for every month; pick the line accordingly.
		const safeDay = Math.min(today.getDate(), 28);
		const docSafe: JSONContent = {
			type: 'doc',
			content: [p('일정'), p(`${month}월`), ul(li(`${safeDay} 등산 7시`))]
		};
		await updateNoteFromEditor(note.guid, docSafe);

		const pending = await loadPendingScheduleState();
		expect(pending?.noteGuid).toBe(note.guid);
		expect(pending?.added).toHaveLength(1);
		expect(pending?.added[0].label).toBe('등산');
	});

	it('does NOT write pending state when editing an unrelated note', async () => {
		const sched = await createNote('일정');
		await setScheduleNote(sched.guid);

		const other = await createNote('잡담');
		const doc: JSONContent = {
			type: 'doc',
			content: [p('잡담'), p('아무말')]
		};
		await updateNoteFromEditor(other.guid, doc);
		expect(await loadPendingScheduleState()).toBeNull();
	});

	it('does NOT write pending state when no schedule note is configured', async () => {
		const note = await createNote('일정');
		const doc: JSONContent = {
			type: 'doc',
			content: [p('일정'), p('4월'), ul(li('15(금) 등산 7시'))]
		};
		await updateNoteFromEditor(note.guid, doc);
		expect(await loadPendingScheduleState()).toBeNull();
	});
});
