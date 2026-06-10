// 앱 전역 단일 오디오 엔진.
//
// musicPlayer(싱글톤 룬 스토어)를 구동원으로 단 하나의 HTMLAudioElement 만 재생한다.
// 음악 노트 패널(MusicPlayerBar)은 순수 뷰 — 여러 패널/창이 떠 있어도 소리는 하나다.
// +layout 에서 1회 설치(installMusicAudio)하며, 모바일/데스크탑(chromeless) 양쪽을 덮는다.
//
// <audio> 를 DOM 에 붙이지 않고 new Audio() 로 만든다(재생에 DOM 부착 불필요).
import { untrack } from 'svelte';
import { musicPlayer } from './musicPlayer.svelte.js';
import { pushToast } from '$lib/stores/toast.js';
import {
	isMediaSessionSupported,
	buildMetadataInit,
	installMediaSession,
	syncMediaSession
} from './mediaSession.js';

const MEDIA_ERR_NAMES = ['', 'ABORTED', 'NETWORK', 'DECODE', 'SRC_NOT_SUPPORTED'];

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
 * 사용자 제스처(탭/클릭) 안에서 동기적으로 호출해야 하는 재생 시작 훅.
 *
 * 모바일 브라우저(특히 iOS Safari)는 오디오 재생을 "사용자 제스처와 같은 동기
 * 실행 구간"에서 시작할 때만 허용한다. 스토어 상태(isPlaying)만 바꾸고 실제
 * play() 를 $effect 에서 한 틱 뒤에 호출하면 제스처 밖이라 차단되어 — 재생
 * 버튼을 눌러도 소리가 안 나고 0:00 에 멈춰 보인다(데스크탑은 허용해서 동작).
 *
 * 그래서 재생 버튼 onclick(=제스처) 에서 스토어를 갱신한 직후 이 함수를 동기로
 * 호출한다. 현재 트랙 src 를 즉시 맞추고 그 자리에서 play() 를 호출해 엘리먼트를
 * 잠금 해제하면, 이후 자동 넘김(onEnded→next)의 effect-기반 play() 도 통과한다.
 * 멱등 — src 가 이미 맞으면 다시 설정하지 않고, 재생 중이면 play() 는 no-op.
 */
export function resumePlaybackFromGesture(): void {
	const audio = audioEl;
	if (!audio) return;
	const url = musicPlayer.currentTrack?.url ?? '';
	if (!url) return;
	if ((audio.getAttribute('src') ?? '') !== url) audio.src = url;
	void audio.play().catch(() => {});
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

	// iOS 자동재생 잠금 추적. 사용자 제스처로 재생이 한 번이라도 *실제로* 시작되면
	// ('playing' 이벤트) 엘리먼트가 풀려 이후 프로그램적 play() 가 허용된다. 그 전까지는
	// 제스처 밖 play() 가 차단된다. onError 의 자동 스킵 여부를 이 플래그로 가른다.
	let unlocked = false;
	const onPlaying = () => {
		unlocked = true;
	};
	const onTime = () => musicPlayer.reportTime(audio.currentTime || 0);
	const onMeta = () => musicPlayer.reportDuration(audio.duration || 0);
	const onEnded = () => musicPlayer.reportEnded();
	const onError = () => {
		// 자동 스킵 전에 "왜" 를 노출 — 모바일은 콘솔을 못 보므로 토스트로.
		// (조용히 next() 하면 곡이 그냥 사라져 디버그가 불가능.)
		const e = audio.error;
		const code = e?.code ?? 0;
		const name = MEDIA_ERR_NAMES[code] ?? `code${code}`;
		const src = audio.currentSrc || audio.getAttribute('src') || '';
		const tail = src.replace(/^https?:\/\/[^/]+/, '').slice(-72);
		console.error('[music] audio error', {
			code,
			name,
			message: e?.message,
			networkState: audio.networkState,
			readyState: audio.readyState,
			src
		});
		pushToast(`재생 실패 ⟨${name}⟩ ${tail}`, { kind: 'error', timeoutMs: 9000 });
		// 큐 연쇄 붕괴 방지: 엘리먼트가 아직 잠겨 있으면(제스처 재생 성공 전) 자동
		// 스킵하지 않는다. iOS 에서 첫 곡이 에러나면 next() → 다음 곡 play() 도 제스처
		// 밖이라 막히고, 그게 또 에러로 보여 줄줄이 스킵되며 큐 전체가 무너진다(첫 곡
		// 실패 → "전부 그냥 스킵"). 잠금 해제 후의 에러만 죽은 링크 스킵으로 안전하게 넘긴다.
		if (unlocked) musicPlayer.next();
		else musicPlayer.pause();
	};
	audio.addEventListener('playing', onPlaying);
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
			// 이어듣기: 저장된 위치가 있으면 메타데이터 로드 후 그 지점으로 seek 한다. resumeAt 은
			// untrack 으로 읽어 이 effect 의 의존성에 넣지 않는다(중복 재실행 방지). 1회성 리스너라
			// 자연스러운 다음 곡 전환(resumeAt 미설정)엔 영향 없다.
			const at = untrack(() => musicPlayer.resumeAt);
			if (at > 0) {
				const onMetaSeek = () => {
					const tgt = musicPlayer.takeResumeAt();
					if (tgt > 0) audio.currentTime = tgt;
					audio.removeEventListener('loadedmetadata', onMetaSeek);
				};
				audio.addEventListener('loadedmetadata', onMetaSeek);
			}
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
		audio.removeEventListener('playing', onPlaying);
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
