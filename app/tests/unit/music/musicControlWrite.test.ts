import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';
import { recordTransport, __resetMusicControlForTest } from '$lib/music/musicControl.svelte.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { setSetting } from '$lib/storage/appSettings.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { parseRecordsFromDoc, MUSIC_CONTROL_GUID } from '$lib/music/musicControlNote.js';
import { _resetForTest as resetNoteReloadBus } from '$lib/core/noteReloadBus.js';

const tracks = [{ url: 'https://x/a.mp3', title: 'A', display: 'A', liPos: 0 }];

async function records() {
	const note = await noteStore.getNote(MUSIC_CONTROL_GUID);
	return note ? parseRecordsFromDoc(deserializeContent(note.xmlContent)) : [];
}

beforeEach(async () => {
	__resetMusicPlayer();
	__resetMusicProgress();
	__resetMusicControlForTest();
	resetNoteReloadBus();
	const existing = await noteStore.getNote(MUSIC_CONTROL_GUID);
	if (existing) await noteStore.deleteNote(MUSIC_CONTROL_GUID);
	await setSetting('firebaseNotesEnabled', false);
});

describe('musicControl write path', () => {
	it('no-op when sync toggle is off', async () => {
		musicPlayer.playNote('g1', tracks, '음악::x');
		await recordTransport('play');
		expect(await noteStore.getNote(MUSIC_CONTROL_GUID)).toBeUndefined();
	});

	it('creates the control note and upserts this device record when on', async () => {
		await setSetting('firebaseNotesEnabled', true);
		musicPlayer.playNote('g1', tracks, '음악::x');
		musicPlayer.requestSeek(30);
		await recordTransport('play');

		const note = await noteStore.getNote(MUSIC_CONTROL_GUID);
		expect(note).toBeDefined();
		expect(note!.title).toBe('음악제어::공유');
		let recs = await records();
		expect(recs).toHaveLength(1);
		expect(recs[0].trackUrl).toBe('https://x/a.mp3');
		expect(recs[0].state).toBe('playing');
		expect(recs[0].position).toBeCloseTo(30, 0);

		musicPlayer.requestSeek(45);
		await recordTransport('pause');
		recs = await records();
		expect(recs).toHaveLength(1);
		expect(recs[0].state).toBe('paused');
		expect(recs[0].position).toBeCloseTo(45, 0);
	});
});
