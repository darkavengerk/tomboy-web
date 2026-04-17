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
});

async function seedThreeNotes() {
	const guids = [
		'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
		'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
		'cccccccc-cccc-cccc-cccc-cccccccccccc'
	];
	for (const g of guids) await putNote(createEmptyNote(g));
	return guids;
}

function effectiveZ(win: { z: number; pinned?: boolean }): number {
	return (win.pinned ? 1_000_000 : 0) + win.z;
}

describe('desktopSession — pin (always-on-top)', () => {
	it('togglePin flips the pinned flag on a window', async () => {
		const [g] = await seedThreeNotes();
		desktopSession._reset();
		desktopSession.openWindow(g);
		expect(desktopSession.isPinned(g)).toBe(false);
		desktopSession.togglePin(g);
		expect(desktopSession.isPinned(g)).toBe(true);
		desktopSession.togglePin(g);
		expect(desktopSession.isPinned(g)).toBe(false);
	});

	it('pinned window stays above unpinned even after focusWindow on the unpinned one', async () => {
		const [a, b, c] = await seedThreeNotes();
		desktopSession._reset();
		desktopSession.openWindow(a);
		desktopSession.openWindow(b);
		desktopSession.openWindow(c);

		// Pin a, then focus b (so b is the topmost unpinned).
		desktopSession.togglePin(a);
		desktopSession.focusWindow(b);

		const wins = desktopSession.windows;
		const aWin = wins.find((w) => w.guid === a)!;
		const bWin = wins.find((w) => w.guid === b)!;

		// a should still be above b in effective z because it is pinned.
		expect(effectiveZ(aWin)).toBeGreaterThan(effectiveZ(bWin));
	});

	it('two pinned windows: the more-recently-focused one wins among them', async () => {
		const [a, b] = await seedThreeNotes();
		desktopSession._reset();
		desktopSession.openWindow(a);
		desktopSession.openWindow(b);
		desktopSession.togglePin(a);
		desktopSession.togglePin(b);
		// Focus a last → a should be on top among pinned.
		desktopSession.focusWindow(a);
		const wins = desktopSession.windows;
		const aWin = wins.find((w) => w.guid === a)!;
		const bWin = wins.find((w) => w.guid === b)!;
		expect(effectiveZ(aWin)).toBeGreaterThan(effectiveZ(bWin));
	});

	it('togglePin on a non-existent guid is a silent no-op', async () => {
		desktopSession._reset();
		expect(() => desktopSession.togglePin('nope')).not.toThrow();
		expect(desktopSession.isPinned('nope')).toBe(false);
	});
});

describe('desktopSession — sendToBack', () => {
	it('puts the given window below all other currently open unpinned windows', async () => {
		const [a, b, c] = await seedThreeNotes();
		desktopSession._reset();
		desktopSession.openWindow(a);
		desktopSession.openWindow(b);
		desktopSession.openWindow(c);
		// c is the top by default (last opened).
		desktopSession.sendToBack(c);
		const wins = desktopSession.windows;
		const cZ = wins.find((w) => w.guid === c)!.z;
		const others = wins.filter((w) => w.guid !== c).map((w) => w.z);
		expect(Math.max(...others)).toBeGreaterThan(cZ);
		expect(Math.min(...others)).toBeGreaterThan(cZ);
	});

	it("sendToBack does NOT push the window below pinned windows' effective z", async () => {
		const [a, b] = await seedThreeNotes();
		desktopSession._reset();
		desktopSession.openWindow(a);
		desktopSession.openWindow(b);
		// Pin a (it's now above b regardless).
		desktopSession.togglePin(a);
		// sendToBack on b — b's raw z goes below a's, but a is pinned so a is still above.
		desktopSession.sendToBack(b);
		const wins = desktopSession.windows;
		const aWin = wins.find((w) => w.guid === a)!;
		const bWin = wins.find((w) => w.guid === b)!;
		expect(effectiveZ(aWin)).toBeGreaterThan(effectiveZ(bWin));
	});

	it('sendToBack on a single-window workspace keeps the window visible (no crash)', async () => {
		const [a] = await seedThreeNotes();
		desktopSession._reset();
		desktopSession.openWindow(a);
		expect(() => desktopSession.sendToBack(a)).not.toThrow();
		expect(desktopSession.windows).toHaveLength(1);
	});

	it('sendToBack on a non-existent guid is a silent no-op', async () => {
		desktopSession._reset();
		expect(() => desktopSession.sendToBack('nope')).not.toThrow();
	});
});

describe('desktopSession — pin persistence', () => {
	it('pinned state survives a simulated reload', async () => {
		const [g] = await seedThreeNotes();
		desktopSession._reset();
		desktopSession.openWindow(g);
		desktopSession.togglePin(g);
		// Let debounced persist fire.
		await new Promise((r) => setTimeout(r, 400));

		desktopSession._reset();
		await desktopSession.load();
		expect(desktopSession.isPinned(g)).toBe(true);
	});
});
