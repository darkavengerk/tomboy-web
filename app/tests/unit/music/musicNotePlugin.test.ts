import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { buildMusicDecorations, handleTrackButtonClick, createMusicNotePlugin, musicNotePluginKey } from '$lib/editor/musicNote/musicNotePlugin.js';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';

let ed: Editor | null = null;
function doc(html: string) {
	ed = new Editor({ extensions: [StarterKit, TomboyUrlLink], content: html });
	return ed.state.doc;
}
afterEach(() => { ed?.destroy(); ed = null; });

const TWO = '<p>음악::x</p><p>플레이리스트: a</p><ul><li><p>https://h/1.mp3</p></li><li><p>https://h/2.mp3</p></li></ul>';

describe('buildMusicDecorations', () => {
	it('no decorations when idle and ctrl off', () => {
		const set = buildMusicDecorations(doc(TWO), { currentUrl: null, isPlaying: false, ctrlActive: false, onPlay: () => {} });
		expect(set.find().length).toBe(0);
	});
	it('playing track gets node deco + eq widget', () => {
		const d = doc(TWO);
		const set = buildMusicDecorations(d, { currentUrl: 'https://h/1.mp3', isPlaying: true, ctrlActive: false, onPlay: () => {} });
		// 1 node decoration + 1 widget = 2
		expect(set.find().length).toBe(2);
	});
	it('ctrl active adds one play button per track', () => {
		const d = doc(TWO);
		const set = buildMusicDecorations(d, { currentUrl: null, isPlaying: false, ctrlActive: true, onPlay: () => {} });
		expect(set.find().length).toBe(2); // 2 tracks → 2 buttons
	});
	it('play button invokes onPlay with the track index (extracted-function approach)', () => {
		// type.toDOM is a function (not HTMLElement), so we test via exported handleTrackButtonClick
		let called = -1;
		const onPlay = (i: number) => { called = i; };

		// index=1, not current → calls onPlay(1)
		handleTrackButtonClick({ currentUrl: null, isPlaying: false, ctrlActive: true, onPlay }, 1, false);
		expect(called).toBe(1);
	});
	it('handleTrackButtonClick calls onPlay for non-current track', () => {
		let called = -1;
		handleTrackButtonClick(
			{ currentUrl: 'https://h/1.mp3', isPlaying: true, ctrlActive: true, onPlay: (i) => { called = i; } },
			0,
			false // isCurrent = false → calls onPlay
		);
		expect(called).toBe(0);
	});

	it('handleTrackButtonClick toggles (pauses) current track without calling onPlay', () => {
		__resetMusicPlayer();
		// Set up a queue and start playing track 0
		musicPlayer.setQueue('test-guid', [
			{ url: 'https://h/1.mp3', title: 'Track 1', display: 'Track 1', liPos: 0 },
			{ url: 'https://h/2.mp3', title: 'Track 2', display: 'Track 2', liPos: 10 }
		]);
		musicPlayer.play(0);
		expect(musicPlayer.isPlaying).toBe(true);

		let onPlayCalled = false;
		handleTrackButtonClick(
			{ currentUrl: 'https://h/1.mp3', isPlaying: true, ctrlActive: true, onPlay: () => { onPlayCalled = true; } },
			0,
			true // isCurrent = true → toggle
		);

		expect(musicPlayer.isPlaying).toBe(false); // toggle paused it
		expect(onPlayCalled).toBe(false); // onPlay must NOT be called

		__resetMusicPlayer(); // cleanup: don't leak store state
	});
});

describe('createMusicNotePlugin', () => {
	it('decorations returns null for a non-music note', () => {
		// Mount plugin via Extension wrapper so we can read its props.decorations
		const plugin = createMusicNotePlugin();
		const ed2 = new Editor({
			extensions: [
				StarterKit,
				TomboyUrlLink,
				Extension.create({
					name: 'tomboyMusicNoteTest',
					addProseMirrorPlugins() { return [plugin]; }
				})
			],
			content: '<p>그냥 노트</p>'
		});
		// Access props.decorations through the plugin's spec
		const decorationsFn = plugin.props.decorations as ((state: unknown) => unknown) | undefined;
		const result = decorationsFn?.(ed2.state);
		ed2.destroy();
		expect(result).toBeNull();
	});
});
