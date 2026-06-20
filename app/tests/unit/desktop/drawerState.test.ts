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

	it('setDrawerWidth floors at 100, no upper cap', () => {
		desktopSession.setDrawerWidth(0, 99999);
		expect(desktopSession.getDrawerWidth(0)).toBe(99999); // no max
		desktopSession.setDrawerWidth(0, 10);
		expect(desktopSession.getDrawerWidth(0)).toBe(100); // floor, never 0
		desktopSession.setDrawerWidth(0, 500);
		expect(desktopSession.getDrawerWidth(0)).toBe(500);
		expect(desktopSession.getDrawerWidth(1)).toBe(480);
	});

	it('default widths: top drawer (0) wider than the right drawer (1)', () => {
		expect(desktopSession.getDrawerWidth(0)).toBe(760);
		expect(desktopSession.getDrawerWidth(1)).toBe(480);
	});

	it('setDrawerHeight floors at 100, no upper cap (top drawer)', () => {
		expect(desktopSession.getDrawerHeight(0)).toBe(380);
		desktopSession.setDrawerHeight(0, 99999);
		expect(desktopSession.getDrawerHeight(0)).toBe(99999); // no max
		desktopSession.setDrawerHeight(0, 10);
		expect(desktopSession.getDrawerHeight(0)).toBe(100); // floor, never 0
		desktopSession.setDrawerHeight(0, 420);
		expect(desktopSession.getDrawerHeight(0)).toBe(420);
	});

	it('out-of-range setDrawerHeight is a no-op', () => {
		desktopSession.setDrawerHeight(9, 500);
		expect(desktopSession.getDrawerHeight(0)).toBe(380);
	});

	it('default left offset: top drawer (0) = 100, right drawer (1) = 0', () => {
		expect(desktopSession.getDrawerLeft(0)).toBe(100);
		expect(desktopSession.getDrawerLeft(1)).toBe(0);
	});

	it('setDrawerLeftKeepRight moves the left edge, pins the right, never 0', () => {
		// top default: left 100, width 760 → right 860
		desktopSession.setDrawerLeftKeepRight(0, 200);
		expect(desktopSession.getDrawerLeft(0)).toBe(200);
		expect(desktopSession.getDrawerWidth(0)).toBe(660); // 860 - 200, right pinned

		// dragging past 0 floors above 0 (clears the rail handle)
		desktopSession.setDrawerLeftKeepRight(0, -50);
		expect(desktopSession.getDrawerLeft(0)).toBeGreaterThan(0);
		// right edge still pinned at 860
		expect(desktopSession.getDrawerLeft(0) + desktopSession.getDrawerWidth(0)).toBe(860);
	});

	it('out-of-range setDrawerLeftKeepRight is a no-op', () => {
		desktopSession.setDrawerLeftKeepRight(9, 300);
		expect(desktopSession.getDrawerLeft(0)).toBe(100);
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
