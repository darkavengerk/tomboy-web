import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup, screen } from '@testing-library/svelte';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import MusicPlayerBar from '$lib/editor/musicNote/MusicPlayerBar.svelte';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';

// jsdom doesn't implement media playback — stub so effects can poke <audio> safely.
beforeAll(() => {
	const def = (name: string, value: unknown) =>
		Object.defineProperty(HTMLMediaElement.prototype, name, { value, configurable: true });
	def('play', () => Promise.resolve());
	def('pause', () => {});
	def('load', () => {});
});

let ed: Editor | null = null;
function makeEditor(html: string): Editor {
	ed = new Editor({ extensions: [StarterKit, TomboyUrlLink], content: html });
	return ed;
}

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
