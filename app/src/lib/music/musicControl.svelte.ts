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
import { buildQueueFromXml } from './headlessMusicParse.js';
import { deviceStateSync } from './deviceStateSync.firestore.js';

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
	lastOwnActionAt = record.updatedAt;

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
// THIS device's own record in the control note (or null). Exposed so the
// continuity picker can compare our last-action time against the remote when
// both sides share a source note (same-playlist → newest side auto-wins).
let localLatest = $state<MusicControlRecord | null>(null);
// ISO timestamp of the last transport event recorded by THIS device.
// Used to guard against auto-pausing ourselves when our own record echoes back
// slightly after a competing remote record (race window).
let lastOwnActionAt: string | null = null;
// Set true around the REACTIVE auto-pause in refreshFromNote so its
// musicPlayer.pause() does NOT emit a recorded transport event. Recording it
// would write a paused-own record with a now-timestamp that hijacks the
// global-latest leader (and the picker's "remote") onto this device's OWN
// track — the exact bug that broke cross-device handoff + the picker. An
// auto-pause is a reaction to another device, not a user action; stays silent.
let suppressTransportRecord = false;

function syntheticTrack(r: MusicControlRecord): MusicTrack {
	return {
		url: r.trackUrl,
		title: r.trackTitle || null,
		display: r.trackTitle || r.trackUrl,
		liPos: -1
	};
}

/** Build the restore queue from a record: re-parse the source music note via
 *  buildQueueFromXml (so ⏭/⏮ work + urls are the source's playable ones),
 *  else fall back to a v1 single synthetic track when the note is absent locally
 *  or yields no parseable queue. */
async function tracksFromRecord(r: MusicControlRecord): Promise<MusicTrack[]> {
	const note = await noteStore.getNote(r.noteGuid);
	if (note) {
		const q = buildQueueFromXml(note.xmlContent);
		if (q.length) return q;
	}
	return [syntheticTrack(r)];
}

/** Re-read the control note and recompute the cross-device pointers:
 *  - `globalLatest` = most-recent OTHER-device, non-stopped record. This is the
 *    picker's "remote" + the FAB/rail remote pointer (spec #3). NEVER this
 *    device (own session is the picker's "local"), NEVER a 'stopped' record
 *    (the other device explicitly ended — nothing to resume).
 *  - #1 single-playback: if another device holds a `playing` record newer than
 *    our last own action AND we're playing, silently pause (queue preserved).
 *
 *  Deliberately does NOT stage the remote queue here. Passive staging would
 *  overwrite musicPlayer's queue with the remote song, erasing the LOCAL
 *  session so the continuity picker would have nothing to choose against (and
 *  would silently play the remote). The actual remote queue restore happens at
 *  press time in resumeGlobalLatest, only when the user picks 'remote'. */
export async function refreshFromNote(): Promise<void> {
	const note = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (!note) {
		globalLatest = null;
		localLatest = null;
		return;
	}
	// Lossless raw-xml read (deserializeContent would atomize+drop url chars).
	const records = parseRecordsFromXml(note.xmlContent);
	const { id } = await deviceIdentity();
	localLatest = records.find((r) => r.deviceId === id) ?? null;
	const latestOther = pickGlobalLatest(records.filter((r) => r.deviceId !== id));
	// Remote pointer: only a resumable (non-stopped) other-device session.
	globalLatest = latestOther && latestOther.state !== 'stopped' ? latestOther : null;
	if (!latestOther) return;

	// #1 single-playback: another device started playing more recently than our
	// last own action → pause our audio (queue preserved so the user can still
	// pick it as 'local' in the picker). SILENT — see suppressTransportRecord.
	if (
		latestOther.state === 'playing' &&
		musicPlayer.isPlaying &&
		(!lastOwnActionAt || latestOther.updatedAt > lastOwnActionAt)
	) {
		suppressTransportRecord = true;
		try {
			musicPlayer.pause();
		} finally {
			suppressTransportRecord = false;
		}
	}
}

export function getGlobalLatest(): MusicControlRecord | null {
	return globalLatest;
}

/** THIS device's own record in the control note (or null) as of the last
 *  refreshFromNote. Used by the continuity picker to compare last-action times
 *  with the remote when both share a source note. */
export function getLocalLatest(): MusicControlRecord | null {
	return localLatest;
}

/** Explicitly adopt the current global-latest remote record and play it (the
 *  picker's 'remote' choice / a play press with only a remote session). Returns
 *  false if there is no remote record. Rebuilds the queue by re-parsing the
 *  source note (synthetic single-track fallback) and seeds the Channel-B
 *  position. Call inside a user gesture, then resumePlaybackFromGesture() so iOS
 *  unlocks the element. */
export async function resumeGlobalLatest(): Promise<boolean> {
	const latest = globalLatest;
	if (!latest) return false;
	const tracks = await tracksFromRecord(latest);
	if (tracks.length === 0) return false;
	const found = tracks.findIndex((t) => t.url === latest.trackUrl);
	const index = found >= 0 ? found : 0;
	const ds = await deviceStateSync.readDeviceState(latest.deviceId);
	const position = ds && ds.trackUrl === tracks[index].url ? ds.position : 0;
	saveProgress(latest.noteGuid, tracks[index].url, position);
	musicPlayer.restoreSession({
		activeNoteGuid: latest.noteGuid,
		activeNoteName: latest.noteTitle,
		queue: tracks,
		currentIndex: index,
		originNoteGuid: latest.noteGuid
	});
	musicPlayer.resume();
	return true;
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
		// A reactive auto-pause (refreshFromNote) is suppressed: recording it would
		// hijack the global-latest leader onto this device's own paused track.
		if (suppressTransportRecord) return;
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
	localLatest = null;
	lastOwnActionAt = null;
	suppressTransportRecord = false;
}

/** Test-only: stamp this device's last own-action time so the auto-pause
 *  "newer than mine" guard can be exercised without driving recordTransport
 *  (which would pollute the control note with a newer own record). */
export function __setLastOwnActionAtForTest(ts: string | null): void {
	lastOwnActionAt = ts;
}
