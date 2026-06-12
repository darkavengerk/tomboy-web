import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { putNote, findNoteByTitle, titleExists } from '$lib/storage/noteStore.js';
import { createEmptyNote, type NoteData } from '$lib/core/note.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { clear as clearIndex } from '$lib/core/backlinkIndex.js';

function makeNote(guid: string, title: string): NoteData {
	const n = createEmptyNote(guid);
	n.title = title;
	n.xmlContent = `<note-content version="0.1">${title}\n\n</note-content>`;
	return n;
}

beforeEach(() => {
	clearIndex();
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('noteStore.findNoteByTitle (by-title IDB index fast path)', () => {
	it('resolves an exactly-titled note via the index', async () => {
		await putNote(makeNote('a', 'Foo'));
		await putNote(makeNote('b', 'Bar'));
		expect((await findNoteByTitle('Foo'))?.guid).toBe('a');
		expect((await findNoteByTitle('Bar'))?.guid).toBe('b');
	});

	it('trims the QUERY before the keyed lookup', async () => {
		await putNote(makeNote('a', 'Foo'));
		expect((await findNoteByTitle('  Foo  '))?.guid).toBe('a');
	});

	it('is case-sensitive and returns undefined for unknown/blank titles', async () => {
		await putNote(makeNote('a', 'Foo'));
		expect(await findNoteByTitle('foo')).toBeUndefined();
		expect(await findNoteByTitle('Nope')).toBeUndefined();
		expect(await findNoteByTitle('   ')).toBeUndefined();
	});

	it('never returns a deleted note, even when the index key matches', async () => {
		const d = makeNote('a', 'Foo');
		d.deleted = true;
		await putNote(d);
		expect(await findNoteByTitle('Foo')).toBeUndefined();
	});

	it('on duplicate titles returns the most recently changed match', async () => {
		await putNote({ ...makeNote('older', 'Dup'), changeDate: '2024-01-01T00:00:00Z' });
		await putNote({ ...makeNote('newer', 'Dup'), changeDate: '2024-06-01T00:00:00Z' });
		expect((await findNoteByTitle('Dup'))?.guid).toBe('newer');
	});

	it('FALLBACK: resolves a legacy note whose STORED title is untrimmed (index key misses)', async () => {
		// putNote stores titles verbatim — trimming is enforced at the
		// editor/import layers, so direct-IDB legacy rows can carry whitespace.
		await putNote(makeNote('legacy', '  Foo  '));
		expect((await findNoteByTitle('Foo'))?.guid).toBe('legacy');
	});

	it('FALLBACK still excludes deleted notes', async () => {
		const d = makeNote('legacy', '  Foo  ');
		d.deleted = true;
		await putNote(d);
		expect(await findNoteByTitle('Foo')).toBeUndefined();
	});

	it('documented edge: a raw-key match wins over an untrimmed duplicate regardless of changeDate', async () => {
		await putNote({ ...makeNote('untrimmed', ' Foo '), changeDate: '2024-06-01T00:00:00Z' });
		await putNote({ ...makeNote('exact', 'Foo'), changeDate: '2024-01-01T00:00:00Z' });
		// Both trim to "Foo" (a uniqueness-invariant violation); the fast path
		// short-circuits on the exact raw key without consulting the legacy row.
		expect((await findNoteByTitle('Foo'))?.guid).toBe('exact');
	});
});

describe('noteStore.titleExists (index-only probe)', () => {
	it('true for an existing exact title, false for unknown/blank', async () => {
		await putNote(makeNote('a', 'Foo'));
		expect(await titleExists('Foo')).toBe(true);
		expect(await titleExists('  Foo ')).toBe(true); // query is trimmed
		expect(await titleExists('foo')).toBe(false); // case-sensitive
		expect(await titleExists('Nope')).toBe(false);
		expect(await titleExists('   ')).toBe(false);
	});

	it('a deleted note does not block its title', async () => {
		const d = makeNote('a', 'Foo');
		d.deleted = true;
		await putNote(d);
		expect(await titleExists('Foo')).toBe(false);
	});

	it('deliberately NO fallback: an untrimmed legacy title is invisible to the probe', async () => {
		await putNote(makeNote('legacy', '  Foo  '));
		expect(await titleExists('Foo')).toBe(false);
	});
});
