// app/tests/unit/storage/favoriteStore.test.ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { getSetting, setSetting } from '$lib/storage/appSettings.js';
import { favoriteStore } from '$lib/storage/favoriteStore.svelte.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	favoriteStore._reset();
});

describe('favoriteStore', () => {
	it('has() returns false before load()', () => {
		expect(favoriteStore.has('any-guid')).toBe(false);
	});

	it('toggle() adds when absent and returns true', async () => {
		await favoriteStore.load();
		const next = favoriteStore.toggle('g1');
		expect(next).toBe(true);
		expect(favoriteStore.has('g1')).toBe(true);
	});

	it('toggle() removes when present and returns false', async () => {
		await favoriteStore.load();
		favoriteStore.toggle('g1');
		const next = favoriteStore.toggle('g1');
		expect(next).toBe(false);
		expect(favoriteStore.has('g1')).toBe(false);
	});

	it('forget() removes a guid; no-op for unknown', async () => {
		await favoriteStore.load();
		favoriteStore.toggle('g1');
		favoriteStore.forget('g1');
		expect(favoriteStore.has('g1')).toBe(false);
		expect(() => favoriteStore.forget('never-existed')).not.toThrow();
	});

	it('persist is debounced — multiple toggles within window write once', async () => {
		vi.useFakeTimers();
		try {
			await favoriteStore.load();
			favoriteStore.toggle('a');
			favoriteStore.toggle('b');
			favoriteStore.toggle('c');
			expect(await getSetting<Record<string, true>>('local:favorites')).toBeUndefined();
			await vi.advanceTimersByTimeAsync(350);
			const stored = await getSetting<Record<string, true>>('local:favorites');
			expect(stored).toEqual({ a: true, b: true, c: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it('load() is idempotent — second call does not re-read from IDB', async () => {
		await setSetting('local:favorites', { seed: true });
		await favoriteStore.load();
		expect(favoriteStore.has('seed')).toBe(true);
		await setSetting('local:favorites', { other: true });
		await favoriteStore.load();
		expect(favoriteStore.has('seed')).toBe(true);
		expect(favoriteStore.has('other')).toBe(false);
	});

	it('load() restores existing appSettings data', async () => {
		await setSetting('local:favorites', { x: true, y: true });
		await favoriteStore.load();
		expect(favoriteStore.has('x')).toBe(true);
		expect(favoriteStore.has('y')).toBe(true);
		expect(favoriteStore.has('z')).toBe(false);
	});
});
