import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildDateNoteScheduleSeed } from '$lib/schedule/dateNoteSeed.js';
import {
	setScheduleNote,
	_resetScheduleCacheForTest
} from '$lib/core/schedule.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote } from '$lib/storage/noteStore.js';
import { serializeContent } from '$lib/core/noteContentArchiver.js';
import type { NoteData } from '$lib/core/note.js';
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
function makeNote(
	guid: string,
	doc: JSONContent,
	overrides: Partial<NoteData> = {}
): NoteData {
	return {
		uri: `note://tomboy/${guid}`,
		guid,
		title: '일정',
		xmlContent: serializeContent(doc),
		createDate: '2026-04-01T00:00:00.0000000+09:00',
		changeDate: '2026-04-15T00:00:00.0000000+09:00',
		metadataChangeDate: '2026-04-15T00:00:00.0000000+09:00',
		cursorPosition: 0,
		selectionBoundPosition: -1,
		width: 450,
		height: 360,
		x: 0,
		y: 0,
		tags: [],
		openOnStartup: false,
		localDirty: false,
		deleted: false,
		...overrides
	};
}

const noteDoc = (lines: string[]) => {
	const items = lines.map((l) => li(l));
	return { type: 'doc', content: [p('일정'), p('4월'), ul(...items)] } as JSONContent;
};

describe('buildDateNoteScheduleSeed', () => {
	it('returns [] when no schedule note is configured', async () => {
		const result = await buildDateNoteScheduleSeed(2026, 4, 15);
		expect(result).toEqual([]);
	});

	it("returns [] when configured schedule note doesn't exist in IDB", async () => {
		await setScheduleNote('missing-guid');
		const result = await buildDateNoteScheduleSeed(2026, 4, 15);
		expect(result).toEqual([]);
	});

	it('returns [] when schedule note has no entries for that date', async () => {
		await setScheduleNote('sched-guid');
		const note = makeNote(
			'sched-guid',
			{ type: 'doc', content: [p('일정'), p('Just a note')] }
		);
		await putNote(note);
		const result = await buildDateNoteScheduleSeed(2026, 4, 15);
		expect(result).toEqual([]);
	});

	it('returns TODO blocks for matching entries (single match)', async () => {
		await setScheduleNote('sched-guid');
		const note = makeNote(
			'sched-guid',
			noteDoc(['15(수) 독서모임 7시'])
		);
		await putNote(note);
		const result = await buildDateNoteScheduleSeed(2026, 4, 15);
		expect(result).toEqual([
			p('TODO:'),
			ul(li('독서모임 7시'))
		]);
	});

	it('returns TODO blocks for multiple matches in input order, day-prefix stripped', async () => {
		await setScheduleNote('sched-guid');
		const note = makeNote(
			'sched-guid',
			noteDoc([
				'15(수) 독서',
				'15(수) 독서모임 7시',
				'16(목) 빨래',
				'15(수) 산책 8시'
			])
		);
		await putNote(note);
		const result = await buildDateNoteScheduleSeed(2026, 4, 15);
		expect(result).toEqual([
			p('TODO:'),
			ul(li('독서'), li('독서모임 7시'), li('산책 8시'))
		]);
	});

	it('returns [] when schedule entries are on different day', async () => {
		await setScheduleNote('sched-guid');
		const note = makeNote(
			'sched-guid',
			noteDoc(['16(목) 빨래'])
		);
		await putNote(note);
		const result = await buildDateNoteScheduleSeed(2026, 4, 15);
		expect(result).toEqual([]);
	});

	it('returns [] when schedule note is soft-deleted', async () => {
		await setScheduleNote('sched-guid');
		const note = makeNote(
			'sched-guid',
			noteDoc(['15(수) 독서모임 7시']),
			{ deleted: true }
		);
		await putNote(note);
		const result = await buildDateNoteScheduleSeed(2026, 4, 15);
		expect(result).toEqual([]);
	});
});
