import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote } from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';
import { desktopSession } from '$lib/desktop/session.svelte.js';

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RAIL = 80;
const CANVAS = { kind: 'workspace', index: 0 } as const;
const DRAWER0 = { kind: 'drawer', index: 0 } as const;
const DRAWER1 = { kind: 'drawer', index: 1 } as const;

// Top drawer (0) defaults: left 100, width 760, height 380.
//   viewport rect = left RAIL+100=180, top 0, right 940, bottom 380.
// Right drawer (1) default width 480.
//   viewport rect = left innerWidth-480=520, top 0, right 1000, bottom 800.

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	desktopSession._reset();
	window.innerWidth = 1000;
	window.innerHeight = 800;
});

async function openOnCanvas(): Promise<void> {
	await putNote(createEmptyNote(A));
	desktopSession._reset();
	desktopSession.openWindow(A);
}

function canvasWin() {
	return desktopSession.windows.find((w) => w.guid === A);
}
function drawerWin(i: number) {
	return desktopSession.drawerWindows(i).find((w) => w.guid === A);
}

describe('desktopSession — dropDraggedWindow', () => {
	it('canvas→canvas: no drawer open → geometry update on canvas (winTopLeft − rail)', async () => {
		await openOnCanvas();
		await desktopSession.dropDraggedWindow(
			CANVAS,
			A,
			{ x: 300, y: 200 },
			{ x: 320, y: 210 },
			RAIL
		);
		expect(drawerWin(0)).toBeUndefined();
		const w = canvasWin()!;
		expect(w.x).toBe(220); // 300 − 80
		expect(w.y).toBe(200);
	});

	it('canvas→top-drawer: pointer inside open top drawer → moves in (drawer-local coords)', async () => {
		await openOnCanvas();
		desktopSession.toggleDrawer(0);
		await desktopSession.dropDraggedWindow(
			CANVAS,
			A,
			{ x: 400, y: 100 },
			{ x: 400, y: 100 },
			RAIL
		);
		expect(canvasWin()).toBeUndefined();
		const w = drawerWin(0)!;
		expect(w.x).toBe(220); // 400 − 180
		expect(w.y).toBe(100); // 100 − 0
	});

	it('top-drawer→canvas: pointer outside the open drawer → moves out to canvas', async () => {
		await openOnCanvas();
		desktopSession.toggleDrawer(0);
		await desktopSession.stashToActiveDrawer(A);
		expect(drawerWin(0)).toBeDefined();
		// y 500 is below the top drawer (bottom 380) → outside.
		await desktopSession.dropDraggedWindow(
			DRAWER0,
			A,
			{ x: 400, y: 500 },
			{ x: 400, y: 500 },
			RAIL
		);
		expect(drawerWin(0)).toBeUndefined();
		const w = canvasWin()!;
		expect(w.x).toBe(320); // 400 − 80
		expect(w.y).toBe(500);
	});

	it('top-drawer→top-drawer: pointer still inside → geometry update within the drawer', async () => {
		await openOnCanvas();
		desktopSession.toggleDrawer(0);
		await desktopSession.stashToActiveDrawer(A);
		await desktopSession.dropDraggedWindow(
			DRAWER0,
			A,
			{ x: 300, y: 100 },
			{ x: 300, y: 100 },
			RAIL
		);
		expect(canvasWin()).toBeUndefined();
		const w = drawerWin(0)!;
		expect(w.x).toBe(120); // 300 − 180
		expect(w.y).toBe(100);
	});

	it('no drawer open → always canvas even if pointer is where a drawer would be', async () => {
		await openOnCanvas();
		await desktopSession.dropDraggedWindow(
			CANVAS,
			A,
			{ x: 400, y: 100 },
			{ x: 400, y: 100 },
			RAIL
		);
		expect(drawerWin(0)).toBeUndefined();
		expect(canvasWin()).toBeDefined();
	});

	it('drop over the rail clamps the canvas x to 0', async () => {
		await openOnCanvas();
		await desktopSession.dropDraggedWindow(
			CANVAS,
			A,
			{ x: 40, y: 50 },
			{ x: 40, y: 50 },
			RAIL
		);
		const w = canvasWin()!;
		expect(w.x).toBe(0); // max(0, 40 − 80)
		expect(w.y).toBe(50);
	});

	it('canvas→right-drawer: pointer inside open right drawer → moves in', async () => {
		await openOnCanvas();
		desktopSession.toggleDrawer(1);
		await desktopSession.dropDraggedWindow(
			CANVAS,
			A,
			{ x: 600, y: 400 },
			{ x: 600, y: 400 },
			RAIL
		);
		expect(canvasWin()).toBeUndefined();
		const w = drawerWin(1)!;
		expect(w.x).toBe(80); // 600 − 520
		expect(w.y).toBe(400);
	});

	it('canvas→canvas when pointer misses the open right drawer (left of it)', async () => {
		await openOnCanvas();
		desktopSession.toggleDrawer(1);
		// x 300 is left of the right drawer (left 520) → outside → stays canvas.
		await desktopSession.dropDraggedWindow(
			CANVAS,
			A,
			{ x: 300, y: 400 },
			{ x: 300, y: 400 },
			RAIL
		);
		expect(drawerWin(1)).toBeUndefined();
		const w = canvasWin()!;
		expect(w.x).toBe(220); // 300 − 80
	});

	it('missing guid is a silent no-op', async () => {
		desktopSession._reset();
		await expect(
			desktopSession.dropDraggedWindow(CANVAS, 'nope', { x: 0, y: 0 }, { x: 0, y: 0 }, RAIL)
		).resolves.toBeUndefined();
	});
});
