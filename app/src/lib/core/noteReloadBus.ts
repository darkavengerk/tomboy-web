/**
 * Reload + flush bus for note editor windows. Independent of the desktop
 * `session.svelte.ts` `reloadHooks` / `flushHooks` channels (those are
 * dedicated to slip-note chain ops and window lifecycle). Lives at the core
 * layer so both the mobile `/note/[id]` page and the desktop `NoteWindow` can
 * subscribe without pulling in desktop session internals.
 *
 * Two channels, both keyed by guid:
 *
 * - **Reload** (`emitNoteReload`) — fired by `updateNoteFromEditor` on every
 *   successful write so other open editors of the SAME note converge (the
 *   saving editor excludes itself via `{ except: token }`), and additionally
 *   for each backlink-affected note after a rename-triggered rewrite so its
 *   open editor picks up the freshly-rewritten xml instead of clobbering it on
 *   the next debounced save with a stale pendingDoc.
 *
 * - **Flush** (`emitNoteFlush`) — fired by the rename sweep BEFORE it reads +
 *   rewrites a backlinked note, so any open editor's unsaved pending body
 *   edit lands in IDB first. Without it, a desktop window editing a
 *   backlinked note within the debounce window would have that edit read
 *   stale, overwritten by the link rewrite, then dropped by the subsequent
 *   reload — silent content loss. No-op on mobile (single-note-per-page →
 *   the backlinked targets are never open) and for any guid with no
 *   registered editor.
 */

type ReloadListener = () => void | Promise<void>;

/** A subscriber + the token identifying which editor instance owns it. */
interface ReloadEntry {
	fn: ReloadListener;
	token: unknown;
}

const listeners = new Map<string, Set<ReloadEntry>>();
const flushListeners = new Map<string, Set<ReloadListener>>();

/**
 * Register `fn` to be invoked when `emitNoteReload(guids)` contains `guid`.
 * `token` (optional) identifies the editor instance so a save by THAT instance
 * can exclude itself via `emitNoteReload(guids, { except: token })`. Returns an
 * unsubscribe function. Idempotent: calling it more than once is a no-op.
 */
export function subscribeNoteReload(
	guid: string,
	fn: ReloadListener,
	token?: unknown
): () => void {
	let set = listeners.get(guid);
	if (!set) {
		set = new Set();
		listeners.set(guid, set);
	}
	const entry: ReloadEntry = { fn, token };
	set.add(entry);
	return () => {
		const s = listeners.get(guid);
		if (!s) return;
		s.delete(entry);
		if (s.size === 0) listeners.delete(guid);
	};
}

export interface EmitReloadOptions {
	/** Skip the listener whose token === except. Undefined excludes nobody. */
	except?: unknown;
}

/**
 * Fire every listener registered for each guid in `guids`, except the one whose
 * token matches `opts.except` (the editor that just saved — so it isn't reloaded
 * out from under the user's cursor). Per-listener errors are swallowed so one
 * broken subscriber never stalls the batch. Resolves once every listener
 * (sync or async) has settled.
 */
export async function emitNoteReload(
	guids: Iterable<string>,
	opts?: EmitReloadOptions
): Promise<void> {
	const except = opts?.except;
	const tasks: Array<Promise<void>> = [];
	for (const guid of guids) {
		const set = listeners.get(guid);
		if (!set) continue;
		// Snapshot so a listener that unsubscribes during emit doesn't mutate
		// the set we're iterating.
		for (const entry of Array.from(set)) {
			if (except !== undefined && entry.token === except) continue;
			tasks.push(
				(async () => {
					await entry.fn();
				})().catch(() => {
					/* swallowed — one broken subscriber must not stall the batch */
				})
			);
		}
	}
	await Promise.all(tasks);
}

/**
 * Register `fn` to flush `guid`'s open editor (persist its pending edit to
 * IDB). Returns an unsubscribe function. Mirrors `subscribeNoteReload`.
 */
export function subscribeNoteFlush(guid: string, fn: ReloadListener): () => void {
	let set = flushListeners.get(guid);
	if (!set) {
		set = new Set();
		flushListeners.set(guid, set);
	}
	set.add(fn);
	return () => {
		const s = flushListeners.get(guid);
		if (!s) return;
		s.delete(fn);
		if (s.size === 0) flushListeners.delete(guid);
	};
}

/**
 * Flush every open editor registered for each guid in `guids`, awaiting all
 * of them. Per-listener errors are swallowed so one broken/destroyed editor
 * never stalls the caller (the rename sweep must proceed regardless). Resolves
 * once every flush (sync or async) has settled.
 */
export async function emitNoteFlush(guids: Iterable<string>): Promise<void> {
	const tasks: Array<Promise<void>> = [];
	for (const guid of guids) {
		const set = flushListeners.get(guid);
		if (!set) continue;
		for (const fn of Array.from(set)) {
			tasks.push(
				(async () => {
					await fn();
				})().catch(() => {
					/* swallowed — a broken flush must not stall the sweep */
				})
			);
		}
	}
	await Promise.all(tasks);
}

/** Clear the registry. Test-only. */
export function _resetForTest(): void {
	listeners.clear();
	flushListeners.clear();
}
