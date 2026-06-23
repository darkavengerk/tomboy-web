import { musicPlayer, type TransportKind } from './musicPlayer.svelte.js';
import { flushPlaybackPosition } from './deviceStatePlayback.js';
import {
	MUSIC_CONTROL_GUID,
	MUSIC_CONTROL_TITLE,
	type MusicControlRecord,
	type TransportState,
	parseRecordsFromXml,
	upsertRecords,
	setMarkerRecordsInDoc,
	pickGlobalLatest
} from './musicControlNote.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { createEmptyNote, escapeXml, NOTE_CONTENT_VERSION } from '$lib/core/note.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { updateNoteFromEditor } from '$lib/core/noteManager.js';
import { emitNoteFlush, subscribeNoteReload } from '$lib/core/noteReloadBus.js';
import { getSetting, getDeviceName } from '$lib/storage/appSettings.js';
import { getOrCreateInstallId } from '$lib/schedule/installId.js';
import { saveProgress } from './musicProgress.js';
import type { MusicTrack } from './parseMusicNote.js';

const FIREBASE_NOTES_ENABLED_KEY = 'firebaseNotesEnabled';

let myDeviceId: string | null = null;

const STATE_BY_KIND: Record<TransportKind, TransportState> = {
	play: 'playing',
	pause: 'paused',
	stop: 'stopped',
	track: 'playing'
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
	if (!track || !noteGuid) return;

	if (!(await isSharingEnabled())) return;
	const { id, name } = await deviceIdentity();
	const record: MusicControlRecord = {
		deviceId: id,
		deviceName: name,
		noteGuid,
		trackUrl: track.url,
		trackTitle: track.display,
		noteTitle,
		state: STATE_BY_KIND[kind],
		updatedAt: new Date().toISOString()
	};

	await ensureControlNote();
	// No-op for the control note (no editor holds it open); kept for structural symmetry with the rename-sweep flush-before-read pattern.
	await emitNoteFlush([MUSIC_CONTROL_GUID]);
	const fresh = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (!fresh) return;
	// Read existing records LOSSLESSLY from raw xml — deserializeContent atomizes
	// inline-marker tokens and drops the glyphs, corrupting other devices' urls
	// on re-upsert. Upsert this device, then write a clean marker paragraph.
	const records = upsertRecords(parseRecordsFromXml(fresh.xmlContent), record);
	const newDoc = setMarkerRecordsInDoc(deserializeContent(fresh.xmlContent), records);
	await updateNoteFromEditor(MUSIC_CONTROL_GUID, newDoc);
}

let globalLatest = $state<MusicControlRecord | null>(null);
// Last record actually applied via restoreSession — dedupes the repeated
// deliveries of this hot-synced control note (see refreshFromNote).
let lastAppliedSig: string | null = null;

function syntheticTrack(r: MusicControlRecord): MusicTrack {
	return {
		url: r.trackUrl,
		title: r.trackTitle || null,
		display: r.trackTitle || r.trackUrl,
		liPos: -1
	};
}

/** Build the restore queue from a record: the full source queue when present
 *  (so ⏭/⏮ work + urls are the source's playable ones), else a v1 single-track. */
function tracksFromRecord(r: MusicControlRecord): MusicTrack[] {
	if (r.queue && r.queue.length) {
		return r.queue.map((t) => {
			const track: MusicTrack = {
				url: t.url,
				title: t.title ?? null,
				display: t.display || t.url,
				liPos: -1
			};
			if (t.playlistLabel) track.playlistLabel = t.playlistLabel;
			return track;
		});
	}
	return [syntheticTrack(r)];
}

/** Re-read the control note, recompute the global-latest pointer, and (when
 *  safe) restore it as a ready paused queue so the existing ▶ resumes it
 *  synchronously inside the user gesture. */
export async function refreshFromNote(): Promise<void> {
	const note = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (!note) {
		globalLatest = null;
		return;
	}
	// Lossless raw-xml read (deserializeContent would atomize+drop url chars).
	const latest = pickGlobalLatest(parseRecordsFromXml(note.xmlContent));
	globalLatest = latest;
	if (!latest) return;
	if (musicPlayer.isPlaying) return; // never yank an active playback
	// A 'stop' = user explicitly ended playback; don't resurrect it as resumable.
	if (latest.state === 'stopped') return;
	const { id } = await deviceIdentity();
	if (latest.deviceId === id) return; // own device → keep richer local session

	// re-check after the await — a play() may have started in the gap
	if (musicPlayer.isPlaying) return;
	// Dedupe: this control note is re-delivered on every Firestore pull; without
	// this each delivery re-runs restoreSession (zeroing duration/currentTime/
	// isPlaying) and yanks the user mid-handoff.
	const sig = `${latest.deviceId}|${latest.updatedAt}|${latest.trackUrl}`;
	if (sig === lastAppliedSig) return;
	lastAppliedSig = sig;

	const tracks = tracksFromRecord(latest);
	if (tracks.length === 0) return;
	const index = Math.min(Math.max(0, latest.index ?? 0), tracks.length - 1);
	// Seed musicProgress so restoreSession's loadProgress matches our restored
	// current track's url and promotes `position` into pendingRestore.
	saveProgress(latest.noteGuid, tracks[index].url, latest.position);
	musicPlayer.restoreSession({
		activeNoteGuid: latest.noteGuid,
		activeNoteName: latest.noteTitle,
		queue: tracks,
		currentIndex: index,
		originNoteGuid: latest.noteGuid
	});
}

export function getGlobalLatestForTest(): MusicControlRecord | null {
	return globalLatest;
}

/** Boot read + subscribe to control-note changes + listen for transport events.
 *  Install once from +layout. Returns uninstall. */
export function installMusicControl(): () => void {
	if (typeof window === 'undefined') return () => {};
	void refreshFromNote();
	const unsubReload = subscribeNoteReload(MUSIC_CONTROL_GUID, () => {
		void refreshFromNote();
	});
	const unsubTransport = musicPlayer.onTransport((kind) => {
		const t = musicPlayer.currentTrack;
		if (t) flushPlaybackPosition(musicPlayer.currentTime, t.url);
		void recordTransport(kind);
	});
	return () => {
		unsubReload();
		unsubTransport();
	};
}

/** Test-only reset. */
export function __resetMusicControlForTest(): void {
	myDeviceId = null;
	globalLatest = null;
	lastAppliedSig = null;
}
