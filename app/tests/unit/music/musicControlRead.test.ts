import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';
import {
	refreshFromNote,
	getGlobalLatestForTest,
	__resetMusicControlForTest
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

const remoteRec = (o: Partial<MusicControlRecord> = {}): MusicControlRecord => ({
	deviceId: 'other-device',
	deviceName: '아이폰',
	trackUrl: 'https://x/remote.mp3',
	trackTitle: '리모트곡',
	noteGuid: 'gR',
	noteTitle: '음악::리모트',
	position: 42,
	state: 'paused',
	updatedAt: '2026-06-22T10:00:00.000Z',
	...o
});

beforeEach(async () => {
	__resetMusicPlayer();
	__resetMusicProgress();
	__resetMusicControlForTest();
	resetNoteReloadBus();
	const existing = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (existing) await noteStore.deleteNote(MUSIC_CONTROL_GUID);
	await setSetting('firebaseNotesEnabled', true);
});

describe('musicControl read path', () => {
	it('restores a ready paused single-track queue from a remote latest', async () => {
		await seedControlNote([remoteRec()]);
		await refreshFromNote();

		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.activeNoteGuid).toBe('gR');
		expect(musicPlayer.queue).toHaveLength(1);
		expect(musicPlayer.currentTrack!.url).toBe('https://x/remote.mp3');
		expect(musicPlayer.resumeAt).toBe(0); // not promoted until resume()
		musicPlayer.resume();
		expect(musicPlayer.resumeAt).toBeCloseTo(42, 0); // pendingRestore promoted
	});

	it('does NOT restore when latest is this device', async () => {
		const myId = await getOrCreateInstallId();
		await seedControlNote([remoteRec({ deviceId: myId, updatedAt: '2026-06-22T11:00:00.000Z' })]);
		await refreshFromNote();
		expect(musicPlayer.queue).toHaveLength(0);
	});

	it('does NOT yank while playing', async () => {
		musicPlayer.playNote('local', [{ url: 'https://x/local.mp3', title: 'L', display: 'L', liPos: 0 }], '음악::local');
		await seedControlNote([remoteRec()]);
		await refreshFromNote();
		expect(musicPlayer.activeNoteGuid).toBe('local');
	});

	it('restores the FULL queue so ⏭ advances instead of stopping', async () => {
		const queue = [
			{ url: 'https://x/a.mp3', display: 'A', title: 'A', playlistLabel: '로제' },
			{ url: 'https://x/b.mp3', display: 'B', title: 'B', playlistLabel: '로제' },
			{ url: 'https://x/c.mp3', display: 'C', title: 'C', playlistLabel: '로제' }
		];
		await seedControlNote([remoteRec({ queue, index: 0 })]);
		await refreshFromNote();
		expect(musicPlayer.queue).toHaveLength(3);
		expect(musicPlayer.currentIndex).toBe(0);
		// ⏭ — with a single synthetic track this returned null → isPlaying=false (stop).
		musicPlayer.next();
		expect(musicPlayer.currentIndex).toBe(1);
		expect(musicPlayer.isPlaying).toBe(true);
	});

	it('restores at the recorded index within the full queue', async () => {
		const queue = [
			{ url: 'https://x/a.mp3', display: 'A' },
			{ url: 'https://x/b.mp3', display: 'B' }
		];
		await seedControlNote([remoteRec({ queue, index: 1, position: 30 })]);
		await refreshFromNote();
		expect(musicPlayer.currentIndex).toBe(1);
		expect(musicPlayer.currentTrack!.url).toBe('https://x/b.mp3');
		musicPlayer.resume();
		expect(musicPlayer.resumeAt).toBeCloseTo(30, 0);
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
		expect(getGlobalLatestForTest()!.state).toBe('stopped');
	});
});
