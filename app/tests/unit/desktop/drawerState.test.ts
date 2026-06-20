import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote } from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';
import { desktopSession } from '$lib/desktop/session.svelte.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	desktopSession._reset();
});

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('desktopSession — drawers: toggle + width', () => {
	it('toggleDrawer opens, closes, and switches (one open at a time)', () => {
		expect(desktopSession.activeDrawer).toBe(null);
		desktopSession.toggleDrawer(0);
		expect(desktopSession.activeDrawer).toBe(0);
		expect(desktopSession.isDrawerOpen(0)).toBe(true);
		desktopSession.toggleDrawer(0);
		expect(desktopSession.activeDrawer).toBe(null);
		desktopSession.toggleDrawer(0);
		desktopSession.toggleDrawer(1);
		expect(desktopSession.activeDrawer).toBe(1);
		expect(desktopSession.isDrawerOpen(0)).toBe(false);
		desktopSession.closeDrawer();
		expect(desktopSession.activeDrawer).toBe(null);
	});

	it('out-of-range toggle is a no-op', () => {
		desktopSession.toggleDrawer(5);
		expect(desktopSession.activeDrawer).toBe(null);
	});

	it('setDrawerWidth clamps; getDrawerWidth reads it', () => {
		desktopSession.setDrawerWidth(0, 99999);
		expect(desktopSession.getDrawerWidth(0)).toBe(1200);
		desktopSession.setDrawerWidth(0, 10);
		expect(desktopSession.getDrawerWidth(0)).toBe(280);
		desktopSession.setDrawerWidth(0, 500);
		expect(desktopSession.getDrawerWidth(0)).toBe(500);
		expect(desktopSession.getDrawerWidth(1)).toBe(480);
	});

	it('drawerWindows is empty for a fresh / out-of-range drawer', () => {
		expect(desktopSession.drawerWindows(0)).toEqual([]);
		expect(desktopSession.drawerWindows(9)).toEqual([]);
	});

	it('focusedNoteGuid follows the active surface', async () => {
		await putNote(createEmptyNote(A));
		await putNote(createEmptyNote(B));
		desktopSession._reset();
		desktopSession.openWindow(A);
		expect(desktopSession.focusedNoteGuid).toBe(A);
		desktopSession.toggleDrawer(0);
		expect(desktopSession.focusedNoteGuid).toBe(null);
		desktopSession.closeDrawer();
		expect(desktopSession.focusedNoteGuid).toBe(A);
	});
});
