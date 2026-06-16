import { SvelteMap } from 'svelte/reactivity';
import { loadNoteBg, loadNoteBgMode, type WallpaperMode } from './session.svelte.js';

/** A live per-note background: an ObjectURL pointing at the cached blob + its
 *  display mode. The url is owned by the pool and revoked on release/reload. */
export interface NoteBgEntry {
	url: string;
	mode: WallpaperMode;
}

/**
 * Keyed background loader for places that show MANY notes at once (the note
 * bundle stack embeds one editor per visible leaf). Each guid's background is
 * stored independently in appSettings (`note:bg:<guid>`), so a leaf only needs
 * its OWN guid — no parent/window state. The pool owns the ObjectURL lifecycle:
 *
 *  - `load(guid)`  read blob+mode, mint an ObjectURL, revoke the previous one.
 *                  Idempotent-ish: a second call reloads (used on bg change).
 *  - `release(guid)` revoke + drop a single entry (leaf torn down).
 *  - `releaseAll()`  revoke everything (component destroyed).
 *
 * `entries` is a SvelteMap so reads inside a component template/`$derived`
 * react to load/release. A per-guid token guards against a stale in-flight load
 * (fast guid churn / overlapping epoch reloads) applying after a newer one —
 * the stale call returns before minting a URL, so it can never leak.
 */
export function createNoteBgPool() {
	const entries = new SvelteMap<string, NoteBgEntry>();
	const tokens = new Map<string, number>();
	let seq = 0;

	async function load(guid: string): Promise<void> {
		const token = ++seq;
		tokens.set(guid, token);
		const [blob, mode] = await Promise.all([loadNoteBg(guid), loadNoteBgMode(guid)]);
		if (tokens.get(guid) !== token) return; // superseded by a newer load — drop
		const prev = entries.get(guid);
		if (blob) {
			entries.set(guid, { url: URL.createObjectURL(blob), mode });
		} else {
			entries.delete(guid);
		}
		if (prev) URL.revokeObjectURL(prev.url);
	}

	function get(guid: string): NoteBgEntry | undefined {
		return entries.get(guid);
	}

	function release(guid: string): void {
		const e = entries.get(guid);
		if (e) {
			URL.revokeObjectURL(e.url);
			entries.delete(guid);
		}
		tokens.delete(guid);
	}

	function releaseAll(): void {
		for (const e of entries.values()) URL.revokeObjectURL(e.url);
		entries.clear();
		tokens.clear();
	}

	return { entries, load, get, release, releaseAll };
}

export type NoteBgPool = ReturnType<typeof createNoteBgPool>;
