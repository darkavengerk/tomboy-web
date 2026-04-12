/**
 * Title list provider for the auto-link plugin.
 *
 * Wraps `listNotes()` + `noteListCache.onInvalidate` to expose a synchronous
 * `getTitles()` view that is kept up to date as notes are created, renamed
 * or deleted anywhere in the app.
 */

import { listNotes } from '$lib/core/noteManager.js';
import { onInvalidate } from '$lib/stores/noteListCache.js';
import type { TitleEntry } from './findTitleMatches.js';

export interface TitleProvider {
	/** Current snapshot of title entries. Excludes blank titles / the excluded guid. */
	getTitles(): TitleEntry[];
	/** Re-fetch from the note store. */
	refresh(): Promise<void>;
	/** Subscribe to refresh completions. Returns unsubscribe fn. */
	onChange(cb: () => void): () => void;
	/** Release the invalidation subscription. */
	dispose(): void;
}

export interface TitleProviderOptions {
	excludeGuid?: string | null;
}

export function createTitleProvider(opts: TitleProviderOptions = {}): TitleProvider {
	const excludeGuid = opts.excludeGuid ?? null;
	let entries: TitleEntry[] = [];
	const listeners = new Set<() => void>();
	let disposed = false;

	async function refresh(): Promise<void> {
		if (disposed) return;
		const notes = await listNotes();
		if (disposed) return;
		const next: TitleEntry[] = [];
		for (const n of notes) {
			if (!n || typeof n.title !== 'string') continue;
			if (excludeGuid !== null && n.guid === excludeGuid) continue;
			const trimmed = n.title.trim();
			if (!trimmed) continue;
			next.push({
				titleLower: trimmed.toLocaleLowerCase(),
				original: n.title,
				guid: n.guid
			});
		}
		entries = next;
		for (const l of listeners) l();
	}

	const off = onInvalidate(() => {
		// Fire-and-forget; internal listeners run after the refresh completes.
		void refresh();
	});

	return {
		getTitles() {
			return entries;
		},
		refresh,
		onChange(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			off();
			listeners.clear();
			entries = [];
		}
	};
}
