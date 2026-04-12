import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { toggleFavorite, isFavorite, sortForList, createNote } from '$lib/core/noteManager.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import type { NoteData } from '$lib/core/note.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('favorite', () => {
	it('toggleFavorite adds system:pinned when absent', async () => {
		const n = await createNote('test');
		const updated = await toggleFavorite(n.guid);
		expect(updated?.tags).toContain('system:pinned');
	});

	it('toggleFavorite removes system:pinned when present', async () => {
		const n = await createNote('test');
		await toggleFavorite(n.guid);
		const updated = await toggleFavorite(n.guid);
		expect(updated?.tags).not.toContain('system:pinned');
	});

	it('toggle twice is idempotent (back to original)', async () => {
		const n = await createNote('test');
		const orig = isFavorite(n);
		await toggleFavorite(n.guid);
		const updated = await toggleFavorite(n.guid);
		expect(isFavorite(updated!)).toBe(orig);
	});

	it('sorting: pinned notes come first then by changeDate desc', async () => {
		const a = await createNote('a');
		await new Promise((r) => setTimeout(r, 5));
		const b = await createNote('b');
		await toggleFavorite(a.guid); // pin a (older)

		const all: NoteData[] = [
			{ ...b, tags: [] },
			{ ...a, tags: ['system:pinned'] }
		];
		const sorted = sortForList(all, 'changeDate');
		expect(sorted[0].guid).toBe(a.guid); // pinned first
	});
});
