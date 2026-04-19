import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NoteData } from '$lib/core/note.js';

// In-memory fake store keyed by guid.
const store = new Map<string, NoteData>();
const putSpy = vi.fn();
const putSyncedSpy = vi.fn();

vi.mock('$lib/storage/noteStore.js', () => ({
	getNote: vi.fn(async (guid: string) => store.get(guid)),
	putNote: vi.fn(async (note: NoteData) => {
		putSpy(note);
		store.set(note.guid, { ...note, localDirty: true });
	}),
	putNoteSynced: vi.fn(async (note: NoteData) => {
		putSyncedSpy(note);
		store.set(note.guid, { ...note });
	}),
	getAllNotes: vi.fn(async () => Array.from(store.values())),
	getAllNotesIncludingTemplates: vi.fn(async () => Array.from(store.values())),
	deleteNote: vi.fn(),
	findNoteByTitle: vi.fn(async (title: string) => {
		const needle = title.trim();
		if (!needle) return undefined;
		return Array.from(store.values()).find(
			(n) => !n.deleted && n.title.trim() === needle
		);
	})
}));

const pushToastMock = vi.fn();
vi.mock('$lib/stores/toast.js', () => ({
	pushToast: (...args: unknown[]) => pushToastMock(...args)
}));

vi.mock('$lib/stores/noteListCache.js', () => ({
	invalidateCache: vi.fn()
}));

import { importNoteXml } from '$lib/core/noteManager.js';

function buildNoteXml(guid: string, title: string, body = 'body text'): string {
	// Minimal .note XML — the parser reads <title> and <text>'s inner
	// <note-content> blob. We spell both out to keep the xmlContent
	// byte-for-byte predictable.
	return [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<note version="0.3" xmlns:link="http://beatniksoftware.com/tomboy/link" xmlns:size="http://beatniksoftware.com/tomboy/size" xmlns="http://beatniksoftware.com/tomboy">',
		`  <title>${title}</title>`,
		`  <text xml:space="preserve"><note-content version="0.1">${title}\n${body}</note-content></text>`,
		'  <last-change-date>2024-06-01T10:20:30.1234567+00:00</last-change-date>',
		'  <last-metadata-change-date>2024-06-01T10:20:30.1234567+00:00</last-metadata-change-date>',
		'  <create-date>2024-01-01T00:00:00.0000000+00:00</create-date>',
		'  <cursor-position>0</cursor-position>',
		'  <selection-bound-position>-1</selection-bound-position>',
		'  <width>450</width>',
		'  <height>360</height>',
		'  <x>0</x>',
		'  <y>0</y>',
		'  <open-on-startup>False</open-on-startup>',
		'</note>'
	].join('\n');
}

function seedNote(overrides: Partial<NoteData> & { guid: string; title: string }): void {
	const n: NoteData = {
		uri: `note://tomboy/${overrides.guid}`,
		xmlContent: `<note-content version="0.1">${overrides.title}\nexisting body</note-content>`,
		createDate: '2024-01-01T00:00:00.0000000+00:00',
		changeDate: '2024-01-01T00:00:00.0000000+00:00',
		metadataChangeDate: '2024-01-01T00:00:00.0000000+00:00',
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
	store.set(n.guid, n);
}

beforeEach(() => {
	store.clear();
	putSpy.mockReset();
	putSyncedSpy.mockReset();
	pushToastMock.mockReset();
});

describe('importNoteXml — title uniqueness suffix', () => {
	it('stores the title unchanged when no local collision exists', async () => {
		const xml = buildNoteXml('incoming-guid-1', 'Fresh Title');
		const result = await importNoteXml(xml, 'incoming-guid-1.note');

		expect(result.title).toBe('Fresh Title');
		expect(result.localDirty).toBe(false);
		expect(putSyncedSpy).toHaveBeenCalledTimes(1);
		expect(putSpy).not.toHaveBeenCalled();
		expect(pushToastMock).not.toHaveBeenCalled();

		// Stored note has the clean title.
		const stored = store.get('incoming-guid-1');
		expect(stored?.title).toBe('Fresh Title');
		expect(stored?.localDirty).toBe(false);
	});

	it('suffixes to "T (2)" when a DIFFERENT local guid owns title T', async () => {
		seedNote({ guid: 'existing-guid', title: 'Dupe' });

		const xml = buildNoteXml('incoming-guid-2', 'Dupe', 'new body');
		const result = await importNoteXml(xml, 'incoming-guid-2.note');

		expect(result.title).toBe('Dupe (2)');
		expect(result.localDirty).toBe(true);
		expect(result.xmlContent).toBe(
			'<note-content version="0.1">Dupe (2)\nnew body</note-content>'
		);

		expect(putSpy).toHaveBeenCalledTimes(1);
		expect(putSyncedSpy).not.toHaveBeenCalled();

		expect(pushToastMock).toHaveBeenCalledTimes(1);
		expect(pushToastMock).toHaveBeenCalledWith(
			"제목 중복 — 'Dupe' → 'Dupe (2)' 로 이름 변경됨",
			{ kind: 'info' }
		);

		const stored = store.get('incoming-guid-2');
		expect(stored?.title).toBe('Dupe (2)');
		expect(stored?.localDirty).toBe(true);
		// Existing note untouched.
		expect(store.get('existing-guid')?.title).toBe('Dupe');
	});

	it('does NOT suffix when re-importing the same guid (self-match)', async () => {
		seedNote({ guid: 'same-guid', title: 'Returning Title' });

		const xml = buildNoteXml('same-guid', 'Returning Title');
		const result = await importNoteXml(xml, 'same-guid.note');

		expect(result.title).toBe('Returning Title');
		expect(result.localDirty).toBe(false);
		expect(putSyncedSpy).toHaveBeenCalledTimes(1);
		expect(putSpy).not.toHaveBeenCalled();
		expect(pushToastMock).not.toHaveBeenCalled();
	});

	it('chains collisions — local has T, T (2) → incoming fresh guid titled T gets T (3)', async () => {
		seedNote({ guid: 'a-guid', title: 'T' });
		seedNote({ guid: 'b-guid', title: 'T (2)' });

		const xml = buildNoteXml('fresh-guid', 'T', 'third copy');
		const result = await importNoteXml(xml, 'fresh-guid.note');

		expect(result.title).toBe('T (3)');
		expect(result.localDirty).toBe(true);
		expect(result.xmlContent).toBe(
			'<note-content version="0.1">T (3)\nthird copy</note-content>'
		);

		expect(pushToastMock).toHaveBeenCalledWith(
			"제목 중복 — 'T' → 'T (3)' 로 이름 변경됨",
			{ kind: 'info' }
		);
	});
});
