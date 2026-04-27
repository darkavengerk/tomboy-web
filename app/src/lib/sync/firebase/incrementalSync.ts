/**
 * Collection-level incremental sync for Firestore note documents.
 *
 * Listens to `users/{uid}/notes` filtered by `serverUpdatedAt > lastSeen`,
 * so a single live cursor delivers both the catch-up of changes that
 * accumulated while the device was offline AND realtime updates that
 * arrive while the listener is alive.
 *
 * The watermark is a millisecond timestamp persisted in `appSettings`. It's
 * advanced after each batch to the maximum `serverUpdatedAt` we've seen, so
 * the next session resumes exactly where the previous one ended. We never
 * regress the watermark — older batches (which shouldn't happen given the
 * server-side `>` filter, but be safe) are accepted but don't move the
 * cursor backwards.
 *
 * Per-doc reconcile is delegated to {@link IncrementalSyncDeps.applyRemote},
 * which is wired by the orchestrator to the same `reconcileWithRemote`
 * routine used by the per-note attach listener. That gives us echo
 * suppression for free: our own pushes come back through the collection
 * listener, hit the conflict resolver's equivalence check, and short-circuit
 * to `noop`.
 *
 * `start(uid)` is idempotent — calling it twice while running is a no-op.
 * `stop()` tears down the subscription synchronously; if `stop()` is called
 * while a pending start is still resolving its initial getLastSyncMillis,
 * the eventual subscription is cancelled.
 */
import type { FirestoreNotePayload } from './notePayload.js';
import type { Unsubscribe } from './openNoteRegistry.js';

export interface IncrementalSyncChange {
	payload: FirestoreNotePayload;
	/** Server-clock milliseconds; used to advance the persisted watermark. */
	serverUpdatedAtMillis: number;
}

export interface IncrementalSyncDeps {
	/**
	 * Begin a live collection listener for `users/{uid}/notes` where
	 * `serverUpdatedAt > sinceMillis`. The first emission delivers the
	 * catch-up batch; subsequent emissions deliver realtime changes.
	 */
	subscribe: (
		uid: string,
		sinceMillis: number,
		onChange: (changes: IncrementalSyncChange[]) => void,
		onError: (err: Error) => void
	) => Unsubscribe;

	/** Apply a remote payload to local IDB (delegates to the conflict resolver). */
	applyRemote: (payload: FirestoreNotePayload) => Promise<void>;

	/** Returns the persisted lower-bound watermark in milliseconds (0 if never synced). */
	getLastSyncMillis: () => Promise<number>;

	/** Persist the new lower-bound watermark in milliseconds. */
	setLastSyncMillis: (millis: number) => Promise<void>;
}

export interface IncrementalSync {
	start(uid: string): Promise<void>;
	stop(): void;
	isRunning(): boolean;
}

export function createIncrementalSync(deps: IncrementalSyncDeps): IncrementalSync {
	let unsub: Unsubscribe | null = null;
	let starting = false;
	let stopRequested = false;
	let watermark = 0;

	async function start(uid: string): Promise<void> {
		if (unsub || starting) return;
		starting = true;
		stopRequested = false;
		try {
			watermark = await deps.getLastSyncMillis();
			if (stopRequested) {
				// stop() ran while we awaited; bail without subscribing.
				return;
			}
			const innerUnsub = deps.subscribe(
				uid,
				watermark,
				(changes) => void handleBatch(changes),
				(err) => {
					console.warn('[noteSync] incremental subscription error', err);
				}
			);
			if (stopRequested) {
				try {
					innerUnsub();
				} catch (err) {
					console.warn('[noteSync] inner unsubscribe threw during late stop', err);
				}
				return;
			}
			unsub = innerUnsub;
		} finally {
			starting = false;
		}
	}

	function stop(): void {
		stopRequested = true;
		if (!unsub) return;
		try {
			unsub();
		} catch (err) {
			console.warn('[noteSync] incremental unsubscribe threw', err);
		}
		unsub = null;
	}

	function isRunning(): boolean {
		return unsub !== null;
	}

	async function handleBatch(changes: IncrementalSyncChange[]): Promise<void> {
		if (changes.length === 0) return;
		let batchMax = 0;
		for (const ch of changes) {
			try {
				await deps.applyRemote(ch.payload);
			} catch (err) {
				console.warn(
					`[noteSync] incremental applyRemote failed for ${ch.payload.guid}`,
					err
				);
			}
			if (ch.serverUpdatedAtMillis > batchMax) {
				batchMax = ch.serverUpdatedAtMillis;
			}
		}
		if (batchMax > watermark) {
			watermark = batchMax;
			try {
				await deps.setLastSyncMillis(batchMax);
			} catch (err) {
				console.warn('[noteSync] persist incremental watermark failed', err);
			}
		}
	}

	return { start, stop, isRunning };
}
