import { describe, it, expect, beforeEach } from 'vitest';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import type { MusicTrack } from '$lib/music/parseMusicNote.js';

const t = (url: string): MusicTrack => ({ url, title: null, display: url, liPos: 0 });

beforeEach(() => __resetMusicPlayer());

describe('musicPlayer.setQueue', () => {
	it('starts at index 0 paused for a fresh note', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(false);
	});
	it('preserves the playing track by url across re-parse (same note)', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b'), t('c')]);
		musicPlayer.play(2); // c
		musicPlayer.setQueue('n1', [t('x'), t('a'), t('b'), t('c')]); // c moved to idx 3
		expect(musicPlayer.currentTrack?.url).toBe('c');
		expect(musicPlayer.currentIndex).toBe(3);
		expect(musicPlayer.isPlaying).toBe(true);
	});
	it('resets to 0 paused when the playing url vanished', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(1);
		musicPlayer.setQueue('n1', [t('a'), t('z')]);
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(false);
	});
	it('resets on a different note even if a url coincides', () => {
		musicPlayer.setQueue('n1', [t('a')]);
		musicPlayer.play(0);
		musicPlayer.setQueue('n2', [t('a'), t('b')]);
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(false);
	});
});

describe('musicPlayer transport', () => {
	it('toggle from no selection plays first', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.toggle();
		expect(musicPlayer.isPlaying).toBe(true);
		expect(musicPlayer.currentIndex).toBe(0);
	});
	it('next stops at end of queue', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(1);
		musicPlayer.next();
		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.currentIndex).toBe(1);
	});
	it('reportEnded advances to next track', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(0);
		musicPlayer.reportEnded();
		expect(musicPlayer.currentIndex).toBe(1);
		expect(musicPlayer.isPlaying).toBe(true);
	});
	it('prev at start requests seek to 0', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(0);
		const before = musicPlayer.seekToken;
		musicPlayer.prev();
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.seekToken).toBe(before + 1);
	});
	it('requestSeek bumps token and updates time', () => {
		musicPlayer.setQueue('n1', [t('a')]);
		const before = musicPlayer.seekToken;
		musicPlayer.requestSeek(42);
		expect(musicPlayer.currentTime).toBe(42);
		expect(musicPlayer.seekToken).toBe(before + 1);
	});
	it('pause stops playback without changing the index', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(1);
		expect(musicPlayer.isPlaying).toBe(true);
		musicPlayer.pause();
		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.currentIndex).toBe(1);
	});
});
