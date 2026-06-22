import { describe, it, expect, beforeEach } from 'vitest';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';

beforeEach(() => {
	__resetMusicPlayer();
	__resetMusicProgress();
});

const tracks = [{ url: 'https://x/a.mp3', title: 'A', display: 'A', liPos: 0 }];

describe('musicPlayer transport emitter', () => {
	it('emits play/pause/stop and stop fires before state clears', () => {
		const seen: Array<{ kind: string; hadTrack: boolean }> = [];
		const off = musicPlayer.onTransport((kind) =>
			seen.push({ kind, hadTrack: !!musicPlayer.currentTrack })
		);

		musicPlayer.playNote('g1', tracks, '음악::x');
		musicPlayer.notifyExplicitPlay();
		musicPlayer.pause();
		musicPlayer.stop();
		off();

		expect(seen.map((s) => s.kind)).toEqual(['play', 'pause', 'stop']);
		expect(seen.find((s) => s.kind === 'stop')!.hadTrack).toBe(true);
		expect(musicPlayer.currentTrack).toBeNull();
	});

	it('unsubscribe stops delivery', () => {
		let n = 0;
		const off = musicPlayer.onTransport(() => n++);
		off();
		musicPlayer.notifyExplicitPlay();
		expect(n).toBe(0);
	});

	it('toggle emits pause on the pause transition only (play recorded elsewhere)', () => {
		const seen: string[] = [];
		const off = musicPlayer.onTransport((k) => seen.push(k));
		musicPlayer.playNote('g1', tracks, '음악::x'); // isPlaying = true, no emit
		musicPlayer.toggle(); // → paused → emit 'pause'
		musicPlayer.toggle(); // → playing → no emit (play recorded via notifyExplicitPlay at gesture layer)
		off();
		expect(seen).toEqual(['pause']);
	});
});
