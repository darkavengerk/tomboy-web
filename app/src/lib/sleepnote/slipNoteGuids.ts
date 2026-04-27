/**
 * Shared snapshot of guids whose notebook is the Slip-Box.
 *
 * Used to segregate slip notes from date notes when computing date-arrow
 * adjacency: a slip note whose title happens to parse as a date must not
 * appear as the prev/next of a date note (and vice versa). The set is
 * refreshed whenever the global note list cache is invalidated, so it
 * stays in lock-step with renames / notebook reassignments / deletions.
 *
 * Pattern mirrors `editor/autoLink/titleProvider.ts`: module-level state
 * + manual onChange broadcasting; the listener registers an
 * `onInvalidate` subscription on first use and never tears it down (the
 * set must stay fresh for any caller of `get()` even when no UI is
 * subscribed).
 */

import { listNotes } from '$lib/core/noteManager.js';
import { onInvalidate } from '$lib/stores/noteListCache.js';
import { getNotebook } from '$lib/core/notebooks.js';
import { SLIPBOX_NOTEBOOK } from './validator.js';

let sharedSet: Set<string> = new Set();
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
let invalidateOff: (() => void) | null = null;

async function doRefresh(): Promise<void> {
	if (inFlight) return inFlight;
	inFlight = (async () => {
		const notes = await listNotes();
		const next = new Set<string>();
		for (const n of notes) {
			if (n.deleted) continue;
			if (getNotebook(n) === SLIPBOX_NOTEBOOK) next.add(n.guid);
		}
		if (sameSet(sharedSet, next)) return;
		sharedSet = next;
		for (const l of listeners) l();
	})().finally(() => {
		inFlight = null;
	});
	return inFlight;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const v of a) if (!b.has(v)) return false;
	return true;
}

function ensureSubscribed(): void {
	if (invalidateOff) return;
	invalidateOff = onInvalidate(() => {
		void doRefresh();
	});
}

export const slipNoteGuids = {
	/** Current snapshot. Empty until `refresh()` resolves at least once. */
	get(): Set<string> {
		return sharedSet;
	},
	/**
	 * Populate / repopulate the set. Coalesces concurrent callers via
	 * `inFlight`. Subscribes to noteListCache invalidations on first call.
	 */
	async refresh(): Promise<void> {
		ensureSubscribed();
		return doRefresh();
	},
	/** Subscribe to set changes. Returns unsubscribe fn. */
	onChange(cb: () => void): () => void {
		ensureSubscribed();
		listeners.add(cb);
		return () => listeners.delete(cb);
	}
};

export function _resetForTest(): void {
	sharedSet = new Set();
	inFlight = null;
	listeners.clear();
	if (invalidateOff) {
		invalidateOff();
		invalidateOff = null;
	}
}
