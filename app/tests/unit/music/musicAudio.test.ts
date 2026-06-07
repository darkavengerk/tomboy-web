import { describe, it, expect, afterEach, beforeAll, beforeEach } from 'vitest';
import { flushSync } from 'svelte';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMediaSession } from '$lib/music/mediaSession.js';
import {
	installMusicAudio,
	__musicAudioForTest,
	resumePlaybackFromGesture
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

	// iOS 자동재생 잠금: 제스처로 한 번도 재생 못 한 상태에서 에러가 나면 자동 스킵하면
	// 안 된다(다음 곡 play() 도 막혀 큐 전체가 줄줄이 무너짐). 멈추고 에러만 노출.
	it('잠금 상태(playing 전) 에러 → 자동 스킵 안 하고 멈춤(큐 연쇄 붕괴 방지)', () => {
		musicPlayer.setQueue('g', [T('https://h/a.mp3', 'a'), T('https://h/b.mp3', 'b')], 'pl');
		musicPlayer.play(0);
		flushSync();
		const audio = __musicAudioForTest().audio!;
		audio.dispatchEvent(new Event('error'));
		flushSync();
		expect(musicPlayer.currentIndex).toBe(0); // 다음 곡으로 안 넘어감
		expect(musicPlayer.isPlaying).toBe(false); // 멈춤
	});

	// 한 곡이라도 제스처로 재생되어 엘리먼트가 풀리면(playing) 이후 에러는 죽은 링크
	// 스킵으로 안전 — 정상 곡 재생 중 깨진 곡을 만나면 다음으로 넘어가야 한다.
	it('잠금 해제 후(playing) 에러 → 다음 곡으로 스킵', () => {
		musicPlayer.setQueue('g', [T('https://h/a.mp3', 'a'), T('https://h/b.mp3', 'b')], 'pl');
		musicPlayer.play(0);
		flushSync();
		const audio = __musicAudioForTest().audio!;
		audio.dispatchEvent(new Event('playing')); // 잠금 해제
		audio.dispatchEvent(new Event('error'));
		flushSync();
		expect(musicPlayer.currentIndex).toBe(1); // 죽은 링크 스킵
		expect(musicPlayer.isPlaying).toBe(true);
	});

	// 재생 src 는 노트의 원본 URL 을 그대로 넘긴다(URL 재작성 없음 — 브릿지 곡 재생
	// 실패의 진짜 원인은 URL 이 아니라 임베디드 커버였고, music-service 에서 제거됨).
	it('재생 시 트랙 url 을 그대로 audio.src 로 넘긴다(재작성 없음)', () => {
		const u = '737140b8-2cca-40c1-b2bf-a901e5999a6f';
		const url = `https://br.test/files/${u}/CHUNG 'Snapping' (live).mp3`;
		musicPlayer.setQueue('g', [T(url, 'x')], 'pl');
		musicPlayer.play(0);
		resumePlaybackFromGesture();
		expect(playSrcs.at(-1)).toBe(url);
		expect(__musicAudioForTest().audio?.getAttribute('src')).toBe(url);
	});
});
