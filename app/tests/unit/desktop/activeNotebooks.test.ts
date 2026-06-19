import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { getSetting } from '$lib/storage/appSettings.js';
import { activeNotebooks } from '$lib/desktop/activeNotebooks.svelte.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	activeNotebooks._reset();
});

describe('activeNotebooks', () => {
	it('toggle adds newest key to the front (topmost)', () => {
		activeNotebooks.toggle(0, 'A');
		activeNotebooks.toggle(0, 'B');
		expect(activeNotebooks.list(0)).toEqual(['B', 'A']);
		expect(activeNotebooks.top(0)).toBe('B');
	});

	it('toggle removes an existing key', () => {
		activeNotebooks.toggle(0, 'A');
		activeNotebooks.toggle(0, 'A');
		expect(activeNotebooks.list(0)).toEqual([]);
		expect(activeNotebooks.top(0)).toBeUndefined();
	});

	it('isActive reflects membership; sets are per-workspace', () => {
		activeNotebooks.toggle(0, 'A');
		expect(activeNotebooks.isActive(0, 'A')).toBe(true);
		expect(activeNotebooks.isActive(1, 'A')).toBe(false);
	});

	it('clear empties one workspace only', () => {
		activeNotebooks.toggle(0, 'A');
		activeNotebooks.toggle(1, 'B');
		activeNotebooks.clear(0);
		expect(activeNotebooks.list(0)).toEqual([]);
		expect(activeNotebooks.list(1)).toEqual(['B']);
	});

	it('persists and reloads round-trip', async () => {
		activeNotebooks.toggle(0, 'A');
		activeNotebooks.toggle(2, 'X');
		await new Promise((r) => setTimeout(r, 400)); // 300ms 디바운스 flush
		const raw = await getSetting<Record<number, string[]>>('desktop:activeNotebooks');
		expect(raw).toBeTruthy();

		activeNotebooks._reset();
		await activeNotebooks.load();
		expect(activeNotebooks.list(0)).toEqual(['A']);
		expect(activeNotebooks.list(2)).toEqual(['X']);
	});

	it('lockedOpen toggles and is not persisted', () => {
		expect(activeNotebooks.lockedOpen).toBe(false);
		activeNotebooks.toggleLockedOpen();
		expect(activeNotebooks.lockedOpen).toBe(true);
	});
});
