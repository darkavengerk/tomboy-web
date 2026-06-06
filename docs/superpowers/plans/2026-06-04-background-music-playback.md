# 잠금화면 백그라운드 음악 재생 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 음악 노트 재생 중 폰 화면을 꺼도 재생이 끊기지 않고, OS 잠금화면에 곡 정보 + 재생/일시정지/이전/다음/탐색 컨트롤을 띄우며, 한 곡이 끝나면 잠금 상태에서도 다음 곡으로 자동으로 넘어간다.

**Architecture:** Media Session API 배선을 `lib/music/mediaSession.ts` 모듈(순수 매핑 + 얇은 설치자 + 동기화)로 분리하고, `MusicPlayerBar.svelte`가 `$effect` 3개로 이를 배선한다(다음 곡 프리로드용 숨김 `<audio>` 포함). 잠금화면 범위(전역 미니플레이어 아님), 프리로드만(오프라인 blob 캐시 아님).

**Tech Stack:** SvelteKit, Svelte 5 runes(`$state`/`$derived`/`$effect`), Web Media Session API, vitest + @testing-library/svelte.

**Spec:** `docs/superpowers/specs/2026-06-04-background-music-playback-design.md`

---

## File Structure

| 파일 | 책임 |
|---|---|
| `app/src/lib/music/mediaSession.ts` | (신규) Media Session 순수 매핑(`buildMetadataInit`) + 설치자(`installMediaSession`) + 동기화(`syncMediaSession`) + 지원 가드 + 테스트용 리셋. `navigator.mediaSession` 외 어떤 룬 스토어도 안 건드림. |
| `app/tests/unit/music/mediaSession.test.ts` | (신규) 위 모듈 단위 테스트(jsdom stub). |
| `app/src/lib/music/musicPlayer.svelte.ts` | (수정) `pause()` 메서드 추가. |
| `app/tests/unit/music/musicPlayer.test.ts` | (수정) `pause()` 케이스 추가. |
| `app/src/lib/editor/musicNote/MusicPlayerBar.svelte` | (수정) 프리로드 `<audio>` + `$effect` 3개(preload / install / sync) 배선. |
| `app/tests/unit/music/MusicPlayerBar.test.ts` | (수정) media-session/preload 테스트 + jsdom stub 추가. |
| `app/src/routes/settings/+page.svelte` | (수정) `설정 → 가이드 → 환경/호환성` env 탭에 guide-card 추가. |

**의존성:** Task 3 ← (Task 1, Task 2). Task 4 ← Task 3.

---

## Task 1: `mediaSession.ts` 모듈 (순수 매핑 + 설치자 + 동기화)

**Goal:** `navigator.mediaSession`을 다루는 순수·테스트 가능한 모듈을 만든다. 룬 스토어와 무관하게 콜백/상태만 받는다.

**Files:**
- Create: `app/src/lib/music/mediaSession.ts`
- Test: `app/tests/unit/music/mediaSession.test.ts`

**Acceptance Criteria:**
- [ ] `buildMetadataInit`가 `trackDisplay→title`, `playlistLabel→artist`, `noteName→album`, 앱 아이콘 → `artwork`로 매핑한다.
- [ ] `syncMediaSession`이 `isPlaying`→`playbackState`('playing'/'paused'), 트랙 없음→'none'로 설정한다.
- [ ] `syncMediaSession`이 메타데이터를 키(title/artist/album) 변경 시에만 `new MediaMetadata`로 재생성한다(position만 바뀌면 재생성 안 함).
- [ ] `syncMediaSession`이 `duration<=0`이면 `setPositionState`를 호출하지 않고, 유효하면 position을 `[0,duration]`로 clamp한다.
- [ ] `installMediaSession`이 play/pause/nexttrack/previoustrack/seekto 핸들러를 콜백에 연결하고, uninstall이 핸들러를 null로 정리한다.
- [ ] `mediaSession` 미지원 환경에서 모든 export가 throw 없이 no-op이다.

**Verify:** `cd app && npx vitest run tests/unit/music/mediaSession.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/music/mediaSession.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	isMediaSessionSupported,
	buildMetadataInit,
	installMediaSession,
	syncMediaSession,
	__resetMediaSession
} from '$lib/music/mediaSession.js';

interface FakeSession {
	metadata: { title: string; artist: string; album: string } | null;
	playbackState: string;
	handlers: Record<string, ((d?: unknown) => void) | null>;
	positionStates: Array<{ duration: number; position: number; playbackRate: number }>;
	setActionHandler(a: string, h: ((d?: unknown) => void) | null): void;
	setPositionState(s: { duration: number; position: number; playbackRate: number }): void;
}

let session: FakeSession;
let metaCtorCount = 0;

function makeSession(): FakeSession {
	return {
		metadata: null,
		playbackState: 'none',
		handlers: {},
		positionStates: [],
		setActionHandler(a, h) {
			this.handlers[a] = h;
		},
		setPositionState(s) {
			this.positionStates.push(s);
		}
	};
}

beforeEach(() => {
	session = makeSession();
	metaCtorCount = 0;
	Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true });
	(globalThis as unknown as { MediaMetadata: unknown }).MediaMetadata = class {
		title: string;
		artist: string;
		album: string;
		artwork: unknown;
		constructor(init: { title?: string; artist?: string; album?: string; artwork?: unknown }) {
			this.title = init.title ?? '';
			this.artist = init.artist ?? '';
			this.album = init.album ?? '';
			this.artwork = init.artwork ?? [];
			metaCtorCount++;
		}
	};
	__resetMediaSession();
});

afterEach(() => {
	delete (navigator as unknown as { mediaSession?: unknown }).mediaSession;
	delete (globalThis as unknown as { MediaMetadata?: unknown }).MediaMetadata;
	__resetMediaSession();
});

const meta = (trackDisplay: string, playlistLabel = '', noteName = 'n') =>
	buildMetadataInit({ trackDisplay, playlistLabel, noteName });

describe('mediaSession.buildMetadataInit', () => {
	it('maps track/playlist/note to title/artist/album/artwork', () => {
		const init = buildMetadataInit({ trackDisplay: 'a', playlistLabel: '길', noteName: '드라이브' });
		expect(init.title).toBe('a');
		expect(init.artist).toBe('길');
		expect(init.album).toBe('드라이브');
		expect(Array.isArray(init.artwork)).toBe(true);
		expect(init.artwork?.[0]?.src).toBe('/icons/icon-192.png');
	});
});

describe('mediaSession.syncMediaSession', () => {
	it('sets playbackState from isPlaying', () => {
		syncMediaSession({ metaInit: meta('a'), isPlaying: true, duration: 100, position: 5 });
		expect(session.playbackState).toBe('playing');
		syncMediaSession({ metaInit: meta('a'), isPlaying: false, duration: 100, position: 5 });
		expect(session.playbackState).toBe('paused');
	});

	it('sets playbackState none when there is no track', () => {
		syncMediaSession({ metaInit: null, isPlaying: false, duration: 0, position: 0 });
		expect(session.playbackState).toBe('none');
	});

	it('rebuilds metadata only when the meta key changes', () => {
		syncMediaSession({ metaInit: meta('a'), isPlaying: true, duration: 100, position: 1 });
		syncMediaSession({ metaInit: meta('a'), isPlaying: true, duration: 100, position: 2 });
		expect(metaCtorCount).toBe(1); // position change → no rebuild
		syncMediaSession({ metaInit: meta('b'), isPlaying: true, duration: 100, position: 0 });
		expect(metaCtorCount).toBe(2); // new track → rebuild
	});

	it('skips setPositionState when duration <= 0', () => {
		syncMediaSession({ metaInit: meta('a'), isPlaying: true, duration: 0, position: 0 });
		expect(session.positionStates.length).toBe(0);
	});

	it('clamps position into [0, duration]', () => {
		syncMediaSession({ metaInit: meta('a'), isPlaying: true, duration: 100, position: 250 });
		expect(session.positionStates.at(-1)).toEqual({ duration: 100, position: 100, playbackRate: 1 });
	});
});

describe('mediaSession.installMediaSession', () => {
	it('wires handlers to callbacks and uninstall clears them', () => {
		const calls: string[] = [];
		const uninstall = installMediaSession({
			play: () => calls.push('play'),
			pause: () => calls.push('pause'),
			next: () => calls.push('next'),
			prev: () => calls.push('prev'),
			seekTo: (t) => calls.push('seek:' + t)
		});
		session.handlers['play']?.();
		session.handlers['pause']?.();
		session.handlers['nexttrack']?.();
		session.handlers['previoustrack']?.();
		session.handlers['seekto']?.({ seekTime: 12 });
		expect(calls).toEqual(['play', 'pause', 'next', 'prev', 'seek:12']);
		uninstall();
		expect(session.handlers['play']).toBeNull();
		expect(session.handlers['seekto']).toBeNull();
	});
});

describe('mediaSession — unsupported environment', () => {
	it('is a no-op when navigator.mediaSession is absent', () => {
		delete (navigator as unknown as { mediaSession?: unknown }).mediaSession;
		expect(isMediaSessionSupported()).toBe(false);
		expect(() =>
			syncMediaSession({ metaInit: null, isPlaying: false, duration: 0, position: 0 })
		).not.toThrow();
		const uninstall = installMediaSession({
			play() {},
			pause() {},
			next() {},
			prev() {},
			seekTo() {}
		});
		expect(() => uninstall()).not.toThrow();
	});
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd app && npx vitest run tests/unit/music/mediaSession.test.ts`
Expected: FAIL — `$lib/music/mediaSession.js` 모듈 없음 (Cannot find module / import error).

- [ ] **Step 3: 모듈 구현** — `app/src/lib/music/mediaSession.ts`

```ts
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
	return `${init.title ?? ''} ${init.artist ?? ''} ${init.album ?? ''}`;
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
		lastMetaKey = key;
		try {
			ms.metadata = state.metaInit ? new MediaMetadata(state.metaInit) : null;
		} catch {
			/* 무시 */
		}
	}

	ms.playbackState = state.metaInit ? (state.isPlaying ? 'playing' : 'paused') : 'none';

	if (state.duration > 0 && Number.isFinite(state.duration)) {
		const position = Math.max(0, Math.min(state.position, state.duration));
		try {
			ms.setPositionState({ duration: state.duration, position, playbackRate: 1 });
		} catch {
			/* 무시 */
		}
	}
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/music/mediaSession.test.ts`
Expected: PASS (모든 케이스).

- [ ] **Step 5: 타입 체크**

Run: `cd app && npm run check`
Expected: 0 errors (기존 a11y 경고는 무관).

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/music/mediaSession.ts app/tests/unit/music/mediaSession.test.ts
git commit -m "feat(music): Media Session 매핑·설치자·동기화 모듈 추가"
```

---

## Task 2: `musicPlayer.pause()` 메서드

**Goal:** 잠금화면 'pause' 핸들러가 호출할, 인덱스를 바꾸지 않고 재생만 멈추는 `pause()`를 스토어에 추가한다.

**Files:**
- Modify: `app/src/lib/music/musicPlayer.svelte.ts` (현재 `play()`는 71-79행)
- Test: `app/tests/unit/music/musicPlayer.test.ts` ('musicPlayer transport' describe)

**Acceptance Criteria:**
- [ ] `musicPlayer.pause()`가 `isPlaying`을 false로 만들고 `currentIndex`는 보존한다.

**Verify:** `cd app && npx vitest run tests/unit/music/musicPlayer.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 실패하는 테스트 추가** — `app/tests/unit/music/musicPlayer.test.ts`의 `describe('musicPlayer transport', …)` 블록 안(예: `reportEnded advances…` 케이스 뒤)에 추가:

```ts
	it('pause stops playback without changing the index', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(1);
		expect(musicPlayer.isPlaying).toBe(true);
		musicPlayer.pause();
		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.currentIndex).toBe(1);
	});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd app && npx vitest run tests/unit/music/musicPlayer.test.ts -t "pause stops playback"`
Expected: FAIL — `musicPlayer.pause is not a function`.

- [ ] **Step 3: `pause()` 구현** — `app/src/lib/music/musicPlayer.svelte.ts`의 `play()` 블록(78행 `isPlaying = true;` 다음의 `},`) 바로 뒤, `toggle()` 앞에 삽입:

```ts
	pause(): void {
		isPlaying = false;
	},
```

삽입 후 모습(참고):

```ts
	play(index: number): void {
		if (queue.length === 0) return;
		const i = clampIndex(index);
		if (i !== currentIndex) {
			currentIndex = i;
			currentTime = 0;
		}
		isPlaying = true;
	},

	pause(): void {
		isPlaying = false;
	},

	toggle(): void {
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/music/musicPlayer.test.ts`
Expected: PASS (신규 케이스 포함 전부).

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/music/musicPlayer.svelte.ts app/tests/unit/music/musicPlayer.test.ts
git commit -m "feat(music): musicPlayer.pause() 추가 (잠금화면 일시정지용)"
```

---

## Task 3: `MusicPlayerBar.svelte` 배선 (프리로드 + Media Session)

**Goal:** 컴포넌트에 다음 곡 프리로드용 숨김 `<audio>`와 Media Session 배선 `$effect` 3개(preload / install / sync)를 추가한다.

**Files:**
- Modify: `app/src/lib/editor/musicNote/MusicPlayerBar.svelte`
- Test: `app/tests/unit/music/MusicPlayerBar.test.ts`

**Acceptance Criteria:**
- [ ] 음악 노트 마운트 + `play(0)` 후 `navigator.mediaSession.metadata.title`이 현재 트랙(`a`), `playbackState`가 `'playing'`이다.
- [ ] 두 번째(프리로드) `<audio>`의 `src`가 다음 트랙 URL이고, 마지막 곡에선 빈 값이다.
- [ ] `render()`가 effect 루프 없이 마운트된다(throw 없음). 기존 자동 넘김 테스트가 그대로 통과한다.

**Verify:** `cd app && npx vitest run tests/unit/music/MusicPlayerBar.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 공유 stub + 실패 테스트 추가** — `app/tests/unit/music/MusicPlayerBar.test.ts`

(1) import 줄에 `__resetMediaSession` 추가:

```ts
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMediaSession } from '$lib/music/mediaSession.js';
```

(2) 기존 `beforeAll(() => { … })` 블록 끝(미디어 stub 정의 뒤)에 Media Session stub 추가:

```ts
	// Media Session: jsdom 미구현 → 기록형 stub.
	Object.defineProperty(navigator, 'mediaSession', {
		value: {
			metadata: null as { title: string; artist: string; album: string } | null,
			playbackState: 'none',
			setActionHandler() {},
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
```

(3) 기존 `afterEach`에서 `__resetMusicPlayer()` 옆에 `__resetMediaSession()` 호출 추가:

```ts
afterEach(() => {
	cleanup();
	ed?.destroy();
	ed = null;
	__resetMusicPlayer();
	__resetMediaSession();
});
```

(4) 파일 끝에 새 describe 추가:

```ts
describe('MusicPlayerBar — media session + preload', () => {
	it('reflects the current track in lock-screen metadata and playback state', () => {
		const editor = makeEditor(
			'<p>음악::드라이브</p><p>플레이리스트: 길</p><ul><li><p>https://h/a.mp3</p></li><li><p>https://h/b.mp3</p></li></ul>'
		);
		render(MusicPlayerBar, { editor, guid: 'note-5' });
		musicPlayer.play(0);
		flushSync();
		const ms = navigator.mediaSession as unknown as {
			metadata: { title: string; artist: string; album: string } | null;
			playbackState: string;
		};
		expect(ms.metadata?.title).toBe('a');
		expect(ms.metadata?.artist).toBe('길');
		expect(ms.metadata?.album).toBe('드라이브');
		expect(ms.playbackState).toBe('playing');
	});

	it('warms the next track in a second <audio> element', () => {
		const editor = makeEditor(
			'<p>음악::드라이브</p><p>플레이리스트: 길</p><ul><li><p>https://h/a.mp3</p></li><li><p>https://h/b.mp3</p></li></ul>'
		);
		const { container } = render(MusicPlayerBar, { editor, guid: 'note-6' });
		const audios = container.querySelectorAll('audio');
		expect(audios.length).toBe(2);
		musicPlayer.play(0);
		flushSync();
		// 두 번째(프리로드) audio 가 다음 곡(b)을 데운다.
		expect(audios[1].getAttribute('src')).toBe('https://h/b.mp3');
	});

	it('clears the preload src on the last track', () => {
		const editor = makeEditor(
			'<p>음악::밤</p><p>플레이리스트: 끝</p><ul><li><p>https://h/c.mp3</p></li></ul>'
		);
		const { container } = render(MusicPlayerBar, { editor, guid: 'note-7' });
		const audios = container.querySelectorAll('audio');
		musicPlayer.play(0);
		flushSync();
		// 다음 곡이 없으므로 프리로드 src 는 비어 있어야 한다.
		expect(audios[1].getAttribute('src')).toBeNull();
	});
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd app && npx vitest run tests/unit/music/MusicPlayerBar.test.ts -t "media session"`
Expected: FAIL — 두 번째 `<audio>` 없음(`audios.length` 1) + `ms.metadata` null(아직 sync effect 없음).

- [ ] **Step 3: 컴포넌트 배선 구현** — `app/src/lib/editor/musicNote/MusicPlayerBar.svelte`

(3a) `<script>` 상단 import에 mediaSession 모듈 추가 (기존 `import { musicPlayer } …` 아래):

```ts
	import {
		isMediaSessionSupported,
		buildMetadataInit,
		installMediaSession,
		syncMediaSession
	} from '$lib/music/mediaSession.js';
```

(3b) `let audioEl = $state<HTMLAudioElement | null>(null);` 바로 아래에 프리로드 엘리먼트 상태 추가:

```ts
	let preloadEl = $state<HTMLAudioElement | null>(null);
```

(3c) `const playing = $derived(musicPlayer.isPlaying);` 아래에 노트 제목 + 다음 곡 URL 파생 추가:

```ts
	const noteName = $derived.by(() => {
		version;
		return parseMusicNote(editor.state.doc).name;
	});
	const nextUrl = $derived(musicPlayer.queue[musicPlayer.currentIndex + 1]?.url ?? '');
```

(3d) 기존 마지막 `$effect`(`// 재생/Ctrl 상태 변화 → 에디터 데코 갱신`, ~84행에서 끝나는 블록) 뒤에 새 effect 3개 추가(effect 들은 서로 독립이라 위치는 기능에 영향 없음):

```ts
	// 다음 곡 미리 데우기 — preloadEl 은 절대 play() 하지 않는다(HTTP 캐시 워밍 전용).
	// 잠금/백그라운드에서 자동 넘김 시 메인 <audio> src 교체가 캐시 적중으로 즉시 시작된다.
	$effect(() => {
		const el = preloadEl;
		const url = nextUrl;
		if (!el) return;
		if ((el.getAttribute('src') ?? '') === url) return;
		if (url) el.src = url;
		else el.removeAttribute('src');
	});
	// 잠금화면 컨트롤 핸들러 등록(마운트 동안 1회). 핸들러는 호출 시점에 스토어를 읽으므로
	// 여기서 currentIndex 등을 읽지 않는다 → 이 effect 는 재실행되지 않는다.
	$effect(() => {
		if (!isMediaSessionSupported()) return;
		return installMediaSession({
			play: () => musicPlayer.play(musicPlayer.currentIndex),
			pause: () => musicPlayer.pause(),
			next: () => musicPlayer.next(),
			prev: () => musicPlayer.prev(),
			seekTo: (t) => musicPlayer.requestSeek(t)
		});
	});
	// 잠금화면 메타데이터·재생상태·위치 동기화. navigator 만 쓰므로 루프 위험 없음.
	$effect(() => {
		if (!isMediaSessionSupported()) return;
		const t = track;
		const metaInit = t
			? buildMetadataInit({ trackDisplay: t.display, playlistLabel: label, noteName })
			: null;
		syncMediaSession({
			metaInit,
			isPlaying: musicPlayer.isPlaying,
			duration: musicPlayer.duration,
			position: musicPlayer.currentTime
		});
	});
```

(3e) 템플릿 끝의 메인 `<audio bind:this={audioEl} …></audio>` 바로 뒤에 프리로드 엘리먼트 추가(전역 `audio { display: none; }` 규칙이 숨겨줌):

```svelte
<audio bind:this={preloadEl} preload="auto" muted></audio>
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/music/MusicPlayerBar.test.ts`
Expected: PASS — 신규 media-session/preload 3건 + 기존 mount/auto-advance 테스트 전부.

- [ ] **Step 5: 음악 스위트 전체 + 타입 체크**

Run: `cd app && npx vitest run tests/unit/music/ && npm run check`
Expected: 음악 테스트 전부 PASS, `npm run check` 0 errors.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/musicNote/MusicPlayerBar.svelte app/tests/unit/music/MusicPlayerBar.test.ts
git commit -m "feat(music): 잠금화면 Media Session 배선 + 다음 곡 프리로드"
```

---

## Task 4: 가이드 문서 (설정 → 가이드 → 환경/호환성)

**Goal:** 사용자 발견 표면인 `설정 → 가이드`의 env 탭에 백그라운드 재생 기능 카드를 추가한다(CLAUDE.md 필수 규칙).

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (env 탭 블록: `{:else if guideSubTab === 'env'}` 2012행~; iOS PWA 카드 2033-2044행)

**Acceptance Criteria:**
- [ ] env 탭에 "음악 노트 — 잠금화면 백그라운드 재생" `<details class="guide-card">`가 추가된다.
- [ ] 카드에 PWA 설치 권장 + iOS 자동 넘김 미보장 + Android 정상 동작 내용이 포함된다.
- [ ] `npm run check`가 0 errors다(마크업 정상).

**Verify:** `cd app && npm run check` → 0 errors; `npm run dev` → 설정 → 가이드 → 환경/호환성에서 카드 표시 확인.

**Steps:**

- [ ] **Step 1: 가이드 카드 추가** — `app/src/routes/settings/+page.svelte`의 env 탭에서 "iOS — PWA 설치가 푸시 알림의 전제조건" 카드(`</details>` 가 2044행)와 그 다음 "알림 권한" 카드(2046행) 사이에 삽입:

```svelte
				<details class="guide-card">
					<summary>음악 노트 — 잠금화면 백그라운드 재생</summary>
					<p class="info-text">
						<code>음악::</code> 노트에서 재생하면 화면을 꺼도 재생이 이어지고, OS 잠금화면에
						곡 정보와 재생/일시정지/이전/다음/탐색 컨트롤이 뜹니다. 한 곡이 끝나면 다음 곡을
						미리 받아둔 덕에 잠금 상태에서도 끊김 없이 자동으로 넘어갑니다.
					</p>
					<ul class="guide-list">
						<li><strong>홈 화면에 추가(PWA 설치)</strong>를 권장합니다 — 브라우저 탭보다 백그라운드
							재생이 안정적입니다.</li>
						<li><strong>Android</strong>: 잠금화면 컨트롤과 자동 넘김이 거의 네이티브처럼 동작합니다.</li>
						<li><strong>iOS</strong>: 잠금 컨트롤과 단일 곡 재생은 안정적이나, 잠금 상태 자동 넘김은
							iOS 버전에 따라 완벽히 보장되지는 않습니다(다음 곡이 안 넘어가면 한 번 깨워서
							재생을 눌러주세요).</li>
						<li>오프라인 저장은 아직 없습니다 — 곡은 네트워크에서 재생되며, 다음 곡만 미리 받아둡니다.</li>
					</ul>
				</details>
```

- [ ] **Step 2: 타입/마크업 체크**

Run: `cd app && npm run check`
Expected: 0 errors(기존 a11y 경고 외 신규 오류 없음).

- [ ] **Step 3: 커밋**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(music): 가이드에 잠금화면 백그라운드 재생 카드 추가"
```

---

## 최종 검증

모든 태스크 완료 후:

```bash
cd app && npx vitest run tests/unit/music/ && npm run check
```

Expected: 음악 스위트 전부 PASS, `npm run check` 0 errors(기존 a11y 경고 3건은 무관). 전체 스위트(`npx vitest run`)는 알려진 OCR teardown flake("1 error", `runOcrInEditor.test.ts`, `document is not defined`)만 간헐 출력될 수 있으며 테스트 실패는 0이어야 한다.

**실기기 수동 확인(선택, 코드 외):** Android/iOS 설치 PWA에서 음악 노트 재생 → 화면 잠금 → 곡 끝에서 자동 넘김 + 잠금화면 컨트롤 동작 확인.
