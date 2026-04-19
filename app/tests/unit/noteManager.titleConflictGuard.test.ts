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

const invalidateCacheSpy = vi.fn();
vi.mock('$lib/stores/noteListCache.js', () => ({
	invalidateCache: () => invalidateCacheSpy()
}));

const lookupGuidByTitleMock = vi.fn<(title: string) => string | null>();
const ensureTitleIndexReadySpy = vi.fn(async () => {});
vi.mock('$lib/editor/autoLink/titleProvider.js', () => ({
	lookupGuidByTitle: (title: string) => lookupGuidByTitleMock(title),
	ensureTitleIndexReady: () => ensureTitleIndexReadySpy()
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
	invalidateCacheSpy.mockReset();
	lookupGuidByTitleMock.mockReset();
	ensureTitleIndexReadySpy.mockClear();
});

describe('updateNoteFromEditor — title uniqueness guard', () => {
	it('refuses to save when the new title collides with another note', async () => {
		const note = makeNote({
			guid: 'abc',
			title: 'Hello',
			xmlContent: '<note-content version="0.1">Hello\n\nbody</note-content>'
		});
		store.set(note.guid, { ...note });

		// Simulated title index: 'Taken' already maps to another note.
		lookupGuidByTitleMock.mockImplementation((t: string) =>
			t === 'Taken' ? 'someone-else' : null
		);

		// User typed a new title that collides.
		const doc = deserializeContent(
			'<note-content version="0.1">Taken\n\nbody</note-content>'
		);

		const result = await updateNoteFromEditor(note.guid, doc);

		// Defensive guard: no write, no cache invalidation.
		expect(putSpy).not.toHaveBeenCalled();
		expect(invalidateCacheSpy).not.toHaveBeenCalled();

		// The returned note must be unchanged (original title / xml).
		expect(result?.title).toBe('Hello');
		expect(result?.xmlContent).toBe(
			'<note-content version="0.1">Hello\n\nbody</note-content>'
		);

		// Stored note should still be untouched.
		expect(store.get(note.guid)?.title).toBe('Hello');
		expect(store.get(note.guid)?.xmlContent).toBe(
			'<note-content version="0.1">Hello\n\nbody</note-content>'
		);

		// ensureTitleIndexReady must have been awaited.
		expect(ensureTitleIndexReadySpy).toHaveBeenCalled();
	});

	it('saves normally when the lookup returns the same guid (paranoia case)', async () => {
		const note = makeNote({
			guid: 'abc',
			title: 'Hello',
			xmlContent: '<note-content version="0.1">Hello\n\nbody</note-content>'
		});
		store.set(note.guid, { ...note });

		// Self-hit: the index returns our own guid. Should not block.
		lookupGuidByTitleMock.mockImplementation((t: string) =>
			t === 'Renamed' ? 'abc' : null
		);

		const doc = deserializeContent(
			'<note-content version="0.1">Renamed\n\nbody</note-content>'
		);

		const result = await updateNoteFromEditor(note.guid, doc);

		expect(putSpy).toHaveBeenCalledTimes(1);
		expect(invalidateCacheSpy).toHaveBeenCalledTimes(1);
		expect(result?.title).toBe('Renamed');
		expect(store.get(note.guid)?.title).toBe('Renamed');
	});

	it('saves normally when the new title is not taken by anyone', async () => {
		const note = makeNote({
			guid: 'abc',
			title: 'Hello',
			xmlContent: '<note-content version="0.1">Hello\n\nbody</note-content>'
		});
		store.set(note.guid, { ...note });

		lookupGuidByTitleMock.mockReturnValue(null);

		const doc = deserializeContent(
			'<note-content version="0.1">NewName\n\nbody</note-content>'
		);

		const result = await updateNoteFromEditor(note.guid, doc);

		expect(putSpy).toHaveBeenCalledTimes(1);
		expect(invalidateCacheSpy).toHaveBeenCalledTimes(1);
		expect(result?.title).toBe('NewName');
		expect(ensureTitleIndexReadySpy).toHaveBeenCalled();
	});

	it('does not call ensureTitleIndexReady when the title did not change (body-only edit)', async () => {
		const note = makeNote({
			guid: 'abc',
			title: 'Hello',
			xmlContent: '<note-content version="0.1">Hello\n\nbody</note-content>'
		});
		store.set(note.guid, { ...note });

		// Body-only edit: title stays 'Hello' but body changes.
		const doc = deserializeContent(
			'<note-content version="0.1">Hello\n\nnew body text</note-content>'
		);

		const result = await updateNoteFromEditor(note.guid, doc);

		// Save still happened (body changed), but guard was NOT consulted.
		expect(putSpy).toHaveBeenCalledTimes(1);
		expect(ensureTitleIndexReadySpy).not.toHaveBeenCalled();
		expect(lookupGuidByTitleMock).not.toHaveBeenCalled();
		// Body-only edits should not invalidate the shared cache either.
		expect(invalidateCacheSpy).not.toHaveBeenCalled();
		expect(result?.title).toBe('Hello');
		expect(serializeContent(doc)).toContain('new body text');
	});
});
