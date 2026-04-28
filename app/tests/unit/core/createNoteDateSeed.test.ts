import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { createNote } from '$lib/core/noteManager.js';
import {
	setScheduleNote,
	_resetScheduleCacheForTest
} from '$lib/core/schedule.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote } from '$lib/storage/noteStore.js';
import {
	serializeContent,
	deserializeContent
} from '$lib/core/noteContentArchiver.js';
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
function makeNote(guid: string, doc: JSONContent): NoteData {
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
		deleted: false
	};
}

const noteDoc = (lines: string[]) => {
	const items = lines.map((l) => li(l));
	return { type: 'doc', content: [p('일정'), p('4월'), ul(...items)] } as JSONContent;
};

describe('createNote — date-titled seeding', () => {
	it('non-date title: existing behavior unchanged', async () => {
		const note = await createNote('My Note');
		expect(note.title).toBe('My Note');
		expect(note.xmlContent).toBe(
			'<note-content version="0.1">My Note\n\n</note-content>'
		);
	});

	it('date title with no schedule note configured: default seed only', async () => {
		const note = await createNote('2026-04-15');
		expect(note.title).toBe('2026-04-15');
		expect(note.xmlContent).toBe(
			'<note-content version="0.1">2026-04-15\n2026년\n</note-content>'
		);
	});

	it('date title with matching schedule entries: seeds TODO + bullet list', async () => {
		await setScheduleNote('sched-guid');
		await putNote(
			makeNote(
				'sched-guid',
				noteDoc(['15(수) 독서', '15(수) 독서모임 7시', '16(목) 빨래'])
			)
		);

		const note = await createNote('2026-04-15');
		expect(note.title).toBe('2026-04-15');

		// Round-trip the persisted XML so we assert structure, not formatting.
		const doc = deserializeContent(note.xmlContent);
		const content = doc.content ?? [];

		// First three blocks: title, "2026년", blank paragraph.
		expect(content[0]).toEqual(p('2026-04-15'));
		expect(content[1]).toEqual(p('2026년'));
		expect(content[2]?.type).toBe('paragraph');

		// Then the seed: paragraph "TODO:" and a bulletList.
		const todoIdx = content.findIndex(
			(b) =>
				b.type === 'paragraph' &&
				b.content?.[0]?.type === 'text' &&
				b.content?.[0]?.text === 'TODO:'
		);
		expect(todoIdx).toBeGreaterThan(-1);
		const bulletList = content[todoIdx + 1];
		expect(bulletList?.type).toBe('bulletList');
		const labels = (bulletList?.content ?? []).map(
			(item) => item.content?.[0]?.content?.[0]?.text
		);
		expect(labels).toEqual(['독서', '독서모임 7시']);
	});

	it('date title with schedule entries on a different day: default seed (no TODO)', async () => {
		await setScheduleNote('sched-guid');
		await putNote(
			makeNote('sched-guid', noteDoc(['16(목) 빨래']))
		);

		const note = await createNote('2026-04-15');
		expect(note.xmlContent).toBe(
			'<note-content version="0.1">2026-04-15\n2026년\n</note-content>'
		);
	});

	it('preserves note.title when seeded with TODO blocks', async () => {
		await setScheduleNote('sched-guid');
		await putNote(
			makeNote('sched-guid', noteDoc(['15(수) 독서모임 7시']))
		);

		const note = await createNote('2026-04-15');
		expect(note.title).toBe('2026-04-15');
	});
});
