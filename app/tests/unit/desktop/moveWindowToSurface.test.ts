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

const CANVAS = { kind: 'workspace', index: 0 } as const;
const DRAWER0 = { kind: 'drawer', index: 0 } as const;

describe('desktopSession — moveWindowToSurface', () => {
	it('moves a canvas note into a drawer (MOVE: leaves the source)', async () => {
		await putNote(createEmptyNote(A));
		desktopSession._reset();
		desktopSession.openWindow(A);
		expect(desktopSession.windows.some((w) => w.guid === A)).toBe(true);

		await desktopSession.moveWindowToSurface(CANVAS, DRAWER0, A);
		expect(desktopSession.windows.some((w) => w.guid === A)).toBe(false);
		expect(desktopSession.drawerWindows(0).some((w) => w.guid === A)).toBe(true);
	});

	it('keeps per-surface geometry independent', async () => {
		await putNote(createEmptyNote(A));
		desktopSession._reset();
		desktopSession.openWindow(A);
		desktopSession.updateGeometry(A, { x: 10, y: 10, width: 600, height: 600 });

		await desktopSession.moveWindowToSurface(CANVAS, DRAWER0, A);
		desktopSession.updateGeometryOn(DRAWER0, A, { x: 5, y: 5, width: 320, height: 320 });
		expect(desktopSession.drawerWindows(0)[0].width).toBe(320);

		await desktopSession.moveWindowToSurface(DRAWER0, CANVAS, A);
		const back = desktopSession.windows.find((w) => w.guid === A)!;
		expect(back.width).toBe(600);
		expect(back.height).toBe(600);
	});

	it('stashToActiveDrawer moves the canvas note into the open drawer', async () => {
		await putNote(createEmptyNote(A));
		desktopSession._reset();
		desktopSession.openWindow(A);
		desktopSession.toggleDrawer(0);
		await desktopSession.stashToActiveDrawer(A);
		expect(desktopSession.drawerWindows(0).some((w) => w.guid === A)).toBe(true);
		expect(desktopSession.windows.some((w) => w.guid === A)).toBe(false);
	});

	it('stashToActiveDrawer is a no-op when no drawer is open', async () => {
		await putNote(createEmptyNote(A));
		desktopSession._reset();
		desktopSession.openWindow(A);
		await desktopSession.stashToActiveDrawer(A);
		expect(desktopSession.windows.some((w) => w.guid === A)).toBe(true);
	});

	it('moving a missing guid is a silent no-op', async () => {
		desktopSession._reset();
		await expect(
			desktopSession.moveWindowToSurface(CANVAS, DRAWER0, 'nope')
		).resolves.toBeUndefined();
	});
});
