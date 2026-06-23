import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';

const calls = { write: [] as [number, string][], flush: [] as [number, string][] };
vi.mock('$lib/music/deviceStatePlayback.js', () => ({
	reportPlaybackPosition: (p: number, u: string) => calls.write.push([p, u]),
	flushPlaybackPosition: (p: number, u: string) => calls.flush.push([p, u])
}));

import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';
import { installMusicAudio, __musicAudioForTest } from '$lib/music/musicAudio.svelte.js';

// jsdom 은 미디어 재생 미구현 → stub
beforeAll(() => {
	const def = (name: string, value: unknown) =>
		Object.defineProperty(HTMLMediaElement.prototype, name, { value, configurable: true });
	def('play', function () {
		return Promise.resolve();
	});
	def('pause', () => {});
	def('load', () => {});
});

let uninstall = () => {};

beforeEach(() => {
	calls.write.length = 0;
	calls.flush.length = 0;
	__resetMusicPlayer();
	__resetMusicProgress();
	uninstall = installMusicAudio();
});

afterEach(() => {
	uninstall();
});

describe('Channel B engine wiring', () => {
	it('reports position on timeupdate', () => {
		musicPlayer.playNote('g', [{ url: 'https://x/a.mp3', title: 'A', display: 'A', liPos: 0 }], '음악::x');
		flushSync();
		const { audio } = __musicAudioForTest();
		Object.defineProperty(audio!, 'currentTime', { value: 12, configurable: true });
		audio!.dispatchEvent(new Event('timeupdate'));
		expect(calls.write).toContainEqual([12, 'https://x/a.mp3']);
	});

	it('flushes on seek', () => {
		musicPlayer.playNote('g', [{ url: 'https://x/a.mp3', title: 'A', display: 'A', liPos: 0 }], '음악::x');
		flushSync();
		musicPlayer.requestSeek(30);
		flushSync();
		expect(calls.flush.some(([p, u]) => p === 30 && u === 'https://x/a.mp3')).toBe(true);
	});
});
