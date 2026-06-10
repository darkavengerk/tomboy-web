# 노트별 음악 플레이어 + 전역 미니 플레이어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 각 음악 노트가 자신의 재생 트랙·위치를 로컬에 기억해 이어 재생하고, 노트를 닫아도 떠 있는 전역 미니 플레이어(모바일 알약 / 데스크탑 떠다니는 창)로 돌아갈 수 있게 한다.

**Architecture:** 오디오 엔진은 단일 `<audio>` 유지(동시 재생 1개). 신규 `musicProgress.ts`(localStorage, guid별 `{trackUrl, currentTime}`, 인메모리 맵이 진실 소스)에 위치를 저장한다. `musicPlayer.setQueue`가 노트 전환 시 나가는 노트를 저장하고 들어오는 노트를 복원하는 스왑 지점이 된다. 신규 `resume()`/`playNote()`/`stop()`로 이어듣기·정지+해제를 처리하고, 엔진은 새 src 로드 후 복원 위치로 seek한다. 전역 UI는 모바일 알약(`GlobalMiniPlayer`, `+layout`)과 데스크탑 떠다니는 창(`DesktopMiniPlayer`, `DesktopWorkspace`) — 둘 다 순수 가시성 술어(`miniPlayerVisibility.ts`)로 표시 여부를 판정한다.

**Tech Stack:** SvelteKit, Svelte 5 runes, TipTap 3, vitest + @testing-library/svelte, fake/real localStorage (jsdom).

---

## File Structure

| 파일 | 책임 |
|---|---|
| `app/src/lib/music/musicProgress.ts` | **신규.** localStorage 기반 노트별 진행상태 맵. 인메모리 맵 + throttled flush + URL 식별. |
| `app/src/lib/music/musicPlayer.svelte.ts` | **수정.** setQueue 스왑(저장/복원), `resume`/`playNote`/`stop`, reportTime→저장, `pendingRestore`/`resumeAt`. |
| `app/src/lib/music/musicAudio.svelte.ts` | **수정.** 새 src 로드 후 `resumeAt` 위치로 seek(이어듣기). |
| `app/src/lib/editor/musicNote/MusicPlayerBar.svelte` | **수정.** 비활성 노트 = 그 노트의 기억된 트랙·위치 표시, ▶ = `playNote`. |
| `app/src/lib/editor/musicNote/miniPlayerVisibility.ts` | **신규.** 순수 가시성 술어 2개(모바일/데스크탑). |
| `app/src/lib/editor/musicNote/GlobalMiniPlayer.svelte` | **신규.** 모바일 떠다니는 알약/펼침 카드. `+layout` 마운트. |
| `app/src/lib/editor/musicNote/DesktopMiniPlayer.svelte` | **신규.** 데스크탑 작업대 떠다니는 플레이어 창. `DesktopWorkspace` 마운트. |
| `app/src/routes/+layout.svelte` | **수정.** 비-chromeless 분기에 `GlobalMiniPlayer` 마운트. |
| `app/src/lib/desktop/DesktopWorkspace.svelte` | **수정.** `DesktopMiniPlayer` 마운트. |
| `app/src/app.css` | **수정.** `--z-miniplayer: 250` 토큰. |
| `app/src/routes/settings/+page.svelte` | **수정.** 음악 노트 가이드 카드(전역 단일 → 노트별 이어듣기 + 미니 플레이어). |

테스트: `tests/unit/music/musicProgress.test.ts`(신규), `miniPlayerVisibility.test.ts`(신규), 기존 `musicPlayer.test.ts`/`musicAudio.test.ts`/`MusicPlayerBar.test.ts` 갱신.

---

### Task 1: `musicProgress.ts` — 노트별 진행상태 저장소

**Goal:** guid별 `{trackUrl, currentTime}`를 localStorage에 저장/복원하는 순수 모듈. 인메모리 맵이 진실 소스라 read-after-write가 동기.

**Files:**
- Create: `app/src/lib/music/musicProgress.ts`
- Test: `app/src/lib/../../tests/unit/music/musicProgress.test.ts` → `app/tests/unit/music/musicProgress.test.ts`

**Acceptance Criteria:**
- [ ] `saveProgress(guid, url, time)` 직후 `loadProgress(guid)`가 `{trackUrl:url, currentTime:time}` 반환(flush 대기 없이)
- [ ] `loadProgress`는 저장 없으면 `null`
- [ ] `clearProgress(guid)`가 그 guid 엔트리만 제거
- [ ] `flushProgress()` 후 새 인메모리 맵(`__resetMusicProgress` 안 함)으로 다시 읽어도 localStorage에서 복원
- [ ] `__resetMusicProgress()`가 인메모리 맵 + localStorage 키 + 타이머를 모두 비움
- [ ] localStorage 없음/손상 JSON에도 throw 없이 빈 맵 동작

**Verify:** `npm run test -- musicProgress` → 전부 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/music/musicProgress.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
	loadProgress,
	saveProgress,
	clearProgress,
	flushProgress,
	__resetMusicProgress
} from '$lib/music/musicProgress.js';

beforeEach(() => __resetMusicProgress());

describe('musicProgress', () => {
	it('save 직후 load 가 동기로 같은 값을 돌려준다', () => {
		saveProgress('A', 'https://h/a.mp3', 42);
		expect(loadProgress('A')).toEqual({ trackUrl: 'https://h/a.mp3', currentTime: 42 });
	});

	it('저장 없으면 null', () => {
		expect(loadProgress('none')).toBeNull();
	});

	it('같은 guid 재저장은 덮어쓴다', () => {
		saveProgress('A', 'https://h/a.mp3', 10);
		saveProgress('A', 'https://h/b.mp3', 5);
		expect(loadProgress('A')).toEqual({ trackUrl: 'https://h/b.mp3', currentTime: 5 });
	});

	it('clearProgress 는 해당 guid 만 지운다', () => {
		saveProgress('A', 'https://h/a.mp3', 1);
		saveProgress('B', 'https://h/b.mp3', 2);
		clearProgress('A');
		expect(loadProgress('A')).toBeNull();
		expect(loadProgress('B')).toEqual({ trackUrl: 'https://h/b.mp3', currentTime: 2 });
	});

	it('flush 후 인메모리 맵을 비워도 localStorage 에서 복원된다', () => {
		saveProgress('A', 'https://h/a.mp3', 7);
		flushProgress();
		// localStorage 직접 확인 — 모듈은 한 키에 직렬화한다.
		const raw = window.localStorage.getItem('tomboy.musicProgress');
		expect(raw).toBeTruthy();
		const parsed = JSON.parse(raw!);
		expect(parsed.A).toMatchObject({ trackUrl: 'https://h/a.mp3', currentTime: 7 });
	});

	it('손상 JSON 이어도 throw 없이 빈 맵', () => {
		window.localStorage.setItem('tomboy.musicProgress', '{not json');
		__resetMusicProgress();
		window.localStorage.setItem('tomboy.musicProgress', '{not json');
		// 다음 save 가 손상값을 무시하고 새로 시작
		saveProgress('A', 'https://h/a.mp3', 3);
		expect(loadProgress('A')).toEqual({ trackUrl: 'https://h/a.mp3', currentTime: 3 });
	});
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm run test -- musicProgress` → FAIL (module not found)

- [ ] **Step 3: 구현** — `app/src/lib/music/musicProgress.ts`

```ts
/**
 * 음악 노트별 재생 위치(이어듣기) 저장소.
 *
 * guid → { trackUrl, currentTime } 를 단일 localStorage 키에 직렬화한다. 노트 데이터가
 * 아니라 로컬 전용(브라우저 스코프, 동기 안 됨). 인메모리 맵(`mem`)이 진실 소스라
 * save 직후 load 가 동기로 최신값을 돌려준다(flush 대기 불필요) — 테스트/UI 모두 단순.
 * localStorage 는 영속 캐시일 뿐이며 throttled flush(5초) + 일시정지/정지/트랙변경/페이지
 * 숨김 시 즉시 flush 로 채운다.
 */

const STORAGE_KEY = 'tomboy.musicProgress';
const FLUSH_MS = 5000;

export interface ProgressEntry {
	trackUrl: string;
	currentTime: number;
}
type StoredEntry = ProgressEntry & { updatedAt: number };
type ProgressMap = Record<string, StoredEntry>;

function safeStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null;
	}
}

function parseStored(): ProgressMap {
	const ls = safeStorage();
	if (!ls) return {};
	const raw = ls.getItem(STORAGE_KEY);
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return {};
		const out: ProgressMap = {};
		for (const [guid, v] of Object.entries(parsed as Record<string, unknown>)) {
			const e = v as Record<string, unknown>;
			if (typeof e?.trackUrl === 'string' && typeof e?.currentTime === 'number') {
				out[guid] = {
					trackUrl: e.trackUrl,
					currentTime: e.currentTime,
					updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0
				};
			}
		}
		return out;
	} catch {
		return {};
	}
}

let mem: ProgressMap = parseStored();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let hideListenerInstalled = false;

function installHideFlush(): void {
	if (hideListenerInstalled || typeof window === 'undefined') return;
	hideListenerInstalled = true;
	window.addEventListener('pagehide', flushProgress);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') flushProgress();
	});
}

function scheduleFlush(): void {
	installHideFlush();
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		flushProgress();
	}, FLUSH_MS);
}

/** 인메모리 맵을 localStorage 로 즉시 직렬화. 타이머도 해제. */
export function flushProgress(): void {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	const ls = safeStorage();
	if (!ls) return;
	try {
		ls.setItem(STORAGE_KEY, JSON.stringify(mem));
	} catch {
		/* 쿼터 초과/비활성 — 인메모리만 유지(세션 동안은 동작) */
	}
}

/** 노트의 마지막 재생 트랙·위치 조회. 없으면 null. */
export function loadProgress(guid: string): ProgressEntry | null {
	const e = mem[guid];
	return e ? { trackUrl: e.trackUrl, currentTime: e.currentTime } : null;
}

/** 진행 위치 갱신(인메모리 즉시 + flush 예약). */
export function saveProgress(guid: string, trackUrl: string, currentTime: number): void {
	if (!guid || !trackUrl) return;
	mem[guid] = { trackUrl, currentTime: Math.max(0, currentTime), updatedAt: Date.now() };
	scheduleFlush();
}

/** 특정 노트 엔트리 제거(노트 삭제 청소용 — 알약 ✕ 는 이걸 호출하지 않는다). */
export function clearProgress(guid: string): void {
	if (mem[guid]) {
		delete mem[guid];
		scheduleFlush();
	}
}

/** 테스트 전용 — 인메모리 맵·타이머·localStorage 키를 모두 비운다. */
export function __resetMusicProgress(): void {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	mem = {};
	const ls = safeStorage();
	try {
		ls?.removeItem(STORAGE_KEY);
	} catch {
		/* ignore */
	}
}
```

- [ ] **Step 4: 통과 확인** — Run: `npm run test -- musicProgress` → PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/music/musicProgress.ts app/tests/unit/music/musicProgress.test.ts
git commit -m "feat(music): 노트별 재생위치 저장소(musicProgress)"
```

---

### Task 2: `musicPlayer.svelte.ts` — 전환 스왑 + resume/playNote/stop

**Goal:** setQueue가 노트 전환 시 나가는 노트를 저장하고 들어오는 노트를 복원하는 스왑 지점이 되고, `resume`/`playNote`/`stop`과 reportTime 저장으로 이어듣기·정지+해제를 구현.

**Files:**
- Modify: `app/src/lib/music/musicPlayer.svelte.ts`
- Test: `app/tests/unit/music/musicPlayer.test.ts`

**Acceptance Criteria:**
- [ ] 기존 setQueue 같은-노트 보존 동작(4개 테스트) 그대로 통과
- [ ] 노트 A 재생(위치 33s) → 노트 B로 전환 → 다시 A `playNote` 시 트랙·위치(33s) 복원, `isPlaying=true`
- [ ] `stop()`은 `isPlaying=false`·`queue=[]`·`activeNoteGuid=null`로 만들되 진행위치는 보존(다시 playNote 하면 복원)
- [ ] `reportTime(t)`가 활성 노트의 진행을 saveProgress 한다
- [ ] 명시적 `play(index)`는 복원(pendingRestore)을 버리고 그 트랙을 0:00부터

**Verify:** `npm run test -- musicPlayer` → 전부 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 추가** — `app/tests/unit/music/musicPlayer.test.ts` 상단 import + beforeEach 갱신, 그리고 새 describe 블록 추가

import 줄을 다음으로 교체:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';
import type { MusicTrack } from '$lib/music/parseMusicNote.js';

const t = (url: string): MusicTrack => ({ url, title: null, display: url, liPos: 0 });

beforeEach(() => {
	__resetMusicPlayer();
	__resetMusicProgress();
});
```

파일 끝에 새 describe 추가:

```ts
describe('musicPlayer 노트별 이어듣기', () => {
	it('다른 노트로 갔다 돌아오면 트랙+위치를 복원해 이어 재생', () => {
		musicPlayer.playNote('A', [t('a'), t('b')]);
		musicPlayer.play(1); // 트랙 b
		musicPlayer.reportTime(33);
		musicPlayer.playNote('B', [t('c')]); // B 로 전환(A@b:33 저장)
		expect(musicPlayer.activeNoteGuid).toBe('B');
		musicPlayer.playNote('A', [t('a'), t('b')]); // A 로 복귀
		expect(musicPlayer.currentIndex).toBe(1);
		expect(musicPlayer.currentTrack?.url).toBe('b');
		expect(musicPlayer.currentTime).toBeCloseTo(33, 0);
		expect(musicPlayer.resumeAt).toBeCloseTo(33, 0);
		expect(musicPlayer.isPlaying).toBe(true);
	});

	it('stop: 정지+활성 해제, 진행위치는 보존', () => {
		musicPlayer.playNote('A', [t('a')]);
		musicPlayer.reportTime(12);
		musicPlayer.stop();
		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.activeNoteGuid).toBeNull();
		expect(musicPlayer.queue.length).toBe(0);
		musicPlayer.playNote('A', [t('a')]);
		expect(musicPlayer.currentTime).toBeCloseTo(12, 0);
	});

	it('명시적 play(index) 는 복원을 버리고 그 트랙을 0:00 부터', () => {
		musicPlayer.playNote('A', [t('a'), t('b')]);
		musicPlayer.play(1);
		musicPlayer.reportTime(20);
		musicPlayer.playNote('B', [t('c')]);
		// A 로 복귀하되 사용자가 트랙 0 을 명시적으로 클릭
		musicPlayer.setQueue('A', [t('a'), t('b')]);
		musicPlayer.play(0);
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.currentTime).toBe(0);
		expect(musicPlayer.resumeAt).toBe(0);
	});
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm run test -- musicPlayer` → FAIL (`playNote`/`resumeAt`/`stop` 없음)

- [ ] **Step 3: 구현** — `app/src/lib/music/musicPlayer.svelte.ts`

상단 import 추가(파일 1행 아래):

```ts
import { saveProgress, loadProgress, flushProgress } from './musicProgress.js';
```

상태 선언부(`let shuffleOrder ...` 다음)에 2개 필드 추가:

```ts
// 노트 전환 복원: setQueue 가 저장된 위치를 여기에 담고, resume() 가 소비해 resumeAt 으로 승격.
let pendingRestore = $state(0);
// 엔진(musicAudio)이 새 src 로드 후 이 위치로 seek 한다(이어듣기). 적용 후 0.
let resumeAt = $state(0);
```

`__resetMusicPlayer` 본문에 추가(마지막 `shuffleOrder = [];` 다음):

```ts
	pendingRestore = 0;
	resumeAt = 0;
```

`setQueue` 메서드를 통째로 교체:

```ts
	/** doc 재파싱/노트 활성화 반영. 같은 노트면 재생 중 url 로 index 보존; 다른 노트로
	 *  전환하면 나가는 노트 위치를 저장하고 들어오는 노트의 저장 위치를 복원한다(이어듣기). */
	setQueue(noteGuid: string, tracks: MusicTrack[], noteName = ''): void {
		const sameNote = noteGuid === activeNoteGuid;
		// 전환이면 나가는 노트의 현재 위치를 저장.
		if (!sameNote && activeNoteGuid && queue[currentIndex]) {
			saveProgress(activeNoteGuid, queue[currentIndex].url, currentTime);
		}
		const prevUrl = sameNote ? (queue[currentIndex]?.url ?? null) : null;
		queue = tracks;
		activeNoteGuid = noteGuid;
		activeNoteName = noteName;
		if (sameNote) {
			let idx = prevUrl ? tracks.findIndex((t) => t.url === prevUrl) : -1;
			if (idx === -1) {
				idx = tracks.length ? 0 : -1;
				isPlaying = false;
				currentTime = 0;
				duration = 0;
			}
			currentIndex = idx;
		} else {
			// 들어오는 노트의 저장 위치 복원(트랙 url 로 식별, 없으면 0번/0초).
			const entry = loadProgress(noteGuid);
			let idx = entry ? tracks.findIndex((t) => t.url === entry.trackUrl) : -1;
			if (idx === -1) idx = tracks.length ? 0 : -1;
			currentIndex = idx;
			isPlaying = false;
			currentTime = 0;
			duration = 0;
			pendingRestore = entry && idx >= 0 ? entry.currentTime : 0;
		}
		if (shuffle) rebuildShuffle(true);
	},
```

`play` 메서드를 교체(상단에 `pendingRestore = 0;` 추가 — 명시적 트랙 선택은 복원을 버린다):

```ts
	play(index: number): void {
		if (queue.length === 0) return;
		pendingRestore = 0;
		const i = clampIndex(index);
		if (i !== currentIndex) {
			currentIndex = i;
			currentTime = 0;
		}
		isPlaying = true;
	},
```

`reportTime` 메서드를 교체(활성 노트 진행 저장):

```ts
	reportTime(t: number): void {
		currentTime = t;
		if (activeNoteGuid && queue[currentIndex]) {
			saveProgress(activeNoteGuid, queue[currentIndex].url, t);
		}
	},
```

`pause` 메서드를 교체(일시정지 시 즉시 flush):

```ts
	pause(): void {
		isPlaying = false;
		if (activeNoteGuid && queue[currentIndex]) {
			saveProgress(activeNoteGuid, queue[currentIndex].url, currentTime);
			flushProgress();
		}
	},
```

getter 묶음(`get shuffle()` 다음)에 `resumeAt` getter 추가:

```ts
	/** 엔진이 새 src 로드 후 seek 할 이어듣기 위치(0 이면 없음). */
	get resumeAt(): number {
		return resumeAt;
	},
```

`setQueue` 다음(메서드 사이 아무 곳)에 신규 메서드 3개 추가:

```ts
	/** 현재(복원된) 활성 노트를 그 위치에서 이어 재생. pendingRestore 를 resumeAt 으로 승격. */
	resume(): void {
		if (queue.length === 0) return;
		if (currentIndex < 0) currentIndex = 0;
		isPlaying = true;
		if (pendingRestore > 0) {
			resumeAt = pendingRestore;
			currentTime = pendingRestore;
		}
		pendingRestore = 0;
	},

	/** 노트를 활성화하고 저장된 위치에서 이어 재생(다른 노트는 정지). 메인 ▶ 진입점. */
	playNote(noteGuid: string, tracks: MusicTrack[], noteName = ''): void {
		this.setQueue(noteGuid, tracks, noteName);
		this.resume();
	},

	/** 엔진이 resumeAt 을 적용하고 비운다(1회성). */
	takeResumeAt(): number {
		const v = resumeAt;
		resumeAt = 0;
		return v;
	},

	/** 정지 + 활성 해제(알약 ✕). 오디오를 멈추고 큐/활성노트를 비우되, 마지막 위치는
	 *  저장해 두어 다음에 그 노트에서 이어 재생할 수 있게 한다. */
	stop(): void {
		if (activeNoteGuid && queue[currentIndex]) {
			saveProgress(activeNoteGuid, queue[currentIndex].url, currentTime);
			flushProgress();
		}
		isPlaying = false;
		queue = [];
		currentIndex = -1;
		currentTime = 0;
		duration = 0;
		activeNoteGuid = null;
		activeNoteName = '';
		pendingRestore = 0;
		resumeAt = 0;
	},
```

- [ ] **Step 4: 통과 확인** — Run: `npm run test -- musicPlayer` → PASS (신규 3 + 기존 전부)

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/music/musicPlayer.svelte.ts app/tests/unit/music/musicPlayer.test.ts
git commit -m "feat(music): 노트 전환 스왑(저장/복원) + resume/playNote/stop"
```

---

### Task 3: `musicAudio.svelte.ts` — 새 src 로드 후 이어듣기 seek

**Goal:** 새 트랙 src 설정 시 `musicPlayer.resumeAt > 0`이면 `loadedmetadata` 후 그 위치로 seek 해 이어듣기가 0:00이 아닌 저장 지점에서 시작되게 한다.

**Files:**
- Modify: `app/src/lib/music/musicAudio.svelte.ts`
- Test: `app/tests/unit/music/musicAudio.test.ts`

**Acceptance Criteria:**
- [ ] 저장 위치가 있는 노트를 `playNote` 하면, `loadedmetadata` 후 `audio.currentTime`이 저장 위치로 설정된다
- [ ] 저장 위치 없는 일반 재생은 seek 부작용 없음(0:00)
- [ ] 자연스러운 다음 곡 전환에는 stale seek가 적용되지 않는다(resumeAt 미설정 시)

**Verify:** `npm run test -- musicAudio` → 전부 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 추가** — `app/tests/unit/music/musicAudio.test.ts`

상단 import에 progress 추가:

```ts
import { saveProgress, __resetMusicProgress } from '$lib/music/musicProgress.js';
```

`beforeEach`에 progress 리셋 추가(`__resetMusicPlayer();` 다음 줄):

```ts
	__resetMusicProgress();
```

`describe('musicAudio 엔진 — 단일 오디오', ...)` 안에 테스트 추가:

```ts
	it('이어듣기: 저장 위치가 있으면 loadedmetadata 후 그 위치로 seek', () => {
		saveProgress('g', 'https://h/a.mp3', 42);
		musicPlayer.playNote('g', [T('https://h/a.mp3', 'a')], '드라이브');
		flushSync();
		const audio = __musicAudioForTest().audio!;
		expect(audio.getAttribute('src')).toBe('https://h/a.mp3');
		audio.dispatchEvent(new Event('loadedmetadata'));
		expect(audio.currentTime).toBeCloseTo(42, 0);
		expect(musicPlayer.resumeAt).toBe(0); // 소비됨
	});

	it('저장 위치 없는 일반 재생은 seek 하지 않는다(0:00)', () => {
		musicPlayer.playNote('g', [T('https://h/a.mp3', 'a')], '드라이브');
		flushSync();
		const audio = __musicAudioForTest().audio!;
		audio.dispatchEvent(new Event('loadedmetadata'));
		expect(audio.currentTime).toBe(0);
	});
```

- [ ] **Step 2: 실패 확인** — Run: `npm run test -- musicAudio` → FAIL (seek 미적용)

- [ ] **Step 3: 구현** — `app/src/lib/music/musicAudio.svelte.ts`

`installMusicAudio` 안의 src 동기화 `$effect`(현재 lines 112-122)를 교체:

```ts
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
```

- [ ] **Step 4: 통과 확인** — Run: `npm run test -- musicAudio` → PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/music/musicAudio.svelte.ts app/tests/unit/music/musicAudio.test.ts
git commit -m "feat(music): 새 src 로드 후 이어듣기 위치로 seek"
```

---

### Task 4: `MusicPlayerBar.svelte` — 비활성 노트는 자기 기억 위치 표시

**Goal:** 인-노트 바가 활성 노트면 라이브, 비활성 노트면 그 노트의 기억된 트랙·위치(일시정지)를 보여주고 ▶ = `playNote`로 이어 재생.

**Files:**
- Modify: `app/src/lib/editor/musicNote/MusicPlayerBar.svelte`
- Test: `app/tests/unit/music/MusicPlayerBar.test.ts`

**Acceptance Criteria:**
- [ ] 다른 노트가 재생 중일 때, 이 노트의 바는 **이 노트의** 첫 곡(또는 기억 위치)을 표시하고 '대기'/'이어듣기', 이전/다음 비활성
- [ ] idle ▶ → `playNote`로 이 노트 활성화·재생, `activeNoteGuid === 이 노트`
- [ ] 활성 노트면 기존처럼 라이브 상태/컨트롤
- [ ] 기존 반복/셔플/빈 노트/큐 재동기화 테스트 통과

**Verify:** `npm run test -- MusicPlayerBar` → 전부 PASS

**Steps:**

- [ ] **Step 1: 테스트 갱신** — `app/tests/unit/music/MusicPlayerBar.test.ts`

상단 import에 progress 추가:

```ts
import { __resetMusicProgress } from '$lib/music/musicProgress.js';
```

`afterEach`의 `__resetMusicPlayer();` 다음 줄에 추가:

```ts
	__resetMusicProgress();
```

기존 테스트 `'다른 노트가 재생 중이면, 이 노트 패널도 글로벌 재생 곡을 표시'`(현재 lines 61-76)를 **새 동작으로 교체**:

```ts
	it('다른 노트가 재생 중이어도, 이 노트 패널은 자기 노트(로컬 첫 곡)를 표시', () => {
		__resetMusicPlayer();
		__resetMusicProgress();
		musicPlayer.playNote('other', [T('https://h/z.mp3', '젭', '밤')], '다른노트');
		const editor = makeEditor(ONE); // 이 노트의 로컬 첫 곡은 'a'
		const { container } = render(MusicPlayerBar, { editor, guid: 'this' });
		flushSync();
		// 글로벌 '젭' 이 아니라 자기 노트의 'a' 를 표시.
		expect(container.querySelector('.music-now b')?.textContent).toBe('a');
		expect(container.querySelector('.music-now')?.textContent).toContain('대기');
		// 비활성 노트는 이전/다음 비활성.
		expect((container.querySelector('button[aria-label="이전"]') as HTMLButtonElement).disabled).toBe(true);
		// 활성 큐는 여전히 다른 노트.
		expect(musicPlayer.activeNoteGuid).toBe('other');
	});
```

기존 `'활성 노트를 편집하면 큐가 재동기화된다'` 테스트의 클릭 라인(`(document.querySelector('button.main') as HTMLButtonElement).click();`)은 그대로 둔다(▶ 가 playNote 로 활성화 → 같은 노트라 setQueue 재동기화는 유지).

- [ ] **Step 2: 실패 확인** — Run: `npm run test -- MusicPlayerBar` → FAIL (현재는 글로벌 곡 표시)

- [ ] **Step 3: 구현** — `app/src/lib/editor/musicNote/MusicPlayerBar.svelte` `<script>` 교체

import에 progress 추가(`resumePlaybackFromGesture` import 다음):

```ts
	import { loadProgress } from '$lib/music/musicProgress.js';
```

표시 파생값 블록(현재 lines 55-62 `globalTrack`~`statusText`)을 교체:

```ts
	// 이 노트가 활성(현재 재생) 노트인가.
	const isThisActive = $derived(musicPlayer.activeNoteGuid === guid);
	// 비활성 노트면 이 노트의 기억된 위치(트랙+초)를 찾는다. version 으로 doc 변경에 반응.
	const remembered = $derived.by(() => {
		version;
		if (isThisActive) return null;
		const e = loadProgress(guid);
		if (!e) return null;
		const tr = parsedNote.flatQueue.find((t) => t.url === e.trackUrl);
		return tr ? { track: tr, time: e.currentTime } : null;
	});
	const localFirst = $derived(parsedNote.flatQueue[0] ?? null);
	const shown = $derived(isThisActive ? musicPlayer.currentTrack : (remembered?.track ?? localFirst));
	const playing = $derived(isThisActive && musicPlayer.isPlaying);
	const label = $derived(shown?.playlistLabel ?? '');
	const statusText = $derived(
		isThisActive
			? playing
				? '재생 중'
				: '일시정지'
			: remembered
				? `이어듣기 ${fmt(remembered.time)}`
				: '대기'
	);
	// 탐색/이전/다음은 라이브(활성 노트)에서만. 비활성은 ▶ 로 이어 재생 후 활성화.
	const seekTime = $derived(isThisActive ? musicPlayer.currentTime : (remembered?.time ?? 0));
```

`startLocal`/`onMainBtn`(현재 lines 70-82)을 교체:

```ts
	function onMainBtn() {
		if (isThisActive) {
			musicPlayer.toggle();
		} else {
			const note = parsedNote;
			if (note.flatQueue.length === 0) return;
			musicPlayer.playNote(guid, note.flatQueue, note.name);
		}
		// 모바일 재생 잠금 해제: 제스처(이 onclick) 안에서 동기로 play().
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	}
```

`fmt` 함수는 `statusText`보다 위에서 선언돼 있어야 한다(현재 lines 93-98). `$derived`는 컴포넌트 평가 시 함수 호이스팅으로 `fmt` 참조 가능하지만, 안전하게 `fmt` 선언을 `<script>` 상단(version 선언 다음)으로 **이동**한다:

```ts
	function fmt(s: number): string {
		if (!Number.isFinite(s) || s < 0) s = 0;
		const m = Math.floor(s / 60);
		const sec = Math.floor(s % 60);
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}
```

(기존 위치의 `fmt` 정의는 제거 — 중복 선언 금지.)

템플릿에서 `isGlobalActive`를 쓰던 disabled/표시 조건을 교체:
- 이전 버튼: `disabled={!isThisActive}`
- 메인 버튼: `disabled={!shown}` / `aria-label={playing ? '일시정지' : '재생'}` / 본문 `{playing ? '⏸' : '▶'}`
- 다음 버튼: `disabled={!isThisActive}`
- 탐색 슬라이더: `value={seekTime}` / `disabled={!isThisActive}` / `max={Math.max(1, isThisActive ? musicPlayer.duration : 1)}`
- 좌측 시간 `{fmt(seekTime)}`, 우측 `{fmt(isThisActive ? musicPlayer.duration : 0)}`

구체 diff(템플릿 lines 110-165) — 다음 블록으로 교체:

```svelte
	<div class="music-row">
		<div class="music-btns">
			<button
				type="button"
				onclick={onPrev}
				disabled={!isThisActive}
				aria-label="이전">⏮</button
			>
			<button
				type="button"
				class="main"
				onclick={onMainBtn}
				disabled={!shown}
				aria-label={playing ? '일시정지' : '재생'}
				>{playing ? '⏸' : '▶'}</button
			>
			<button
				type="button"
				onclick={onNext}
				disabled={!isThisActive}
				aria-label="다음">⏭</button
			>
		</div>
		<div class="music-modes">
			<button
				type="button"
				class="mode"
				class:active={repeat !== 'off'}
				onclick={() => musicPlayer.cycleRepeat()}
				aria-label={repeatLabel}
				title={repeatLabel}>{repeat === 'one' ? '🔂' : '🔁'}</button
			>
			<button
				type="button"
				class="mode"
				class:active={shuffle}
				onclick={() => musicPlayer.toggleShuffle()}
				aria-label="랜덤 섞기"
				aria-pressed={shuffle}
				title="랜덤 섞기">🔀</button
			>
		</div>
		<div class="music-seek">
			<span class="t">{fmt(seekTime)}</span>
			<input
				type="range"
				min="0"
				max={Math.max(1, isThisActive ? musicPlayer.duration : 1)}
				step="0.1"
				value={seekTime}
				oninput={onSeekInput}
				disabled={!isThisActive}
				aria-label="탐색"
			/>
			<span class="t">{fmt(isThisActive ? musicPlayer.duration : 0)}</span>
		</div>
	</div>
```

- [ ] **Step 4: 통과 확인** — Run: `npm run test -- MusicPlayerBar` → PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/musicNote/MusicPlayerBar.svelte app/tests/unit/music/MusicPlayerBar.test.ts
git commit -m "feat(music): 비활성 노트 바는 자기 기억위치 표시 + ▶ 이어 재생"
```

---

### Task 5: `GlobalMiniPlayer` (모바일 알약) + 가시성 술어 + 마운트

**Goal:** 노트를 떠나도 떠 있는 모바일 떠다니는 알약/펼침 카드. 활성 노트가 현재 페이지가 아닐 때만 표시, ✕=정지, 노트 열기 제공.

**Files:**
- Create: `app/src/lib/editor/musicNote/miniPlayerVisibility.ts`
- Create: `app/src/lib/editor/musicNote/GlobalMiniPlayer.svelte`
- Modify: `app/src/routes/+layout.svelte`
- Modify: `app/src/app.css`
- Test: `app/tests/unit/music/miniPlayerVisibility.test.ts`

**Acceptance Criteria:**
- [ ] `miniPlayerVisible(activeGuid, queueLen, currentNoteGuid)`: 활성 있고 큐>0이며 현재 페이지 노트가 활성 노트가 아닐 때만 true
- [ ] 알약은 `--z-miniplayer`(250) 토큰을 쓴다(하드코드 금지)
- [ ] ✕ → `musicPlayer.stop()`, 노트 열기 → `/note/<activeGuid>`로 이동
- [ ] `+layout`의 비-chromeless 분기에만 마운트(데스크탑/embed/welcome 제외)

**Verify:** `npm run test -- miniPlayerVisibility` → PASS · `npm run check` → 0 errors

**Steps:**

- [ ] **Step 1: 실패 테스트(술어)** — `app/tests/unit/music/miniPlayerVisibility.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
	miniPlayerVisible,
	desktopMiniPlayerVisible
} from '$lib/editor/musicNote/miniPlayerVisibility.js';

describe('miniPlayerVisible (모바일)', () => {
	it('활성 노트가 현재 페이지가 아니면 표시', () => {
		expect(miniPlayerVisible('A', 2, 'B')).toBe(true);
		expect(miniPlayerVisible('A', 2, null)).toBe(true); // /notes 등
	});
	it('현재 페이지가 활성 노트면 숨김(인-노트 바가 담당)', () => {
		expect(miniPlayerVisible('A', 2, 'A')).toBe(false);
	});
	it('활성 없음/빈 큐면 숨김', () => {
		expect(miniPlayerVisible(null, 0, 'B')).toBe(false);
		expect(miniPlayerVisible('A', 0, 'B')).toBe(false);
	});
});

describe('desktopMiniPlayerVisible', () => {
	it('활성 노트 창이 안 열려 있으면 표시', () => {
		expect(desktopMiniPlayerVisible('A', 1, new Set(['B', 'C']))).toBe(true);
	});
	it('활성 노트 창이 열려 있으면 숨김(인-노트 바 담당)', () => {
		expect(desktopMiniPlayerVisible('A', 1, new Set(['A', 'B']))).toBe(false);
	});
	it('활성 없음/빈 큐면 숨김', () => {
		expect(desktopMiniPlayerVisible(null, 0, new Set())).toBe(false);
		expect(desktopMiniPlayerVisible('A', 0, new Set())).toBe(false);
	});
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm run test -- miniPlayerVisibility` → FAIL

- [ ] **Step 3: 술어 구현** — `app/src/lib/editor/musicNote/miniPlayerVisibility.ts`

```ts
/**
 * 전역 미니 플레이어 가시성 순수 술어. 컴포넌트(라우트/세션 의존)와 분리해 단위 테스트.
 *
 * 공통 규칙: 활성 노트가 있고(큐>0) 그 노트를 "지금 보고 있지 않을" 때만 미니 플레이어를
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

/** 데스크탑 작업대: 활성 노트의 창이 현재 워크스페이스에 열려 있지 않을 때만 표시. */
export function desktopMiniPlayerVisible(
	activeGuid: string | null,
	queueLen: number,
	openGuids: ReadonlySet<string>
): boolean {
	if (!activeGuid || queueLen <= 0) return false;
	return !openGuids.has(activeGuid);
}
```

- [ ] **Step 4: 술어 통과 확인** — Run: `npm run test -- miniPlayerVisibility` → PASS

- [ ] **Step 5: z 토큰 추가** — `app/src/app.css` `:root`의 `--z-nav: 200;` 다음 줄에 삽입:

```css
	--z-miniplayer: 250; /* 전역 음악 미니 플레이어(알약) — nav 위, 시트 아래 */
```

- [ ] **Step 6: 컴포넌트 구현** — `app/src/lib/editor/musicNote/GlobalMiniPlayer.svelte`

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
	import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';
	import { miniPlayerVisible } from './miniPlayerVisibility.js';

	// 현재 페이지의 노트 guid(/note/[id]). 그 외 라우트는 null.
	const currentNoteGuid = $derived(page.params.id ?? null);
	const visible = $derived(
		miniPlayerVisible(musicPlayer.activeNoteGuid, musicPlayer.queue.length, currentNoteGuid)
	);

	let expanded = $state(false);

	// 드래그 위치(localStorage 기억). 기본 우하단.
	const POS_KEY = 'tomboy.miniPlayerPos';
	function loadPos(): { x: number; y: number } | null {
		try {
			const raw = window.localStorage.getItem(POS_KEY);
			if (!raw) return null;
			const p = JSON.parse(raw);
			if (typeof p?.x === 'number' && typeof p?.y === 'number') return p;
		} catch {
			/* ignore */
		}
		return null;
	}
	let pos = $state<{ x: number; y: number } | null>(null);
	$effect(() => {
		if (pos === null && typeof window !== 'undefined') pos = loadPos();
	});

	let dragging = false;
	let dragDX = 0;
	let dragDY = 0;
	let moved = false;
	function onPointerDown(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		const r = el.getBoundingClientRect();
		dragging = true;
		moved = false;
		dragDX = e.clientX - r.left;
		dragDY = e.clientY - r.top;
		el.setPointerCapture(e.pointerId);
	}
	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		moved = true;
		const x = Math.max(4, Math.min(e.clientX - dragDX, window.innerWidth - 60));
		const y = Math.max(4, Math.min(e.clientY - dragDY, window.innerHeight - 60));
		pos = { x, y };
	}
	function onPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		if (pos) {
			try {
				window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
			} catch {
				/* ignore */
			}
		}
	}

	const track = $derived(musicPlayer.currentTrack);
	const playing = $derived(musicPlayer.isPlaying);

	function onTogglePill(e: MouseEvent) {
		if (moved) {
			e.preventDefault();
			return;
		}
		expanded = !expanded;
	}
	function onPlayPause() {
		musicPlayer.toggle();
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
	function onStop() {
		musicPlayer.stop();
		expanded = false;
	}
	function onSeek(e: Event) {
		musicPlayer.requestSeek(Number((e.currentTarget as HTMLInputElement).value));
	}
	function onOpenNote() {
		const g = musicPlayer.activeNoteGuid;
		if (g) void goto('/note/' + g);
		expanded = false;
	}
	function fmt(s: number): string {
		if (!Number.isFinite(s) || s < 0) s = 0;
		const m = Math.floor(s / 60);
		const sec = Math.floor(s % 60);
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}
</script>

{#if visible && track}
	<div
		class="mini"
		class:expanded
		style={pos ? `left:${pos.x}px; top:${pos.y}px; right:auto; bottom:auto;` : ''}
	>
		{#if expanded}
			<div class="mini-card">
				<button type="button" class="note-link" onclick={onOpenNote} title="노트 열기">
					<b>{track.display}</b>
					<span class="note-name">{musicPlayer.activeNoteName}</span>
				</button>
				<div class="mini-transport">
					<button type="button" onclick={onPrev} aria-label="이전">⏮</button>
					<button type="button" class="main" onclick={onPlayPause} aria-label={playing ? '일시정지' : '재생'}>{playing ? '⏸' : '▶'}</button>
					<button type="button" onclick={onNext} aria-label="다음">⏭</button>
				</div>
				<div class="mini-seek">
					<span class="t">{fmt(musicPlayer.currentTime)}</span>
					<input type="range" min="0" max={Math.max(1, musicPlayer.duration)} step="0.1" value={musicPlayer.currentTime} oninput={onSeek} aria-label="탐색" />
					<span class="t">{fmt(musicPlayer.duration)}</span>
				</div>
				<div class="mini-foot">
					<button type="button" class="open-btn" onclick={onOpenNote}>노트 열기</button>
					<button type="button" class="collapse" onclick={() => (expanded = false)} aria-label="접기">▾</button>
				</div>
			</div>
		{:else}
			<div
				class="pill"
				role="button"
				tabindex="0"
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onclick={onTogglePill}
			>
				<span class="pill-icon">♪</span>
				<button type="button" class="pill-pp" onclick={(e) => { e.stopPropagation(); onPlayPause(); }} aria-label={playing ? '일시정지' : '재생'}>{playing ? '⏸' : '▶'}</button>
				<button type="button" class="pill-x" onclick={(e) => { e.stopPropagation(); onStop(); }} aria-label="정지">✕</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.mini {
		position: fixed;
		right: clamp(0.6rem, 3vw, 1.2rem);
		bottom: calc(var(--topnav-height, 0px) + clamp(0.6rem, 3vw, 1.2rem));
		z-index: var(--z-miniplayer);
	}
	.pill {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		background: var(--surface, #fff);
		border: 1px solid var(--border, #ececea);
		border-radius: 999px;
		box-shadow: 0 3px 10px rgba(0, 0, 0, 0.18);
		padding: 0.3rem 0.5rem;
		cursor: grab;
		touch-action: none;
		user-select: none;
	}
	.pill-icon {
		color: var(--accent, #a05);
		font-size: 1rem;
	}
	.pill button,
	.mini-transport button,
	.mini-foot button {
		border: none;
		background: transparent;
		cursor: pointer;
		font-size: 0.95rem;
		color: var(--text, #333);
		width: 1.9em;
		height: 1.9em;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.pill-pp,
	.mini-transport .main {
		background: var(--accent, #a05);
		color: #fff;
	}
	.mini-card {
		background: var(--surface, #fff);
		border: 1px solid var(--border, #ececea);
		border-radius: 12px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
		padding: 0.7rem 0.8rem;
		width: min(78vw, 320px);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.note-link {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		background: transparent;
		border: none;
		cursor: pointer;
		text-align: left;
		width: 100%;
	}
	.note-link b {
		color: var(--text, #222);
	}
	.note-name {
		font-size: 0.72rem;
		color: var(--text-muted, #777);
	}
	.mini-transport {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.6rem;
	}
	.mini-seek {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.mini-seek input[type='range'] {
		flex: 1;
		accent-color: var(--accent, #a05);
	}
	.mini-seek .t {
		font-size: 0.65rem;
		color: var(--text-muted, #888);
		font-variant-numeric: tabular-nums;
	}
	.mini-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.open-btn {
		width: auto;
		border-radius: 8px;
		padding: 0.25rem 0.7rem;
		background: var(--accent-soft, #f0e6f0);
		color: var(--accent, #a05);
		font-size: 0.8rem;
	}
</style>
```

- [ ] **Step 7: 마운트** — `app/src/routes/+layout.svelte`

import 추가(`installMusicAudio` import 다음):

```ts
	import GlobalMiniPlayer from '$lib/editor/musicNote/GlobalMiniPlayer.svelte';
```

비-chromeless 분기의 `<Toast />` 바로 앞(현재 line 357 `{:else}` 블록 내부, `</div>` 뒤)에 추가:

```svelte
		<GlobalMiniPlayer />
```

즉:

```svelte
		</div>
		<GlobalMiniPlayer />
		<Toast />
		<ImageViewerModal />
		<ImageActionMenu />
	{/if}
```

- [ ] **Step 8: 검증** — Run: `npm run test -- miniPlayerVisibility` → PASS · `npm run check` → 0 errors

- [ ] **Step 9: 커밋**

```bash
git add app/src/lib/editor/musicNote/miniPlayerVisibility.ts app/src/lib/editor/musicNote/GlobalMiniPlayer.svelte app/src/routes/+layout.svelte app/src/app.css app/tests/unit/music/miniPlayerVisibility.test.ts
git commit -m "feat(music): 모바일 전역 미니 플레이어(알약) + 가시성 술어"
```

---

### Task 6: `DesktopMiniPlayer` — 작업대 떠다니는 플레이어 창

**Goal:** 데스크탑 작업대에서 재생 중인 NoteWindow를 닫으면(=활성 노트 창이 안 열려 있으면) 떠다니는 플레이어 패널을 띄우고, '노트 열기'로 창을 복원.

**Files:**
- Create: `app/src/lib/editor/musicNote/DesktopMiniPlayer.svelte`
- Modify: `app/src/lib/desktop/DesktopWorkspace.svelte`

**Acceptance Criteria:**
- [ ] `desktopMiniPlayerVisible`(Task 5)로 표시 판정 — 활성 노트 창이 현재 워크스페이스에 없을 때만
- [ ] 컨트롤(이전/재생·일시정지/다음/탐색) + '노트 열기'(`desktopSession.openWindow`) + ✕(`stop`)
- [ ] 드래그 이동 가능, `.desktop-root` 안에서 `.canvas` 뒤 형제로 마운트(창 위에 표시)
- [ ] `npm run check` 0 errors

**Verify:** `npm run check` → 0 errors (데스크탑 멀티윈도우는 자동화 테스트 없음 — 수동 검증)

**Steps:**

- [ ] **Step 1: 컴포넌트 구현** — `app/src/lib/editor/musicNote/DesktopMiniPlayer.svelte`

```svelte
<script lang="ts">
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
	import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';
	import { desktopSession } from '$lib/desktop/session.svelte.js';
	import { desktopMiniPlayerVisible } from './miniPlayerVisibility.js';

	const openGuids = $derived(new Set(desktopSession.windows.map((w) => w.guid)));
	const visible = $derived(
		desktopMiniPlayerVisible(musicPlayer.activeNoteGuid, musicPlayer.queue.length, openGuids)
	);
	const track = $derived(musicPlayer.currentTrack);
	const playing = $derived(musicPlayer.isPlaying);

	let pos = $state<{ x: number; y: number }>({ x: 0, y: 0 });
	let placed = false;
	$effect(() => {
		if (!placed && typeof window !== 'undefined') {
			placed = true;
			pos = { x: Math.round(window.innerWidth / 2 - 150), y: Math.round(window.innerHeight / 2 - 70) };
		}
	});

	let dragging = false;
	let dragDX = 0;
	let dragDY = 0;
	function onPointerDown(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		const r = el.getBoundingClientRect();
		dragging = true;
		dragDX = e.clientX - r.left;
		dragDY = e.clientY - r.top;
		el.setPointerCapture(e.pointerId);
	}
	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		pos = {
			x: Math.max(0, Math.min(e.clientX - dragDX, window.innerWidth - 80)),
			y: Math.max(0, Math.min(e.clientY - dragDY, window.innerHeight - 40))
		};
	}
	function onPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
	}

	function onPlayPause() {
		musicPlayer.toggle();
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
	function onSeek(e: Event) {
		musicPlayer.requestSeek(Number((e.currentTarget as HTMLInputElement).value));
	}
	function onOpenNote() {
		const g = musicPlayer.activeNoteGuid;
		if (g) desktopSession.openWindow(g);
	}
	function onStop() {
		musicPlayer.stop();
	}
	function fmt(s: number): string {
		if (!Number.isFinite(s) || s < 0) s = 0;
		const m = Math.floor(s / 60);
		const sec = Math.floor(s % 60);
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}
</script>

{#if visible && track}
	<div class="dmini" style={`left:${pos.x}px; top:${pos.y}px;`}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="dmini-grip"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
		>
			<span class="now">♪ 재생 중</span>
			<button type="button" class="x" onclick={onStop} aria-label="정지">✕</button>
		</div>
		<div class="title">{track.display}</div>
		<div class="name">{musicPlayer.activeNoteName}</div>
		<div class="transport">
			<button type="button" onclick={onPrev} aria-label="이전">⏮</button>
			<button type="button" class="main" onclick={onPlayPause} aria-label={playing ? '일시정지' : '재생'}>{playing ? '⏸' : '▶'}</button>
			<button type="button" onclick={onNext} aria-label="다음">⏭</button>
			<button type="button" class="open" onclick={onOpenNote}>노트 열기</button>
		</div>
		<div class="seek">
			<span class="t">{fmt(musicPlayer.currentTime)}</span>
			<input type="range" min="0" max={Math.max(1, musicPlayer.duration)} step="0.1" value={musicPlayer.currentTime} oninput={onSeek} aria-label="탐색" />
			<span class="t">{fmt(musicPlayer.duration)}</span>
		</div>
	</div>
{/if}

<style>
	.dmini {
		position: fixed;
		width: 300px;
		background: #1e1e1e;
		color: #eee;
		border: 1px solid #3a3a3a;
		border-radius: 12px;
		box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
		padding: 0.6rem 0.8rem 0.8rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		/* .desktop-root 안에서 .canvas 뒤 형제로 놓여 창 위에 표시된다. */
	}
	.dmini-grip {
		display: flex;
		align-items: center;
		justify-content: space-between;
		cursor: grab;
		touch-action: none;
		user-select: none;
		margin: -0.2rem -0.2rem 0;
	}
	.now {
		font-size: 0.72rem;
		color: #b98;
	}
	.title {
		font-weight: 600;
	}
	.name {
		font-size: 0.72rem;
		color: #999;
	}
	.transport {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.transport button,
	.dmini-grip .x {
		border: none;
		background: transparent;
		color: #eee;
		cursor: pointer;
		font-size: 0.95rem;
		width: 1.9em;
		height: 1.9em;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.transport .main {
		background: var(--accent, #a05);
		color: #fff;
	}
	.transport .open {
		width: auto;
		border-radius: 8px;
		padding: 0.2rem 0.6rem;
		background: #333;
		font-size: 0.78rem;
		margin-left: auto;
	}
	.seek {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.seek input[type='range'] {
		flex: 1;
		accent-color: var(--accent, #a05);
	}
	.seek .t {
		font-size: 0.65rem;
		color: #999;
		font-variant-numeric: tabular-nums;
	}
</style>
```

- [ ] **Step 2: 마운트** — `app/src/lib/desktop/DesktopWorkspace.svelte`

import 추가(`import SpreadOverlay ...` 다음):

```ts
	import DesktopMiniPlayer from '$lib/editor/musicNote/DesktopMiniPlayer.svelte';
```

`</div>`(`.canvas` 닫힘, 현재 line 349) 바로 다음, `<SidePanel ... />` 앞에 마운트:

```svelte
		</div>

		<DesktopMiniPlayer />

		<SidePanel
```

- [ ] **Step 3: 검증** — Run: `npm run check` → 0 errors

- [ ] **Step 4: 커밋**

```bash
git add app/src/lib/editor/musicNote/DesktopMiniPlayer.svelte app/src/lib/desktop/DesktopWorkspace.svelte
git commit -m "feat(music): 데스크탑 작업대 떠다니는 플레이어 창"
```

---

### Task 7: 설정 가이드 카드 갱신

**Goal:** 음악 노트 가이드 카드를 "전역 단일 재생" 설명에서 "노트별 이어듣기 + 전역 미니 플레이어(닫아도 재생 유지·노트 복귀)"로 갱신. CLAUDE.md 가이드 규약 준수.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte`

**Acceptance Criteria:**
- [ ] "재생은 전역에 하나" 불릿이 새 동작(노트별 이어듣기)으로 교체됨
- [ ] 미니 플레이어(모바일 알약 / 데스크탑 떠다니는 창) + ✕=정지 + 노트 복귀가 가이드에 설명됨
- [ ] `npm run check` 0 errors

**Verify:** `npm run check` → 0 errors

**Steps:**

- [ ] **Step 1: 불릿 교체** — `app/src/routes/settings/+page.svelte`

다음 기존 불릿(현재 lines 1884-1886):

```svelte
						<li><strong>재생은 전역에 하나</strong>입니다. 어느 노트에서 틀든, 열려 있는 모든 음악 노트의
							배너가 <strong>같은 재생 곡</strong>을 표시합니다. 아무것도 재생 중이 아니면 배너는 지금 보는
							노트의 첫 곡을 미리 보여주고, ▶ 로 그 노트를 시작합니다.</li>
```

을 다음으로 교체:

```svelte
						<li><strong>노트별 이어듣기</strong>: 각 음악 노트는 <strong>자신이 어디까지 들었는지</strong>를
							로컬에 기억합니다(노트에 저장 안 됨). 다른 노트를 틀면 이전 노트는 멈추고, 그 노트로 다시
							와서 ▶ 를 누르면 <strong>처음이 아니라 멈췄던 지점부터</strong> 이어 재생됩니다. 재생 중이
							아닌 노트의 배너는 그 노트의 <strong>이어듣기 지점</strong>(없으면 첫 곡)을 보여줍니다.</li>
						<li><strong>전역 미니 플레이어</strong>: 재생 중인 노트를 떠나도 소리는 계속 나고,
							화면에 <strong>떠다니는 미니 플레이어</strong>가 남습니다. 모바일/일반 화면은 <strong>떠다니는
							알약</strong>(드래그 이동, 탭하면 펼쳐져 전체 컨트롤 + <b>노트 열기</b>), 데스크탑 작업대는
							<strong>떠다니는 플레이어 창</strong>으로 떠요. <b>노트 열기</b>로 그 노트로 돌아가고,
							<b>✕</b> 는 재생을 멈춥니다(이어듣기 지점은 보존돼 다음에 다시 이어집니다).</li>
```

- [ ] **Step 2: 검증** — Run: `npm run check` → 0 errors

- [ ] **Step 3: 전체 테스트 + 커밋**

```bash
npm run test
git add app/src/routes/settings/+page.svelte
git commit -m "docs(settings): 음악 가이드 — 노트별 이어듣기 + 미니 플레이어"
```

---

## Self-Review

**Spec coverage:**
- 노트별 진행상태(localStorage) → T1 ✓
- 전환 스왑(저장/복원), 동시 1개 → T2 ✓
- 이어듣기 seek → T3 ✓
- 비활성 노트 바 = 기억 위치 → T4 ✓
- 모바일 떠다니는 알약 + ✕=정지+해제(위치 보존) + 노트 열기 → T5 ✓
- 데스크탑 떠다니는 창 + 노트 열기 → T6 ✓
- 가이드 문서 갱신 → T7 ✓
- 비목표(다중 동시재생/노트 저장/자동재생) 모두 미구현 ✓

**Type consistency:** `loadProgress`/`saveProgress`/`clearProgress`/`flushProgress`/`__resetMusicProgress`(T1) ↔ T2/T3/T4 사용 일치. `ProgressEntry = {trackUrl, currentTime}` 일관. `playNote`/`resume`/`stop`/`takeResumeAt`/`resumeAt`(T2) ↔ T3(`resumeAt`/`takeResumeAt`)·T4·T5·T6(`playNote`/`stop`/`toggle`/`prev`/`next`) 일치. `miniPlayerVisible`/`desktopMiniPlayerVisible`(T5) ↔ T6 사용 일치.

**Placeholder scan:** 모든 스텝에 실제 코드 포함, TBD/TODO 없음. 데스크탑 멀티윈도우 자동화 테스트 부재는 명시(수동 검증).

**알려진 위험:** resume seek는 effect 실행 순서와 무관하게 src effect 안에서 1회성 `loadedmetadata` 리스너로 처리 — stale seek 방지(resumeAt 미설정 시 미적용). `reportTime` 저장은 throttled(인메모리 즉시, flush 5초 + pause/stop/hide 즉시)라 localStorage thrash 없음.
