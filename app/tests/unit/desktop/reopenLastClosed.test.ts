import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote, deleteNote } from '$lib/storage/noteStore.js';
import { createEmptyNote, type NoteData } from '$lib/core/note.js';
import { desktopSession } from '$lib/desktop/session.svelte.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	desktopSession._reset();
});

function makeNote(guid: string, title: string): NoteData {
	const n = createEmptyNote(guid);
	n.title = title;
	return n;
}

describe('desktopSession.reopenLastClosed', () => {
	it('reopens the most recently closed note', async () => {
		const a = makeNote('aaaa-1111', 'A');
		const b = makeNote('bbbb-2222', 'B');
		await putNote(a);
		await putNote(b);

		desktopSession.openWindow(a.guid);
		desktopSession.openWindow(b.guid);
		await desktopSession.closeWindow(a.guid);
		await desktopSession.closeWindow(b.guid);

		await desktopSession.reopenLastClosed();

		const wins = desktopSession.windows;
		expect(wins.map((w) => w.guid)).toContain(b.guid);
		expect(wins.map((w) => w.guid)).not.toContain(a.guid);
	});

	it('pops through the stack on repeated calls (LIFO)', async () => {
		const a = makeNote('aaaa-1111', 'A');
		const b = makeNote('bbbb-2222', 'B');
		await putNote(a);
		await putNote(b);

		desktopSession.openWindow(a.guid);
		desktopSession.openWindow(b.guid);
		await desktopSession.closeWindow(a.guid);
		await desktopSession.closeWindow(b.guid);

		await desktopSession.reopenLastClosed(); // B
		await desktopSession.reopenLastClosed(); // A

		expect(desktopSession.windows.map((w) => w.guid).sort()).toEqual(
			[a.guid, b.guid].sort()
		);
	});

	it('is a no-op when nothing was closed', async () => {
		const a = makeNote('aaaa-1111', 'A');
		await putNote(a);
		desktopSession.openWindow(a.guid);

		await desktopSession.reopenLastClosed();

		expect(desktopSession.windows).toHaveLength(1);
		expect(desktopSession.windows[0].guid).toBe(a.guid);
	});

	it('skips a guid that is already open and falls through to the next', async () => {
		const a = makeNote('aaaa-1111', 'A');
		const b = makeNote('bbbb-2222', 'B');
		await putNote(a);
		await putNote(b);

		desktopSession.openWindow(a.guid);
		desktopSession.openWindow(b.guid);
		await desktopSession.closeWindow(a.guid); // stack: [a]
		await desktopSession.closeWindow(b.guid); // stack: [a, b]
		desktopSession.openWindow(b.guid); // b open again, top of stack now stale

		await desktopSession.reopenLastClosed(); // b is open → skip, reopen a

		const guids = desktopSession.windows.map((w) => w.guid);
		expect(guids).toContain(a.guid);
		expect(guids).toContain(b.guid);
	});

	it('skips a guid whose note has been deleted', async () => {
		const a = makeNote('aaaa-1111', 'A');
		const b = makeNote('bbbb-2222', 'B');
		await putNote(a);
		await putNote(b);

		desktopSession.openWindow(a.guid);
		desktopSession.openWindow(b.guid);
		await desktopSession.closeWindow(a.guid);
		await desktopSession.closeWindow(b.guid);
		await deleteNote(b.guid);

		await desktopSession.reopenLastClosed(); // b deleted → skip, reopen a

		const guids = desktopSession.windows.map((w) => w.guid);
		expect(guids).toContain(a.guid);
		expect(guids).not.toContain(b.guid);
	});

	it('de-dupes: closing the same note twice keeps a single, most-recent entry', async () => {
		const a = makeNote('aaaa-1111', 'A');
		const b = makeNote('bbbb-2222', 'B');
		await putNote(a);
		await putNote(b);

		desktopSession.openWindow(a.guid);
		desktopSession.openWindow(b.guid);
		await desktopSession.closeWindow(b.guid); // stack: [b]
		await desktopSession.closeWindow(a.guid); // stack: [b, a]
		desktopSession.openWindow(b.guid);
		await desktopSession.closeWindow(b.guid); // stack de-duped: [a, b]

		await desktopSession.reopenLastClosed(); // b
		await desktopSession.reopenLastClosed(); // a

		// Only two reopens needed — no stale duplicate b lingering.
		expect(desktopSession.windows.map((w) => w.guid).sort()).toEqual(
			[a.guid, b.guid].sort()
		);
	});

	it('does not record settings/admin closes', async () => {
		const a = makeNote('aaaa-1111', 'A');
		await putNote(a);

		desktopSession.openWindow(a.guid);
		desktopSession.openSettings();
		await desktopSession.closeWindow('__settings__');

		await desktopSession.reopenLastClosed();

		// Settings was not recorded, so nothing reopens (A is still open).
		const guids = desktopSession.windows.map((w) => w.guid);
		expect(guids).toContain(a.guid);
		expect(guids).not.toContain('__settings__');
	});
});
