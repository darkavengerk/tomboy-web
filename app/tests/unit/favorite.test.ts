import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { toggleFavorite, isFavorite, sortForList, createNote } from '$lib/core/noteManager.js';
import { getNote } from '$lib/storage/noteStore.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { favoriteStore } from '$lib/storage/favoriteStore.svelte.js';
import type { NoteData } from '$lib/core/note.js';

beforeEach(async () => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	favoriteStore._reset();
	await favoriteStore.load();
});

describe('favorite (local-only)', () => {
	it('toggleFavorite returns true when adding and false when removing', async () => {
		const n = await createNote('test');
		expect(toggleFavorite(n.guid)).toBe(true);
		expect(toggleFavorite(n.guid)).toBe(false);
	});

	it('isFavorite reflects favoriteStore membership', async () => {
		const n = await createNote('test');
		expect(isFavorite(n)).toBe(false);
		toggleFavorite(n.guid);
		expect(isFavorite(n)).toBe(true);
		toggleFavorite(n.guid);
		expect(isFavorite(n)).toBe(false);
	});

	it('toggleFavorite does NOT modify note.tags or metadataChangeDate', async () => {
		const n = await createNote('test');
		const before = await getNote(n.guid);
		toggleFavorite(n.guid);
		const after = await getNote(n.guid);
		expect(after?.tags).toEqual(before?.tags);
		expect(after?.metadataChangeDate).toBe(before?.metadataChangeDate);
	});

	it('isFavorite ignores legacy system:pinned tag', async () => {
		const n = await createNote('test');
		const stale: NoteData = { ...n, tags: ['system:pinned'] };
		expect(isFavorite(stale)).toBe(false);
	});

	it('sortForList sorts purely by changeDate desc, ignoring favorites', async () => {
		const a = await createNote('a');
		await new Promise((r) => setTimeout(r, 5));
		const b = await createNote('b');
		toggleFavorite(a.guid);

		const sorted = sortForList([a, b], 'changeDate');
		expect(sorted[0].guid).toBe(b.guid);
		expect(sorted[1].guid).toBe(a.guid);
	});

	it('sortForList handles missing dates gracefully', () => {
		const n1 = { guid: '1', changeDate: '', createDate: '' } as NoteData;
		const n2 = { guid: '2', changeDate: '2026-01-01T00:00:00.0000000+09:00', createDate: '' } as NoteData;
		const sorted = sortForList([n1, n2], 'changeDate');
		expect(sorted[0].guid).toBe('2');
	});
});
