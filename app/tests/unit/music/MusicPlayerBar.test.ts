import { describe, it, expect, afterEach, beforeAll, beforeEach } from 'vitest';
import { flushSync } from 'svelte';
import { render, cleanup, screen } from '@testing-library/svelte';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import MusicPlayerBar from '$lib/editor/musicNote/MusicPlayerBar.svelte';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';

// Records the src present on the element each time play() is invoked, so tests can
// assert that auto-advance re-issues play() against the NEW track's src.
let playSrcs: string[] = [];

// jsdom doesn't implement media playback — stub so effects can poke <audio> safely.
beforeAll(() => {
	const def = (name: string, value: unknown) =>
		Object.defineProperty(HTMLMediaElement.prototype, name, { value, configurable: true });
	def('play', function (this: HTMLMediaElement) {
		playSrcs.push(this.getAttribute('src') ?? '');
		return Promise.resolve();
	});
	def('pause', () => {});
	def('load', () => {});
});

let ed: Editor | null = null;
function makeEditor(html: string): Editor {
	ed = new Editor({ extensions: [StarterKit, TomboyUrlLink], content: html });
	return ed;
}

beforeEach(() => {
	playSrcs = [];
});

afterEach(() => {
	cleanup();
	ed?.destroy();
	ed = null;
	__resetMusicPlayer();
});

describe('MusicPlayerBar — mount (effect-loop regression)', () => {
	// Before the untrack fix, setQueue read+wrote the same player $state inside the
	// re-parse $effect, so mounting any music note threw effect_update_depth_exceeded.
	it('mounts a music note with a track without an effect loop and wires the queue', () => {
		const editor = makeEditor(
			'<p>음악::주말</p><p>플레이리스트: 아침</p><ul><li><p>https://h/b.mp3</p></li></ul>'
		);
		// render() flushes effects synchronously — a self-invalidating effect throws here.
		expect(() => render(MusicPlayerBar, { editor, guid: 'note-1' })).not.toThrow();

		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.currentTrack?.url).toBe('https://h/b.mp3');
		expect(musicPlayer.isPlaying).toBe(false);
		// the control bar renders for a cued track
		expect(screen.getByRole('button', { name: '재생' })).toBeTruthy();
	});

	it('mounts a non-music note without looping and renders no control bar', () => {
		const editor = makeEditor('<p>그냥 노트</p>');
		const { container } = render(MusicPlayerBar, { editor, guid: 'note-2' });
		expect(container.querySelector('.music-bar')).toBeNull();
		expect(musicPlayer.currentTrack).toBeNull();
	});
});

describe('MusicPlayerBar — auto-advance keeps playing', () => {
	// Regression: when a track ends, next() advances the index but leaves isPlaying === true.
	// Since the value doesn't change, the play/pause effect doesn't re-run, and setting a fresh
	// <audio> src loads it PAUSED. The src effect must therefore re-issue play() on the new src,
	// otherwise the UI shows "재생 중" while nothing actually plays until the user presses play.
	it('re-issues play() on the new src when the current track ends', () => {
		const editor = makeEditor(
			'<p>음악::드라이브</p><p>플레이리스트: 길</p><ul><li><p>https://h/a.mp3</p></li><li><p>https://h/b.mp3</p></li></ul>'
		);
		const { container } = render(MusicPlayerBar, { editor, guid: 'note-3' });
		const audio = container.querySelector('audio') as HTMLAudioElement;
		expect(audio).toBeTruthy();

		// Start playing the first track.
		musicPlayer.play(0);
		flushSync();
		expect(musicPlayer.currentIndex).toBe(0);
		expect(audio.getAttribute('src')).toBe('https://h/a.mp3');
		expect(playSrcs.at(-1)).toBe('https://h/a.mp3');

		// First track ends → auto-advance. isPlaying stays true the whole time.
		audio.dispatchEvent(new Event('ended'));
		flushSync();

		expect(musicPlayer.currentIndex).toBe(1);
		expect(musicPlayer.isPlaying).toBe(true);
		expect(audio.getAttribute('src')).toBe('https://h/b.mp3');
		// The crux: play() was re-issued against the new src, not left paused.
		expect(playSrcs.at(-1)).toBe('https://h/b.mp3');
	});

	it('does not auto-play a freshly loaded note (src set while paused stays paused)', () => {
		const editor = makeEditor(
			'<p>음악::대기</p><p>플레이리스트: 밤</p><ul><li><p>https://h/c.mp3</p></li></ul>'
		);
		const { container } = render(MusicPlayerBar, { editor, guid: 'note-4' });
		const audio = container.querySelector('audio') as HTMLAudioElement;
		flushSync();
		// Mount cues track 0 but isPlaying is false — src is set, play() must NOT be called.
		expect(audio.getAttribute('src')).toBe('https://h/c.mp3');
		expect(musicPlayer.isPlaying).toBe(false);
		expect(playSrcs).toEqual([]);
	});
});
