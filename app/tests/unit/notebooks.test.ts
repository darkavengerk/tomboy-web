import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import {
	listNotebooks,
	createNotebook,
	assignNotebook,
	deleteNotebook,
	getNotebook
} from '$lib/core/notebooks.js';
import { createNote, getNote } from '$lib/core/noteManager.js';
import { getAllNotes } from '$lib/storage/noteStore.js';
import { _resetDBForTest } from '$lib/storage/db.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('notebooks', () => {
	it('listNotebooks returns unique sorted names from all notes including templates', async () => {
		await createNotebook('Work');
		await createNotebook('Personal');
		const n = await createNote('test');
		await assignNotebook(n.guid, 'Work');
		const names = await listNotebooks();
		expect(names).toEqual(['Personal', 'Work']);
	});

	it('createNotebook creates a template note with proper tags', async () => {
		await createNotebook('Work');
		const notebooks = await listNotebooks();
		expect(notebooks).toContain('Work');
	});

	it('createNotebook is idempotent (creating existing notebook does not duplicate)', async () => {
		await createNotebook('Work');
		await createNotebook('Work');
		const names = await listNotebooks();
		expect(names.filter((n) => n === 'Work')).toHaveLength(1);
	});

	it('assignNotebook(guid, "Work") replaces any existing system:notebook:* tag', async () => {
		const n = await createNote('hello');
		await assignNotebook(n.guid, 'Work');
		await assignNotebook(n.guid, 'Home');
		const updated = await getNote(n.guid);
		expect(getNotebook(updated!)).toBe('Home');
		expect(updated!.tags.filter((t) => t.startsWith('system:notebook:'))).toHaveLength(1);
	});

	it('assignNotebook(guid, null) removes all system:notebook:* tags', async () => {
		const n = await createNote('hello');
		await assignNotebook(n.guid, 'Work');
		await assignNotebook(n.guid, null);
		const updated = await getNote(n.guid);
		expect(getNotebook(updated!)).toBeNull();
	});

	it('deleteNotebook removes template note and strips tag from member notes', async () => {
		await createNotebook('Work');
		const n = await createNote('test');
		await assignNotebook(n.guid, 'Work');
		await deleteNotebook('Work');
		const names = await listNotebooks();
		expect(names).not.toContain('Work');
		const updated = await getNote(n.guid);
		expect(getNotebook(updated!)).toBeNull();
	});

	it('getAllNotes excludes system:template notes', async () => {
		await createNotebook('Work'); // creates template note
		const n = await createNote('regular');
		const all = await getAllNotes();
		expect(all.every((x) => !x.tags.includes('system:template'))).toBe(true);
		expect(all.some((x) => x.guid === n.guid)).toBe(true);
	});

	it('getNotebook(note) returns first system:notebook:* tag, or null', async () => {
		const n = await createNote('test');
		expect(getNotebook(n)).toBeNull();
		await assignNotebook(n.guid, 'Work');
		const updated = await getNote(n.guid);
		expect(getNotebook(updated!)).toBe('Work');
	});
});
