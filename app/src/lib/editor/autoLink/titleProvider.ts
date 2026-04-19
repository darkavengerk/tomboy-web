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
	/** Release this handle's forward listener and its user listeners. Does NOT touch the shared module-level subscription. */
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
let sharedByTitle = new Map<string, string>(); // title → guid (case-sensitive, first-wins)
let sharedInFlight: Promise<void> | null = null;
const sharedListeners = new Set<() => void>();
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

		// Skip the fan-out to subscribers when the title set is identical to
		// what we had before. Many callers of invalidateCache() don't
		// actually change the title list (toggleFavorite, a body-only edit
		// that happens to race a refresh, etc.) and each broadcast triggers
		// a full-document auto-link rescan on EVERY open editor — so a
		// single unnecessary broadcast in a workspace with N editors costs
		// O(N * doc * titles) main-thread work with no observable effect.
		//
		// Equivalence is checked order-independently on (guid, title).
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
		if (match.title !== e.title) return false;
	}
	return true;
}

function ensureSubscribed(): void {
	if (invalidateOff) return;
	invalidateOff = onInvalidate(() => {
		void doSharedRefresh();
	});
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
			// listener, so any real staleness (a note created / renamed /
			// deleted anywhere in the app) will still refresh the cache via
			// that subscription.
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
