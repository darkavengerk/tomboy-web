import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { setHomeNote, getHomeNote, getHomeNoteGuid, clearHomeNote } from '$lib/core/home.js';
import { createNote } from '$lib/core/noteManager.js';
import { _resetDBForTest } from '$lib/storage/db.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('home note', () => {
	it('setHomeNote stores guid in appSettings', async () => {
		await setHomeNote('abc');
		expect(await getHomeNoteGuid()).toBe('abc');
	});

	it('getHomeNote returns stored note when exists', async () => {
		const n = await createNote('My note');
		await setHomeNote(n.guid);
		const home = await getHomeNote();
		expect(home?.guid).toBe(n.guid);
	});

	it('getHomeNote falls back to most-recent note when unset', async () => {
		const a = await createNote('older');
		await new Promise((r) => setTimeout(r, 5));
		const b = await createNote('newer');
		const home = await getHomeNote();
		expect(home?.guid).toBe(b.guid);
	});

	it('getHomeNote falls back to most-recent note when stored guid no longer exists', async () => {
		await setHomeNote('nonexistent');
		const b = await createNote('newer');
		const home = await getHomeNote();
		expect(home?.guid).toBe(b.guid);
	});

	it('clearHomeNote removes the setting', async () => {
		await setHomeNote('abc');
		await clearHomeNote();
		expect(await getHomeNoteGuid()).toBeUndefined();
	});

	it('getHomeNote returns null when no notes at all', async () => {
		const home = await getHomeNote();
		expect(home).toBeNull();
	});
});
