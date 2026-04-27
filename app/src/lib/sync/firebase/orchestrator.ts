/**
 * Module-level orchestrator wiring the editor save path to Firestore note sync.
 *
 * The hook `notifyNoteSaved(guid)` is called from `noteManager.updateNoteFromEditor`
 * (and the backlink-rewrite cascade) on every IDB write. It is a no-op until
 * the user explicitly enables Firebase note sync from settings — the gate is
 * `setNoteSyncEnabled(true)`. When enabled, calls coalesce through a per-guid
 * debounce queue and land in Firestore via the configured push function.
 *
 * Configuration is split from the singleton state:
 *   - `configureNoteSync({ push, getNote, debounceMs })` — wires the actual
 *     Firestore write fn (typically `noteSyncClient.setNoteDoc`) and IDB read
 *     fn. Called once at app startup from a thin glue module that owns the
 *     real Firebase imports. Re-callable for tests / runtime reconfiguration.
 *   - `setNoteSyncEnabled(boolean)` — the runtime gate. Bound to the user's
 *     settings toggle.
 *
 * Tests use `_resetNoteSyncForTest()` to wipe state between cases.
 */
import { createPushQueue, type PushQueue } from './pushQueue.js';
import {
	createOpenNoteRegistry,
	type OpenNoteRegistry,
	type Unsubscribe
} from './openNoteRegistry.js';
import { resolveNoteConflict, type ConflictSide } from './conflictResolver.js';
import {
	mergeRemoteIntoLocal,
	type FirestoreNotePayload
} from './notePayload.js';
import {
	createIncrementalSync,
	type IncrementalSync,
	type IncrementalSyncDeps
} from './incrementalSync.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { emitNoteReload } from '$lib/core/noteReloadBus.js';
import { invalidateCache } from '$lib/stores/noteListCache.js';
import type { NoteData } from '$lib/core/note.js';

export type RemoteSubscribe = (
	uid: string,
	guid: string,
	onChange: (payload: FirestoreNotePayload | undefined) => void
) => Unsubscribe;

export interface NoteSyncConfig {
	push: (note: NoteData) => Promise<void>;
	getNote: (guid: string) => Promise<NoteData | undefined>;
	debounceMs?: number;
	/** Returns the current Firebase uid, or null when sign-in is impossible. */
	getUid?: () => Promise<string | null>;
	/** Subscribes to the remote doc; returns an unsubscribe handle. */
	subscribeRemote?: RemoteSubscribe;
	/**
	 * Begin a live `users/{uid}/notes` listener for `serverUpdatedAt > since`.
	 * Optional — when omitted, only per-note attach-side sync runs (legacy
	 * behavior). When provided, the orchestrator starts an incremental sync
	 * any time `setNoteSyncEnabled(true)` runs.
	 */
	subscribeNoteCollection?: IncrementalSyncDeps['subscribe'];
	getLastSyncMillis?: IncrementalSyncDeps['getLastSyncMillis'];
	setLastSyncMillis?: IncrementalSyncDeps['setLastSyncMillis'];
}

const DEFAULT_DEBOUNCE_MS = 400;

let queue: PushQueue | null = null;
let registry: OpenNoteRegistry | null = null;
let pushFn: (note: NoteData) => Promise<void> = async () => undefined;
let getNoteFn: (g: string) => Promise<NoteData | undefined> = async () =>
	undefined;
let getUidFn: () => Promise<string | null> = async () => null;
let subscribeRemoteFn: RemoteSubscribe | null = null;
let subscribeNoteCollectionFn: IncrementalSyncDeps['subscribe'] | null = null;
let getLastSyncMillisFn: IncrementalSyncDeps['getLastSyncMillis'] | null = null;
let setLastSyncMillisFn: IncrementalSyncDeps['setLastSyncMillis'] | null = null;
let incrementalSync: IncrementalSync | null = null;
let debounceMs = DEFAULT_DEBOUNCE_MS;
let enabled = false;

function ensureQueue(): PushQueue {
	if (!queue) {
		queue = createPushQueue({
			debounceMs,
			push: (n) => pushFn(n),
			getNote: (g) => getNoteFn(g),
			onError: (g, err) =>
				console.warn(`[noteSync] push failed for ${g}`, err)
		});
	}
	return queue;
}

export function configureNoteSync(cfg: NoteSyncConfig): void {
	pushFn = cfg.push;
	getNoteFn = cfg.getNote;
	if (cfg.debounceMs !== undefined) debounceMs = cfg.debounceMs;
	if (cfg.getUid) getUidFn = cfg.getUid;
	if (cfg.subscribeRemote) subscribeRemoteFn = cfg.subscribeRemote;
	if (cfg.subscribeNoteCollection) subscribeNoteCollectionFn = cfg.subscribeNoteCollection;
	if (cfg.getLastSyncMillis) getLastSyncMillisFn = cfg.getLastSyncMillis;
	if (cfg.setLastSyncMillis) setLastSyncMillisFn = cfg.setLastSyncMillis;
	queue = null; // rebuild with the new debounce/push
	// Drop any prior incremental instance — its captured deps may be stale.
	if (incrementalSync) {
		incrementalSync.stop();
		incrementalSync = null;
	}
}

export function setNoteSyncEnabled(v: boolean): void {
	enabled = v;
	if (v) {
		void startIncrementalIfPossible();
	} else if (incrementalSync) {
		incrementalSync.stop();
	}
}

function ensureIncrementalSync(): IncrementalSync | null {
	if (
		!subscribeNoteCollectionFn ||
		!getLastSyncMillisFn ||
		!setLastSyncMillisFn
	) {
		return null;
	}
	if (!incrementalSync) {
		incrementalSync = createIncrementalSync({
			subscribe: subscribeNoteCollectionFn,
			applyRemote: (payload) => reconcileWithRemote(payload.guid, payload),
			getLastSyncMillis: getLastSyncMillisFn,
			setLastSyncMillis: setLastSyncMillisFn
		});
	}
	return incrementalSync;
}

async function startIncrementalIfPossible(): Promise<void> {
	const inst = ensureIncrementalSync();
	if (!inst) return;
	const uid = await getUidFn().catch(() => null);
	if (!uid) return;
	if (!enabled) return; // race: disabled while we awaited uid
	await inst.start(uid);
}

export function isNoteSyncEnabled(): boolean {
	return enabled;
}

/**
 * Called from the editor save path. Cheap when disabled, debounced when enabled.
 * Always synchronous so the caller's hot path isn't slowed down.
 */
export function notifyNoteSaved(guid: string): void {
	if (!enabled) return;
	ensureQueue().enqueue(guid);
}

/** Drain every pending debounced push (e.g. before navigating away). */
export async function flushAllNoteSync(): Promise<void> {
	if (!queue) return;
	await queue.flushAll();
}

/**
 * Begin realtime sync for an open note. No-op when sync is disabled or no
 * `subscribeRemote` has been configured. The first onSnapshot emission will
 * drive the initial reconcile (push or pull) so we don't need a separate
 * fetch round-trip.
 *
 * Idempotent: refcounted by guid, so multiple windows holding the same note
 * share one subscription.
 */
export function attachOpenNote(guid: string): void {
	if (!enabled) return;
	if (!subscribeRemoteFn) return;
	ensureRegistry().attach(guid);
}

/**
 * Detach a previously-attached open note. Safe to call without a prior
 * attach (no-op).
 */
export function detachOpenNote(guid: string): void {
	if (!registry) return;
	registry.detach(guid);
}

export function _resetNoteSyncForTest(): void {
	if (registry) {
		try {
			registry.detachAll();
		} catch {
			/* swallow — test reset must not throw */
		}
	}
	if (incrementalSync) {
		try {
			incrementalSync.stop();
		} catch {
			/* swallow */
		}
	}
	registry = null;
	queue = null;
	incrementalSync = null;
	pushFn = async () => undefined;
	getNoteFn = async () => undefined;
	getUidFn = async () => null;
	subscribeRemoteFn = null;
	subscribeNoteCollectionFn = null;
	getLastSyncMillisFn = null;
	setLastSyncMillisFn = null;
	debounceMs = DEFAULT_DEBOUNCE_MS;
	enabled = false;
}

function ensureRegistry(): OpenNoteRegistry {
	if (!registry) {
		registry = createOpenNoteRegistry({
			start: (guid) => startSubscription(guid)
		});
	}
	return registry;
}

function startSubscription(guid: string): Unsubscribe {
	let innerUnsub: Unsubscribe = () => undefined;
	let cancelled = false;

	void (async () => {
		const sub = subscribeRemoteFn;
		if (!sub) return;
		const uid = await getUidFn().catch(() => null);
		if (!uid || cancelled) return;
		innerUnsub = sub(uid, guid, (payload) => {
			void reconcileWithRemote(guid, payload);
		});
	})();

	return () => {
		cancelled = true;
		try {
			innerUnsub();
		} catch (err) {
			console.warn(`[noteSync] inner unsubscribe threw for ${guid}`, err);
		}
	};
}

async function reconcileWithRemote(
	guid: string,
	remote: FirestoreNotePayload | undefined
): Promise<void> {
	const local = await noteStore.getNote(guid);
	const localSide: ConflictSide | undefined = local
		? {
				xmlContent: local.xmlContent,
				changeDate: local.changeDate,
				metadataChangeDate: local.metadataChangeDate,
				tags: local.tags,
				deleted: local.deleted
			}
		: undefined;
	const decision = resolveNoteConflict(localSide, remote);
	if (decision.kind === 'push') {
		ensureQueue().enqueue(guid);
	} else if (decision.kind === 'pull' && remote) {
		const merged = mergeRemoteIntoLocal(local, remote);
		await noteStore.putNoteSynced(merged);
		// Fan out to noteListCache subscribers (SidePanel, the auto-link
		// title→guid index, the /notes list) so freshly-arrived remote
		// notes appear without a manual refresh. Only fired on pull —
		// noop / push paths leave IDB unchanged so there's nothing for
		// these subscribers to learn.
		invalidateCache();
		await emitNoteReload([guid]);
	}
}
