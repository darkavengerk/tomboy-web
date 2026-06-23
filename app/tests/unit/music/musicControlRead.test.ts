import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';
import {
	refreshFromNote,
	getGlobalLatest,
	resumeGlobalLatest,
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
	type MusicControlRecord
} from '$lib/music/musicControlNote.js';
import * as deviceState from '$lib/music/deviceStateSync.firestore.js';

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

beforeEach(async () => {
	vi.restoreAllMocks();
	__resetMusicPlayer();
	__resetMusicProgress();
	__resetMusicControlForTest();
	resetNoteReloadBus();
	const existing = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (existing) await noteStore.deleteNote(MUSIC_CONTROL_GUID);
	// Clean up any test music notes
	for (const guid of ['gR', 'missing', 'local']) {
		const n = await noteStore.getNote(guid);
		if (n) await noteStore.deleteNote(guid);
	}
	await setSetting('firebaseNotesEnabled', true);
});

describe('musicControl read path', () => {
	it('restores a ready paused single-track queue from a remote latest (note absent = synthetic)', async () => {
		// No music note seeded — falls back to synthetic track
		await seedControlNote([remoteRec()]);
		await refreshFromNote();

		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.activeNoteGuid).toBe('gR');
		expect(musicPlayer.queue).toHaveLength(1);
		expect(musicPlayer.currentTrack!.url).toBe('https://x/remote.mp3');
	});

	it('does NOT restore when latest is this device', async () => {
		const myId = await getOrCreateInstallId();
		await seedControlNote([remoteRec({ deviceId: myId, updatedAt: '2026-06-22T11:00:00.000Z' })]);
		await refreshFromNote();
		expect(musicPlayer.queue).toHaveLength(0);
	});

	it('does NOT yank while playing (remote paused record)', async () => {
		musicPlayer.playNote('local', [{ url: 'https://x/local.mp3', title: 'L', display: 'L', liPos: 0 }], '음악::local');
		await seedControlNote([remoteRec()]);
		await refreshFromNote();
		expect(musicPlayer.activeNoteGuid).toBe('local');
	});

	it('rebuilds the full queue from the note so ⏭ advances', async () => {
		await seedMusicNote('gR', ['https://x/a.mp3', 'https://x/b.mp3', 'https://x/c.mp3']);
		await seedControlNote([remoteRec({ noteGuid: 'gR', trackUrl: 'https://x/a.mp3' })]);
		await refreshFromNote();
		expect(musicPlayer.queue).toHaveLength(3);
		expect(musicPlayer.currentIndex).toBe(0);
		musicPlayer.next();
		expect(musicPlayer.currentIndex).toBe(1);
	});

	it('indexes the queue at the record trackUrl', async () => {
		await seedMusicNote('gR', ['https://x/a.mp3', 'https://x/b.mp3']);
		await seedControlNote([remoteRec({ noteGuid: 'gR', trackUrl: 'https://x/b.mp3' })]);
		await refreshFromNote();
		expect(musicPlayer.currentTrack!.url).toBe('https://x/b.mp3');
	});

	it('falls back to a single synthetic track when the note is not local', async () => {
		await seedControlNote([remoteRec({ noteGuid: 'missing', trackUrl: 'https://x/z.mp3' })]);
		await refreshFromNote();
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
		musicPlayer.resume();
		expect(musicPlayer.resumeAt).toBeCloseTo(55, 0);
	});

	it('uses position=0 when Channel-B trackUrl does not match current track', async () => {
		vi.spyOn(deviceState.deviceStateSync, 'readDeviceState').mockResolvedValue({
			position: 55,
			trackUrl: 'https://x/different.mp3' // different URL
		});
		await seedMusicNote('gR', ['https://x/a.mp3']);
		await seedControlNote([remoteRec({ noteGuid: 'gR', trackUrl: 'https://x/a.mp3' })]);
		await refreshFromNote();
		musicPlayer.resume();
		expect(musicPlayer.resumeAt).toBeCloseTo(0, 0);
	});

	it('pauses this device when another device starts playing (newer)', async () => {
		// this device is playing locally
		musicPlayer.playNote('local', [{ url: 'https://x/local.mp3', title: 'L', display: 'L', liPos: 0 }], '음악::local');
		expect(musicPlayer.isPlaying).toBe(true);
		await seedControlNote([remoteRec({ state: 'playing', updatedAt: '2099-01-01T00:00:00.000Z' })]);
		await refreshFromNote();
		expect(musicPlayer.isPlaying).toBe(false); // auto-paused
		expect(musicPlayer.queue).toHaveLength(1); // queue NOT cleared
	});

	it('does NOT pause for a remote paused record', async () => {
		musicPlayer.playNote('local', [{ url: 'https://x/local.mp3', title: 'L', display: 'L', liPos: 0 }], '음악::local');
		await seedControlNote([remoteRec({ state: 'paused', updatedAt: '2099-01-01T00:00:00.000Z' })]);
		await refreshFromNote();
		expect(musicPlayer.isPlaying).toBe(true);
	});

	it('does NOT pause for a remote playing record that is NOT newer than our last action', async () => {
		// This device is playing AND stamped a more-recent own action than the remote.
		musicPlayer.playNote('local', [{ url: 'https://x/local.mp3', title: 'L', display: 'L', liPos: 0 }], '음악::local');
		__setLastOwnActionAtForTest('2099-01-01T00:00:00.000Z'); // our action is newest
		// Remote says playing, but its updatedAt is OLDER than our last action → must NOT pause.
		await seedControlNote([remoteRec({ state: 'playing', updatedAt: '2026-06-22T10:00:00.000Z' })]);
		await refreshFromNote();
		expect(musicPlayer.isPlaying).toBe(true);
	});

	it('dedupes a re-delivered identical record (no destructive re-restore)', async () => {
		await seedControlNote([remoteRec()]);
		await refreshFromNote();
		// simulate user/engine moving the position without starting playback
		musicPlayer.requestSeek(50);
		expect(musicPlayer.currentTime).toBeCloseTo(50, 0);
		// same record delivered again → must NOT re-run restoreSession (which zeros currentTime)
		await refreshFromNote();
		expect(musicPlayer.currentTime).toBeCloseTo(50, 0);
	});

	it('does NOT stage a stopped record, but still sets the global-latest pointer', async () => {
		await seedControlNote([remoteRec({ state: 'stopped' })]);
		await refreshFromNote();
		expect(musicPlayer.queue).toHaveLength(0);
		expect(getGlobalLatest()!.state).toBe('stopped');
	});

	it('resumeGlobalLatest adopts and plays the remote record', async () => {
		await seedMusicNote('gR', ['https://x/a.mp3', 'https://x/b.mp3']);
		await seedControlNote([remoteRec({ noteGuid: 'gR', trackUrl: 'https://x/b.mp3' })]);
		await refreshFromNote(); // sets globalLatest
		const ok = await resumeGlobalLatest();
		expect(ok).toBe(true);
		expect(musicPlayer.isPlaying).toBe(true);
		expect(musicPlayer.currentTrack!.url).toBe('https://x/b.mp3');
	});
});
