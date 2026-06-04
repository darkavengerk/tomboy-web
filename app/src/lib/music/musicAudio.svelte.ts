// 앱 전역 단일 오디오 엔진.
//
// musicPlayer(싱글톤 룬 스토어)를 구동원으로 단 하나의 HTMLAudioElement 만 재생한다.
// 음악 노트 패널(MusicPlayerBar)은 순수 뷰 — 여러 패널/창이 떠 있어도 소리는 하나다.
// +layout 에서 1회 설치(installMusicAudio)하며, 모바일/데스크탑(chromeless) 양쪽을 덮는다.
//
// <audio> 를 DOM 에 붙이지 않고 new Audio() 로 만든다(재생에 DOM 부착 불필요).
import { untrack } from 'svelte';
import { musicPlayer } from './musicPlayer.svelte.js';
import {
	isMediaSessionSupported,
	buildMetadataInit,
	installMediaSession,
	syncMediaSession
} from './mediaSession.js';

let audioEl: HTMLAudioElement | null = null;
let preloadEl: HTMLAudioElement | null = null;
let teardown: (() => void) | null = null;

/** 테스트 전용 — 엔진 내부 오디오 엘리먼트 접근. */
export function __musicAudioForTest(): {
	audio: HTMLAudioElement | null;
	preload: HTMLAudioElement | null;
} {
	return { audio: audioEl, preload: preloadEl };
}

/**
 * 전역 오디오 엔진 설치. 반환값은 uninstall.
 * 싱글톤 — 중복 호출 시 기존 teardown 을 그대로 돌려준다(이중 오디오 방지).
 */
export function installMusicAudio(): () => void {
	if (typeof document === 'undefined') return () => {};
	if (teardown) return teardown;

	const audio = new Audio();
	audio.preload = 'metadata';
	const preload = new Audio();
	preload.preload = 'auto';
	preload.muted = true;
	audioEl = audio;
	preloadEl = preload;

	const onTime = () => musicPlayer.reportTime(audio.currentTime || 0);
	const onMeta = () => musicPlayer.reportDuration(audio.duration || 0);
	const onEnded = () => musicPlayer.reportEnded();
	const onError = () => musicPlayer.next();
	audio.addEventListener('timeupdate', onTime);
	audio.addEventListener('loadedmetadata', onMeta);
	audio.addEventListener('ended', onEnded);
	audio.addEventListener('error', onError);

	const stop = $effect.root(() => {
		// src 동기화. 트랙이 바뀌면(특히 자동 넘김) 새 src 로 재생을 이어준다.
		$effect(() => {
			const url = musicPlayer.currentTrack?.url ?? '';
			if ((audio.getAttribute('src') ?? '') === url) return;
			if (!url) {
				audio.removeAttribute('src');
				return;
			}
			audio.src = url;
			// 자동 넘김은 isPlaying 을 true 로 둔 채 src 만 바꾼다 → 여기서 직접 이어 재생.
			if (untrack(() => musicPlayer.isPlaying)) void audio.play().catch(() => {});
		});
		// 재생/일시정지.
		$effect(() => {
			if (musicPlayer.isPlaying) void audio.play().catch(() => {});
			else audio.pause();
		});
		// seek 요청 적용.
		$effect(() => {
			musicPlayer.seekToken; // subscribe
			const target = musicPlayer.pendingSeekTime;
			if (Math.abs((audio.currentTime || 0) - target) > 0.25) audio.currentTime = target;
		});
		// 다음 곡 프리로드 — preload 는 절대 play 하지 않는다(HTTP 캐시 워밍 전용).
		$effect(() => {
			const url = musicPlayer.queue[musicPlayer.currentIndex + 1]?.url ?? '';
			if ((preload.getAttribute('src') ?? '') === url) return;
			if (url) preload.src = url;
			else preload.removeAttribute('src');
		});
		// 잠금화면 메타데이터·재생상태·위치 동기화.
		$effect(() => {
			if (!isMediaSessionSupported()) return;
			const t = musicPlayer.currentTrack;
			const metaInit = t
				? buildMetadataInit({
						trackDisplay: t.display,
						playlistLabel: t.playlistLabel ?? '',
						noteName: musicPlayer.activeNoteName
					})
				: null;
			syncMediaSession({
				metaInit,
				isPlaying: musicPlayer.isPlaying,
				duration: musicPlayer.duration,
				position: musicPlayer.currentTime
			});
		});
	});

	// 잠금화면 컨트롤 핸들러(1회). 호출 시점에 스토어를 읽으므로 재설치 불필요.
	const uninstallMs = isMediaSessionSupported()
		? installMediaSession({
				play: () => musicPlayer.play(musicPlayer.currentIndex < 0 ? 0 : musicPlayer.currentIndex),
				pause: () => musicPlayer.pause(),
				next: () => musicPlayer.next(),
				prev: () => musicPlayer.prev(),
				seekTo: (t) => musicPlayer.requestSeek(t)
			})
		: () => {};

	teardown = () => {
		stop();
		uninstallMs();
		audio.pause();
		audio.removeEventListener('timeupdate', onTime);
		audio.removeEventListener('loadedmetadata', onMeta);
		audio.removeEventListener('ended', onEnded);
		audio.removeEventListener('error', onError);
		audioEl = null;
		preloadEl = null;
		teardown = null;
	};
	return teardown;
}
