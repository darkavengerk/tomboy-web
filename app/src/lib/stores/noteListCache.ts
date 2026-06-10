import type { NoteData } from '$lib/core/note.js';

let cached: NoteData[] | null = null;
let scrollTop = 0;
const listeners = new Set<() => void>();

// Read-through coalescing state. `inFlight` lets concurrent cold-cache
// callers (e.g. the title-index refresh and the slip-note set refresh both
// firing on one invalidate) share ONE underlying fetch instead of issuing a
// full getAll each. `epoch` is bumped on every invalidate so a fetch that
// resolves AFTER an intervening invalidation is returned to its callers but
// NOT written into the cache (stale-after-invalidate guard).
let inFlight: Promise<NoteData[]> | null = null;
let epoch = 0;

export function getCachedNotes(): NoteData[] | null {
	return cached;
}

export function setCachedNotes(n: NoteData[]): void {
	cached = n;
}

export function invalidateCache(): void {
	cached = null;
	// Abandon any in-flight read-through: its result predates this
	// invalidation, so callers triggered by the listener fan-out below must
	// re-fetch rather than coalesce onto the stale fetch.
	inFlight = null;
	epoch++;
	for (const l of listeners) l();
}

/**
 * Coalesced, invalidation-safe read-through over the shared note list.
 *
 * - Warm cache → resolves immediately with the cached array.
 * - Cold cache, no fetch in flight → runs `fetch()`, populates the cache,
 *   and resolves.
 * - Cold cache, a fetch already in flight → awaits that same fetch (one
 *   getAll shared across all concurrent callers).
 *
 * If `invalidateCache()` runs while a fetch is in flight, that fetch's result
 * is still returned to its own callers but is NOT written to the cache, so
 * the post-invalidate readers (driven by the listener fan-out) re-fetch fresh
 * IDB state instead of seeing pre-invalidate data.
 *
 * The cache stores the FULL note list (the `getAllNotes` shape). It is only
 * invalidated on note-list-shaping mutations (create / rename / delete /
 * notebook), NOT on body-only edits — which is why callers that need
 * changeDate freshness on every read (the 전체 list, home "latest" redirect)
 * use `listNotes()` directly instead of this path.
 */
export function readThroughNotes(fetch: () => Promise<NoteData[]>): Promise<NoteData[]> {
	if (cached) return Promise.resolve(cached);
	if (inFlight) return inFlight;
	const myEpoch = epoch;
	const p = fetch()
		.then((fresh) => {
			if (epoch === myEpoch) {
				cached = fresh;
				if (inFlight === p) inFlight = null;
			}
			return fresh;
		})
		.catch((err) => {
			if (epoch === myEpoch && inFlight === p) inFlight = null;
			throw err;
		});
	inFlight = p;
	return p;
}

export function getCachedScrollTop(): number {
	return scrollTop;
}

export function setCachedScrollTop(n: number): void {
	scrollTop = n;
}

export function onInvalidate(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

export function _resetForTest(): void {
	cached = null;
	scrollTop = 0;
	inFlight = null;
	epoch = 0;
	listeners.clear();
}
