import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { putNote } from '$lib/storage/noteStore.js';
import { findNoteByTitleIndexed } from '$lib/core/noteManager.js';
import { invalidateCache, _resetForTest as resetCache } from '$lib/stores/noteListCache.js';
import { _resetForTest as resetTitleProvider } from '$lib/editor/autoLink/titleProvider.js';
import { clear as clearIndex } from '$lib/core/backlinkIndex.js';
import { createEmptyNote, type NoteData } from '$lib/core/note.js';
import { _resetDBForTest } from '$lib/storage/db.js';

function makeNote(guid: string, title: string): NoteData {
	const n = createEmptyNote(guid);
	n.title = title;
	n.xmlContent = `<note-content version="0.1">${title}\n\n</note-content>`;
	return n;
}

beforeEach(() => {
	clearIndex();
	resetCache();
	resetTitleProvider();
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('findNoteByTitleIndexed', () => {
	it('resolves a note by exact, trimmed, case-sensitive title via the index', async () => {
		await putNote(makeNote('a', 'Foo'));
		await putNote(makeNote('b', 'Bar'));
		expect((await findNoteByTitleIndexed('Foo'))?.guid).toBe('a');
		expect((await findNoteByTitleIndexed('  Bar  '))?.guid).toBe('b');
	});

	it('returns undefined for an unknown or blank title', async () => {
		await putNote(makeNote('a', 'Foo'));
		expect(await findNoteByTitleIndexed('Nope')).toBeUndefined();
		expect(await findNoteByTitleIndexed('   ')).toBeUndefined();
	});

	it('is case-sensitive', async () => {
		await putNote(makeNote('a', 'Foo'));
		expect(await findNoteByTitleIndexed('foo')).toBeUndefined();
		expect((await findNoteByTitleIndexed('Foo'))?.guid).toBe('a');
	});

	it('falls back to the authoritative scan for a note the warm index lacks', async () => {
		await putNote(makeNote('a', 'Foo'));
		// Warm the index with just Foo → a.
		expect((await findNoteByTitleIndexed('Foo'))?.guid).toBe('a');

		// A second note is committed but the index is NOT refreshed (putNote
		// does not invalidate, and the warm index skips a refresh). The fast
		// path misses → fallback full scan still finds it.
		await putNote(makeNote('b', 'NewNote'));
		expect((await findNoteByTitleIndexed('NewNote'))?.guid).toBe('b');
	});

	it('a stale index entry never returns the wrong-titled note', async () => {
		await putNote(makeNote('a', 'Foo'));
		expect((await findNoteByTitleIndexed('Foo'))?.guid).toBe('a');

		// Rename a → Bar in IDB without refreshing the index. The index still
		// maps Foo → a, but a's title is now Bar: the equality guard rejects the
		// fast-path hit and the fallback scan (no note titled Foo) returns
		// undefined — never note `a` under the wrong title.
		await putNote(makeNote('a', 'Bar'));
		expect(await findNoteByTitleIndexed('Foo')).toBeUndefined();
		// Bar resolves via the fallback even before the index catches up.
		expect((await findNoteByTitleIndexed('Bar'))?.guid).toBe('a');

		// After an invalidate the index itself catches up too.
		invalidateCache();
		await new Promise((r) => setTimeout(r, 0));
		expect((await findNoteByTitleIndexed('Bar'))?.guid).toBe('a');
	});

	it('does not resolve a deleted note', async () => {
		const d = makeNote('a', 'Foo');
		d.deleted = true;
		await putNote(d);
		expect(await findNoteByTitleIndexed('Foo')).toBeUndefined();
	});

	it('on duplicate titles resolves the most-recently-changed (first-wins)', async () => {
		await putNote({ ...makeNote('older', 'Dup'), changeDate: '2024-01-01T00:00:00Z' });
		await putNote({ ...makeNote('newer', 'Dup'), changeDate: '2024-06-01T00:00:00Z' });
		// getAllNotes sorts changeDate DESC → newer first → first-wins index.
		expect((await findNoteByTitleIndexed('Dup'))?.guid).toBe('newer');
	});
});
