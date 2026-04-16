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
 * `onChange` listeners over the shared entries array. An internal refcount
 * keeps the `invalidateCache` subscription alive only while at least one
 * provider is undisposed.
 */

import { listNotes } from '$lib/core/noteManager.js';
import { onInvalidate } from '$lib/stores/noteListCache.js';
import type { TitleEntry } from './findTitleMatches.js';

export interface TitleProvider {
	/** Current snapshot of title entries. Excludes blank titles / the excluded guid. */
	getTitles(): TitleEntry[];
	/** Re-fetch from the note store. Coalesces concurrent callers. */
	refresh(): Promise<void>;
	/** Subscribe to refresh completions. Returns unsubscribe fn. */
	onChange(cb: () => void): () => void;
	/** Release the invalidation subscription for this handle. */
	dispose(): void;
}

export interface TitleProviderOptions {
	/** Static guid to filter out of `getTitles()` (the current note). */
	excludeGuid?: string | null;
	/**
	 * Dynamic variant of `excludeGuid` — consulted on every `getTitles()`
	 * call so the filter can follow a note-transition without requiring
	 * dispose + recreate of the provider. When provided, takes precedence
	 * over the static `excludeGuid`.
	 */
	getExcludeGuid?: () => string | null;
}

// --- Singleton state -----------------------------------------------------

let sharedEntries: TitleEntry[] = [];
let sharedInFlight: Promise<void> | null = null;
const sharedListeners = new Set<() => void>();
let providerCount = 0;
let invalidateOff: (() => void) | null = null;

async function doSharedRefresh(): Promise<void> {
	if (sharedInFlight) return sharedInFlight;
	sharedInFlight = (async () => {
		const notes = await listNotes();
		const next: TitleEntry[] = [];
		for (const n of notes) {
			if (!n || typeof n.title !== 'string') continue;
			const trimmed = n.title.trim();
			if (!trimmed) continue;
			next.push({
				titleLower: trimmed.toLocaleLowerCase(),
				original: n.title,
				guid: n.guid
			});
		}
		// Skip the fan-out to subscribers when the title set is identical to
		// what we had before. Many callers of invalidateCache() don't
		// actually change the title list (toggleFavorite, a body-only edit
		// that happens to race a refresh, etc.) and each broadcast triggers
		// a full-document auto-link rescan on EVERY open editor — so a
		// single unnecessary broadcast in a workspace with N editors costs
		// O(N * doc * titles) main-thread work with no observable effect.
		//
		// Equivalence is checked order-independently on (guid, titleLower,
		// original). The sort order from listNotes() is `changeDate` desc,
		// and most refreshes fire for reasons that don't alter changeDates,
		// but we shouldn't *require* stable ordering to skip the broadcast.
		const unchanged = entriesEquivalent(sharedEntries, next);
		sharedEntries = next;
		if (unchanged) return;
		for (const l of sharedListeners) l();
	})().finally(() => {
		sharedInFlight = null;
	});
	return sharedInFlight;
}

function entriesEquivalent(a: TitleEntry[], b: TitleEntry[]): boolean {
	if (a.length !== b.length) return false;
	if (a.length === 0) return true;
	const byGuid = new Map<string, TitleEntry>();
	for (const e of a) byGuid.set(e.guid, e);
	for (const e of b) {
		const match = byGuid.get(e.guid);
		if (!match) return false;
		if (match.titleLower !== e.titleLower) return false;
		if (match.original !== e.original) return false;
	}
	return true;
}

function ensureSubscribed(): void {
	if (invalidateOff) return;
	invalidateOff = onInvalidate(() => {
		void doSharedRefresh();
	});
}

function maybeUnsubscribe(): void {
	if (providerCount === 0 && invalidateOff) {
		invalidateOff();
		invalidateOff = null;
	}
}

// --- Public factory ------------------------------------------------------

export function createTitleProvider(opts: TitleProviderOptions = {}): TitleProvider {
	const staticExclude = opts.excludeGuid ?? null;
	const readExclude =
		opts.getExcludeGuid ?? (() => staticExclude);
	let disposed = false;
	const myListeners = new Set<() => void>();

	const forward = () => {
		if (disposed) return;
		for (const l of myListeners) l();
	};
	sharedListeners.add(forward);
	providerCount++;
	ensureSubscribed();

	return {
		getTitles() {
			if (disposed) return [];
			const excludeGuid = readExclude();
			if (excludeGuid === null) return sharedEntries;
			// Excluded case: build a filtered view. Callers may call this per
			// scan, so filtering eagerly here (instead of relying on
			// findTitleMatches' secondary filter) keeps the plugin's inner
			// loop working on a smaller array when the current note is in a
			// store with many other entries.
			return sharedEntries.filter((e) => e.guid !== excludeGuid);
		},
		refresh(): Promise<void> {
			if (disposed) return Promise.resolve();
			// Fast path: when the shared cache is already warm (another
			// editor already fetched), skip the listNotes() round-trip.
			// ensureSubscribed() has already registered the onInvalidate
			// listener for this provider, so any real staleness (a note
			// created / renamed / deleted anywhere in the app) will still
			// refresh the cache via that subscription.
			if (sharedEntries.length > 0 && !sharedInFlight) return Promise.resolve();
			return doSharedRefresh();
		},
		onChange(cb) {
			myListeners.add(cb);
			return () => myListeners.delete(cb);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			sharedListeners.delete(forward);
			myListeners.clear();
			providerCount--;
			maybeUnsubscribe();
		}
	};
}

// --- Test-only reset -----------------------------------------------------

export function _resetForTest(): void {
	sharedEntries = [];
	sharedInFlight = null;
	sharedListeners.clear();
	providerCount = 0;
	if (invalidateOff) {
		invalidateOff();
		invalidateOff = null;
	}
}
