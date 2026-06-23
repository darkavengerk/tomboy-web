import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';
import {
	refreshFromNote,
	getGlobalLatest,
	resumeGlobalLatest,
	installMusicControl,
	__resetMusicControlForTest,
	__setLastOwnActionAtForTest
} from '$lib/music/musicControl.svelte.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { setSetting } from '$lib/storage/appSettings.js';
import { createEmptyNote } from '$lib/core/note.js';
import { serializeContent } from '$lib/core/noteContentArchiver.js';
import { _resetForTest as resetNoteReloadBus } from '$lib/core/noteReloadBus.js';
import { getOrCreateInstallId } from '$lib/schedule/installId.js';
import {
	MUSIC_CONTROL_GUID,
	MUSIC_CONTROL_TITLE,
	serializeRecords,
	parseRecordsFromXml,
	type MusicControlRecord
} from '$lib/music/musicControlNote.js';
import * as deviceState from '$lib/music/deviceStateSync.firestore.js';
import * as noteManager from '$lib/core/noteManager.js';

async function seedControlNote(records: MusicControlRecord[]) {
	const note = createEmptyNote(MUSIC_CONTROL_GUID);
	note.title = MUSIC_CONTROL_TITLE;
	const doc = {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: MUSIC_CONTROL_TITLE }] },
			{ type: 'paragraph', content: [{ type: 'text', text: serializeRecords(records) }] }
		]
	};
	note.xmlContent = serializeContent(doc);
	await noteStore.putNote(note);
}

/** Seed a real 음악:: note so buildQueueFromXml can parse the queue. */
async function seedMusicNote(guid: string, urls: string[]) {
	const note = createEmptyNote(guid);
	note.title = '음악::로제';
	const doc = {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: '음악::로제' }] },
			{ type: 'paragraph', content: [{ type: 'text', text: '플레이리스트:로제' }] },
			{
				type: 'bulletList',
				content: urls.map((u) => ({
					type: 'listItem',
					content: [
						{
							type: 'paragraph',
							content: [{ type: 'text', text: u, marks: [{ type: 'tomboyUrlLink', attrs: { href: u } }] }]
						}
					]
				}))
			}
		]
	};
	note.xmlContent = serializeContent(doc);
	await noteStore.putNote(note);
}

const remoteRec = (o: Partial<MusicControlRecord> = {}): MusicControlRecord => ({
	deviceId: 'other-device',
	deviceName: '아이폰',
	trackUrl: 'https://x/remote.mp3',
	trackTitle: '리모트곡',
	noteGuid: 'gR',
	noteTitle: '음악::리모트',
	state: 'paused',
	updatedAt: '2026-06-22T10:00:00.000Z',
	...o
});

const LOCAL_TRACK = { url: 'https://x/local.mp3', title: 'L', display: 'L', liPos: 0 };

beforeEach(async () => {
	vi.restoreAllMocks();
	__resetMusicPlayer();
	__resetMusicProgress();
	__resetMusicControlForTest();
	resetNoteReloadBus();
	const existing = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (existing) await noteStore.deleteNote(MUSIC_CONTROL_GUID);
	for (const guid of ['gR', 'missing', 'local']) {
		const n = await noteStore.getNote(guid);
		if (n) await noteStore.deleteNote(guid);
	}
	await setSetting('firebaseNotesEnabled', true);
});

describe('refreshFromNote — remote pointer (globalLatest)', () => {
	it('points at the most-recent OTHER-device, non-stopped record', async () => {
		await seedControlNote([remoteRec({ state: 'playing', updatedAt: '2026-06-22T10:00:00.000Z' })]);
		await refreshFromNote();
		const g = getGlobalLatest();
		expect(g).not.toBeNull();
		expect(g!.deviceId).toBe('other-device');
		expect(g!.trackUrl).toBe('https://x/remote.mp3');
	});

	it('a paused other-device record is still resumable (offered as remote)', async () => {
		await seedControlNote([remoteRec({ state: 'paused' })]);
		await refreshFromNote();
		expect(getGlobalLatest()!.state).toBe('paused');
	});

	it('ignores this device\'s OWN record for the remote pointer', async () => {
		const myId = await getOrCreateInstallId();
		await seedControlNote([remoteRec({ deviceId: myId, updatedAt: '2026-06-22T11:00:00.000Z' })]);
		await refreshFromNote();
		expect(getGlobalLatest()).toBeNull();
	});

	it('does NOT stage the remote queue passively (local session preserved for the picker)', async () => {
		// local session present (e.g. session-restored)
		musicPlayer.playNote('local', [LOCAL_TRACK], '음악::local');
		musicPlayer.pause();
		expect(musicPlayer.activeNoteGuid).toBe('local');
		await seedControlNote([remoteRec({ state: 'paused' })]);
		await refreshFromNote();
		// queue is still the LOCAL one — refreshFromNote must not overwrite it
		expect(musicPlayer.activeNoteGuid).toBe('local');
		expect(musicPlayer.currentTrack!.url).toBe('https://x/local.mp3');
	});

	it('global-latest is null when the latest other-device record is stopped', async () => {
		await seedControlNote([remoteRec({ state: 'stopped' })]);
		await refreshFromNote();
		expect(getGlobalLatest()).toBeNull();
	});

	it('falls back to an older non-stopped record when the newest other is stopped', async () => {
		await seedControlNote([
			remoteRec({
				deviceId: 'dev-a',
				trackUrl: 'https://x/a.mp3',
				state: 'paused',
				updatedAt: '2026-06-22T09:00:00.000Z'
			}),
			remoteRec({
				deviceId: 'dev-b',
				trackUrl: 'https://x/b.mp3',
				state: 'stopped',
				updatedAt: '2026-06-22T12:00:00.000Z'
			})
		]);
		await refreshFromNote();
		// newest is dev-b stopped → pointer is null (we don't resurrect dev-a's older session)
		expect(getGlobalLatest()).toBeNull();
	});
});

describe('refreshFromNote — #1 single playback auto-pause', () => {
	it('pauses this device when another device starts playing (newer); queue preserved', async () => {
		musicPlayer.playNote('local', [LOCAL_TRACK], '음악::local');
		expect(musicPlayer.isPlaying).toBe(true);
		await seedControlNote([remoteRec({ state: 'playing', updatedAt: '2099-01-01T00:00:00.000Z' })]);
		await refreshFromNote();
		expect(musicPlayer.isPlaying).toBe(false); // auto-paused
		expect(musicPlayer.queue).toHaveLength(1); // queue NOT cleared
		expect(musicPlayer.activeNoteGuid).toBe('local'); // still our own session
	});

	it('does NOT pause for a remote PAUSED record (newer)', async () => {
		musicPlayer.playNote('local', [LOCAL_TRACK], '음악::local');
		await seedControlNote([remoteRec({ state: 'paused', updatedAt: '2099-01-01T00:00:00.000Z' })]);
		await refreshFromNote();
		expect(musicPlayer.isPlaying).toBe(true);
	});

	it('does NOT pause for a remote PLAYING record that is NOT newer than our last action', async () => {
		musicPlayer.playNote('local', [LOCAL_TRACK], '음악::local');
		__setLastOwnActionAtForTest('2099-01-01T00:00:00.000Z'); // our action is newest
		await seedControlNote([remoteRec({ state: 'playing', updatedAt: '2026-06-22T10:00:00.000Z' })]);
		await refreshFromNote();
		expect(musicPlayer.isPlaying).toBe(true);
	});

	it('does NOT pause when the latest record is this device', async () => {
		const myId = await getOrCreateInstallId();
		musicPlayer.playNote('local', [LOCAL_TRACK], '음악::local');
		await seedControlNote([
			remoteRec({ deviceId: myId, state: 'playing', updatedAt: '2099-01-01T00:00:00.000Z' })
		]);
		await refreshFromNote();
		expect(musicPlayer.isPlaying).toBe(true);
	});

	it('auto-pause is SILENT — writes NO control-note record (no leader hijack)', async () => {
		// Regression: without the suppress gate the auto-pause emitted 'pause' →
		// recordTransport → a paused-own record that became the global-latest,
		// pointing "remote" back at this device's own track (handoff + picker dead).
		const writeSpy = vi.spyOn(noteManager, 'updateNoteFromEditor').mockResolvedValue(undefined as never);
		const uninstall = installMusicControl(); // installs the transport listener
		try {
			musicPlayer.playNote('local', [LOCAL_TRACK], '음악::local'); // emits no transport
			await seedControlNote([
				remoteRec({ state: 'playing', updatedAt: '2099-01-01T00:00:00.000Z' })
			]);
			await refreshFromNote();
			expect(musicPlayer.isPlaying).toBe(false); // did auto-pause
			await new Promise((r) => setTimeout(r, 20)); // let any async write settle
			expect(writeSpy).not.toHaveBeenCalled(); // but recorded nothing
		} finally {
			uninstall();
		}
	});
});

describe('resumeGlobalLatest — explicit remote adopt + play', () => {
	it('rebuilds the full queue from the note so ⏭ advances', async () => {
		await seedMusicNote('gR', ['https://x/a.mp3', 'https://x/b.mp3', 'https://x/c.mp3']);
		await seedControlNote([remoteRec({ noteGuid: 'gR', trackUrl: 'https://x/a.mp3' })]);
		await refreshFromNote(); // sets globalLatest
		const ok = await resumeGlobalLatest();
		expect(ok).toBe(true);
		expect(musicPlayer.queue).toHaveLength(3);
		expect(musicPlayer.currentIndex).toBe(0);
		musicPlayer.next();
		expect(musicPlayer.currentIndex).toBe(1);
	});

	it('indexes the queue at the record trackUrl and plays', async () => {
		await seedMusicNote('gR', ['https://x/a.mp3', 'https://x/b.mp3']);
		await seedControlNote([remoteRec({ noteGuid: 'gR', trackUrl: 'https://x/b.mp3' })]);
		await refreshFromNote();
		await resumeGlobalLatest();
		expect(musicPlayer.isPlaying).toBe(true);
		expect(musicPlayer.currentTrack!.url).toBe('https://x/b.mp3');
	});

	it('falls back to a single synthetic track when the note is not local', async () => {
		await seedControlNote([remoteRec({ noteGuid: 'missing', trackUrl: 'https://x/z.mp3' })]);
		await refreshFromNote();
		await resumeGlobalLatest();
		expect(musicPlayer.queue).toHaveLength(1);
		expect(musicPlayer.currentTrack!.url).toBe('https://x/z.mp3');
	});

	it('seeds resume position from Channel B when trackUrl matches', async () => {
		vi.spyOn(deviceState.deviceStateSync, 'readDeviceState').mockResolvedValue({
			position: 55,
			trackUrl: 'https://x/a.mp3'
		});
		await seedMusicNote('gR', ['https://x/a.mp3']);
		await seedControlNote([remoteRec({ noteGuid: 'gR', trackUrl: 'https://x/a.mp3' })]);
		await refreshFromNote();
		await resumeGlobalLatest();
		expect(musicPlayer.resumeAt).toBeCloseTo(55, 0);
	});

	it('uses position=0 when Channel-B trackUrl does not match current track', async () => {
		vi.spyOn(deviceState.deviceStateSync, 'readDeviceState').mockResolvedValue({
			position: 55,
			trackUrl: 'https://x/different.mp3'
		});
		await seedMusicNote('gR', ['https://x/a.mp3']);
		await seedControlNote([remoteRec({ noteGuid: 'gR', trackUrl: 'https://x/a.mp3' })]);
		await refreshFromNote();
		await resumeGlobalLatest();
		expect(musicPlayer.resumeAt).toBeCloseTo(0, 0);
	});

	it('returns false when there is no remote record', async () => {
		await seedControlNote([remoteRec({ state: 'stopped' })]); // stopped → no remote pointer
		await refreshFromNote();
		expect(getGlobalLatest()).toBeNull();
		expect(await resumeGlobalLatest()).toBe(false);
	});
});
