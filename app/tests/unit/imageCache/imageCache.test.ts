import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import {
	lookupOrFetch,
	prime,
	getBlob,
	clearAll,
	getStats,
	setQuota,
	__resetForTest as resetCache
} from '$lib/imageCache/imageCache.js';
import { __resetForTest as resetPool } from '$lib/imageCache/objectUrlPool.js';
import {
	registerFetcher,
	__resetForTest as resetFetchers
} from '$lib/imageCache/fetchers/registry.js';

function fakeBlob(bytes: number, type = 'image/png'): Blob {
	return new Blob([new Uint8Array(bytes)], { type });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	resetCache();
	resetPool();
	resetFetchers();
	vi.spyOn(URL, 'createObjectURL').mockImplementation(
		(b: Blob | MediaSource) => `blob:${(b as Blob).size}-${Math.random()}`
	);
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
	fetchMock = vi.fn();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('imageCache', () => {
	it('prime → lookupOrFetch returns fromCache:true', async () => {
		await prime('https://a/x.png', fakeBlob(100), 'image/png');
		const r = await lookupOrFetch('https://a/x.png');
		expect(r.fromCache).toBe(true);
		expect(r.src.startsWith('blob:')).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('lookupOrFetch miss → fetch + cache, returns fromCache:false', async () => {
		const blob = fakeBlob(100);
		fetchMock.mockResolvedValueOnce({
			ok: true,
			blob: () => Promise.resolve(blob),
			headers: { get: () => 'image/png' }
		});
		const r = await lookupOrFetch('https://a/x.png');
		expect(r.fromCache).toBe(false);
		expect(r.src.startsWith('blob:')).toBe(true);
		expect(fetchMock).toHaveBeenCalledOnce();

		// Second call should be a cache hit
		const r2 = await lookupOrFetch('https://a/x.png');
		expect(r2.fromCache).toBe(true);
		expect(fetchMock).toHaveBeenCalledOnce(); // still only 1 fetch
	});

	it('lookupOrFetch fetch failure → fallback to original url, no cache', async () => {
		fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
		const r = await lookupOrFetch('https://a/x.png');
		expect(r.src).toBe('https://a/x.png');
		expect(r.fromCache).toBe(false);

		// Second call should also miss (not cached)
		fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
		const r2 = await lookupOrFetch('https://a/x.png');
		expect(r2.fromCache).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('concurrent lookupOrFetch dedupes fetch', async () => {
		const blob = fakeBlob(100);
		fetchMock.mockResolvedValueOnce({
			ok: true,
			blob: () => Promise.resolve(blob),
			headers: { get: () => null }
		});
		const [a, b, c] = await Promise.all([
			lookupOrFetch('https://a/x.png'),
			lookupOrFetch('https://a/x.png'),
			lookupOrFetch('https://a/x.png')
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(a.src).toBe(b.src);
		expect(b.src).toBe(c.src);
	});

	it('prime over quota triggers LRU evict', async () => {
		// quota=1000, prime 400+400+400=1200 → oldest item evicted
		await setQuota(1000);
		await prime('https://a/1.png', fakeBlob(400), 'image/png');
		await new Promise((r) => setTimeout(r, 5)); // ensure distinct lastAccess
		await prime('https://a/2.png', fakeBlob(400), 'image/png');
		await new Promise((r) => setTimeout(r, 5));
		await prime('https://a/3.png', fakeBlob(400), 'image/png');

		const stats = await getStats();
		expect(stats.totalBytes).toBeLessThanOrEqual(1000);
		expect(stats.count).toBe(2); // 1st entry evicted
		expect(await getBlob('https://a/1.png')).toBeNull();
		expect(await getBlob('https://a/3.png')).not.toBeNull();
	});

	it('single image larger than quota → not cached, no error', async () => {
		await setQuota(100);
		await prime('https://a/big.png', fakeBlob(500), 'image/png'); // should not throw
		const stats = await getStats();
		expect(stats.count).toBe(0);
		expect(stats.totalBytes).toBe(0);
	});

	it('clearAll empties store and pool', async () => {
		await prime('https://a/x.png', fakeBlob(100), 'image/png');
		await clearAll();
		const s = await getStats();
		expect(s.count).toBe(0);
		expect(s.totalBytes).toBe(0);
		expect(await getBlob('https://a/x.png')).toBeNull();
	});

	it('setQuota shrink → immediate evict to fit', async () => {
		await setQuota(2000); // ensure both items can be added initially
		await prime('https://a/1.png', fakeBlob(400), 'image/png');
		await new Promise((r) => setTimeout(r, 5));
		await prime('https://a/2.png', fakeBlob(400), 'image/png');
		await setQuota(500);
		const s = await getStats();
		expect(s.totalBytes).toBeLessThanOrEqual(500);
		expect(s.quotaBytes).toBe(500);
	});

	it('getBlob returns blob on hit, null on miss', async () => {
		await prime('https://a/x.png', fakeBlob(100), 'image/png');
		const b = await getBlob('https://a/x.png');
		// fake-indexeddb structuredClone may return a plain object instead of
		// a true Blob instance (jsdom limitation) — just check it's truthy
		expect(b).not.toBeNull();
		expect(b).toBeTruthy();
		expect(await getBlob('https://nope/x.png')).toBeNull();
	});

	it('getStats reconciles totalBytes via cursorSumSize', async () => {
		await prime('https://a/x.png', fakeBlob(100), 'image/png');
		await prime('https://a/y.png', fakeBlob(200), 'image/png');
		const s = await getStats();
		expect(s.totalBytes).toBe(300);
		expect(s.count).toBe(2);
	});

	it('setQuota persists and getStats returns new quotaBytes', async () => {
		await setQuota(2_000_000);
		const s = await getStats();
		expect(s.quotaBytes).toBe(2_000_000);
	});

	it('prime overwrite: old size subtracted, new size added, old ObjectURL revoked', async () => {
		const url = 'https://a/overwrite.png';
		const blobA = fakeBlob(200);
		const blobB = fakeBlob(100);

		await prime(url, blobA, 'image/png');
		await prime(url, blobB, 'image/png');

		const s = await getStats();
		expect(s.count).toBe(1);
		expect(s.totalBytes).toBe(100);

		// getBlob should return the new record (not null)
		const stored = await getBlob(url);
		expect(stored).not.toBeNull();

		// The new ObjectURL (registered in pool from blobB, size=100) should be
		// surfaced by lookupOrFetch. Our URL.createObjectURL mock encodes the blob
		// size as `blob:<size>-<random>`, so a src starting with "blob:100" means
		// blobB is in the pool — not the old blobA (200-byte).
		const r = await lookupOrFetch(url);
		expect(r.fromCache).toBe(true);
		expect(r.src).toMatch(/^blob:100-/);

		// The old ObjectURL for blobA must have been revoked during the overwrite
		expect(URL.revokeObjectURL).toHaveBeenCalled();
	});

	it('lookupOrFetch miss → registered fetcher used over plain fetch', async () => {
		const blob = fakeBlob(123, 'image/jpeg');
		const fetcherFetch = vi.fn(async () => blob);
		registerFetcher({
			name: 'test-host',
			matches: (u) => u.startsWith('https://cdn.test/'),
			fetch: fetcherFetch
		});

		const r = await lookupOrFetch('https://cdn.test/a.jpg');
		expect(r.fromCache).toBe(false);
		expect(r.src.startsWith('blob:')).toBe(true);
		expect(fetcherFetch).toHaveBeenCalledWith('https://cdn.test/a.jpg');
		expect(fetchMock).not.toHaveBeenCalled();

		// Second call hits cache
		const r2 = await lookupOrFetch('https://cdn.test/a.jpg');
		expect(r2.fromCache).toBe(true);
		expect(fetcherFetch).toHaveBeenCalledTimes(1);
	});

	it('fetcher throws → fallback to original URL, no cache entry', async () => {
		registerFetcher({
			name: 'failing',
			matches: () => true,
			fetch: async () => {
				throw new Error('cors blocked');
			}
		});

		const r = await lookupOrFetch('https://x/y.png');
		expect(r.fromCache).toBe(false);
		expect(r.src).toBe('https://x/y.png');
		expect(await getBlob('https://x/y.png')).toBeNull();
	});

	it('no matching fetcher → plain fetch used as fallback', async () => {
		registerFetcher({
			name: 'narrow',
			matches: (u) => u.includes('dropbox.com'),
			fetch: async () => fakeBlob(50)
		});
		const blob = fakeBlob(80);
		fetchMock.mockResolvedValueOnce({
			ok: true,
			blob: () => Promise.resolve(blob),
			headers: new Map([['content-type', 'image/png']])
		});

		const r = await lookupOrFetch('https://cdn.example.com/x.png');
		expect(r.fromCache).toBe(false);
		expect(r.src.startsWith('blob:')).toBe(true);
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
