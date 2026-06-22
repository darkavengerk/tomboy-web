import { musicPlayer, type TransportKind } from './musicPlayer.svelte.js';
import {
	MUSIC_CONTROL_GUID,
	MUSIC_CONTROL_TITLE,
	type MusicControlRecord,
	type TransportState,
	upsertRecordInDoc
} from './musicControlNote.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { createEmptyNote, escapeXml, NOTE_CONTENT_VERSION } from '$lib/core/note.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { updateNoteFromEditor } from '$lib/core/noteManager.js';
import { notifyNoteSaved } from '$lib/sync/firebase/orchestrator.js';
import { noteMutated } from '$lib/stores/noteListCache.js';
import { emitNoteFlush } from '$lib/core/noteReloadBus.js';
import { getSetting, getDeviceName } from '$lib/storage/appSettings.js';
import { getOrCreateInstallId } from '$lib/schedule/installId.js';

const FIREBASE_NOTES_ENABLED_KEY = 'firebaseNotesEnabled';

let myDeviceId: string | null = null;

const STATE_BY_KIND: Record<TransportKind, TransportState> = {
	play: 'playing',
	pause: 'paused',
	stop: 'stopped'
};

async function isSharingEnabled(): Promise<boolean> {
	return (await getSetting<boolean>(FIREBASE_NOTES_ENABLED_KEY)) === true;
}

async function deviceIdentity(): Promise<{ id: string; name: string }> {
	if (!myDeviceId) myDeviceId = await getOrCreateInstallId();
	const stored = await getDeviceName();
	const name = stored || `기기-${myDeviceId.slice(0, 4)}`;
	return { id: myDeviceId, name };
}

async function ensureControlNote() {
	let note = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (!note) {
		note = createEmptyNote(MUSIC_CONTROL_GUID);
		note.title = MUSIC_CONTROL_TITLE;
		note.xmlContent = `<note-content version="${NOTE_CONTENT_VERSION}">${escapeXml(
			MUSIC_CONTROL_TITLE
		)}\n\n</note-content>`;
		await noteStore.putNote(note);
		notifyNoteSaved(MUSIC_CONTROL_GUID);
		noteMutated(note);
	}
	return note;
}

/** Record an explicit transport event for THIS device into the control note.
 *  Snapshot of player state captured SYNCHRONOUSLY at the top before any await —
 *  stop() clears musicPlayer immediately after emitting 'stop'. */
export async function recordTransport(kind: TransportKind): Promise<void> {
	// Capture synchronously before any await — stop() clears musicPlayer state
	const track = musicPlayer.currentTrack;
	const noteGuid = musicPlayer.activeNoteGuid;
	const noteTitle = musicPlayer.activeNoteName;
	const position = musicPlayer.currentTime;
	if (!track || !noteGuid) return;

	if (!(await isSharingEnabled())) return;
	const { id, name } = await deviceIdentity();
	const record: MusicControlRecord = {
		deviceId: id,
		deviceName: name,
		trackUrl: track.url,
		trackTitle: track.display,
		noteGuid,
		noteTitle,
		position: Math.max(0, position),
		state: STATE_BY_KIND[kind],
		updatedAt: new Date().toISOString()
	};

	await ensureControlNote();
	await emitNoteFlush([MUSIC_CONTROL_GUID]);
	const fresh = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (!fresh) return;
	const newDoc = upsertRecordInDoc(deserializeContent(fresh.xmlContent), record);
	await updateNoteFromEditor(MUSIC_CONTROL_GUID, newDoc);
}

/** Test-only reset. */
export function __resetMusicControlForTest(): void {
	myDeviceId = null;
}
