import { describe, it, expect, afterEach, beforeAll, beforeEach } from 'vitest';
import { flushSync } from 'svelte';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMediaSession } from '$lib/music/mediaSession.js';
import {
	installMusicAudio,
	__musicAudioForTest,
	resumePlaybackFromGesture,
	toPlayableSrc
} from '$lib/music/musicAudio.svelte.js';
import type { MusicTrack } from '$lib/music/parseMusicNote.js';

// jsdom 은 미디어 재생 미구현 → 기록형 stub.
let playSrcs: string[] = [];
const msHandlers: Record<string, ((d?: unknown) => void) | null> = {};

beforeAll(() => {
	const def = (name: string, value: unknown) =>
		Object.defineProperty(HTMLMediaElement.prototype, name, { value, configurable: true });
	def('play', function (this: HTMLMediaElement) {
		playSrcs.push(this.getAttribute('src') ?? '');
		return Promise.resolve();
	});
	def('pause', () => {});
	def('load', () => {});
	Object.defineProperty(navigator, 'mediaSession', {
		value: {
			metadata: null as { title: string; artist: string; album: string } | null,
			playbackState: 'none',
			setActionHandler(action: string, handler: ((d?: unknown) => void) | null) {
				msHandlers[action] = handler;
			},
			setPositionState() {}
		},
		configurable: true
	});
	(globalThis as unknown as { MediaMetadata: unknown }).MediaMetadata = class {
		title: string;
		artist: string;
		album: string;
		constructor(init: { title?: string; artist?: string; album?: string }) {
			this.title = init.title ?? '';
			this.artist = init.artist ?? '';
			this.album = init.album ?? '';
		}
	};
});

const T = (url: string, display: string, playlistLabel = ''): MusicTrack => ({
	url,
	title: null,
	display,
	liPos: 0,
	playlistLabel
});

let uninstall = () => {};
beforeEach(() => {
	playSrcs = [];
	__resetMusicPlayer();
	__resetMediaSession();
	uninstall = installMusicAudio();
});
afterEach(() => {
	uninstall();
	const ms = navigator.mediaSession as unknown as { metadata: unknown; playbackState: string };
	ms.metadata = null;
	ms.playbackState = 'none';
	for (const k of Object.keys(msHandlers)) delete msHandlers[k];
});

describe('musicAudio 엔진 — 단일 오디오', () => {
	it('현재 트랙 url 을 audio.src 로 동기화(재생 안 했으면 play 안 함)', () => {
		musicPlayer.setQueue('g', [T('https://h/a.mp3', 'a')], '드라이브'); // 인덱스 0 큐(일시정지)
		flushSync();
		expect(__musicAudioForTest().audio?.getAttribute('src')).toBe('https://h/a.mp3');
		expect(playSrcs).toEqual([]);
	});

	it('play → 현재 src 로 재생', () => {
		musicPlayer.setQueue('g', [T('https://h/a.mp3', 'a')], '드라이브');
		musicPlayer.play(0);
		flushSync();
		expect(playSrcs.at(-1)).toBe('https://h/a.mp3');
	});

	it('곡이 끝나면 자동 넘김 + 새 src 로 재생을 이어준다', () => {
		musicPlayer.setQueue('g', [T('https://h/a.mp3', 'a'), T('https://h/b.mp3', 'b')], '드라이브');
		musicPlayer.play(0);
		flushSync();
		const audio = __musicAudioForTest().audio!;
		expect(audio.getAttribute('src')).toBe('https://h/a.mp3');

		audio.dispatchEvent(new Event('ended'));
		flushSync();
		expect(musicPlayer.currentIndex).toBe(1);
		expect(musicPlayer.isPlaying).toBe(true);
		expect(audio.getAttribute('src')).toBe('https://h/b.mp3');
		expect(playSrcs.at(-1)).toBe('https://h/b.mp3');
	});

	it('다음 곡을 preload 엘리먼트에 데움, 마지막 곡이면 비움', () => {
		musicPlayer.setQueue('g', [T('https://h/a.mp3', 'a'), T('https://h/b.mp3', 'b')], '드라이브');
		musicPlayer.play(0);
		flushSync();
		expect(__musicAudioForTest().preload?.getAttribute('src')).toBe('https://h/b.mp3');

		musicPlayer.play(1); // 마지막
		flushSync();
		expect(__musicAudioForTest().preload?.getAttribute('src')).toBeNull();
	});

	it('잠금화면 메타데이터/상태 반영 (title/artist/album + playing)', () => {
		musicPlayer.setQueue('g', [T('https://h/a.mp3', 'a', '아침')], '드라이브');
		musicPlayer.play(0);
		flushSync();
		const ms = navigator.mediaSession as unknown as {
			metadata: { title: string; artist: string; album: string } | null;
			playbackState: string;
		};
		expect(ms.metadata?.title).toBe('a');
		expect(ms.metadata?.artist).toBe('아침');
		expect(ms.metadata?.album).toBe('드라이브');
		expect(ms.playbackState).toBe('playing');
	});

	it('잠금화면 play/pause 핸들러가 스토어를 구동', () => {
		musicPlayer.setQueue('g', [T('https://h/a.mp3', 'a')], '드라이브');
		musicPlayer.play(0);
		musicPlayer.reportTime(5);
		flushSync();
		msHandlers['pause']?.();
		flushSync();
		expect(musicPlayer.isPlaying).toBe(false);
		msHandlers['play']?.();
		flushSync();
		expect(musicPlayer.isPlaying).toBe(true);
		expect(musicPlayer.currentTime).toBe(5);
		expect(musicPlayer.currentIndex).toBe(0);
	});

	it('중복 설치해도 같은 teardown(이중 오디오 방지)', () => {
		const again = installMusicAudio();
		expect(again).toBe(uninstall);
	});

	// 모바일 자동재생 차단 회피 — 재생은 반드시 제스처와 같은 동기 구간에서 시작돼야
	// 한다. resumePlaybackFromGesture 는 effect(flushSync) 를 기다리지 않고 그 자리에서
	// src 를 맞추고 play() 한다.
	it('resumePlaybackFromGesture — effect 대기 없이 현재 트랙을 즉시 play', () => {
		musicPlayer.setQueue('g', [T('https://h/a.mp3', 'a')], '드라이브');
		musicPlayer.play(0);
		// flushSync 하지 않음 = 제스처 안(아직 effect 미실행) 시뮬레이션.
		expect(playSrcs).toEqual([]);
		resumePlaybackFromGesture();
		expect(playSrcs.at(-1)).toBe('https://h/a.mp3');
	});

	it('resumePlaybackFromGesture — 재생할 트랙이 없으면 no-op', () => {
		resumePlaybackFromGesture();
		expect(playSrcs).toEqual([]);
	});

	// WebKit 은 파일명에서 온 일부 문자가 src URL 에 있으면 SRC_NOT_SUPPORTED 로 거부
	// (FF/Chrome 은 같은 URL 재생). 브릿지 URL 은 깨끗한 고정 파일명으로 다시 써서 넘긴다.
	it('재생 시 브릿지 URL 은 깨끗한 파일명으로 다시 써서 audio.src 로 넘긴다', () => {
		const u = '737140b8-2cca-40c1-b2bf-a901e5999a6f';
		musicPlayer.setQueue(
			'g',
			[T(`https://br.test/files/${u}/CHUNG 'Snapping' (live).mp3`, 'x')],
			'pl'
		);
		musicPlayer.play(0);
		resumePlaybackFromGesture();
		expect(playSrcs.at(-1)).toBe(`https://br.test/files/${u}/audio.mp3`);
		expect(__musicAudioForTest().audio?.getAttribute('src')).toBe(
			`https://br.test/files/${u}/audio.mp3`
		);
	});
});

describe('toPlayableSrc', () => {
	const U = '737140b8-2cca-40c1-b2bf-a901e5999a6f';
	it('rewrites bridge /files/<uuid>/<name> to a clean fixed filename (any char)', () => {
		expect(toPlayableSrc(`https://br.test/files/${U}/CHUNG 'Snapping' (live)!.mp3`)).toBe(
			`https://br.test/files/${U}/audio.mp3`
		);
	});
	it('preserves the original extension', () => {
		expect(toPlayableSrc(`https://br.test/files/${U}/x(y).m4a`)).toBe(
			`https://br.test/files/${U}/audio.m4a`
		);
	});
	it('leaves non-bridge URLs untouched (internet direct links)', () => {
		expect(toPlayableSrc("https://cdn.example.com/a/b'c (d).mp3")).toBe(
			"https://cdn.example.com/a/b'c (d).mp3"
		);
	});
});
