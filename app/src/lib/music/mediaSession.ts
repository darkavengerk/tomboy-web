// Media Session API 연동 — 잠금화면 컨트롤·메타데이터·백그라운드 생존.
// 순수 매핑(buildMetadataInit) + 얇은 설치자(installMediaSession) + 동기화(syncMediaSession).
// navigator.mediaSession 외엔 어떤 룬 스토어도 건드리지 않으므로 effect 자기-구독 루프 위험이 없다.
// 미지원/예외 환경에서도 일반 재생은 불변하도록 모든 호출을 지원 가드 + try/catch 로 감싼다.

export interface MetaSource {
	trackDisplay: string;
	playlistLabel: string;
	noteName: string;
}

export interface MediaSessionHandlers {
	play(): void;
	pause(): void;
	next(): void;
	prev(): void;
	seekTo(time: number): void;
}

export interface SyncState {
	metaInit: MediaMetadataInit | null;
	isPlaying: boolean;
	duration: number;
	position: number;
}

const ARTWORK: MediaImage[] = [
	{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
	{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
];

export function isMediaSessionSupported(): boolean {
	return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

/** 순수 — 트랙/플레이리스트/노트 제목 → MediaMetadata 초기화 객체. */
export function buildMetadataInit(src: MetaSource): MediaMetadataInit {
	return {
		title: src.trackDisplay,
		artist: src.playlistLabel,
		album: src.noteName,
		artwork: ARTWORK
	};
}

// metadata 는 키(title/artist/album)가 바뀔 때만 재생성한다 — 매 timeupdate 마다 잠금화면이
// 깜빡이지 않도록. 모듈 싱글톤(navigator.mediaSession 도 하나뿐)이라 모듈 변수로 충분.
let lastMetaKey: string | null = null;

/** 테스트 전용 — diff 캐시 초기화. */
export function __resetMediaSession(): void {
	lastMetaKey = null;
}

function metaKey(init: MediaMetadataInit | null): string | null {
	if (!init) return null;
	return `${init.title ?? ''} ${init.artist ?? ''} ${init.album ?? ''}`;
}

/** 잠금화면 컨트롤 핸들러 등록. 반환값은 uninstall. 미지원이면 no-op + 빈 uninstall. */
export function installMediaSession(h: MediaSessionHandlers): () => void {
	if (!isMediaSessionSupported()) return () => {};
	const ms = navigator.mediaSession;
	const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
		try {
			ms.setActionHandler(action, handler);
		} catch {
			/* 미지원 액션 — 무시 */
		}
	};
	set('play', () => h.play());
	set('pause', () => h.pause());
	set('nexttrack', () => h.next());
	set('previoustrack', () => h.prev());
	set('seekto', (details) => {
		if (typeof details.seekTime === 'number') h.seekTo(details.seekTime);
	});
	return () => {
		set('play', null);
		set('pause', null);
		set('nexttrack', null);
		set('previoustrack', null);
		set('seekto', null);
		try {
			ms.metadata = null;
		} catch {
			/* 무시 */
		}
		lastMetaKey = null;
	};
}

/** 잠금화면 상태 동기화. metadata 는 diff 로 변할 때만 재생성. */
export function syncMediaSession(state: SyncState): void {
	if (!isMediaSessionSupported()) return;
	const ms = navigator.mediaSession;

	const key = metaKey(state.metaInit);
	if (key !== lastMetaKey) {
		try {
			ms.metadata = state.metaInit ? new MediaMetadata(state.metaInit) : null;
			lastMetaKey = key;
		} catch {
			/* 무시 */
		}
	}

	// playbackState 쓰기도 부분 구현 브라우저에서 throw 할 수 있어 가드.
	try {
		ms.playbackState = state.metaInit ? (state.isPlaying ? 'playing' : 'paused') : 'none';
	} catch {
		/* 무시 */
	}

	if (state.duration > 0 && Number.isFinite(state.duration)) {
		const position = Math.max(0, Math.min(state.position, state.duration));
		try {
			ms.setPositionState({ duration: state.duration, position, playbackRate: 1 });
		} catch {
			/* 무시 */
		}
	}
}
