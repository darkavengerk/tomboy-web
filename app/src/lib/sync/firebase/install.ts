/**
 * App-startup wiring for Firestore-based note sync.
 *
 * Loads the user's saved enable/disable preference, configures the
 * orchestrator with real Firestore adapters, and applies the saved enable
 * state. Safe to call more than once (idempotent — subsequent calls just
 * re-apply).
 *
 * Guest mode: when `mode.value === 'guest'`, uses a separate IDB database
 * (`tomboy-web-guest`), signs in anonymously, discovers the host's publicConfig,
 * and configures the orchestrator to read public notes from Firestore while
 * writing back to the host's uid namespace. Sync is force-enabled.
 */
import { getSetting, setSetting } from '$lib/storage/appSettings.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { setDbMode } from '$lib/storage/db.js';
import { configureNoteSync, setNoteSyncEnabled } from './orchestrator.js';
import {
	getCurrentNoteSyncUid,
	getRealNoteSyncClient,
	subscribeAllPublicNotesAfter
} from './noteSyncClient.firestore.js';
import { ensureGuestSignedIn } from '$lib/firebase/app.js';
import {
	discoverPublicConfigForGuest,
	getCachedPublicConfig,
	readPublicConfigForHost
} from './publicConfig.js';
import { mode } from '$lib/stores/guestMode.svelte.js';

const ENABLED_SETTING_KEY = 'firebaseNotesEnabled';
const HOST_LAST_SYNC_KEY = 'firebaseNotesLastSyncAt';
const GUEST_LAST_SYNC_KEY = 'firebaseGuestLastSyncAt';

export async function isFirebaseNotesEnabledSetting(): Promise<boolean> {
	const v = await getSetting<boolean>(ENABLED_SETTING_KEY);
	return v === true;
}

export const FIREBASE_NOTES_ENABLED_KEY = ENABLED_SETTING_KEY;

let installed = false;
let hostPublicConfigPrimed = false;

/**
 * Wire the orchestrator with real Firestore adapters and apply the persisted
 * enable flag. Call once from the root layout. The actual Firebase SDK
 * imports are deferred to the noteSyncClient.firestore module so a disabled
 * setting keeps the SDK out of the hot path.
 */
export async function installRealNoteSync(): Promise<void> {
	if (installed) {
		if (mode.value !== 'guest') {
			setNoteSyncEnabled(await isFirebaseNotesEnabledSetting());
		}
		return;
	}
	installed = true;

	const client = getRealNoteSyncClient();

	if (mode.value === 'guest') {
		setDbMode('guest');
		await ensureGuestSignedIn();
		const cfg = getCachedPublicConfig() ?? (await discoverPublicConfigForGuest());
		if (!cfg) {
			// No host has published a publicConfig — leave sync disabled, UI will show empty.
			return;
		}
		const hostUid = cfg.hostUid;
		configureNoteSync({
			push: async (note) => {
				await client.setNoteDoc(hostUid, note);
			},
			getNote: (g) => noteStore.getNote(g),
			getUid: async () => hostUid,
			subscribeRemote: (_uid, guid, cb) => client.subscribeNoteDoc(hostUid, guid, cb),
			subscribeNoteCollection: subscribeAllPublicNotesAfter,
			getLastSyncMillis: async () => {
				const v = await getSetting<number>(GUEST_LAST_SYNC_KEY);
				return typeof v === 'number' ? v : 0;
			},
			setLastSyncMillis: async (m) => {
				await setSetting(GUEST_LAST_SYNC_KEY, m);
			},
			debounceMs: 500
		});
		setNoteSyncEnabled(true); // force-enable for guests
		return;
	}

	// Host mode — existing behavior.
	configureNoteSync({
		push: async (note) => {
			const uid = await getCurrentNoteSyncUid();
			if (!uid) return;
			if (!hostPublicConfigPrimed) {
				// First push of this session — populate publicConfig cache so the
				// payload builder can compute the `public` flag correctly.
				try {
					await readPublicConfigForHost(uid);
				} catch (e) {
					console.warn('[install] readPublicConfigForHost failed; pushes will stamp public:false until next attempt', e);
				}
				hostPublicConfigPrimed = true;
			}
			await client.setNoteDoc(uid, note);
		},
		getNote: (g) => noteStore.getNote(g),
		getUid: getCurrentNoteSyncUid,
		subscribeRemote: (uid, guid, cb) => client.subscribeNoteDoc(uid, guid, cb),
		subscribeNoteCollection: (uid, sinceMillis, onChange, onError) =>
			client.subscribeNoteCollection(uid, sinceMillis, onChange, onError),
		getLastSyncMillis: async () => {
			const v = await getSetting<number>(HOST_LAST_SYNC_KEY);
			return typeof v === 'number' ? v : 0;
		},
		setLastSyncMillis: async (m) => {
			await setSetting(HOST_LAST_SYNC_KEY, m);
		},
		debounceMs: 500
	});

	setNoteSyncEnabled(await isFirebaseNotesEnabledSetting());
}
