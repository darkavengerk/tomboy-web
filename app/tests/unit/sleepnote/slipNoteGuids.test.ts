import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote } from '$lib/storage/noteStore.js';
import { invalidateCache, _resetForTest as resetCache } from '$lib/stores/noteListCache.js';
import { createEmptyNote, type NoteData } from '$lib/core/note.js';
import {
	slipNoteGuids,
	_resetForTest as resetSlipSet
} from '$lib/sleepnote/slipNoteGuids.js';
import { SLIPBOX_NOTEBOOK } from '$lib/sleepnote/validator.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	resetCache();
	resetSlipSet();
});

function makeNote(guid: string, title: string, notebook: string | null): NoteData {
	const n = createEmptyNote(guid);
	n.title = title;
	if (notebook) n.tags = [`system:notebook:${notebook}`];
	return n;
}

describe('slipNoteGuids', () => {
	it('collects guids whose notebook is the Slip-Box', async () => {
		await putNote(makeNote('g1', 'A', SLIPBOX_NOTEBOOK));
		await putNote(makeNote('g2', 'B', '다른노트북'));
		await putNote(makeNote('g3', 'C', null));
		await putNote(makeNote('g4', 'D', SLIPBOX_NOTEBOOK));

		await slipNoteGuids.refresh();
		expect(slipNoteGuids.get()).toEqual(new Set(['g1', 'g4']));
	});

	it('skips deleted notes', async () => {
		const slip = makeNote('g1', 'A', SLIPBOX_NOTEBOOK);
		const deletedSlip = makeNote('g2', 'Deleted', SLIPBOX_NOTEBOOK);
		deletedSlip.deleted = true;
		await putNote(slip);
		await putNote(deletedSlip);

		await slipNoteGuids.refresh();
		expect(slipNoteGuids.get()).toEqual(new Set(['g1']));
	});

	it('refreshes when noteListCache is invalidated', async () => {
		await putNote(makeNote('g1', 'A', SLIPBOX_NOTEBOOK));
		await slipNoteGuids.refresh();
		expect(slipNoteGuids.get()).toEqual(new Set(['g1']));

		// Add a new slip note via the store, then signal the cache.
		await putNote(makeNote('g2', 'B', SLIPBOX_NOTEBOOK));

		const changed = new Promise<void>((resolve) => {
			const off = slipNoteGuids.onChange(() => {
				off();
				resolve();
			});
		});
		invalidateCache();
		await changed;
		expect(slipNoteGuids.get()).toEqual(new Set(['g1', 'g2']));
	});

	it('onChange fires only when the set actually changes', async () => {
		await putNote(makeNote('g1', 'A', SLIPBOX_NOTEBOOK));
		await slipNoteGuids.refresh();

		let calls = 0;
		const off = slipNoteGuids.onChange(() => {
			calls++;
		});
		await slipNoteGuids.refresh(); // same data → no broadcast
		expect(calls).toBe(0);
		off();
	});
});
