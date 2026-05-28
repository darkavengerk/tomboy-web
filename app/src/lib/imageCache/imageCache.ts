/**
 * Public API for the image cache.
 *
 * Wraps imageCacheStore (IDB CRUD + LRU) and objectUrlPool (ObjectURL
 * lifecycle) with quota enforcement, inflight deduplication, and
 * lastAccess debouncing.
 */
import {
	getImageRecord,
	putImageRecord,
	evictLRU,
	cursorSumSize,
	clearImageStore,
	countRecords,
	type ImageCacheRecord
} from './imageCacheStore.js';
import * as pool from './objectUrlPool.js';
import { findFetcher } from './fetchers/registry.js';
import {
	getImageCacheTotalBytes,
	setImageCacheTotalBytes,
	getImageCacheQuotaBytes,
	setImageCacheQuotaBytes
} from '../storage/appSettings.js';

export interface LookupResult {
	src: string;
	fromCache: boolean;
}

// ── Module-level state ─────────────────────────────────────────────────

/** Inflight dedup: concurrent calls to lookupOrFetch for the same URL
 * share a single Promise. */
const inflight = new Map<string, Promise<LookupResult>>();

/** Debounce lastAccess writes: at most one write per URL per 60 seconds. */
const lastAccessWriteAt = new Map<string, number>();
const LAST_ACCESS_DEBOUNCE_MS = 60_000;

/** In-memory hint for totalBytes; null means "not yet read from appSettings". */
let totalBytesCache: number | null = null;

/**
 * Monotonically increasing generation counter. `__resetForTest` bumps it so
 * any in-flight fire-and-forget async operations from previous tests that
 * capture an old generation will silently abort when they resume.
 */
let generation = 0;

// ── Internal helpers ───────────────────────────────────────────────────

async function readTotal(): Promise<number> {
	if (totalBytesCache !== null) return totalBytesCache;
	totalBytesCache = await getImageCacheTotalBytes();
	return totalBytesCache;
}

async function writeTotal(bytes: number): Promise<void> {
	const clamped = Math.max(0, bytes);
	totalBytesCache = clamped;
	await setImageCacheTotalBytes(clamped);
}

/**
 * Ensure there is room for `newSize` bytes within `quota`.
 * Evicts LRU records as needed and revokes their ObjectURLs.
 * Returns true if room was successfully made, false if even after
 * evicting everything the item still doesn't fit.
 */
async function makeRoom(newSize: number, quota: number): Promise<boolean> {
	let total = await readTotal();
	if (total + newSize <= quota) return true;

	const need = total + newSize - quota;
	const { evictedUrls, freedBytes } = await evictLRU(need);
	for (const u of evictedUrls) pool.revoke(u);
	total = Math.max(0, total - freedBytes);
	await writeTotal(total);

	return total + newSize <= quota;
}

/** Fire-and-forget lastAccess bump with 60s debounce per URL.
 *
 * Captures the current `generation` at call time so that if `__resetForTest`
 * bumps the generation before the async continuation runs (cross-test leakage),
 * the write is silently discarded.
 */
function bumpLastAccess(url: string): void {
	const now = Date.now();
	const last = lastAccessWriteAt.get(url) ?? 0;
	if (now - last < LAST_ACCESS_DEBOUNCE_MS) return;
	lastAccessWriteAt.set(url, now);

	const capturedGeneration = generation;

	// async fire-and-forget
	(async () => {
		const rec = await getImageRecord(url);
		if (!rec) return;
		// Abort if the module was reset (e.g. between tests)
		if (generation !== capturedGeneration) return;
		await putImageRecord({ ...rec, lastAccess: now });
	})().catch(() => {
		// debounce write failure is non-fatal
	});
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Store a blob in the cache, register it in the ObjectURL pool, and update
 * totalBytes. If the blob is larger than the current quota, the call is a
 * silent no-op (no throw). If adding the blob would exceed the quota,
 * LRU records are evicted first.
 *
 * If a record already exists for `url`, it is overwritten: the old size is
 * subtracted from totalBytes before the new size is added, and the old
 * ObjectURL is revoked.
 */
export async function prime(url: string, blob: Blob, contentType: string): Promise<void> {
	const size = blob.size;
	const quota = await getImageCacheQuotaBytes();

	// Single image exceeds quota → silent skip
	if (size > quota) return;

	const existing = await getImageRecord(url);
	if (existing) {
		// Subtract old size before inserting new record
		await writeTotal(Math.max(0, (await readTotal()) - existing.size));
		pool.revoke(url);
	}

	const ok = await makeRoom(size, quota);
	if (!ok) return; // still can't fit after evicting everything

	const now = Date.now();
	const rec: ImageCacheRecord = {
		url,
		blob,
		contentType,
		size,
		lastAccess: now,
		insertedAt: now
	};
	await putImageRecord(rec);
	await writeTotal((await readTotal()) + size);
	pool.getOrCreate(url, blob); // pre-register in ObjectURL pool
}

/**
 * Look up `url` in the cache. On a hit, returns an ObjectURL and bumps
 * lastAccess (debounced 60s). On a miss, fetches `url` from the network:
 * success → primes the cache and returns an ObjectURL with fromCache:false;
 * failure → returns the original URL as src with fromCache:false (no cache
 * entry is stored).
 *
 * Concurrent calls for the same URL share a single in-flight Promise.
 */
export async function lookupOrFetch(url: string): Promise<LookupResult> {
	const existing = inflight.get(url);
	if (existing) return existing;

	const promise = (async (): Promise<LookupResult> => {
		const rec = await getImageRecord(url);
		if (rec) {
			bumpLastAccess(url);
			return { src: pool.getOrCreate(url, rec.blob), fromCache: true };
		}

		// Cache miss — try a registered fetcher first (Dropbox SDK route etc.),
		// fall back to plain fetch for hosts that allow CORS.
		try {
			const fetcher = findFetcher(url);
			let blob: Blob;
			let contentType: string;
			if (fetcher) {
				blob = await fetcher.fetch(url);
				contentType = blob.type || 'application/octet-stream';
			} else {
				const res = await fetch(url);
				if (!res.ok) return { src: url, fromCache: false };
				blob = await res.blob();
				contentType =
					res.headers.get('content-type') ?? blob.type ?? 'application/octet-stream';
			}
			await prime(url, blob, contentType).catch(() => {});
			const objUrl = pool.peek(url);
			return { src: objUrl ?? pool.getOrCreate(url, blob), fromCache: false };
		} catch {
			return { src: url, fromCache: false };
		}
	})();

	inflight.set(url, promise);
	try {
		return await promise;
	} finally {
		inflight.delete(url);
	}
}

/**
 * Return the raw blob for `url` from the cache, or null on a miss.
 * Bumps lastAccess (debounced). Does not fetch from the network.
 */
export async function getBlob(url: string): Promise<Blob | null> {
	const rec = await getImageRecord(url);
	if (!rec) return null;
	bumpLastAccess(url);
	return rec.blob;
}

/**
 * Clear the entire cache: empties the IDB store, revokes all ObjectURLs,
 * and resets totalBytes to 0.
 */
export async function clearAll(): Promise<void> {
	await clearImageStore();
	pool.revokeAll();
	lastAccessWriteAt.clear();
	await writeTotal(0);
}

/**
 * Return current cache statistics. totalBytes is reconciled against a
 * full cursor scan on each call to catch any drift.
 */
export async function getStats(): Promise<{
	count: number;
	totalBytes: number;
	quotaBytes: number;
}> {
	const actual = await cursorSumSize();
	const cached = await readTotal();
	if (cached !== actual) await writeTotal(actual);

	const count = await countRecords();
	const quotaBytes = await getImageCacheQuotaBytes();
	return { count, totalBytes: actual, quotaBytes };
}

/**
 * Update the quota. If the new quota is smaller than current usage,
 * LRU records are immediately evicted to bring usage within the new limit.
 */
export async function setQuota(bytes: number): Promise<void> {
	const clamped = Math.max(0, Math.floor(bytes));
	await setImageCacheQuotaBytes(clamped);

	const total = await readTotal();
	if (total > clamped) {
		const need = total - clamped;
		const { evictedUrls, freedBytes } = await evictLRU(need);
		for (const u of evictedUrls) pool.revoke(u);
		await writeTotal(Math.max(0, total - freedBytes));
	}
}

/**
 * Reset all module-level state. For test isolation only — do not call in
 * production code.
 *
 * Bumps `generation` so any pending fire-and-forget bumpLastAccess async
 * continuations from the previous test silently abort when they resume.
 */
export function __resetForTest(): void {
	generation++;
	inflight.clear();
	lastAccessWriteAt.clear();
	totalBytesCache = null;
}
