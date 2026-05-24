import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import {
	buildDateNoteScheduleSeed,
	extractUncheckedFromYesterdayNote
} from '$lib/schedule/dateNoteSeed.js';
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
function liChecked(text: string, checked: boolean): JSONContent {
	return { type: 'listItem', attrs: { checked }, content: [p(text)] };
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

function checklistDoc(title: string, ...items: JSONContent[]): JSONContent {
	return {
		type: 'doc',
		content: [p(title), p('체크리스트:'), { type: 'bulletList', content: items }]
	};
}

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

	it('returns checklist blocks for matching entries (single match)', async () => {
		await setScheduleNote('sched-guid');
		const note = makeNote(
			'sched-guid',
			noteDoc(['15(수) 독서모임 7시'])
		);
		await putNote(note);
		const result = await buildDateNoteScheduleSeed(2026, 4, 15);
		expect(result).toEqual([
			p('체크리스트:'),
			ul(liChecked('독서모임 7시', false))
		]);
	});

	it('returns checklist blocks for multiple matches in input order, day-prefix stripped', async () => {
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
			p('체크리스트:'),
			ul(
				liChecked('독서', false),
				liChecked('독서모임 7시', false),
				liChecked('산책 8시', false)
			)
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

describe('extractUncheckedFromYesterdayNote', () => {
	it('returns [] when yesterday note does not exist', async () => {
		const result = await extractUncheckedFromYesterdayNote(2026, 5, 24);
		expect(result).toEqual([]);
	});

	it('returns [] when yesterday note is soft-deleted', async () => {
		const note = makeNote(
			'y-guid',
			checklistDoc('2026-05-23', liChecked('할 일', false)),
			{ title: '2026-05-23', deleted: true }
		);
		await putNote(note);
		const result = await extractUncheckedFromYesterdayNote(2026, 5, 24);
		expect(result).toEqual([]);
	});

	it('returns [] when yesterday note has no checklist region', async () => {
		const note = makeNote(
			'y-guid',
			{ type: 'doc', content: [p('2026-05-23'), p('그냥 메모')] },
			{ title: '2026-05-23' }
		);
		await putNote(note);
		const result = await extractUncheckedFromYesterdayNote(2026, 5, 24);
		expect(result).toEqual([]);
	});

	it('extracts unchecked items from yesterday note', async () => {
		const note = makeNote(
			'y-guid',
			checklistDoc(
				'2026-05-23',
				liChecked('완료된 일', true),
				liChecked('남은 일 1', false),
				liChecked('남은 일 2', false)
			),
			{ title: '2026-05-23' }
		);
		await putNote(note);
		const result = await extractUncheckedFromYesterdayNote(2026, 5, 24);
		expect(result).toEqual([
			liChecked('남은 일 1', false),
			liChecked('남은 일 2', false)
		]);
	});

	it('month boundary: 2026-05-01 → looks up 2026-04-30', async () => {
		const note = makeNote(
			'y-guid',
			checklistDoc('2026-04-30', liChecked('월말 미완', false)),
			{ title: '2026-04-30' }
		);
		await putNote(note);
		const result = await extractUncheckedFromYesterdayNote(2026, 5, 1);
		expect(result).toEqual([liChecked('월말 미완', false)]);
	});

	it('year boundary: 2026-01-01 → looks up 2025-12-31', async () => {
		const note = makeNote(
			'y-guid',
			checklistDoc('2025-12-31', liChecked('연말 미완', false)),
			{ title: '2025-12-31' }
		);
		await putNote(note);
		const result = await extractUncheckedFromYesterdayNote(2026, 1, 1);
		expect(result).toEqual([liChecked('연말 미완', false)]);
	});

	it('returns [] (does not throw) when yesterday note xmlContent is corrupt', async () => {
		const note = makeNote(
			'y-guid',
			checklistDoc('2026-05-23', liChecked('할 일', false)),
			{ title: '2026-05-23' }
		);
		note.xmlContent = '<note-content version="0.1"><<broken<<';
		await putNote(note);
		const result = await extractUncheckedFromYesterdayNote(2026, 5, 24);
		expect(result).toEqual([]);
	});
});
