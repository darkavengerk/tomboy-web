import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote } from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';
import { setSetting } from '$lib/storage/appSettings.js';
import { desktopSession } from '$lib/desktop/session.svelte.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	desktopSession._reset();
});

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('desktopSession — drawer persistence (v4)', () => {
	it('restores drawer contents + width + height across a simulated reload, closed', async () => {
		await putNote(createEmptyNote(A));
		desktopSession._reset();
		desktopSession.openWindow(A);
		desktopSession.toggleDrawer(0);
		await desktopSession.stashToActiveDrawer(A);
		desktopSession.setDrawerWidth(0, 640);
		desktopSession.setDrawerHeight(0, 520);
		await new Promise((r) => setTimeout(r, 400)); // let debounced persist fire

		desktopSession._reset();
		await desktopSession.load();
		expect(desktopSession.drawerWindows(0).some((w) => w.guid === A)).toBe(true);
		expect(desktopSession.getDrawerWidth(0)).toBe(640);
		expect(desktopSession.getDrawerHeight(0)).toBe(520);
		expect(desktopSession.activeDrawer).toBe(null);
	});

	it('loads a legacy v3 snapshot without error (empty drawers, default width/height)', async () => {
		await putNote(createEmptyNote(A));
		await setSetting('desktop:session', {
			version: 3,
			currentWorkspace: 0,
			workspaces: [
				{ windows: [{ guid: A, x: 0, y: 0, width: 560, height: 520, z: 1 }] },
				{ windows: [] },
				{ windows: [] },
				{ windows: [] }
			]
		});
		desktopSession._reset();
		await desktopSession.load();
		expect(desktopSession.windows.some((w) => w.guid === A)).toBe(true);
		expect(desktopSession.drawerWindows(0)).toEqual([]);
		expect(desktopSession.getDrawerWidth(0)).toBe(760);
		expect(desktopSession.getDrawerHeight(0)).toBe(380);
	});

	it('loads a v4 snapshot that predates drawerHeights (default height)', async () => {
		await putNote(createEmptyNote(A));
		await setSetting('desktop:session', {
			version: 4,
			currentWorkspace: 0,
			workspaces: [{ windows: [] }, { windows: [] }, { windows: [] }, { windows: [] }],
			drawers: [
				{ windows: [{ guid: A, x: 0, y: 0, width: 560, height: 520, z: 1 }] },
				{ windows: [] }
			],
			drawerWidths: [700, 480]
			// no drawerHeights — older v4 blob
		});
		desktopSession._reset();
		await desktopSession.load();
		expect(desktopSession.drawerWindows(0).some((w) => w.guid === A)).toBe(true);
		expect(desktopSession.getDrawerWidth(0)).toBe(700);
		expect(desktopSession.getDrawerHeight(0)).toBe(380);
	});
});
