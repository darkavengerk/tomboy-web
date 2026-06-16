# 데스크탑 레일 음악 플레이어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 떠다니는 `DesktopMiniPlayer`를 제거하고, 데스크탑 `SidePanel`에 항상 보이는 재생 컨트롤(레일)과 호버 시 펼쳐지는 곡 제목·진행바(.main)로 분할하며, 세션을 localStorage에 지속해 새로고침 후에도 복원한다.

**Architecture:** 전역 `musicPlayer` 싱글톤 상태는 그대로 두고 두 개의 데스크탑 전용 컴포넌트(`RailMusicControls`, `RailNowPlaying`)와 한 개의 지속 모듈(`musicSession.svelte.ts`)을 추가한다. `musicPlayer`에 레일 재생 진입점(`resumeOrRestart`)과 부팅 복원(`restoreSession`)을 더한다.

**Tech Stack:** SvelteKit, Svelte 5 runes (`$state`/`$derived`/`$effect`/`$effect.root`), TypeScript, vitest + @testing-library/svelte, localStorage.

스펙: `docs/superpowers/specs/2026-06-16-desktop-rail-music-player-design.md`

---

### Task 1: musicPlayer — `restoreSession` + `resumeOrRestart`

**Goal:** 레일 재생 버튼 의미(이어재생/소진 시 처음부터)와 부팅 세션 복원(자동재생 안 함)을 `musicPlayer`에 추가한다.

**Files:**
- Modify: `app/src/lib/music/musicPlayer.svelte.ts` (객체 리터럴 끝, `reportEnded` 뒤)
- Test: `app/tests/unit/music/musicPlayer.test.ts` (describe 블록 추가)

**Acceptance Criteria:**
- [ ] `restoreSession` 이 큐/인덱스/이름을 채우되 `isPlaying === false`로 둔다(자동재생 금지).
- [ ] `restoreSession` 이 `musicProgress`의 이어듣기 위치를 `pendingRestore`로 잡아 첫 `resume()` 시 `resumeAt`으로 승격한다.
- [ ] 빈 큐 스냅샷이면 `restoreSession` 은 아무 것도 바꾸지 않는다.
- [ ] `resumeOrRestart`: 재생 중이면 일시정지, 일시정지 상태면 이어재생, 큐가 끝까지 소진됐으면 처음(0번)부터 재시작.
- [ ] 빈 큐에서 `resumeOrRestart` 는 no-op.

**Verify:** `cd app && npm run test -- musicPlayer` → 새 케이스 포함 전부 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/music/musicPlayer.test.ts` 끝에 추가

```ts
describe('musicPlayer.resumeOrRestart', () => {
	it('빈 큐면 no-op', () => {
		musicPlayer.resumeOrRestart();
		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.currentIndex).toBe(-1);
	});
	it('재생 중이면 일시정지', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(0);
		expect(musicPlayer.isPlaying).toBe(true);
		musicPlayer.resumeOrRestart();
		expect(musicPlayer.isPlaying).toBe(false);
	});
	it('중간에 멈췄으면 같은 곡 이어재생', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(0);
		musicPlayer.reportDuration(100);
		musicPlayer.reportTime(30);
		musicPlayer.pause();
		musicPlayer.resumeOrRestart();
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(true);
	});
	it('큐가 끝까지 소진됐으면 처음(0번)부터 재시작', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(1); // 마지막 곡
		musicPlayer.reportDuration(100);
		musicPlayer.reportTime(100);
		musicPlayer.reportEnded(); // repeat off → isPlaying=false, index=1 유지
		expect(musicPlayer.isPlaying).toBe(false);
		musicPlayer.resumeOrRestart();
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(true);
	});
	it('한 곡짜리가 끝났으면 0초로 되감아 재시작', () => {
		musicPlayer.setQueue('n1', [t('a')]);
		musicPlayer.play(0);
		musicPlayer.reportDuration(50);
		musicPlayer.reportTime(50);
		musicPlayer.reportEnded(); // 단일곡 repeat off → 정지
		musicPlayer.resumeOrRestart();
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(true);
		expect(musicPlayer.currentTime).toBe(0);
	});
});

describe('musicPlayer.restoreSession', () => {
	it('큐/인덱스/이름을 채우되 재생하지 않는다', () => {
		musicPlayer.restoreSession({
			activeNoteGuid: 'n1',
			activeNoteName: '노트',
			queue: [t('a'), t('b')],
			currentIndex: 1
		});
		expect(musicPlayer.queue.length).toBe(2);
		expect(musicPlayer.currentIndex).toBe(1);
		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.activeNoteName).toBe('노트');
		expect(musicPlayer.activeNoteGuid).toBe('n1');
	});
	it('이어듣기 위치를 첫 resume 에서 resumeAt 으로 승격', () => {
		saveProgress('n1', 'b', 42);
		musicPlayer.restoreSession({
			activeNoteGuid: 'n1',
			activeNoteName: '',
			queue: [t('a'), t('b')],
			currentIndex: 1
		});
		musicPlayer.resume();
		expect(musicPlayer.takeResumeAt()).toBe(42);
	});
	it('빈 큐 스냅샷은 무시', () => {
		musicPlayer.restoreSession({
			activeNoteGuid: 'n1',
			activeNoteName: '',
			queue: [],
			currentIndex: 0
		});
		expect(musicPlayer.queue.length).toBe(0);
		expect(musicPlayer.activeNoteGuid).toBeNull();
	});
});
```

`saveProgress` 임포트가 테스트 상단에 없으면 추가:

```ts
import { __resetMusicProgress, saveProgress } from '$lib/music/musicProgress.js';
```

(기존 줄 `import { __resetMusicProgress } from '$lib/music/musicProgress.js';` 를 위 줄로 교체.)

- [ ] **Step 2: 실패 확인**

Run: `cd app && npm run test -- musicPlayer`
Expected: FAIL — `resumeOrRestart`/`restoreSession` 미정의.

- [ ] **Step 3: 구현** — `app/src/lib/music/musicPlayer.svelte.ts` 의 `reportEnded(): void { ... }` 메서드 **바로 뒤**(객체 닫는 `};` 앞)에 추가. 앞 메서드 끝에 콤마가 붙도록 `reportEnded` 블록 끝 `}` 를 `},` 로 바꾸고 이어서:

```ts
	},

	/** localStorage 복원용 세션 스냅샷 적용(currentTime 제외 — musicProgress 담당). 자동재생 안 함. */
	restoreSession(snap: {
		activeNoteGuid: string;
		activeNoteName: string;
		queue: MusicTrack[];
		currentIndex: number;
	}): void {
		if (!snap || !Array.isArray(snap.queue) || snap.queue.length === 0) return;
		queue = snap.queue;
		activeNoteGuid = snap.activeNoteGuid;
		activeNoteName = snap.activeNoteName ?? '';
		currentIndex = clampIndex(snap.currentIndex);
		isPlaying = false;
		currentTime = 0;
		duration = 0;
		const entry = currentIndex >= 0 ? loadProgress(snap.activeNoteGuid) : null;
		pendingRestore = entry && entry.trackUrl === queue[currentIndex]?.url ? entry.currentTime : 0;
		if (shuffle) rebuildShuffle(true);
	},

	/** 레일 재생 버튼 진입점. 재생 중이면 일시정지; 아니면 이어재생하되 큐가 소진됐으면 처음부터. */
	resumeOrRestart(): void {
		if (queue.length === 0) return;
		if (isPlaying) {
			this.pause();
			return;
		}
		const ord = playOrder();
		const lastIdx = ord[ord.length - 1];
		const exhausted =
			currentIndex < 0 ||
			(currentIndex === lastIdx && duration > 0 && currentTime >= duration - 0.5);
		if (exhausted) {
			const first = ord[0];
			if (first === currentIndex) {
				// 단일곡/같은 인덱스: play() 가 시간을 안 되감으니 직접 되감아 재생.
				this.requestSeek(0);
				isPlaying = true;
			} else {
				this.play(first);
			}
		} else {
			this.resume();
		}
	}
```

(주의: 새로 추가한 마지막 메서드 `resumeOrRestart` 뒤에는 콤마 없이 객체 닫기 `};` 가 와야 한다 — 기존 파일 끝 구조 유지.)

- [ ] **Step 4: 통과 확인**

Run: `cd app && npm run test -- musicPlayer`
Expected: PASS (전부)

- [ ] **Step 5: 타입 체크 + 커밋**

```bash
cd app && npm run check
git add app/src/lib/music/musicPlayer.svelte.ts app/tests/unit/music/musicPlayer.test.ts
git commit -m "feat(music): add restoreSession + resumeOrRestart to musicPlayer"
```

---

### Task 2: 세션 지속 모듈 `musicSession.svelte.ts` + +layout 설치

**Goal:** 음악 세션 스냅샷을 localStorage에 저장/복원하고, 부팅 시 복원 + 변동 시 지속하는 설치 함수를 +layout에 연결한다.

**Files:**
- Create: `app/src/lib/music/musicSession.svelte.ts`
- Modify: `app/src/routes/+layout.svelte` (installMusicAudio 옆 설치/해제)
- Test: `app/tests/unit/music/musicSession.test.ts`

**Acceptance Criteria:**
- [ ] `saveSession` → `loadSession` 가 동일 스냅샷을 돌려준다(round-trip).
- [ ] 저장 없으면 `loadSession()` 은 null.
- [ ] 빈 큐로 `saveSession` 하면 키가 제거돼 `loadSession()` 이 null.
- [ ] 손상 페이로드면 `loadSession()` 이 null(throw 없음).
- [ ] `+layout` 이 `installMusicSession()` 을 설치하고 정리 시 해제한다.

**Verify:** `cd app && npm run test -- musicSession` → PASS; `cd app && npm run check` → 에러 0

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/music/musicSession.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
	saveSession,
	loadSession,
	__clearMusicSessionStorage
} from '$lib/music/musicSession.svelte.js';
import type { MusicTrack } from '$lib/music/parseMusicNote.js';

const t = (url: string): MusicTrack => ({ url, title: null, display: url, liPos: 0 });

beforeEach(() => __clearMusicSessionStorage());

describe('musicSession', () => {
	it('save 후 load 가 같은 스냅샷을 돌려준다', () => {
		const snap = {
			activeNoteGuid: 'n1',
			activeNoteName: '노트',
			queue: [t('a'), t('b')],
			currentIndex: 1
		};
		saveSession(snap);
		expect(loadSession()).toEqual(snap);
	});

	it('저장 없으면 null', () => {
		expect(loadSession()).toBeNull();
	});

	it('빈 큐로 저장하면 키가 지워진다', () => {
		saveSession({ activeNoteGuid: 'n1', activeNoteName: '', queue: [t('a')], currentIndex: 0 });
		saveSession({ activeNoteGuid: 'n1', activeNoteName: '', queue: [], currentIndex: 0 });
		expect(loadSession()).toBeNull();
	});

	it('손상 페이로드면 null', () => {
		window.localStorage.setItem('tomboy.musicSession', '{not json');
		expect(loadSession()).toBeNull();
	});
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd app && npm run test -- musicSession`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 모듈 구현** — `app/src/lib/music/musicSession.svelte.ts`

```ts
/**
 * 음악 세션(활성 노트 + 큐 + 인덱스) 지속 저장소. 노트 데이터가 아니라 로컬 전용.
 * 새로고침 후에도 마지막 세션을 복원해 레일 재생 컨트롤이 항상 동작하게 한다.
 * currentTime(이어듣기 위치)은 여기서 저장하지 않는다 — musicProgress 가 담당.
 */
import type { MusicTrack } from '$lib/music/parseMusicNote.js';
import { musicPlayer } from './musicPlayer.svelte.js';

const STORAGE_KEY = 'tomboy.musicSession';

export interface MusicSessionSnapshot {
	activeNoteGuid: string;
	activeNoteName: string;
	queue: MusicTrack[];
	currentIndex: number;
}

function safeStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null;
	}
}

function isTrack(v: unknown): v is MusicTrack {
	const e = v as Record<string, unknown>;
	return !!e && typeof e.url === 'string' && typeof e.display === 'string';
}

export function loadSession(): MusicSessionSnapshot | null {
	const ls = safeStorage();
	if (!ls) return null;
	const raw = ls.getItem(STORAGE_KEY);
	if (!raw) return null;
	try {
		const p = JSON.parse(raw) as Record<string, unknown>;
		if (!p || typeof p !== 'object') return null;
		const guid = p.activeNoteGuid;
		const queue = p.queue;
		if (typeof guid !== 'string' || !Array.isArray(queue) || queue.length === 0) return null;
		if (!queue.every(isTrack)) return null;
		return {
			activeNoteGuid: guid,
			activeNoteName: typeof p.activeNoteName === 'string' ? p.activeNoteName : '',
			queue: queue as MusicTrack[],
			currentIndex: typeof p.currentIndex === 'number' ? p.currentIndex : 0
		};
	} catch {
		return null;
	}
}

export function saveSession(snap: MusicSessionSnapshot | null): void {
	const ls = safeStorage();
	if (!ls) return;
	try {
		if (!snap || !snap.activeNoteGuid || snap.queue.length === 0) {
			ls.removeItem(STORAGE_KEY);
			return;
		}
		ls.setItem(STORAGE_KEY, JSON.stringify(snap));
	} catch {
		/* quota/denied — 무시 */
	}
}

/** 테스트 전용. */
export function __clearMusicSessionStorage(): void {
	safeStorage()?.removeItem(STORAGE_KEY);
}

/** 부팅 시 마지막 세션 복원 + 세션 식별 필드 변동 시 지속. +layout 에서 1회 설치. */
export function installMusicSession(): () => void {
	if (typeof window === 'undefined') return () => {};
	const snap = loadSession();
	if (snap) musicPlayer.restoreSession(snap);

	let timer: ReturnType<typeof setTimeout> | null = null;
	const stop = $effect.root(() => {
		$effect(() => {
			// 세션 식별 필드만 추적(currentTime 제외 — 저churn).
			const guid = musicPlayer.activeNoteGuid;
			const name = musicPlayer.activeNoteName;
			const q = musicPlayer.queue;
			const idx = musicPlayer.currentIndex;
			const snapshot: MusicSessionSnapshot | null =
				guid && q.length > 0
					? { activeNoteGuid: guid, activeNoteName: name, queue: q, currentIndex: idx }
					: null;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => saveSession(snapshot), 400);
		});
	});
	return () => {
		if (timer) clearTimeout(timer);
		stop();
	};
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd app && npm run test -- musicSession`
Expected: PASS

- [ ] **Step 5: +layout 연결** — `app/src/routes/+layout.svelte`

임포트 추가(기존 `import { installMusicAudio } ...` 줄 아래):

```ts
	import { installMusicSession } from '$lib/music/musicSession.svelte.js';
```

설치(기존 `const uninstallMusicAudio = installMusicAudio();` 줄 아래):

```ts
		const uninstallMusicSession = installMusicSession();
```

해제(기존 `uninstallMusicAudio();` 줄 아래):

```ts
			uninstallMusicSession();
```

- [ ] **Step 6: 타입 체크 + 커밋**

```bash
cd app && npm run check
git add app/src/lib/music/musicSession.svelte.ts app/tests/unit/music/musicSession.test.ts app/src/routes/+layout.svelte
git commit -m "feat(music): persist + restore music session across reload"
```

---

### Task 3: `RailMusicControls.svelte` (기본 패널) + 레일 마운트

**Goal:** 레일 `전체` 위에 항상 보이는 이전·재생·다음 버튼 줄을 추가한다.

**Files:**
- Create: `app/src/lib/editor/musicNote/RailMusicControls.svelte`
- Modify: `app/src/lib/desktop/SidePanel.svelte` (import + `.workspace-switcher`와 `.rail-chips` 사이 마운트)

**Acceptance Criteria:**
- [ ] 레일에서 `.workspace-switcher` 바로 아래, `전체/미분류…` 칩 위에 3버튼 줄이 보인다.
- [ ] 세션 없으면(`queue.length===0`) 세 버튼 모두 `disabled`.
- [ ] 재생 버튼은 `resumeOrRestart()`, 이전 `prev()`, 다음 `next()` 호출 + 재생 시 `resumePlaybackFromGesture()`.
- [ ] 좁은 레일(최소 60px)에서 줄바꿈 없이 한 줄로 밀착(버튼 flex 균등).

**Verify:** `cd app && npm run check` → 에러 0; `npm run dev` 데스크탑에서 음악 재생 중 레일에 컨트롤 표시·동작 확인

**Steps:**

- [ ] **Step 1: 컴포넌트 작성** — `app/src/lib/editor/musicNote/RailMusicControls.svelte`

```svelte
<script lang="ts">
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
	import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';

	const hasSession = $derived(musicPlayer.queue.length > 0);
	const playing = $derived(musicPlayer.isPlaying);

	function onPlayPause() {
		musicPlayer.resumeOrRestart();
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	}
	function onPrev() {
		musicPlayer.prev();
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	}
	function onNext() {
		musicPlayer.next();
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	}
</script>

<div class="rail-music" role="group" aria-label="음악 재생">
	<button type="button" onclick={onPrev} disabled={!hasSession} aria-label="이전 곡">⏮</button>
	<button
		type="button"
		class="play"
		onclick={onPlayPause}
		disabled={!hasSession}
		aria-label={playing ? '일시정지' : '재생'}
	>{playing ? '⏸' : '▶'}</button>
	<button type="button" onclick={onNext} disabled={!hasSession} aria-label="다음 곡">⏭</button>
</div>

<style>
	.rail-music {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 2px;
		width: calc(100% - 12px);
		flex-shrink: 0;
	}
	.rail-music button {
		flex: 1 1 0;
		min-width: 0;
		height: 26px;
		border: 1px solid #2a2a2a;
		background: #111;
		color: #ddd;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.8rem;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}
	.rail-music button:hover:not(:disabled) {
		background: #232323;
		color: #fff;
	}
	.rail-music button.play {
		background: var(--accent, #a05);
		color: #fff;
		border-color: var(--accent, #a05);
	}
	.rail-music button:disabled {
		opacity: 0.35;
		cursor: default;
	}
</style>
```

- [ ] **Step 2: SidePanel import** — `app/src/lib/desktop/SidePanel.svelte` `<script>` 상단 import 묶음에 추가

```ts
	import RailMusicControls from '$lib/editor/musicNote/RailMusicControls.svelte';
```

- [ ] **Step 3: 레일 마운트** — `app/src/lib/desktop/SidePanel.svelte` 에서 `.workspace-switcher` 닫는 `</div>` 와 `<div class="rail-chips" ...>` 사이에 삽입

기존:
```svelte
		</div>

		<div class="rail-chips" role="tablist" aria-label="노트북 필터">
```
교체:
```svelte
		</div>

		<RailMusicControls />

		<div class="rail-chips" role="tablist" aria-label="노트북 필터">
```

- [ ] **Step 4: 타입 체크 + 수동 확인 + 커밋**

```bash
cd app && npm run check
```
Expected: 에러 0

```bash
git add app/src/lib/editor/musicNote/RailMusicControls.svelte app/src/lib/desktop/SidePanel.svelte
git commit -m "feat(music): always-visible play controls in desktop rail"
```

---

### Task 4: `RailNowPlaying.svelte` (확장 패널, 10분 타임아웃) + .main 마운트

**Goal:** 호버 시 펼쳐지는 `.main`의 노트 목록 위에 곡 제목·노트 이름·진행바를 표시하고, 10분 무재생 시 자동으로 접는다.

**Files:**
- Create: `app/src/lib/editor/musicNote/RailNowPlaying.svelte`
- Modify: `app/src/lib/desktop/SidePanel.svelte` (import + `.header`와 `.list` 사이 마운트)

**Acceptance Criteria:**
- [ ] 곡이 로드돼 있으면(일시정지 포함) `.main`의 검색 헤더 아래·노트 목록 위에 제목·진행바 표시.
- [ ] 일시정지 상태로 10분 지나면 곡 정보가 사라진다(레일 기본 컨트롤은 영향 없음).
- [ ] 재생 재개 또는 seek 시 타임아웃이 리셋된다.
- [ ] seek 슬라이더가 `musicPlayer.requestSeek(value)` 를 호출한다.

**Verify:** `cd app && npm run check` → 에러 0; `npm run dev` 데스크탑에서 호버 시 제목·진행바 표시 확인

**Steps:**

- [ ] **Step 1: 컴포넌트 작성** — `app/src/lib/editor/musicNote/RailNowPlaying.svelte`

```svelte
<script lang="ts">
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';

	const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

	const track = $derived(musicPlayer.currentTrack);
	const playing = $derived(musicPlayer.isPlaying);

	let timedOut = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	function clearTimer() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	// 재생 중이면 항상 보이고 타이머 해제. 일시정지(곡 있음)면 10분 후 접기.
	$effect(() => {
		if (playing) {
			timedOut = false;
			clearTimer();
		} else if (track && !timer && !timedOut) {
			timer = setTimeout(() => {
				timedOut = true;
				timer = null;
			}, IDLE_TIMEOUT_MS);
		}
	});

	// 언마운트 정리.
	$effect(() => () => clearTimer());

	const visible = $derived(!!track && !timedOut);

	function fmt(s: number): string {
		if (!Number.isFinite(s) || s < 0) s = 0;
		const m = Math.floor(s / 60);
		const sec = Math.floor(s % 60);
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}
	function onSeek(e: Event) {
		musicPlayer.requestSeek(Number((e.currentTarget as HTMLInputElement).value));
		// 사용자 상호작용 — 타임아웃 리셋(다시 10분).
		timedOut = false;
		clearTimer();
	}
</script>

{#if visible && track}
	<div class="rail-now">
		<div class="title" title={track.display}>{track.display}</div>
		<div class="name">{musicPlayer.activeNoteName}</div>
		<div class="seek">
			<span class="t">{fmt(musicPlayer.currentTime)}</span>
			<input
				type="range"
				min="0"
				max={Math.max(1, musicPlayer.duration)}
				step="0.1"
				value={musicPlayer.currentTime}
				oninput={onSeek}
				aria-label="탐색"
			/>
			<span class="t">{fmt(musicPlayer.duration)}</span>
		</div>
	</div>
{/if}

<style>
	.rail-now {
		padding: 8px 12px;
		border-bottom: 1px solid #2a2a2a;
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex-shrink: 0;
		background: #161616;
	}
	.title {
		font-weight: 600;
		font-size: 0.85rem;
		color: #eee;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.name {
		font-size: 0.72rem;
		color: #999;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.seek {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.seek input[type='range'] {
		flex: 1;
		min-width: 0;
		accent-color: var(--accent, #a05);
	}
	.seek .t {
		font-size: 0.62rem;
		color: #999;
		font-variant-numeric: tabular-nums;
	}
</style>
```

- [ ] **Step 2: SidePanel import** — `app/src/lib/desktop/SidePanel.svelte` `<script>` import 묶음에 추가

```ts
	import RailNowPlaying from '$lib/editor/musicNote/RailNowPlaying.svelte';
```

- [ ] **Step 3: .main 마운트** — `app/src/lib/desktop/SidePanel.svelte` 에서 `.header` 닫는 `</div>` 와 `<div class="list">` 사이에 삽입

기존:
```svelte
			<button type="button" class="new-btn" onclick={handleNew} title="새 노트">＋ 새 노트</button>
			</div>

			<div class="list">
```
교체:
```svelte
			<button type="button" class="new-btn" onclick={handleNew} title="새 노트">＋ 새 노트</button>
			</div>

			<RailNowPlaying />

			<div class="list">
```

- [ ] **Step 4: 타입 체크 + 수동 확인 + 커밋**

```bash
cd app && npm run check
```
Expected: 에러 0

```bash
git add app/src/lib/editor/musicNote/RailNowPlaying.svelte app/src/lib/desktop/SidePanel.svelte
git commit -m "feat(music): now-playing title + seek in side-panel expand area"
```

---

### Task 5: 떠다니는 `DesktopMiniPlayer` 제거

**Goal:** 데스크탑 떠다니는 미니 플레이어와 그 가시성 술어를 제거한다(모바일 미니 플레이어는 유지).

**Files:**
- Delete: `app/src/lib/editor/musicNote/DesktopMiniPlayer.svelte`
- Modify: `app/src/lib/desktop/DesktopWorkspace.svelte` (import + `<DesktopMiniPlayer />` 제거)
- Modify: `app/src/lib/editor/musicNote/miniPlayerVisibility.ts` (`desktopMiniPlayerVisible` 제거)
- Modify: `app/tests/unit/music/miniPlayerVisibility.test.ts` (데스크탑 describe 제거)

**Acceptance Criteria:**
- [ ] `DesktopMiniPlayer.svelte` 삭제, 어떤 파일도 더 이상 import 하지 않는다.
- [ ] `desktopMiniPlayerVisible` 제거, `miniPlayerVisible`(모바일)은 유지.
- [ ] `GlobalMiniPlayer.svelte`, `miniPlayerDrag.ts` 는 그대로 동작.
- [ ] 테스트·타입 체크 통과.

**Verify:** `cd app && npm run test -- miniPlayerVisibility` → PASS; `cd app && npm run check` → 에러 0; `grep -rn DesktopMiniPlayer app/src` → 결과 없음

**Steps:**

- [ ] **Step 1: 가시성 술어 정리** — `app/src/lib/editor/musicNote/miniPlayerVisibility.ts` 에서 `desktopMiniPlayerVisible` 함수(파일 하단 블록)와 상단 주석의 데스크탑 언급을 삭제. `miniPlayerVisible` 만 남긴다. 결과 파일:

```ts
/**
 * 전역 미니 플레이어 가시성 순수 술어. 컴포넌트(라우트 의존)와 분리해 단위 테스트.
 *
 * 규칙: 활성 노트가 있고(큐>0) 그 노트를 "지금 보고 있지 않을" 때만 미니 플레이어를
 * 띄운다. 활성 노트를 보고 있으면 인-노트 MusicPlayerBar 가 풀 컨트롤이라 중복을 피한다.
 */

/** 모바일/일반 라우트: 현재 페이지 노트(=route param)가 활성 노트와 다를 때만 표시. */
export function miniPlayerVisible(
	activeGuid: string | null,
	queueLen: number,
	currentNoteGuid: string | null
): boolean {
	if (!activeGuid || queueLen <= 0) return false;
	return currentNoteGuid !== activeGuid;
}
```

- [ ] **Step 2: 테스트 정리** — `app/tests/unit/music/miniPlayerVisibility.test.ts` 에서 `desktopMiniPlayerVisible` import 와 그 `describe('desktopMiniPlayerVisible', ...)` 블록 전체를 삭제. import 를:

```ts
import { miniPlayerVisible } from '$lib/editor/musicNote/miniPlayerVisibility.js';
```
로 바꾸고 모바일 describe 블록만 남긴다.

- [ ] **Step 3: DesktopWorkspace 정리** — `app/src/lib/desktop/DesktopWorkspace.svelte`
  - import 줄 `import DesktopMiniPlayer from '$lib/editor/musicNote/DesktopMiniPlayer.svelte';` 삭제.
  - 마크업 `<DesktopMiniPlayer />` 줄 삭제.

- [ ] **Step 4: 파일 삭제**

```bash
git rm app/src/lib/editor/musicNote/DesktopMiniPlayer.svelte
```

- [ ] **Step 5: 검증 + 커밋**

```bash
cd app && npm run test -- miniPlayerVisibility && npm run check
grep -rn "DesktopMiniPlayer\|desktopMiniPlayerVisible" app/src app/tests
```
Expected: 테스트 PASS, check 에러 0, grep 결과 없음

```bash
git add app/src/lib/editor/musicNote/miniPlayerVisibility.ts app/tests/unit/music/miniPlayerVisibility.test.ts app/src/lib/desktop/DesktopWorkspace.svelte
git commit -m "refactor(music): remove floating desktop mini player (replaced by rail)"
```

---

### Task 6: 설정 가이드 카드 갱신

**Goal:** 설정 → 가이드의 음악 노트 카드에 데스크탑 레일 플레이어(분할/항상 표시/복원/10분 타임아웃)를 반영한다.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (음악 노트 카드의 "전역 미니 플레이어" 항목)

**Acceptance Criteria:**
- [ ] "전역 미니 플레이어" 항목이 모바일(떠다니는 알약) + 데스크탑(레일 분할) 두 갈래로 갱신됐다.
- [ ] 데스크탑 설명에 "전체 위 컨트롤 항상 표시", "노트 목록 위 곡 정보", "새로고침 복원", "10분 후 곡 정보 접힘", "정지 버튼 없음"이 들어간다.
- [ ] `npm run check` 통과.

**Verify:** `cd app && npm run check` → 에러 0; `npm run dev` → 설정 → 가이드 → 노트 탭 → 음악 노트 카드 확인

**Steps:**

- [ ] **Step 1: 항목 교체** — `app/src/routes/settings/+page.svelte` 에서 기존 "전역 미니 플레이어" `<li>` (아래 블록)를 찾아

```svelte
							<li><strong>전역 미니 플레이어</strong>: 재생 중인 노트를 떠나도 소리는 계속 나고,
								화면에 <strong>떠다니는 미니 플레이어</strong>가 남습니다. 모바일/일반 화면은 <strong>떠다니는
								알약</strong>(드래그 이동, 탭하면 펼쳐져 전체 컨트롤 + <b>노트 열기</b>), 데스크탑 작업대는
								<strong>떠다니는 플레이어 창</strong>으로 떠요. <b>노트 열기</b>로 그 노트로 돌아가고,
								<b>✕</b> 는 재생을 멈춥니다(이어듣기 지점은 보존돼 다음에 다시 이어집니다).</li>
```

다음으로 교체:

```svelte
							<li><strong>전역 재생 컨트롤(모바일)</strong>: 재생 중인 노트를 떠나도 소리는 계속 나고,
								<strong>떠다니는 알약</strong>이 남습니다(드래그 이동, 탭하면 펼쳐져 전체 컨트롤 + <b>노트 열기</b>).
								<b>✕</b> 는 재생을 멈춰요(이어듣기 지점은 보존).</li>
							<li><strong>데스크탑 작업대</strong>: 컨트롤이 <strong>좌측 작업표시줄</strong>에 박혀 있어요.
								<strong>전체 카테고리 위</strong>의 <strong>이전·재생·다음</strong> 버튼은 노트 창 열림/닫힘과
								무관하게 <strong>항상</strong> 보이고, 마우스를 올려 패널을 펼치면 <strong>노트 목록 위</strong>에
								곡 제목·진행바가 나타나요. <strong>새로고침해도 마지막 곡이 복원</strong>되고, 재생을 누르면
								이어재생(끝까지 들었으면 처음부터)됩니다. 일시정지로 <strong>10분</strong>이 지나면 곡 정보는
								접히지만 재생 버튼은 그대로 남아요(정지 버튼 없음).</li>
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
cd app && npm run check
git add app/src/routes/settings/+page.svelte
git commit -m "docs(guide): desktop rail music player in settings guide"
```

---

## 실행 후 전체 검증

```bash
cd app && npm run test && npm run check
```
Expected: 전체 테스트 PASS, 타입 에러 0.

수동(데스크탑 `npm run dev`):
1. 음악 노트 열어 재생 → 레일 `전체` 위 컨트롤 + 호버 시 `.main` 곡 제목·진행바 확인.
2. 노트 창 닫기 → 레일 컨트롤 그대로 동작(이전/재생/다음).
3. 새로고침 → 레일 컨트롤이 마지막 곡으로 복원(자동재생 안 함), 재생 누르면 재생.
4. 곡 끝까지 재생 후 재생 버튼 → 목록 처음부터.
5. (선택) `IDLE_TIMEOUT_MS` 를 임시로 작게 바꿔 일시정지 10분 타임아웃으로 곡 정보 접힘 확인.
