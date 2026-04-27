/**
 * App-startup wiring for Firestore-based note sync.
 *
 * Loads the user's saved enable/disable preference, configures the
 * orchestrator with real Firestore adapters, and applies the saved enable
 * state. Safe to call more than once (idempotent — subsequent calls just
 * re-apply).
 */
import { getSetting } from '$lib/storage/appSettings.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { configureNoteSync, setNoteSyncEnabled } from './orchestrator.js';
import {
	getCurrentNoteSyncUid,
	getRealNoteSyncClient
} from './noteSyncClient.firestore.js';

const ENABLED_SETTING_KEY = 'firebaseNotesEnabled';

export async function isFirebaseNotesEnabledSetting(): Promise<boolean> {
	const v = await getSetting<boolean>(ENABLED_SETTING_KEY);
	return v === true;
}

export const FIREBASE_NOTES_ENABLED_KEY = ENABLED_SETTING_KEY;

let installed = false;

/**
 * Wire the orchestrator with real Firestore adapters and apply the persisted
 * enable flag. Call once from the root layout. The actual Firebase SDK
 * imports are deferred to the noteSyncClient.firestore module so a disabled
 * setting keeps the SDK out of the hot path.
 */
export async function installRealNoteSync(): Promise<void> {
	if (installed) {
		setNoteSyncEnabled(await isFirebaseNotesEnabledSetting());
		return;
	}
	installed = true;

	const client = getRealNoteSyncClient();
	configureNoteSync({
		push: async (note) => {
			const uid = await getCurrentNoteSyncUid();
			if (!uid) return;
			await client.setNoteDoc(uid, note);
		},
		getNote: (g) => noteStore.getNote(g),
		getUid: getCurrentNoteSyncUid,
		subscribeRemote: (uid, guid, cb) => client.subscribeNoteDoc(uid, guid, cb),
		debounceMs: 500
	});

	setNoteSyncEnabled(await isFirebaseNotesEnabledSetting());
}
