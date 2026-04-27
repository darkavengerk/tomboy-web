import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	createNote,
	updateNoteFromEditor,
	deleteNoteById,
	toggleFavorite
} from '$lib/core/noteManager.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import {
	configureNoteSync,
	setNoteSyncEnabled,
	flushAllNoteSync,
	_resetNoteSyncForTest
} from '$lib/sync/firebase/orchestrator.js';
import * as noteStore from '$lib/storage/noteStore.js';
import type { JSONContent } from '@tiptap/core';
import type { NoteData } from '$lib/core/note.js';

function p(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function docOf(...lines: string[]): JSONContent {
	return { type: 'doc', content: lines.map(p) };
}

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	_resetNoteSyncForTest();
});

describe('updateNoteFromEditor → Firebase sync hook', () => {
	it('does not push when sync is disabled (default)', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => noteStore.getNote(g));
		configureNoteSync({ push, getNote, debounceMs: 100 });

		const n = await createNote('hook-disabled');
		await updateNoteFromEditor(n.guid, docOf('hook-disabled', 'body'));
		await flushAllNoteSync();

		expect(push).not.toHaveBeenCalled();
	});

	it('pushes the saved note when sync is enabled', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => noteStore.getNote(g));
		configureNoteSync({ push, getNote, debounceMs: 100 });
		setNoteSyncEnabled(true);

		const n = await createNote('hook-enabled');
		await updateNoteFromEditor(n.guid, docOf('hook-enabled', 'body line'));
		await flushAllNoteSync();

		expect(push).toHaveBeenCalledTimes(1);
		const pushed = push.mock.calls[0][0] as NoteData;
		expect(pushed.guid).toBe(n.guid);
		expect(pushed.title).toBe('hook-enabled');
		expect(pushed.xmlContent).toContain('body line');
	});

	it('queues a push for every backlink-rewritten note when a title is renamed', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => noteStore.getNote(g));
		configureNoteSync({ push, getNote, debounceMs: 50 });
		setNoteSyncEnabled(true);

		const target = await createNote('Old Title');
		const linker = await createNote('Linker');
		// Hand-craft a backlink to the target by writing XML directly.
		const linkerNote = (await noteStore.getNote(linker.guid))!;
		linkerNote.xmlContent = `<note-content version="0.1">Linker\n\n<link:internal>Old Title</link:internal></note-content>`;
		await noteStore.putNote(linkerNote);

		// Reset the spy so we measure the rename push only.
		push.mockClear();

		await updateNoteFromEditor(target.guid, docOf('New Title', 'body'));
		await flushAllNoteSync();

		const guids = push.mock.calls.map((c) => (c[0] as NoteData).guid).sort();
		expect(guids).toContain(target.guid);
		expect(guids).toContain(linker.guid);

		const linkerPush = push.mock.calls
			.map((c) => c[0] as NoteData)
			.find((n) => n.guid === linker.guid);
		expect(linkerPush?.xmlContent).toContain('<link:internal>New Title</link:internal>');
	});

	it('pushes a tombstone when a note is deleted', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => noteStore.getNote(g));
		configureNoteSync({ push, getNote, debounceMs: 50 });
		setNoteSyncEnabled(true);

		const n = await createNote('Doomed');
		push.mockClear();

		await deleteNoteById(n.guid);
		await flushAllNoteSync();

		expect(push).toHaveBeenCalledTimes(1);
		const tomb = push.mock.calls[0][0] as NoteData;
		expect(tomb.guid).toBe(n.guid);
		expect(tomb.deleted).toBe(true);
	});

	it('pushes a freshly created note even before the user edits it', async () => {
		// createNote without a follow-up edit must still propagate to other
		// devices — otherwise a "create new note + drop a link to it from
		// another note" workflow leaves the new note absent from Firestore,
		// and the receiving device sees the link but cannot resolve it.
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => noteStore.getNote(g));
		configureNoteSync({ push, getNote, debounceMs: 50 });
		setNoteSyncEnabled(true);

		const n = await createNote('untouched');
		await flushAllNoteSync();

		expect(push).toHaveBeenCalledTimes(1);
		const pushed = push.mock.calls[0][0] as NoteData;
		expect(pushed.guid).toBe(n.guid);
		expect(pushed.title).toBe('untouched');
		expect(pushed.deleted).toBe(false);
	});

	it('deleteNoteById bumps changeDate so a cross-device tombstone wins on the receiver', async () => {
		// Without bumping changeDate, the tombstone would arrive on the other
		// device with the SAME changeDate as the local non-deleted row. The
		// conflict resolver would then fall through to `tie-prefers-local`
		// and push the local non-deleted state back, undoing the delete.
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => noteStore.getNote(g));
		configureNoteSync({ push, getNote, debounceMs: 50 });
		setNoteSyncEnabled(true);

		const n = await createNote('To-be-killed');
		const before = (await noteStore.getNote(n.guid))!;
		push.mockClear();

		// Tomboy date format has 7-digit subsecond precision so two deletes
		// in the same millisecond would still differ; but to be robust against
		// fast machines, give the wall clock a small step.
		await new Promise((r) => setTimeout(r, 5));

		await deleteNoteById(n.guid);
		await flushAllNoteSync();

		const after = (await noteStore.getNote(n.guid))!;
		expect(after.deleted).toBe(true);
		expect(after.changeDate.localeCompare(before.changeDate)).toBeGreaterThan(0);
		expect(after.metadataChangeDate.localeCompare(before.metadataChangeDate)).toBeGreaterThan(
			0
		);

		expect(push).toHaveBeenCalledTimes(1);
		const pushed = push.mock.calls[0][0] as NoteData;
		expect(pushed.deleted).toBe(true);
		expect(pushed.changeDate).toBe(after.changeDate);
	});

	it('pushes when toggling favorite (metadata change)', async () => {
		const push = vi.fn().mockResolvedValue(undefined);
		const getNote = vi.fn(async (g: string) => noteStore.getNote(g));
		configureNoteSync({ push, getNote, debounceMs: 50 });
		setNoteSyncEnabled(true);

		const n = await createNote('Liked');
		push.mockClear();

		await toggleFavorite(n.guid);
		await flushAllNoteSync();

		expect(push).toHaveBeenCalledTimes(1);
		const pushed = push.mock.calls[0][0] as NoteData;
		expect(pushed.tags).toContain('system:pinned');
	});
});
