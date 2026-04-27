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
