/**
 * Reload bus for note editor windows. Independent of the desktop
 * `session.svelte.ts` `reloadHooks` channel (which is dedicated to slip-note
 * chain ops). Lives at the core layer so both the mobile `/note/[id]` page
 * and the desktop `NoteWindow` can subscribe without pulling in desktop
 * session internals.
 *
 * Fired by `updateNoteFromEditor` after a rename-triggered backlink rewrite
 * so the open editor for each affected note picks up the freshly-rewritten
 * xml instead of clobbering it on the next debounced save with a stale
 * pendingDoc.
 */

type ReloadListener = () => void | Promise<void>;

const listeners = new Map<string, Set<ReloadListener>>();

/**
 * Register `fn` to be invoked when `emitNoteReload(guids)` contains `guid`.
 * Returns an unsubscribe function. Idempotent: calling the returned function
 * more than once is a no-op.
 */
export function subscribeNoteReload(guid: string, fn: ReloadListener): () => void {
	let set = listeners.get(guid);
	if (!set) {
		set = new Set();
		listeners.set(guid, set);
	}
	set.add(fn);
	return () => {
		const s = listeners.get(guid);
		if (!s) return;
		s.delete(fn);
		if (s.size === 0) listeners.delete(guid);
	};
}

/**
 * Fire every listener registered for each guid in `guids`. Per-listener
 * errors are caught and swallowed so one broken subscriber never stalls
 * the batch. Resolves once every listener (sync or async) has settled.
 */
export async function emitNoteReload(guids: Iterable<string>): Promise<void> {
	const tasks: Array<Promise<void>> = [];
	for (const guid of guids) {
		const set = listeners.get(guid);
		if (!set) continue;
		// Snapshot so a listener that unsubscribes during emit doesn't mutate
		// the set we're iterating.
		for (const fn of Array.from(set)) {
			tasks.push(
				(async () => {
					await fn();
				})().catch(() => {
					/* swallowed — one broken subscriber must not stall the batch */
				})
			);
		}
	}
	await Promise.all(tasks);
}

/** Clear the registry. Test-only. */
export function _resetForTest(): void {
	listeners.clear();
}
