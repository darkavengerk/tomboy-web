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

describe('desktopSession — minimize / restore', () => {
	it('minimizeWindow hides the note but keeps it in windows[]', async () => {
		const [g] = await seedThreeNotes();
		desktopSession._reset();
		desktopSession.openWindow(g);
		expect(desktopSession.isMinimized(g)).toBe(false);

		desktopSession.minimizeWindow(g);
		expect(desktopSession.isMinimized(g)).toBe(true);
		// Still part of the workspace — F4 spread reads desktopSession.windows.
		expect(desktopSession.windows.some((w) => w.guid === g)).toBe(true);
	});

	it('minimizedWindows lists only minimized notes, most-recently-minimized first', async () => {
		const [a, b, c] = await seedThreeNotes();
		desktopSession._reset();
		desktopSession.openWindow(a);
		desktopSession.openWindow(b);
		desktopSession.openWindow(c);

		// Minimize b then a. Each open/focus bumped z; restoreWindow/minimize
		// rely on z for ordering. Focus b, minimize it; focus a, minimize it.
		desktopSession.focusWindow(b);
		desktopSession.minimizeWindow(b);
		desktopSession.focusWindow(a);
		desktopSession.minimizeWindow(a);

		const mins = desktopSession.minimizedWindows.map((w) => w.guid);
		expect(mins).toEqual([a, b]); // a minimized last → top (z-desc)
		expect(mins).not.toContain(c); // c is still visible
	});

	it('minimizing the focused note chains focus to the next visible note', async () => {
		const [a, b] = await seedThreeNotes();
		desktopSession._reset();
		desktopSession.openWindow(a);
		desktopSession.openWindow(b); // b is focused (topmost)

		desktopSession.minimizeWindow(b);
		// Focus should chain to a (the remaining visible note).
		expect(desktopSession.focusRequest?.guid).toBe(a);
		// focusedNoteGuid skips minimized windows.
		expect(desktopSession.focusedNoteGuid).toBe(a);
	});

	it('restoreWindow clears the flag, raises, and fires a fresh focusRequest', async () => {
		const [a, b] = await seedThreeNotes();
		desktopSession._reset();
		desktopSession.openWindow(a);
		desktopSession.openWindow(b);
		desktopSession.minimizeWindow(a);
		expect(desktopSession.isMinimized(a)).toBe(true);

		const beforeToken = desktopSession.focusRequest?.token ?? 0;
		desktopSession.restoreWindow(a);
		expect(desktopSession.isMinimized(a)).toBe(false);
		expect(desktopSession.focusRequest?.guid).toBe(a);
		expect(desktopSession.focusRequest!.token).toBeGreaterThan(beforeToken);
		// Restored note is now the topmost (highest z among notes).
		expect(desktopSession.focusedNoteGuid).toBe(a);
	});

	it('minimized lists are per-workspace', async () => {
		const [a, b] = await seedThreeNotes();
		desktopSession._reset();
		// Workspace 0: open + minimize a.
		desktopSession.openWindow(a);
		desktopSession.minimizeWindow(a);
		expect(desktopSession.minimizedWindows.map((w) => w.guid)).toEqual([a]);

		// Workspace 2: open b, minimize nothing — its minimized list is empty.
		await desktopSession.switchWorkspace(2);
		desktopSession.openWindow(b);
		expect(desktopSession.minimizedWindows).toHaveLength(0);

		// Back to workspace 0: a is still the only minimized note there.
		await desktopSession.switchWorkspace(0);
		expect(desktopSession.minimizedWindows.map((w) => w.guid)).toEqual([a]);
	});

	it('re-opening a minimized note via openWindow restores it', async () => {
		const [a] = await seedThreeNotes();
		desktopSession._reset();
		desktopSession.openWindow(a);
		desktopSession.minimizeWindow(a);
		expect(desktopSession.isMinimized(a)).toBe(true);

		// Clicking the note in the SidePanel main list routes through openWindow.
		desktopSession.openWindow(a);
		expect(desktopSession.isMinimized(a)).toBe(false);
		expect(desktopSession.minimizedWindows).toHaveLength(0);
		expect(desktopSession.focusedNoteGuid).toBe(a);
	});

	it('minimizeWindow on a non-existent guid is a silent no-op', async () => {
		desktopSession._reset();
		expect(() => desktopSession.minimizeWindow('nope')).not.toThrow();
		expect(desktopSession.isMinimized('nope')).toBe(false);
	});

	it('minimized state survives a simulated reload', async () => {
		const [g] = await seedThreeNotes();
		desktopSession._reset();
		desktopSession.openWindow(g);
		desktopSession.minimizeWindow(g);
		// Let the debounced persist fire.
		await new Promise((r) => setTimeout(r, 400));

		desktopSession._reset();
		await desktopSession.load();
		expect(desktopSession.isMinimized(g)).toBe(true);
		expect(desktopSession.windows.some((w) => w.guid === g)).toBe(true);
	});
});
