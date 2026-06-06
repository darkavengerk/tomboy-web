# 잠금화면 백그라운드 음악 재생 설계 (Media Session + 다음 곡 프리로드)

**작성일:** 2026-06-04
**상태:** 확정 (구현 계획 대기)
**관련:** `2026-06-03-music-note-design.md` (음악 노트 기본), `2026-06-03-eq-sticky-header-design.md`

## 목표

음악 노트(`음악::`) 재생 중 폰 화면을 꺼도(잠금) 재생이 끊기지 않고, OS 잠금화면에서 곡 정보 표시 + 재생/일시정지/이전/다음/탐색 컨트롤을 제공한다. 한 곡이 끝나면 잠금 상태에서도 다음 곡으로 자동으로 넘어간다.

## 배경 / 현재 상태

- 오디오는 `MusicPlayerBar.svelte`의 숨김 `<audio>` 하나로 재생되며, 이 컴포넌트는 노트 페이지(`routes/note/[id]/+page.svelte`)와 데스크탑 `NoteWindow.svelte` 안에 마운트된다.
- 재생 상태(`musicPlayer`)는 `lib/music/musicPlayer.svelte.ts`의 모듈 싱글톤 룬 스토어다.
- 앱은 이미 **설치형 PWA**다: `manifest.webmanifest`(`display: standalone`) + `service-worker.ts`. iOS·Android 백그라운드 오디오의 최적 토대.
- **Media Session API 연동이 전혀 없다**(`navigator.mediaSession` 참조 0건). 이게 빠진 핵심 조각이다.
- 직전 작업에서 자동 넘김 버그를 수정했다: 자동 넘김 시 `isPlaying`이 계속 `true`라 같은 값 대입이 no-op이 되어 새 트랙이 멈춤 상태로 로드되던 문제. src 동기화 `$effect`가 `untrack(() => musicPlayer.isPlaying)`이 참이면 새 src에 `play()`를 재발행하도록 고쳤다. 이 설계는 그 위에 얹힌다.

## 문제의 두 갈래

"폰 닫혀도 계속 재생"은 두 가지로 쪼개진다:

1. **현재 곡 재생**: 사용자 제스처로 시작된 `<audio>`는 화면이 꺼져도 대체로 계속 재생된다 — 이미 거의 동작.
2. **빠진 것**: (a) 잠금화면 컨트롤·곡 정보, (b) 잠금 상태에서의 자동 넘김. 백그라운드에선 JS 타이머가 throttle되어 `onended → next → play()`라는 JS 체인이 멈출 수 있다. **Media Session API가 활성 미디어 세션을 등록하면 OS가 페이지를 "음악 앱"으로 취급해 곡 경계를 넘어 JS를 살려둔다** — (b)를 살리는 핵심.

## 범위 결정 (확정)

- **재생 범위 = 잠금화면 중심.** 오디오 엘리먼트는 `MusicPlayerBar` 안에 그대로 둔다. 다른 노트로 이동하면 기존대로 정지(전역 미니플레이어 아님).
- **캐시 = 다음 곡 프리로드만.** 숨김 `<audio>` 두 번째로 다음 곡을 데운다. IndexedDB 오프라인 blob 캐시는 범위 밖.

## 접근법 (확정: A — 모듈 분리)

Media Session 배선을 `lib/music/mediaSession.ts` 모듈로 분리한다. 순수 매핑 함수는 직접 단위 테스트하고, `MusicPlayerBar`는 얇은 `$effect` 배선만 담당한다. (교훈: 컴포넌트 `$effect`는 런타임 mount 테스트가 필요하지만 순수 함수는 직접 테스트가 쉽다.) 프리로드는 오디오 엘리먼트와 밀착돼 있어 `MusicPlayerBar` 안에 인라인한다.

## 컴포넌트 설계

### ① `lib/music/mediaSession.ts` (신규)

순수 매핑 + 얇은 설치자. `navigator.mediaSession` 외엔 어떤 룬 스토어도 변경하지 않으므로 effect 자기-구독 루프 위험이 없다.

```ts
export function isMediaSessionSupported(): boolean;
// 'mediaSession' in navigator

export interface MetaSource {
  trackDisplay: string;
  playlistLabel: string; // '' 가능
  noteName: string;      // MusicNote.name
}
export function buildMetadataInit(src: MetaSource): MediaMetadataInit;
// 순수. { title: trackDisplay, artist: playlistLabel, album: noteName,
//         artwork: [{src:'/icons/icon-192.png',sizes:'192x192',type:'image/png'},
//                   {src:'/icons/icon-512.png',sizes:'512x512',type:'image/png'}] }

export interface MediaSessionHandlers {
  play(): void;
  pause(): void;
  next(): void;
  prev(): void;
  seekTo(time: number): void;
}
export function installMediaSession(h: MediaSessionHandlers): () => void;
// 액션 핸들러 등록(play/pause/nexttrack/previoustrack/seekto). 각 setActionHandler
// 는 try/catch(미지원 액션 대비). 반환값은 uninstall(모든 핸들러 null + metadata null).

export interface SyncState {
  metaInit: MediaMetadataInit | null; // null = 트랙 없음
  isPlaying: boolean;
  duration: number;
  position: number;
}
export function syncMediaSession(state: SyncState): void;
// 모듈 내부 diff(직전 metaInit의 title/artist/album 키 비교)로 metadata 는 변할 때만
// new MediaMetadata 재생성. playbackState = isPlaying ? 'playing' : 'paused'(트랙 없으면
// 'none'). positionState 는 duration>0 && Number.isFinite(duration) 일 때만 position 을
// [0,duration] clamp 후 try/catch 로 set.
```

메타데이터 매핑:
- `title` = `track.display`
- `artist` = 플레이리스트 라벨(`MusicPlayerBar`의 기존 `label` 파생값)
- `album` = `MusicNote.name`(노트 제목)
- `artwork` = 앱 아이콘(`/icons/icon-192.png`, `/icons/icon-512.png`) — 음악 노트엔 앨범아트가 없으므로 기본값.

### ② `MusicPlayerBar.svelte` (수정)

- 숨김 `<audio bind:this={preloadEl} preload="auto">` 추가. **절대 `play()` 호출하지 않음** — 데우기 전용.
- `const nextUrl = $derived(musicPlayer.queue[musicPlayer.currentIndex + 1]?.url ?? '')`.
- `$effect` (프리로드 동기화): `nextUrl`이 있으면 `preloadEl.src = nextUrl`, 없으면 `removeAttribute('src')`. 기존 src 동기화 effect와 같은 가드 패턴.
- `$effect` (핸들러 설치): `isMediaSessionSupported()`면 `installMediaSession({...})` 등록, cleanup에서 uninstall. 핸들러는 스토어로 매핑:
  - `play` → `musicPlayer.play(musicPlayer.currentIndex)` (시간 리셋 없는 resume)
  - `pause` → `musicPlayer.pause()`
  - `next` → `musicPlayer.next()`, `prev` → `musicPlayer.prev()`
  - `seekTo` → `musicPlayer.requestSeek(t)`
- `$effect` (상태 동기화): 반응 값(`track`, `label`, `note.name`, `playing`, `duration`, `currentTime`)을 모아 `syncMediaSession({ metaInit, isPlaying, duration, position })` 호출. diff는 모듈 내부라 컴포넌트는 effect 1개로 유지. `note.name`은 기존 `label` 파생처럼 `parseMusicNote(editor.state.doc).name`에서 얻는다.

### ③ `lib/music/musicPlayer.svelte.ts` (수정)

```ts
pause(): void { isPlaying = false; }
```

'play' 핸들러는 기존 `play(currentIndex)`가 `i === currentIndex`라 시간 리셋 없이 `isPlaying = true`만 세팅 → resume 역할을 이미 한다. 'pause'만 신규 메서드 필요.

## 데이터 흐름

```
잠금화면 버튼 → OS → 액션 핸들러 → musicPlayer 메서드 → 스토어 상태
  → 기존 audio effect(play/pause/seek) → <audio> → timeupdate/ended
  → reportTime/reportEnded → 스토어 → syncMediaSession effect → 잠금화면 갱신
```

자동 넘김(잠금 중): `ended → reportEnded → next → play(i+1)` → `currentIndex` 변경 → src effect가 메인 `<audio>.src`를 다음 URL로 교체(**preloadEl이 이미 데워둬 HTTP 캐시 적중 → 즉시 시작**) → 버그픽스가 `play()` 재발행 → 재생 지속 → Media Session이 경계 너머로 페이지를 살려두고 잠금화면을 새 곡으로 갱신.

## 에러 처리 / 엣지 케이스

모든 Media Session 호출은 **지원 가드 + try/catch**로 감싼다(프로그레시브 인핸스먼트 — 미지원/예외 환경에서도 일반 재생 불변).

| 케이스 | 처리 |
|---|---|
| `mediaSession` 미지원 | `isMediaSessionSupported()` 가드로 전부 no-op. 재생 정상. |
| `setPositionState` 예외 | `duration>0 && Number.isFinite(duration)`일 때만, position `[0,duration]` clamp 후 try/catch. |
| `setActionHandler` 미지원 액션(iOS seek 일부) | 각 등록 try/catch — 하나 실패해도 나머지 정상. |
| 아트워크 경로 문제 | 잠금화면에 아트만 누락, 비치명적. |
| preloadEl 로드 실패 | 무시(데우기 전용, onerror 불필요). 실제 재생은 메인 `<audio>`의 `onerror→next`가 관장. preloadEl은 절대 재생 안 함. |
| 마지막 곡 | `nextUrl=''` → preload src 제거. `next()`는 기존대로 `isPlaying=false` 정지(루프 없음). |
| 노트 이탈(언마운트) | install effect cleanup이 uninstall + metadata=null → 잠금 컨트롤 정리. |
| 잦은 `currentTime` | syncMediaSession 내부 diff로 메타는 변할 때만 재생성, positionState만 매 timeupdate 갱신(가벼움). |

## 테스트

### `tests/unit/music/mediaSession.test.ts` (신규)

jsdom에서 `navigator.mediaSession`(metadata/playbackState/setActionHandler/setPositionState 스텁) + 전역 `MediaMetadata` 클래스 스텁:

- `buildMetadataInit` — `trackDisplay`·`playlistLabel`·`noteName` → title/artist/album/artwork 정확히 매핑.
- `syncMediaSession` — `isPlaying` → `playbackState` 'playing'/'paused', 트랙 없으면 'none'.
- diff — 같은 메타로 재호출 시 metadata 세터 재호출 안 됨, 키가 바뀌면 재호출.
- positionState — `duration<=0`이면 미호출, 유효하면 clamp된 position으로 호출.
- `installMediaSession` — 등록 핸들러가 콜백 호출, uninstall이 핸들러 null 처리.
- 미지원 가드 — `mediaSession` 부재 시 모든 호출 no-op(throw 없음).

### `tests/unit/music/MusicPlayerBar.test.ts` (추가)

기존 스텁/패턴(`HTMLMediaElement.prototype` play/pause/load 스텁, `playSrcs` 기록, `flushSync`) 위에:

- mount 시 잠금화면 metadata가 현재 트랙 반영, `play()` 후 playbackState 갱신.
- 프리로드 — 두 번째 `<audio>` src = 다음 트랙 URL, 마지막 곡에선 빈 값.
- effect 루프 회귀 — `render()` throw 없음(기존 패턴). 기존 자동 넘김 테스트 그대로 통과.
- 공유 setup에 `MediaMetadata` + `navigator.mediaSession` 스텁 추가.

### `musicPlayer.svelte.ts`

기존 스토어 단위 테스트가 있으면 `pause()` 케이스 1개 추가(없으면 생략).

## 가이드 문서 (CLAUDE.md 필수)

`설정 → 가이드`의 **env** 서브탭에 `<details class="guide-card">` 추가. 내용: 잠금화면 재생·컨트롤, **홈 화면 추가(PWA 설치) 권장**, iOS는 잠금 자동 넘김이 버전별로 완벽 보장은 아님, Android는 거의 네이티브. 기존 카드 패턴(짧은 `<summary>` / `info-text` 인트로 / `guide-list`) 미러링.

## 명시적 범위 밖 (YAGNI)

- 앱 전역 미니플레이어 / 네비게이션 넘어 지속 재생.
- IndexedDB 오디오 blob 오프라인 캐시.
- 플레이리스트 반복/셔플.

## 기대치 (실기기 테스트 기준)

- **Android(설치 PWA)**: 잠금 컨트롤 + 자동 넘김 정상.
- **iOS(standalone)**: 잠금 컨트롤·단일곡 재생 탄탄. 자동 넘김은 Media Session + 프리로드로 크게 개선되나 iOS 버전별 100% 보장은 아니므로 실기기 확인 필요.

## 파일 요약

| 파일 | 변경 |
|---|---|
| `app/src/lib/music/mediaSession.ts` | 신규 — 순수 매핑 + 설치자 + 동기화 |
| `app/src/lib/editor/musicNote/MusicPlayerBar.svelte` | 수정 — preload `<audio>` + 3개 `$effect`(preload/install/sync) |
| `app/src/lib/music/musicPlayer.svelte.ts` | 수정 — `pause()` 추가 |
| `app/src/routes/settings/+page.svelte` | 수정 — 가이드 env 카드 추가 |
| `app/tests/unit/music/mediaSession.test.ts` | 신규 — 단위 테스트 |
| `app/tests/unit/music/MusicPlayerBar.test.ts` | 수정 — mediaSession/preload 테스트 + 스텁 |
