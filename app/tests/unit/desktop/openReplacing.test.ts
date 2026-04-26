import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote } from '$lib/storage/noteStore.js';
import { createEmptyNote, type NoteData } from '$lib/core/note.js';
import {
	desktopSession,
	registerFlushHook
} from '$lib/desktop/session.svelte.js';

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

describe('desktopSession.openReplacing', () => {
	it("places target at the source's top-left and closes the source", async () => {
		const a = makeNote('aaaa-1111', 'A');
		const b = makeNote('bbbb-2222', 'B');
		await putNote(a);
		await putNote(b);

		desktopSession.openWindow(a.guid);
		desktopSession.moveWindow(a.guid, 320, 200);
		desktopSession.resizeWindow(a.guid, 600, 480);

		await desktopSession.openReplacing(a.guid, 'B');

		const wins = desktopSession.windows;
		expect(wins).toHaveLength(1);
		expect(wins[0].guid).toBe(b.guid);
		// Top-left aligned to where A was.
		expect(wins[0].x).toBe(320);
		expect(wins[0].y).toBe(200);
	});

	it("preserves the target's own size when the two notes differ", async () => {
		const a = makeNote('aaaa-1111', 'A');
		const b = makeNote('bbbb-2222', 'B');
		await putNote(a);
		await putNote(b);

		// Pre-cache a custom size for B by opening / resizing / closing it.
		desktopSession.openWindow(b.guid);
		desktopSession.resizeWindow(b.guid, 400, 320);
		await desktopSession.closeWindow(b.guid);

		desktopSession.openWindow(a.guid);
		desktopSession.moveWindow(a.guid, 100, 60);
		desktopSession.resizeWindow(a.guid, 800, 600);

		await desktopSession.openReplacing(a.guid, 'B');

		const wins = desktopSession.windows;
		expect(wins).toHaveLength(1);
		expect(wins[0].guid).toBe(b.guid);
		// Top-left from source A.
		expect(wins[0].x).toBe(100);
		expect(wins[0].y).toBe(60);
		// Size from B's cached geometry, not from A.
		expect(wins[0].width).toBe(400);
		expect(wins[0].height).toBe(320);
	});

	it("repositions the target window to source's top-left when it is already open", async () => {
		const a = makeNote('aaaa-1111', 'A');
		const b = makeNote('bbbb-2222', 'B');
		await putNote(a);
		await putNote(b);

		desktopSession.openWindow(a.guid);
		desktopSession.moveWindow(a.guid, 50, 40);
		desktopSession.openWindow(b.guid);
		desktopSession.moveWindow(b.guid, 700, 500);

		await desktopSession.openReplacing(a.guid, 'B');

		const wins = desktopSession.windows;
		expect(wins).toHaveLength(1);
		expect(wins[0].guid).toBe(b.guid);
		expect(wins[0].x).toBe(50);
		expect(wins[0].y).toBe(40);
	});

	it('flushes the source window before closing it', async () => {
		const a = makeNote('aaaa-1111', 'A');
		const b = makeNote('bbbb-2222', 'B');
		await putNote(a);
		await putNote(b);

		desktopSession.openWindow(a.guid);

		let flushed = false;
		registerFlushHook(a.guid, () => {
			flushed = true;
		});

		await desktopSession.openReplacing(a.guid, 'B');
		expect(flushed).toBe(true);
	});

	it('toasts and is a no-op when the target title is unknown', async () => {
		const a = makeNote('aaaa-1111', 'A');
		await putNote(a);

		desktopSession.openWindow(a.guid);
		await desktopSession.openReplacing(a.guid, '없는제목');

		// Source remains; nothing else opened.
		const wins = desktopSession.windows;
		expect(wins).toHaveLength(1);
		expect(wins[0].guid).toBe(a.guid);
	});

	it('is a no-op for self-link (target == source)', async () => {
		const a = makeNote('aaaa-1111', 'A');
		await putNote(a);

		desktopSession.openWindow(a.guid);
		await desktopSession.openReplacing(a.guid, 'A');

		const wins = desktopSession.windows;
		expect(wins).toHaveLength(1);
		expect(wins[0].guid).toBe(a.guid);
	});
});
