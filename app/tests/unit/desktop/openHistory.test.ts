import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote } from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';
import { getSetting } from '$lib/storage/appSettings.js';
import { desktopSession, HISTORY_GUID_PREFIX } from '$lib/desktop/session.svelte.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	desktopSession._reset();
	// Wide viewport so the right-placement clamp never fires → deterministic x.
	Object.defineProperty(window, 'innerWidth', { value: 2000, configurable: true });
});

describe('openHistory', () => {
	it('opens a history window beside the source with same size', () => {
		desktopSession.openWindowAt('src-guid', { x: 100, y: 80, width: 400, height: 360 });
		desktopSession.openHistory('src-guid');
		const hist = desktopSession.windows.find((w) => w.guid === `${HISTORY_GUID_PREFIX}src-guid`);
		expect(hist).toBeTruthy();
		expect(hist!.kind).toBe('history');
		expect(hist!.width).toBe(400);
		expect(hist!.height).toBe(360);
		expect(hist!.x).toBe(500);
		expect(hist!.y).toBe(80);
	});

	it('does nothing when the source window is absent', () => {
		desktopSession.openHistory('ghost');
		expect(desktopSession.windows.find((w) => w.guid === `${HISTORY_GUID_PREFIX}ghost`)).toBeUndefined();
	});

	it('focuses an already-open history window instead of duplicating', () => {
		desktopSession.openWindowAt('src2', { x: 0, y: 0, width: 300, height: 300 });
		desktopSession.openHistory('src2');
		desktopSession.openHistory('src2');
		const all = desktopSession.windows.filter((w) => w.guid === `${HISTORY_GUID_PREFIX}src2`);
		expect(all.length).toBe(1);
	});

	it('excludes history windows from the persisted snapshot', async () => {
		const note = createEmptyNote('22222222-2222-2222-2222-222222222222');
		await putNote(note);
		desktopSession._reset();
		desktopSession.openWindow(note.guid);
		desktopSession.openHistory(note.guid);
		// Wait out the 300ms debounced persist.
		await new Promise((r) => setTimeout(r, 400));
		const persisted = await getSetting<{ workspaces: Array<{ windows: Array<{ guid: string; kind: string }> }> }>('desktop:session');
		const allWindows = (persisted?.workspaces ?? []).flatMap((w) => w.windows);
		expect(allWindows.some((w) => w.kind === 'history')).toBe(false);
		expect(allWindows.some((w) => w.guid === note.guid)).toBe(true);
	});
});
