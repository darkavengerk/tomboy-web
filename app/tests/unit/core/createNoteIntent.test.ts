import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { createNote } from '$lib/core/noteManager.js';
import { consumeNewNoteIntent } from '$lib/core/newNoteIntent.js';
import { _resetDBForTest } from '$lib/storage/db.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('createNote — new-note cursor intent', () => {
	it('records selectTitle when no title is supplied (auto date title)', async () => {
		const note = await createNote();
		expect(consumeNewNoteIntent(note.guid)).toBe('selectTitle');
	});

	it('records bodyCursor when an explicit title is supplied', async () => {
		const note = await createNote('My Note');
		expect(consumeNewNoteIntent(note.guid)).toBe('bodyCursor');
	});

	it('records bodyCursor for an explicit date title too', async () => {
		const note = await createNote('2026-04-15');
		expect(consumeNewNoteIntent(note.guid)).toBe('bodyCursor');
	});
});
