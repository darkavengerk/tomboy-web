import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	_resetForTest,
	getCachedNotes,
	setCachedNotes,
	getCachedScrollTop,
	setCachedScrollTop,
	invalidateCache,
	noteMutated,
	getEpoch,
	onInvalidate,
	readThroughNotes
} from '$lib/stores/noteListCache.js';
import type { NoteData } from '$lib/core/note.js';

const stub = (guid: string) => ({ guid } as NoteData);

/** Full-enough NoteData for the noteMutated qualify filter + sort. */
const full = (guid: string, changeDate: string, extra: Partial<NoteData> = {}) =>
	({ guid, title: guid, changeDate, deleted: false, tags: [], ...extra }) as NoteData;

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

describe('noteListCache.noteMutated', () => {
	it('patches a warm cache in place: upsert + changeDate-DESC re-sort, NO refetch', async () => {
		setCachedNotes([full('b', '2024-02-01T00:00:00Z'), full('a', '2024-01-01T00:00:00Z')]);
		noteMutated(full('c', '2024-03-01T00:00:00Z'));
		expect(getCachedNotes()?.map((n) => n.guid)).toEqual(['c', 'b', 'a']);

		// The whole point: a subsequent read-through must NOT hit IDB.
		const fetch = vi.fn(async () => [] as NoteData[]);
		await readThroughNotes(fetch);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('replaces an existing entry by guid (rename / changeDate bump moves it up)', () => {
		setCachedNotes([full('b', '2024-02-01T00:00:00Z'), full('a', '2024-01-01T00:00:00Z')]);
		noteMutated(full('a', '2024-04-01T00:00:00Z', { title: 'renamed' }));
		const cached = getCachedNotes()!;
		expect(cached.map((n) => n.guid)).toEqual(['a', 'b']);
		expect(cached[0].title).toBe('renamed');
		expect(cached).toHaveLength(2); // replaced, not duplicated
	});

	it('removes a note that no longer qualifies (deleted / template) from the cache', () => {
		setCachedNotes([full('a', '2024-01-01T00:00:00Z'), full('b', '2024-02-01T00:00:00Z')]);
		noteMutated(full('a', '2024-03-01T00:00:00Z', { deleted: true }));
		expect(getCachedNotes()?.map((n) => n.guid)).toEqual(['b']);
		noteMutated(full('b', '2024-03-01T00:00:00Z', { tags: ['system:template'] }));
		expect(getCachedNotes()).toEqual([]);
	});

	it('copy-on-write: a consumer holding the previous array never sees the patch', () => {
		setCachedNotes([full('a', '2024-01-01T00:00:00Z')]);
		const before = getCachedNotes()!;
		noteMutated(full('b', '2024-02-01T00:00:00Z'));
		expect(before.map((n) => n.guid)).toEqual(['a']);
		expect(getCachedNotes()!.map((n) => n.guid)).toEqual(['b', 'a']);
	});

	it('cold cache: fires listeners but does not fabricate a cache', () => {
		const cb = vi.fn();
		onInvalidate(cb);
		noteMutated(full('a', '2024-01-01T00:00:00Z'));
		expect(cb).toHaveBeenCalledTimes(1);
		expect(getCachedNotes()).toBeNull();
	});

	it('degrades to a hard invalidate when a read-through fetch is in flight', async () => {
		const { fn, resolve } = deferredFetch([full('pre', '2024-01-01T00:00:00Z')]);
		const p = readThroughNotes(fn);

		// Mutation lands while the fetch is in flight: its snapshot may or may
		// not contain the write, so the cache must NOT be patched OR populated.
		noteMutated(full('new', '2024-02-01T00:00:00Z'));

		resolve();
		await p; // racing fetch still resolves for its own caller
		expect(getCachedNotes()).toBeNull();

		// Next reader re-fetches committed state.
		const fresh = vi.fn(async () => [full('new', '2024-02-01T00:00:00Z')]);
		const out = await readThroughNotes(fresh);
		expect(fresh).toHaveBeenCalledTimes(1);
		expect(out.map((n) => n.guid)).toEqual(['new']);
	});

	it("listeners receive 'mutate' vs 'invalidate' kinds", () => {
		const kinds: string[] = [];
		onInvalidate((kind) => kinds.push(kind));
		setCachedNotes([]);
		noteMutated(full('a', '2024-01-01T00:00:00Z'));
		invalidateCache();
		expect(kinds).toEqual(['mutate', 'invalidate']);
	});

	it('setCachedNotes with a stale epoch token cannot overwrite a newer patch', () => {
		setCachedNotes([full('a', '2024-01-01T00:00:00Z')]);
		// The /notes page captures the epoch, then fetches its own snapshot...
		const asOf = getEpoch();
		const staleSnapshot = [full('a', '2024-01-01T00:00:00Z')];
		// ...but a save lands (and patches the cache) before the fetch returns.
		noteMutated(full('b', '2024-02-01T00:00:00Z'));
		setCachedNotes(staleSnapshot, asOf);
		// The patched state survives; the stale snapshot was dropped.
		expect(getCachedNotes()!.map((n) => n.guid)).toEqual(['b', 'a']);
	});

	it('setCachedNotes with a current epoch token (or none) still writes', () => {
		const asOf = getEpoch();
		setCachedNotes([full('a', '2024-01-01T00:00:00Z')], asOf);
		expect(getCachedNotes()!.map((n) => n.guid)).toEqual(['a']);
		setCachedNotes([full('b', '2024-02-01T00:00:00Z')]);
		expect(getCachedNotes()!.map((n) => n.guid)).toEqual(['b']);
	});

	it('setCachedNotes with a pre-invalidate token is dropped too', () => {
		const asOf = getEpoch();
		invalidateCache();
		setCachedNotes([full('stale', '2024-01-01T00:00:00Z')], asOf);
		expect(getCachedNotes()).toBeNull();
	});
});
