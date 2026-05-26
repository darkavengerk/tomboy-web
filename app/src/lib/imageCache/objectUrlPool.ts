/**
 * Module-level ObjectURL pool.
 *
 * Guarantees that the same source URL is backed by exactly one ObjectURL:
 * `getOrCreate` calls `URL.createObjectURL` only on the first request for
 * a given key; subsequent calls return the cached ObjectURL unchanged.
 *
 * Callers are responsible for invoking `revoke`/`revokeAll` when the
 * ObjectURLs are no longer needed (e.g. on LRU eviction or cache clear).
 */
const pool = new Map<string, string>();

/** Synchronous lookup — returns the ObjectURL or null if not in the pool. */
export function peek(url: string): string | null {
	return pool.get(url) ?? null;
}

/**
 * Returns the existing ObjectURL for `url` if one is registered, otherwise
 * calls `URL.createObjectURL(blob)`, stores the result, and returns it.
 */
export function getOrCreate(url: string, blob: Blob): string {
	const existing = pool.get(url);
	if (existing !== undefined) return existing;
	const objectUrl = URL.createObjectURL(blob);
	pool.set(url, objectUrl);
	return objectUrl;
}

/**
 * Removes `url` from the pool and calls `URL.revokeObjectURL` on its
 * ObjectURL. No-op if `url` is not in the pool.
 */
export function revoke(url: string): void {
	const objectUrl = pool.get(url);
	if (objectUrl === undefined) return;
	URL.revokeObjectURL(objectUrl);
	pool.delete(url);
}

/** Revokes every ObjectURL in the pool and clears it. */
export function revokeAll(): void {
	for (const objectUrl of pool.values()) {
		URL.revokeObjectURL(objectUrl);
	}
	pool.clear();
}

/**
 * Clears the pool without calling `URL.revokeObjectURL`.
 * For test isolation only — do not call in production code.
 */
export function __resetForTest(): void {
	pool.clear();
}
