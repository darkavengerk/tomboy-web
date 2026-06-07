import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { Decoration, DecorationSet } from '@tiptap/pm/view';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { buildMusicDecorations, handleTrackButtonClick, createMusicNotePlugin } from '$lib/editor/musicNote/musicNotePlugin.js';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';

let ed: Editor | null = null;
function doc(html: string) {
	ed = new Editor({ extensions: [StarterKit, TomboyUrlLink], content: html });
	return ed.state.doc;
}
afterEach(() => { ed?.destroy(); ed = null; });

const TWO = '<p>음악::x</p><p>플레이리스트: a</p><ul><li><p>https://h/1.mp3</p></li><li><p>https://h/2.mp3</p></li></ul>';
const NESTED = '<p>음악::x</p><p>플레이리스트: a</p><ul><li><p>좋은 날</p><ul><li><p>https://h/g.mp3</p></li></ul></li></ul>';
// 두 플레이리스트(둘 다 켜짐) — 헤더 ▶ 의 시작 인덱스 검증용.
const TWOPL =
	'<p>음악::x</p>' +
	'<p>플레이리스트: a</p><ul><li><p>https://h/1.mp3</p></li></ul>' +
	'<p>플레이리스트: b</p><ul><li><p>https://h/2.mp3</p></li><li><p>https://h/3.mp3</p></li></ul>';

// 데코 분류 헬퍼. 위젯은 zero-width(from===to), 노드/인라인은 from<to.
// Decoration.type 은 공개 타입에 없으므로 내부 형태로 캐스팅해 읽는다.
type DecoInternal = {
	type: { attrs?: Record<string, string>; toDOM?: ((...a: unknown[]) => HTMLElement) | HTMLElement };
};
const widgets = (set: DecorationSet) => set.find().filter((d) => d.from === d.to);
const spans = (set: DecorationSet) => set.find().filter((d) => d.from < d.to);
const cls = (d: Decoration) => (d as unknown as DecoInternal).type.attrs?.class;
const attr = (d: Decoration, name: string) => (d as unknown as DecoInternal).type.attrs?.[name];
function widgetDom(d: Decoration): HTMLElement {
	const t = (d as unknown as DecoInternal).type.toDOM!;
	return typeof t === 'function' ? t() : t;
}
const nameWidgets = (set: DecorationSet) =>
	widgets(set).filter((w) => widgetDom(w)?.classList?.contains('music-track-name'));
const plPlayButtons = (set: DecorationSet) =>
	widgets(set).filter((w) => widgetDom(w)?.classList?.contains('music-pl-play-btn'));

const sortNums = (a: number, b: number) => a - b;

describe('buildMusicDecorations — 플레이리스트 렌더링', () => {
	it('음악 노트가 아니면(큐 비면) 데코 없음', () => {
		const set = buildMusicDecorations(doc('<p>그냥 노트</p>'), { currentUrl: null, isPlaying: false, onPlay: () => {} });
		expect(set.find().length).toBe(0);
	});

	it('플레이리스트: 트랙마다 행 데코(비편집) + 제목 위젯(liPos+2) + URL 숨김', () => {
		const d = doc(TWO);
		const tracks = parseMusicNote(d).flatQueue;
		const set = buildMusicDecorations(d, { currentUrl: null, isPlaying: false, onPlay: () => {} });

		// 제목 위젯 — 트랙마다 1개, 첫 문단 안쪽(liPos+2).
		expect(nameWidgets(set).map((w) => w.from).sort(sortNums)).toEqual(tracks.map((t) => t.liPos + 2).sort(sortNums));
		// 라벨 = display(파일명), 마커 = ♪.
		const w0 = nameWidgets(set).find((w) => w.from === tracks[0].liPos + 2)!;
		const dom0 = widgetDom(w0);
		expect(dom0.querySelector('.music-track-label')?.textContent).toBe('1');
		expect(dom0.querySelector('.music-track-mark')?.textContent).toContain('♪');

		// 행 데코 — li 시작 위치마다 music-track + music-track--play + contenteditable=false.
		const rows = spans(set).filter((d) => cls(d)?.split(' ').includes('music-track'));
		expect(rows.map((d) => d.from).sort(sortNums)).toEqual(tracks.map((t) => t.liPos).sort(sortNums));
		for (const row of rows) {
			expect(cls(row)).toContain('music-track--play');
			expect(attr(row, 'contenteditable')).toBe('false'); // 곡 행엔 커서 진입 불가
		}

		// URL 숨김 — 트랙마다 music-row-hide span 데코.
		const hides = spans(set).filter((d) => cls(d)?.split(' ').includes('music-row-hide'));
		expect(hides.length).toBeGreaterThanOrEqual(tracks.length);
	});

	it('중첩(제목+URL) 트랙: 제목 위젯 + 중첩 URL 리스트 숨김', () => {
		const d = doc(NESTED);
		const track = parseMusicNote(d).flatQueue[0];
		const set = buildMusicDecorations(d, { currentUrl: null, isPlaying: false, onPlay: () => {} });
		expect(widgetDom(nameWidgets(set)[0]).querySelector('.music-track-label')?.textContent).toBe('좋은 날');
		const hides = spans(set).filter((d) => cls(d)?.split(' ').includes('music-row-hide'));
		expect(hides.length).toBeGreaterThanOrEqual(1);
		// 적어도 하나의 숨김은 li 본문(첫 문단) 뒤쪽(중첩 리스트)을 덮음.
		expect(hides.some((d) => d.to > track.liPos + 4)).toBe(true);
	});

	it('현재 재생 트랙: 행 데코에 music-track--playing, 마커는 이퀄라이저', () => {
		const d = doc(TWO);
		const tracks = parseMusicNote(d).flatQueue;
		const set = buildMusicDecorations(d, { currentUrl: 'https://h/1.mp3', isPlaying: true, onPlay: () => {} });
		const row0 = spans(set).find((x) => x.from === tracks[0].liPos && cls(x)?.split(' ').includes('music-track'));
		expect(cls(row0!)).toContain('music-track--playing');
		const dom0 = widgetDom(nameWidgets(set).find((w) => w.from === tracks[0].liPos + 2)!);
		expect(dom0.querySelector('.music-track-eq')).toBeTruthy(); // 이퀄라이저가 ♪ 를 대체
		expect(dom0.querySelector('.music-track-mark')?.textContent).not.toContain('♪');
	});

	it('헤더 우측 ▶ — 켜진 플레이리스트마다 1개, music-pl-header 헤더 데코 동반', () => {
		const d = doc(TWO);
		const set = buildMusicDecorations(d, { currentUrl: null, isPlaying: false, onPlay: () => {} });
		expect(plPlayButtons(set).length).toBe(1);
		// 헤더 문단에 music-pl-header 노드 데코.
		const headerPos = parseMusicNote(d).playlists[0].headerPos;
		const headerDeco = spans(set).find((x) => x.from === headerPos && cls(x)?.split(' ').includes('music-pl-header'));
		expect(headerDeco).toBeTruthy();
	});

	it('곡 행 위젯 클릭 → 비현재 트랙은 onPlay(index)', () => {
		const d = doc(TWO);
		const tracks = parseMusicNote(d).flatQueue;
		let played = -1;
		const set = buildMusicDecorations(d, { currentUrl: null, isPlaying: false, onPlay: (i) => { played = i; } });
		const w1 = nameWidgets(set).find((w) => w.from === tracks[1].liPos + 2)!;
		(widgetDom(w1) as HTMLElement).click();
		expect(played).toBe(1);
	});
});

describe('handleTrackButtonClick', () => {
	it('비현재 트랙 클릭 → onPlay(index) 호출', () => {
		let called = -1;
		handleTrackButtonClick({ currentUrl: null, isPlaying: false, onPlay: (i) => { called = i; } }, 1, false);
		expect(called).toBe(1);
	});

	it('현재 트랙 클릭 → toggle(일시정지), onPlay 미호출', () => {
		__resetMusicPlayer();
		musicPlayer.setQueue('test-guid', [
			{ url: 'https://h/1.mp3', title: 'Track 1', display: 'Track 1', liPos: 0 },
			{ url: 'https://h/2.mp3', title: 'Track 2', display: 'Track 2', liPos: 10 }
		]);
		musicPlayer.play(0);
		expect(musicPlayer.isPlaying).toBe(true);

		let onPlayCalled = false;
		handleTrackButtonClick(
			{ currentUrl: 'https://h/1.mp3', isPlaying: true, onPlay: () => { onPlayCalled = true; } },
			0,
			true
		);
		expect(musicPlayer.isPlaying).toBe(false);
		expect(onPlayCalled).toBe(false);
		__resetMusicPlayer();
	});
});

describe('createMusicNotePlugin', () => {
	it('비음악 노트는 decorations null', () => {
		const plugin = createMusicNotePlugin();
		const ed2 = new Editor({
			extensions: [
				StarterKit,
				TomboyUrlLink,
				Extension.create({ name: 'tomboyMusicNoteTest', addProseMirrorPlugins() { return [plugin]; } })
			],
			content: '<p>그냥 노트</p>'
		});
		const decorationsFn = plugin.props.decorations as ((state: unknown) => unknown) | undefined;
		const result = decorationsFn?.(ed2.state);
		ed2.destroy();
		expect(result).toBeNull();
	});

	it('decorations 가 라이브 musicPlayer 상태를 반영(재생 트랙 강조)', () => {
		__resetMusicPlayer();
		doc(TWO);
		const state = ed!.state;
		const plugin = createMusicNotePlugin();
		const decoFn = plugin.props.decorations as (state: unknown) => DecorationSet | null;

		musicPlayer.setQueue('g', parseMusicNote(state.doc).flatQueue);
		musicPlayer.play(0);
		expect(musicPlayer.isPlaying).toBe(true);

		const result = decoFn.call(plugin, state) as DecorationSet | null;
		expect(result).not.toBeNull();
		// 두 트랙 모두 제목 위젯, 재생 트랙(0)은 playing 행 데코.
		expect(nameWidgets(result!).length).toBe(2);
		const tracks = parseMusicNote(state.doc).flatQueue;
		const row0 = spans(result!).find((x) => x.from === tracks[0].liPos && cls(x)?.split(' ').includes('music-track'));
		expect(cls(row0!)).toContain('music-track--playing');
		__resetMusicPlayer();
	});

	it('곡 행 클릭 → 그 노트를 setQueue(guid,name)+play (노트를 활성 큐로)', () => {
		__resetMusicPlayer();
		const plugin = createMusicNotePlugin(() => 'n1');
		doc(TWO);
		const state = ed!.state;
		const tracks = parseMusicNote(state.doc).flatQueue;
		const decoFn = plugin.props.decorations as (s: unknown) => DecorationSet | null;
		const set = decoFn.call(plugin, state)!;
		const w1 = nameWidgets(set).find((w) => w.from === tracks[1].liPos + 2)!;
		(widgetDom(w1) as HTMLElement).click();
		expect(musicPlayer.activeNoteGuid).toBe('n1');
		expect(musicPlayer.queue.length).toBe(2);
		expect(musicPlayer.currentTrack?.url).toBe('https://h/2.mp3');
		expect(musicPlayer.isPlaying).toBe(true);
		__resetMusicPlayer();
	});

	it('두 번째 플레이리스트 헤더 ▶ 클릭 → 그 플레이리스트 첫 곡(flat index) 부터 재생', () => {
		__resetMusicPlayer();
		const plugin = createMusicNotePlugin(() => 'n1');
		doc(TWOPL);
		const state = ed!.state;
		const decoFn = plugin.props.decorations as (s: unknown) => DecorationSet | null;
		const set = decoFn.call(plugin, state)!;
		const btns = plPlayButtons(set);
		expect(btns.length).toBe(2);
		// 두 번째 헤더 버튼(문서상 더 뒤) → 두 번째 플레이리스트 첫 곡 = flat index 1 = https://h/2.mp3.
		const second = btns.sort((a, b) => a.from - b.from)[1];
		(widgetDom(second) as HTMLButtonElement).click();
		expect(musicPlayer.queue.length).toBe(3);
		expect(musicPlayer.currentIndex).toBe(1);
		expect(musicPlayer.currentTrack?.url).toBe('https://h/2.mp3');
		expect(musicPlayer.isPlaying).toBe(true);
		__resetMusicPlayer();
	});
});
