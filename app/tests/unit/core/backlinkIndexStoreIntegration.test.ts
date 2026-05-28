import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { putNote, putNoteSynced, deleteNote } from '$lib/storage/noteStore.js';
import {
	getSourcesFor,
	clear as clearIndex,
	__test__getForward
} from '$lib/core/backlinkIndex.js';
import { createEmptyNote } from '$lib/core/note.js';
import { _resetDBForTest } from '$lib/storage/db.js';

function noteWithBody(guid: string, body: string) {
	const n = createEmptyNote(guid);
	n.xmlContent = `<note-content version="0.1">${body}</note-content>`;
	return n;
}

describe('noteStore ↔ backlinkIndex integration', () => {
	beforeEach(() => {
		clearIndex();
		globalThis.indexedDB = new IDBFactory();
		_resetDBForTest();
	});

	it('putNote populates the index', async () => {
		await putNote(noteWithBody('g1', '<link:internal>A</link:internal>'));
		expect(getSourcesFor('A')).toEqual(new Set(['g1']));
	});

	it('putNote with new content swaps target', async () => {
		await putNote(noteWithBody('g1', '<link:internal>A</link:internal>'));
		await putNote(noteWithBody('g1', '<link:internal>B</link:internal>'));
		expect(getSourcesFor('A')).toBeUndefined();
		expect(getSourcesFor('B')).toEqual(new Set(['g1']));
	});

	it('putNoteSynced also updates the index', async () => {
		await putNoteSynced(noteWithBody('g1', '<link:internal>X</link:internal>'));
		expect(getSourcesFor('X')).toEqual(new Set(['g1']));
	});

	it('deleteNote removes all entries for the guid', async () => {
		await putNote(
			noteWithBody('g1', '<link:internal>A</link:internal><link:internal>B</link:internal>')
		);
		await deleteNote('g1');
		expect(getSourcesFor('A')).toBeUndefined();
		expect(getSourcesFor('B')).toBeUndefined();
		expect(__test__getForward().has('g1')).toBe(false);
	});
});
