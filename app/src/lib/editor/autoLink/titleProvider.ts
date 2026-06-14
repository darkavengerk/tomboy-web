/**
 * Title list provider for the auto-link plugin.
 *
 * Wraps `listNotes()` + `noteListCache.onInvalidate` to expose a synchronous
 * `getTitles()` view that is kept up to date as notes are created, renamed
 * or deleted anywhere in the app.
 *
 * Module-level singleton state: the expensive `listNotes()` full-DB read is
 * shared across every active provider instance, which matters a lot when
 * many editors mount at once (e.g. desktop workspace switching opens several
 * NoteWindow components in parallel). Each `createTitleProvider` call
 * returns a thin handle that layers its own `excludeGuid` filter and its own
 * `onChange` listeners over the shared entries array.
 *
 * The `onInvalidate` subscription is established on first use and lives for
 * the life of the process (no refcount). This keeps the title→guid index
 * fresh even when no editor is mounted, so code paths without an active
 * provider (rename rewrite, import dup-check, blur-time validation) can
 * rely on `lookupGuidByTitle` after awaiting `ensureTitleIndexReady`.
 */

import { listNotesShared } from '$lib/core/noteManager.js';
import { onInvalidate } from '$lib/stores/noteListCache.js';
import type { TitleEntry } from './findTitleMatches.js';
import type { TitleDelta } from './shouldRescanForDelta.js';

export interface TitleProvider {
	/** Current snapshot of title entries. Excludes blank titles. */
	getTitles(): TitleEntry[];
	/** Re-fetch from the note store. Coalesces concurrent callers. */
	refresh(): Promise<void>;
	/** Subscribe to refresh completions. Returns unsubscribe fn.
	 *  The callback receives a `TitleDelta` describing what changed.
	 *  Consumers that ignore the arg (0-arg callbacks) keep working unchanged. */
	onChange(cb: (delta?: TitleDelta) => void): () => void;
	/** Release this handle's forward listener and its user listeners. Does NOT touch the shared module-level subscription. */
	dispose(): void;
}

export type TitleProviderOptions = Record<string, never>;

// --- Singleton state -----------------------------------------------------

let sharedEntries: TitleEntry[] = [];
let sharedByTitle = new Map<string, string>(); // title → guid (case-sensitive, first-wins)
let sharedInFlight: Promise<void> | null = null;
const sharedListeners = new Set<(delta?: TitleDelta) => void>();
let invalidateOff: (() => void) | null = null;

async function doSharedRefresh(): Promise<void> {
	if (sharedInFlight) return sharedInFlight;
	sharedInFlight = (async () => {
		const notes = await listNotesShared();
		const next: TitleEntry[] = [];
		for (const n of notes) {
			if (!n || typeof n.title !== 'string') continue;
			const trimmed = n.title.trim();
			if (!trimmed) continue;
			next.push({
				title: trimmed,
				guid: n.guid
			});
		}
		// Build first-wins title→guid map. `listNotes()` returns notes
		// sorted by changeDate DESC, so iterating first-wins gives
		// "most-recently-changed wins" semantics on any stray duplicate
		// title (the uniqueness invariant is enforced elsewhere but this
		// keeps lookups deterministic when it is violated).
		const nextByTitle = new Map<string, string>();
		for (const e of next) {
			if (!nextByTitle.has(e.title)) nextByTitle.set(e.title, e.guid);
		}
		sharedByTitle = nextByTitle;

		// Compute a {added, removed} delta before reassigning sharedEntries.
		// "added" = entries in next whose guid is absent from old, or whose
		//   title changed for the same guid (rename: new title is "added").
		// "removed" = entries in old whose guid is absent from next, or whose
		//   title changed (rename: old title is "removed").
		// This replaces the former `entriesEquivalent` boolean early-out:
		// when both arrays are empty the set is unchanged and we skip broadcast,
		// exactly preserving the previous "no broadcast when nothing changed"
		// guarantee (O(N * doc * titles) saved for body-only edits, toggleFavorite, …).
		const oldByGuid = new Map<string, TitleEntry>(sharedEntries.map((e) => [e.guid, e]));
		const nextByGuid = new Map<string, TitleEntry>(next.map((e) => [e.guid, e]));
		const added = next.filter((e) => {
			const o = oldByGuid.get(e.guid);
			return !o || o.title !== e.title;
		});
		const removed = sharedEntries.filter((e) => {
			const n = nextByGuid.get(e.guid);
			return !n || n.title !== e.title;
		});
		sharedEntries = next;
		if (added.length === 0 && removed.length === 0) return;
		const delta: TitleDelta = { added, removed };
		for (const l of sharedListeners) l(delta);
	})().finally(() => {
		sharedInFlight = null;
	});
	return sharedInFlight;
}

function ensureSubscribed(): void {
	if (invalidateOff) return;
	invalidateOff = onInvalidate(() => {
		void doSharedRefresh();
	});
}

// --- Public factory ------------------------------------------------------

export function createTitleProvider(_opts: TitleProviderOptions = {}): TitleProvider {
	let disposed = false;
	const myListeners = new Set<(delta?: TitleDelta) => void>();

	const forward = (delta?: TitleDelta) => {
		if (disposed) return;
		for (const l of myListeners) l(delta);
	};
	sharedListeners.add(forward);
	ensureSubscribed();

	return {
		getTitles() {
			if (disposed) return [];
			// The current-note filter intentionally lives in findTitleMatches
			// (via its `excludeGuid` option) rather than here: the excluded
			// title must still be visible to the matcher so it can claim its
			// text region, preventing shorter overlapping titles from linking
			// inside the current note's own title. A second filter here would
			// hide it and reintroduce the inner-slice bug.
			return sharedEntries;
		},
		refresh(): Promise<void> {
			if (disposed) return Promise.resolve();
			// Fast path: when the shared cache is already warm (another
			// editor already fetched), skip the listNotes() round-trip.
			// ensureSubscribed() has already registered the onInvalidate
			// listener, so any real staleness (a note created / renamed /
			// deleted anywhere in the app) will still refresh the cache via
			// that subscription.
			if (sharedEntries.length > 0 && !sharedInFlight) return Promise.resolve();
			return doSharedRefresh();
		},
		onChange(cb: (delta?: TitleDelta) => void) {
			myListeners.add(cb);
			return () => myListeners.delete(cb);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			sharedListeners.delete(forward);
			myListeners.clear();
			// Intentionally does NOT unsubscribe the module-level
			// onInvalidate listener — the title→guid index must stay fresh
			// for non-editor callers (rename rewrite, import dup-check).
		}
	};
}

// --- Module-level title→guid lookup --------------------------------------

/**
 * Case-sensitive title→guid lookup against the shared in-memory index.
 *
 * The input title is trimmed. Returns `null` when no note has that exact
 * (trimmed, case-sensitive) title. Callers should `await ensureTitleIndexReady()`
 * beforehand if they cannot be sure a provider has already warmed the cache
 * — this function does NOT trigger a refresh on its own.
 */
export function lookupGuidByTitle(title: string): string | null {
	const trimmed = title.trim();
	if (!trimmed) return null;
	return sharedByTitle.get(trimmed) ?? null;
}

/**
 * Ensure the shared title→guid index is populated at least once.
 *
 * - Subscribes to `onInvalidate` if not already subscribed (so later edits
 *   stay reflected).
 * - Cold (no prior refresh, no in-flight fetch) → triggers a fresh
 *   `listNotes()` and awaits it.
 * - A refresh already in flight → awaits the existing fetch.
 * - Warm (entries already populated) → resolves immediately with no I/O.
 *
 * Designed for code paths that have no editor mounted but still need
 * `lookupGuidByTitle` (rename rewrite, blur-time dup-check, …).
 */
export async function ensureTitleIndexReady(): Promise<void> {
	ensureSubscribed();
	if (sharedInFlight) return sharedInFlight;
	if (sharedEntries.length === 0) return doSharedRefresh();
	return;
}

// --- Test-only reset -----------------------------------------------------

export function _resetForTest(): void {
	sharedEntries = [];
	sharedByTitle = new Map();
	sharedInFlight = null;
	sharedListeners.clear();
	if (invalidateOff) {
		invalidateOff();
		invalidateOff = null;
	}
}
