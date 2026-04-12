import 'fake-indexeddb/auto'; // installs IDBRequest, IDBKeyRange etc. as globals
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { getSetting, setSetting, deleteSetting } from '$lib/storage/appSettings.js';
import { _resetDBForTest } from '$lib/storage/db.js';

beforeEach(() => {
	// Fresh in-memory IDB for each test (keeps globals, resets data)
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('appSettings', () => {
	it('returns undefined for unknown key', async () => {
		const val = await getSetting('nonexistent');
		expect(val).toBeUndefined();
	});

	it('roundtrips string value', async () => {
		await setSetting('myKey', 'hello');
		const val = await getSetting<string>('myKey');
		expect(val).toBe('hello');
	});

	it('overwrites previous value at same key', async () => {
		await setSetting('k', 'first');
		await setSetting('k', 'second');
		expect(await getSetting<string>('k')).toBe('second');
	});

	it('deleteSetting removes the row', async () => {
		await setSetting('toDelete', 'val');
		await deleteSetting('toDelete');
		expect(await getSetting('toDelete')).toBeUndefined();
	});

	it('stores structured value (object) intact', async () => {
		const obj = { a: 1, b: [2, 3] };
		await setSetting('obj', obj);
		expect(await getSetting('obj')).toEqual(obj);
	});

	it('upgrading from v2 preserves existing notes store', async () => {
		// Open at v2 — put a note — close — reopen at v3 via getDB() — note still there
		const { openDB } = await import('idb');

		const db2 = await openDB('tomboy-web', 2, {
			upgrade(db, oldVersion) {
				if (oldVersion < 1) {
					const noteStore = db.createObjectStore('notes', { keyPath: 'guid' });
					noteStore.createIndex('by-changeDate', 'changeDate');
					noteStore.createIndex('by-title', 'title');
					noteStore.createIndex('by-localDirty', 'localDirty');
					noteStore.createIndex('by-deleted', 'deleted');
					db.createObjectStore('syncManifest', { keyPath: 'id' });
				}
				if (oldVersion < 2) {
					if (db.objectStoreNames.contains('syncManifest')) {
						db.deleteObjectStore('syncManifest');
					}
					db.createObjectStore('syncManifest', { keyPath: 'id' });
				}
			}
		});

		await (db2 as any).put('notes', {
			guid: 'test-guid',
			uri: 'note://tomboy/test-guid',
			title: 'Test',
			xmlContent: '',
			createDate: '',
			changeDate: '',
			metadataChangeDate: '',
			cursorPosition: 0,
			selectionBoundPosition: -1,
			width: 450,
			height: 360,
			x: 0,
			y: 0,
			tags: [],
			openOnStartup: false,
			localDirty: false,
			deleted: false
		});
		db2.close();

		// getDB() should upgrade from v2 to v3, preserving existing data
		const { getDB } = await import('$lib/storage/db.js');
		const db3 = await getDB();
		const note = await db3.get('notes', 'test-guid');
		expect(note).toBeDefined();
		expect(note?.title).toBe('Test');
	});
});
