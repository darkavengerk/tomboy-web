import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NoteData } from '$lib/core/note.js';

const store = new Map<string, NoteData>();

vi.mock('$lib/storage/noteStore.js', () => ({
	getNote: vi.fn(async (guid: string) => store.get(guid)),
	putNote: vi.fn(async (note: NoteData) => {
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

import { createNote } from '$lib/core/noteManager.js';

beforeEach(() => {
	store.clear();
});

describe('createNote — yyyy-mm-dd title seeds the year subtitle', () => {
	it('adds yyyy년 on the second line when title is yyyy-mm-dd', async () => {
		const note = await createNote('2026-04-17');
		expect(note.title).toBe('2026-04-17');
		expect(note.xmlContent).toBe(
			'<note-content version="0.1">2026-04-17\n2026년\n</note-content>'
		);
	});

	it('uses the matched year (not today) — 1999', async () => {
		const note = await createNote('1999-12-31');
		expect(note.xmlContent).toContain('\n1999년\n');
	});

	it('leaves the second line empty for non-date titles', async () => {
		const note = await createNote('Meeting notes');
		expect(note.xmlContent).toBe(
			'<note-content version="0.1">Meeting notes\n\n</note-content>'
		);
	});

	it('does not treat partial date-like titles as dates', async () => {
		const note = await createNote('2026-04');
		expect(note.xmlContent).not.toContain('년');
	});

	it('does not match when there is extra content after the date', async () => {
		const note = await createNote('2026-04-17 회의');
		expect(note.xmlContent).not.toContain('년\n');
	});

	it('keeps default empty-note XML when no initial title', async () => {
		const note = await createNote();
		expect(note.xmlContent).toBe(
			'<note-content version="0.1">New Note\n\n</note-content>'
		);
	});
});
