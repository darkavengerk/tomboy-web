import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { putNote } from '$lib/storage/noteStore.js';
import {
	createNote,
	updateNoteFromEditor,
	listNotesShared
} from '$lib/core/noteManager.js';
import {
	getCachedNotes,
	readThroughNotes,
	_resetForTest as resetCache
} from '$lib/stores/noteListCache.js';
import { _resetForTest as resetTitleProvider } from '$lib/editor/autoLink/titleProvider.js';
import { clear as clearIndex } from '$lib/core/backlinkIndex.js';
import { createEmptyNote, type NoteData } from '$lib/core/note.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { vi } from 'vitest';

function makeNote(guid: string, title: string, changeDate: string): NoteData {
	const n = createEmptyNote(guid);
	n.title = title;
	n.xmlContent = `<note-content version="0.1">${title}\n\n</note-content>`;
	n.changeDate = changeDate;
	return n;
}

const doc = (title: string, body = '') => ({
	type: 'doc',
	content: [
		{ type: 'paragraph', content: [{ type: 'text', text: title }] },
		{ type: 'paragraph', content: body ? [{ type: 'text', text: body }] : [] }
	]
});

/** Spy fetch for readThroughNotes: if this gets called, the warm-cache
 *  guarantee is broken and the save path regressed to a full-corpus read. */
const fetchSpy = vi.fn(async () => [] as NoteData[]);

beforeEach(() => {
	clearIndex();
	resetCache();
	resetTitleProvider();
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	fetchSpy.mockClear();
});

describe('noteMutated integration: 새 노트 생성 + 타이틀 수정 with zero full-corpus re-reads', () => {
	it('createNote patches the warm shared cache instead of invalidating it', async () => {
		await putNote(makeNote('old', 'Old note', '2024-01-01T00:00:00Z'));
		await listNotesShared(); // warm the cache (the one allowed full read)

		const note = await createNote('새로 만든 노트');

		const cached = getCachedNotes();
		expect(cached).not.toBeNull(); // NOT nulled — patched
		expect(cached!.map((n) => n.guid)).toContain(note.guid);
		expect(cached![0].guid).toBe(note.guid); // newest changeDate → first

		await readThroughNotes(fetchSpy);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('a title-changing save (the per-debounce hot path) stays on the patched cache', async () => {
		await putNote(makeNote('n1', '2026-06-11 09:30', '2026-06-11T09:30:00Z'));
		await listNotesShared();

		const updated = await updateNoteFromEditor('n1', doc('회의록'));
		expect(updated?.title).toBe('회의록');

		const cached = getCachedNotes();
		expect(cached).not.toBeNull();
		expect(cached!.find((n) => n.guid === 'n1')?.title).toBe('회의록');

		await readThroughNotes(fetchSpy);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('consecutive title saves (typing a title across debounce flushes) never refetch', async () => {
		await putNote(makeNote('n1', '2026-06-11 09:30', '2026-06-11T09:30:00Z'));
		await putNote(makeNote('n2', 'Other', '2024-01-01T00:00:00Z'));
		await listNotesShared();

		await updateNoteFromEditor('n1', doc('회'));
		await updateNoteFromEditor('n1', doc('회의'));
		await updateNoteFromEditor('n1', doc('회의록'));

		const cached = getCachedNotes();
		expect(cached!.find((n) => n.guid === 'n1')?.title).toBe('회의록');
		expect(cached!.filter((n) => n.guid === 'n1')).toHaveLength(1);

		await readThroughNotes(fetchSpy);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('a body-only save patches changeDate in the cache (no refetch, no stale order)', async () => {
		await putNote(makeNote('n1', 'Note A', '2024-01-01T00:00:00Z'));
		await putNote(makeNote('n2', 'Note B', '2025-01-01T00:00:00Z'));
		await listNotesShared();
		expect(getCachedNotes()![0].guid).toBe('n2');

		await updateNoteFromEditor('n1', doc('Note A', '본문 수정'));

		const cached = getCachedNotes()!;
		expect(cached[0].guid).toBe('n1'); // bumped changeDate moved it up
		expect(cached[0].xmlContent).toContain('본문 수정');

		await readThroughNotes(fetchSpy);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('the title index sees a created note through the patch (conflict guard works sans refetch)', async () => {
		await putNote(makeNote('n1', 'Existing', '2024-01-01T00:00:00Z'));
		await listNotesShared();
		await createNote('점유된 제목');

		// Renaming another note to the just-created title must be refused —
		// proving the patched cache propagated into the title index.
		await putNote(makeNote('n2', 'Victim', '2024-02-01T00:00:00Z'));
		const out = await updateNoteFromEditor('n2', doc('점유된 제목'));
		expect(out?.title).toBe('Victim'); // write refused, original returned
	});
});
