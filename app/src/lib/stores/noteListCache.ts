import type { NoteData } from '$lib/core/note.js';

/** Why the listener fan-out fired:
 *  - `'invalidate'` — bulk/unknown mutation (sync pull, import, purge, …);
 *    the cache was dropped and ANYTHING may have changed, including data the
 *    cache doesn't carry (e.g. notebook template notes).
 *  - `'mutate'` — exactly one known note changed and the warm cache was
 *    patched in place; derived settings-caches maintained by the mutation
 *    paths themselves (notebooks) are already up to date. */
export type NoteListChangeKind = 'invalidate' | 'mutate';

let cached: NoteData[] | null = null;
let scrollTop = 0;
const listeners = new Set<(kind: NoteListChangeKind) => void>();

// Read-through coalescing state. `inFlight` lets concurrent cold-cache
// callers (e.g. the title-index refresh and the slip-note set refresh both
// firing on one invalidate) share ONE underlying fetch instead of issuing a
// full getAll each. `epoch` is bumped on every invalidate so a fetch that
// resolves AFTER an intervening invalidation is returned to its callers but
// NOT written into the cache (stale-after-invalidate guard).
let inFlight: Promise<NoteData[]> | null = null;
let epoch = 0;

// ── Cross-context invalidation bridge ───────────────────────────────────────
// The desktop workspace embeds /admin and /settings as IFRAMES (AdminWindow /
// SettingsWindow). Each browsing context loads its OWN instance of this
// module, so an invalidateCache() fired inside an iframe (sync pull, import,
// admin rollback) would never reach the parent workspace's warm cache on its
// own — and since single-note saves only PATCH the cache, nothing in the
// parent would ever heal it. Bridge HARD invalidations over a
// BroadcastChannel. Only 'invalidate' is bridged: 'mutate' patches can't ship
// their object across contexts, and a remote hard-invalidate per debounced
// save would resurrect the full-corpus refetch this cache exists to avoid
// (iframe contexts host no long-lived cache consumers anyway).
const bridge =
	typeof BroadcastChannel !== 'undefined'
		? new BroadcastChannel('tomboy-note-list-cache')
		: null;
if (bridge) {
	bridge.onmessage = () => {
		invalidateLocal();
	};
	// Node's BroadcastChannel (vitest) would otherwise hold the event loop open.
	(bridge as unknown as { unref?: () => void }).unref?.();
}

export function getCachedNotes(): NoteData[] | null {
	return cached;
}

/**
 * Replace the cached list with a freshly-fetched snapshot.
 *
 * `asOfEpoch` (capture `getEpoch()` BEFORE starting the fetch) guards against
 * overwriting newer state: if an invalidate or a `noteMutated` patch landed
 * while the snapshot was being fetched, the stale snapshot is dropped.
 * Omitting it keeps the old unconditional behaviour (callers that fetched
 * synchronously w.r.t. the cache, e.g. tests).
 */
export function setCachedNotes(n: NoteData[], asOfEpoch?: number): void {
	if (asOfEpoch !== undefined && asOfEpoch !== epoch) return;
	cached = n;
}

export function getEpoch(): number {
	return epoch;
}

function invalidateLocal(): void {
	cached = null;
	// Abandon any in-flight read-through: its result predates this
	// invalidation, so callers triggered by the listener fan-out below must
	// re-fetch rather than coalesce onto the stale fetch.
	inFlight = null;
	epoch++;
	for (const l of listeners) l('invalidate');
}

export function invalidateCache(): void {
	invalidateLocal();
	// Notify sibling browsing contexts (desktop iframes ↔ parent workspace).
	// postMessage never loops back to this context's own channel instance.
	bridge?.postMessage('invalidate');
}

/**
 * Single-note mutation notification — the cheap sibling of `invalidateCache`.
 *
 * Call AFTER the note's IDB write has committed. Instead of nulling the
 * cache (which forces the next reader into a full-corpus `getAll` that
 * deserializes every note's xmlContent), this PATCHES the warm cache in
 * place — remove-by-guid, re-insert if the note still qualifies, re-sort —
 * and then fires the same listener fan-out. Listeners that read through
 * `readThroughNotes` (title index, slip-note set, desktop side panel) see
 * current data with ZERO IDB reads; this is what keeps 새 노트 생성 +
 * 타이틀 타이핑 from paying a full-corpus read on every debounced save.
 *
 * The qualify filter (non-deleted, non-template) MUST stay in lock-step
 * with `noteStore.getAllNotes` — the cache stores exactly that shape.
 *
 * Cached entries are NON-AUTHORITATIVE for sync bookkeeping fields
 * (`localDirty`, `syncedXmlContent`): `putNote` injects those at write time
 * while the patch stores the caller's object. Cache consumers (title index,
 * slip-note set, list UIs) must not read sync bookkeeping off this cache —
 * sync code reads IDB directly (`getDirtyNotes`).
 *
 * Use `invalidateCache()` instead for bulk or unknown mutations (sync pull,
 * import, purge, admin rollback): patching is only sound when the caller
 * knows the one note that changed.
 */
export function noteMutated(note: NoteData): void {
	if (inFlight) {
		// A read-through fetch raced this mutation; its snapshot may or may
		// not contain the write. Degrade to a hard invalidate so post-mutation
		// readers re-fetch committed state instead of inheriting the race.
		cached = null;
		inFlight = null;
		epoch++;
	} else if (cached) {
		// Copy-on-write so consumers holding the previous array reference
		// never observe a mid-patch mutation.
		const next = cached.filter((n) => n.guid !== note.guid);
		if (!note.deleted && !note.tags.includes('system:template')) {
			next.push(note);
			// Same comparator as noteStore.getAllNotes (changeDate DESC).
			next.sort((a, b) => (b.changeDate > a.changeDate ? 1 : -1));
		}
		cached = next;
		// The patch advances cache state: bump the epoch so a direct-read
		// snapshot fetched BEFORE this patch (e.g. the /notes page's
		// listNotes() + setCachedNotes flow) can't overwrite it.
		epoch++;
	}
	// Cold cache: nothing to patch — the listener fan-out's read-through
	// fetches fresh committed state anyway.
	for (const l of listeners) l('mutate');
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
 * The cache stores the FULL note list (the `getAllNotes` shape). Editor-path
 * single-note writes keep it current via the `noteMutated` in-place patch;
 * bulk/unknown mutations (sync pull, import, purge, admin rollback) drop it
 * via `invalidateCache()`. Callers that must reflect even bypassing writes
 * the instant they land (the 전체 list, home "latest" redirect) use
 * `listNotes()` directly instead of this path.
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

export function onInvalidate(cb: (kind: NoteListChangeKind) => void): () => void {
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
