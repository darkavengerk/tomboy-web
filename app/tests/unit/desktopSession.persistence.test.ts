import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote } from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('desktopSession persistence', () => {
	// Regression for a silent DataCloneError: persistNow used to shallow-spread
	// Svelte 5 $state proxies, which failed to clone into IndexedDB. The empty
	// catch swallowed the error, so reloads silently started from scratch.
	it(
		'restores a moved/resized window across a simulated reload',
		{ timeout: 30_000 },
		async () => {
			// Seed a note in IDB so collectExistingGuids retains it on restore.
			const note = createEmptyNote('11111111-1111-1111-1111-111111111111');
			await putNote(note);

			const mod = await import('$lib/desktop/session.svelte.js');
			mod.desktopSession._reset();

			// Open → move → resize.
			mod.desktopSession.openWindow(note.guid);
			mod.desktopSession.moveWindow(note.guid, 200, 150);
			mod.desktopSession.resizeWindow(note.guid, 720, 600);

			// Wait for the 300ms debounced persist to fire + commit.
			await new Promise((r) => setTimeout(r, 400));

			// Simulate a browser reload: drop in-memory state, then reload.
			mod.desktopSession._reset();
			await mod.desktopSession.load();

			const restored = mod.desktopSession.windows;
			expect(restored).toHaveLength(1);
			expect(restored[0].guid).toBe(note.guid);
			expect(restored[0].x).toBe(200);
			expect(restored[0].y).toBe(150);
			expect(restored[0].width).toBe(720);
			expect(restored[0].height).toBe(600);
		}
	);
});
