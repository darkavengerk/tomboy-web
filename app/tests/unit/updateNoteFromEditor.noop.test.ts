import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NoteData } from '$lib/core/note.js';

// In-memory fake IDB keyed by guid so we can inspect writes.
const store = new Map<string, NoteData>();
const putSpy = vi.fn();

vi.mock('$lib/storage/noteStore.js', () => ({
	getNote: vi.fn(async (guid: string) => store.get(guid)),
	putNote: vi.fn(async (note: NoteData) => {
		putSpy(note);
		store.set(note.guid, { ...note });
	}),
	getAllNotes: vi.fn(async () => Array.from(store.values())),
	getAllNotesIncludingTemplates: vi.fn(async () => Array.from(store.values())),
	putNoteSynced: vi.fn(),
	deleteNote: vi.fn(),
	findNoteByTitle: vi.fn()
}));

vi.mock('$lib/stores/noteListCache.js', () => ({
	invalidateCache: vi.fn()
}));

import { updateNoteFromEditor } from '$lib/core/noteManager.js';
import {
	deserializeContent,
	serializeContent
} from '$lib/core/noteContentArchiver.js';

function makeNote(overrides: Partial<NoteData> = {}): NoteData {
	return {
		uri: 'note://tomboy/abc',
		guid: 'abc',
		title: 'Hello',
		xmlContent: '<note-content version="0.1">Hello\n\nbody</note-content>',
		createDate: '2024-01-01T00:00:00.0000000+00:00',
		changeDate: '2024-06-01T10:20:30.1234567+00:00',
		metadataChangeDate: '2024-06-01T10:20:30.1234567+00:00',
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

beforeEach(() => {
	store.clear();
	putSpy.mockReset();
});

describe('updateNoteFromEditor — no-op save skip', () => {
	it('does NOT touch the note when the serialized doc matches the stored xmlContent', async () => {
		const xml = '<note-content version="0.1">Hello\n\nbody</note-content>';
		const note = makeNote({ xmlContent: xml, localDirty: false });
		store.set(note.guid, note);

		// User "typed and undid" — the resulting doc is identical to what's stored.
		const doc = deserializeContent(xml);

		const result = await updateNoteFromEditor(note.guid, doc);

		// No write, no date change, localDirty stays false.
		expect(putSpy).not.toHaveBeenCalled();
		expect(result?.changeDate).toBe(note.changeDate);
		expect(result?.metadataChangeDate).toBe(note.metadataChangeDate);
		expect(result?.localDirty).toBe(false);

		// Stored note should be untouched.
		expect(store.get(note.guid)?.changeDate).toBe(note.changeDate);
		expect(store.get(note.guid)?.localDirty).toBe(false);
	});

	it('DOES save when the serialized doc differs from the stored xmlContent', async () => {
		const xml = '<note-content version="0.1">Hello\n\nbody</note-content>';
		const originalDate = '2024-06-01T10:20:30.1234567+00:00';
		const note = makeNote({ xmlContent: xml, changeDate: originalDate, localDirty: false });
		store.set(note.guid, { ...note }); // store a copy so the test's `note` reference stays pristine

		// User actually changed the body.
		const newDoc = deserializeContent(
			'<note-content version="0.1">Hello\n\nbody changed</note-content>'
		);

		const result = await updateNoteFromEditor(note.guid, newDoc);

		expect(putSpy).toHaveBeenCalledTimes(1);
		expect(result?.changeDate).not.toBe(originalDate);
		expect(store.get(note.guid)?.xmlContent).toContain('body changed');
	});

	it('does not flip localDirty back to false if the stored note is already dirty but content matches', async () => {
		// Edge case: a note that was previously saved as dirty still matches
		// the incoming doc byte-for-byte. We treat this as a no-op, preserving
		// the dirty flag (the user hasn't "undone" their original change in
		// the sense of re-syncing — the flag will clear on next sync).
		const xml = '<note-content version="0.1">Hello\n\nbody</note-content>';
		const note = makeNote({ xmlContent: xml, localDirty: true });
		store.set(note.guid, note);

		const doc = deserializeContent(xml);
		await updateNoteFromEditor(note.guid, doc);

		expect(putSpy).not.toHaveBeenCalled();
		expect(store.get(note.guid)?.localDirty).toBe(true);
	});
});
