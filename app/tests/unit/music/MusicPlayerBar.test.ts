import { describe, it, expect, afterEach } from 'vitest';
import { flushSync } from 'svelte';
import { render, cleanup } from '@testing-library/svelte';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import MusicPlayerBar from '$lib/editor/musicNote/MusicPlayerBar.svelte';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import type { MusicTrack } from '$lib/music/parseMusicNote.js';

let ed: Editor | null = null;
function makeEditor(html: string): Editor {
	ed = new Editor({ extensions: [StarterKit, TomboyUrlLink], content: html });
	return ed;
}
const T = (url: string, display: string, label = ''): MusicTrack => ({
	url,
	title: null,
	display,
	liPos: 0,
	playlistLabel: label
});

const ONE = '<p>음악::드라이브</p><p>플레이리스트: 길</p><ul><li><p>https://h/a.mp3</p></li></ul>';
const TWO =
	'<p>음악::드라이브</p><p>플레이리스트: 길</p><ul><li><p>https://h/a.mp3</p></li><li><p>https://h/b.mp3</p></li></ul>';

afterEach(() => {
	cleanup();
	ed?.destroy();
	ed = null;
	__resetMusicPlayer();
});

describe('MusicPlayerBar — 순수 뷰 (글로벌 now-playing + idle 미리보기)', () => {
	it('idle: 음악 노트면 패널이 뜨고 보는 노트의 첫 곡을 미리보기 (이전/다음 비활성)', () => {
		__resetMusicPlayer();
		const editor = makeEditor(ONE);
		const { container } = render(MusicPlayerBar, { editor, guid: 'n1' });
		flushSync();
		expect(container.querySelector('.music-bar')).toBeTruthy();
		expect(container.querySelector('.music-now b')?.textContent).toBe('a'); // 로컬 첫 곡
		expect(container.querySelector('.music-now')?.textContent).toContain('대기');
		expect((container.querySelector('button[aria-label="이전"]') as HTMLButtonElement).disabled).toBe(true);
		expect((container.querySelector('button.main') as HTMLButtonElement).disabled).toBe(false);
	});

	it('idle ▶ → 보는 노트를 재생 시작(setQueue + play(0))', () => {
		__resetMusicPlayer();
		const editor = makeEditor(ONE);
		const { container } = render(MusicPlayerBar, { editor, guid: 'n1' });
		flushSync();
		(container.querySelector('button.main') as HTMLButtonElement).click();
		flushSync();
		expect(musicPlayer.currentTrack?.url).toBe('https://h/a.mp3');
		expect(musicPlayer.isPlaying).toBe(true);
		expect(musicPlayer.activeNoteGuid).toBe('n1');
		expect(container.querySelector('.music-now')?.textContent).toContain('재생 중');
	});

	it('다른 노트가 재생 중이면, 이 노트 패널도 글로벌 재생 곡을 표시', () => {
		__resetMusicPlayer();
		musicPlayer.setQueue('other', [T('https://h/z.mp3', '젭', '밤')], '다른노트');
		musicPlayer.play(0);
		const editor = makeEditor(ONE); // 이 노트의 로컬 첫 곡은 'a'
		const { container } = render(MusicPlayerBar, { editor, guid: 'this' });
		flushSync();
		// 로컬 'a' 가 아니라 글로벌 '젭' 을 표시.
		expect(container.querySelector('.music-now b')?.textContent).toBe('젭');
		expect(container.querySelector('.music-pl')?.textContent).toBe('밤');
		// 글로벌 재생 중이므로 이전/다음 활성.
		expect((container.querySelector('button[aria-label="이전"]') as HTMLButtonElement).disabled).toBe(false);
		// 비활성 노트는 큐를 건드리지 않음.
		expect(musicPlayer.activeNoteGuid).toBe('other');
		expect(musicPlayer.queue.length).toBe(1);
	});

	it('활성 노트를 편집하면 큐가 재동기화된다', () => {
		__resetMusicPlayer();
		const editor = makeEditor(ONE);
		render(MusicPlayerBar, { editor, guid: 'n1' });
		flushSync();
		(document.querySelector('button.main') as HTMLButtonElement).click(); // n1 활성화
		flushSync();
		expect(musicPlayer.queue.length).toBe(1);

		// 두 번째 트랙을 추가하는 편집 → update 이벤트 → 재동기화.
		editor.commands.setContent(TWO, { emitUpdate: true });
		flushSync();
		expect(musicPlayer.queue.length).toBe(2);
	});

	it('곡이 하나도 없으면(빈 음악 노트) 패널은 뜨되 컨트롤 비활성', () => {
		__resetMusicPlayer();
		const editor = makeEditor('<p>음악::빈노트</p><p>그냥 메모</p>');
		const { container } = render(MusicPlayerBar, { editor, guid: 'n2' });
		flushSync();
		expect(container.querySelector('.music-bar')).toBeTruthy();
		expect(container.querySelector('.music-empty')).toBeTruthy();
		expect((container.querySelector('button.main') as HTMLButtonElement).disabled).toBe(true);
	});
});
