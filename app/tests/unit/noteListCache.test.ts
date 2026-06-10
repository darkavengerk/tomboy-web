import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	_resetForTest,
	getCachedNotes,
	setCachedNotes,
	getCachedScrollTop,
	setCachedScrollTop,
	invalidateCache,
	onInvalidate,
	readThroughNotes
} from '$lib/stores/noteListCache.js';
import type { NoteData } from '$lib/core/note.js';

const stub = (guid: string) => ({ guid } as NoteData);

/** A fetch whose resolution is controlled by the returned `resolve` fn. */
function deferredFetch(value: NoteData[]) {
	let resolve!: () => void;
	const gate = new Promise<void>((r) => {
		resolve = r;
	});
	const fn = vi.fn(async () => {
		await gate;
		return value;
	});
	return { fn, resolve };
}

beforeEach(() => {
	_resetForTest();
});

describe('noteListCache', () => {
	it('starts empty', () => {
		expect(getCachedNotes()).toBeNull();
		expect(getCachedScrollTop()).toBe(0);
	});

	it('setCache(notes) stores value retrievable synchronously', () => {
		setCachedNotes([stub('a'), stub('b')]);
		expect(getCachedNotes()).toHaveLength(2);
	});

	it('invalidate() clears notes but keeps scrollTop', () => {
		setCachedNotes([stub('a')]);
		setCachedScrollTop(123);
		invalidateCache();
		expect(getCachedNotes()).toBeNull();
		expect(getCachedScrollTop()).toBe(123);
	});

	it('setScrollTop(n) / getScrollTop() roundtrip', () => {
		setCachedScrollTop(456);
		expect(getCachedScrollTop()).toBe(456);
	});

	it('onInvalidate listener fires once per invalidation', () => {
		const cb = vi.fn();
		const off = onInvalidate(cb);
		invalidateCache();
		invalidateCache();
		expect(cb).toHaveBeenCalledTimes(2);
		off();
		invalidateCache();
		expect(cb).toHaveBeenCalledTimes(2); // no more after unsubscribe
	});
});

describe('noteListCache.readThroughNotes', () => {
	it('cold cache runs the fetch and caches the result', async () => {
		const fetch = vi.fn(async () => [stub('a')]);
		const out = await readThroughNotes(fetch);
		expect(out).toEqual([stub('a')]);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(getCachedNotes()).toEqual([stub('a')]);
	});

	it('warm cache resolves without fetching', async () => {
		setCachedNotes([stub('a')]);
		const fetch = vi.fn(async () => [stub('zzz')]);
		const out = await readThroughNotes(fetch);
		expect(out).toEqual([stub('a')]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('coalesces concurrent cold callers onto ONE fetch', async () => {
		// This is the whole point: titleProvider + slipNoteGuids both refresh on
		// one invalidate; they must share a single getAll, not issue two.
		const { fn, resolve } = deferredFetch([stub('a'), stub('b')]);
		const p1 = readThroughNotes(fn);
		const p2 = readThroughNotes(fn);
		resolve();
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(r1).toBe(r2); // same cached array instance
		expect(r1).toEqual([stub('a'), stub('b')]);
	});

	it('invalidate during an in-flight fetch does NOT cache its (stale) result', async () => {
		const { fn: fn1, resolve: resolve1 } = deferredFetch([stub('stale')]);
		const p1 = readThroughNotes(fn1);

		// A mutation lands mid-fetch.
		invalidateCache();

		// The in-flight fetch resolves AFTER the invalidate.
		resolve1();
		const r1 = await p1;
		expect(r1).toEqual([stub('stale')]); // its own caller still gets the value
		expect(getCachedNotes()).toBeNull(); // but it must NOT have populated the cache

		// The next read re-fetches fresh post-invalidate state.
		const fresh = vi.fn(async () => [stub('fresh')]);
		const r2 = await readThroughNotes(fresh);
		expect(fresh).toHaveBeenCalledTimes(1);
		expect(r2).toEqual([stub('fresh')]);
	});

	it('a fresh read after a completed cache cycle re-fetches once invalidated', async () => {
		const f1 = vi.fn(async () => [stub('v1')]);
		await readThroughNotes(f1);
		// Warm: no re-fetch.
		await readThroughNotes(f1);
		expect(f1).toHaveBeenCalledTimes(1);

		invalidateCache();
		const f2 = vi.fn(async () => [stub('v2')]);
		const out = await readThroughNotes(f2);
		expect(out).toEqual([stub('v2')]);
		expect(f2).toHaveBeenCalledTimes(1);
	});

	it('a rejected fetch clears in-flight so the next call retries', async () => {
		const bad = vi.fn(async () => {
			throw new Error('idb boom');
		});
		await expect(readThroughNotes(bad)).rejects.toThrow('idb boom');
		expect(getCachedNotes()).toBeNull();
		const good = vi.fn(async () => [stub('ok')]);
		const out = await readThroughNotes(good);
		expect(out).toEqual([stub('ok')]);
		expect(good).toHaveBeenCalledTimes(1);
	});
});
