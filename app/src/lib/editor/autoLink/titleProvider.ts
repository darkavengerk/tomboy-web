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
import { markNoteOpenPerf } from '$lib/utils/noteOpenPerfLog.js';
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
	if (sharedInFlight) {
		markNoteOpenPerf('titleProvider.refresh:coalesced');
		return sharedInFlight;
	}
	markNoteOpenPerf('titleProvider.refresh:listNotes:before');
	sharedInFlight = (async () => {
		const notes = await listNotes();
		markNoteOpenPerf('titleProvider.refresh:listNotes:after', {
			count: notes.length
		});
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
		sharedEntries = next;
		markNoteOpenPerf('titleProvider.refresh:entriesBuilt', {
			entries: next.length,
			listeners: sharedListeners.size
		});
		markNoteOpenPerf('titleProvider.refresh:broadcast:before');
		for (const l of sharedListeners) l();
		markNoteOpenPerf('titleProvider.refresh:broadcast:after');
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
