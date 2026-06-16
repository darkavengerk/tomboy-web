# 데스크탑 레일 음악 플레이어 (작업표시줄 분할)

날짜: 2026-06-16
상태: 승인됨 (브레인스토밍)

## 배경 / 문제

데스크탑 작업대(`/desktop`)에서 음악 노트를 재생하다 그 노트 창을 닫으면, 화면 중앙에
떠다니는 `DesktopMiniPlayer`(드래그 가능한 카드)가 대신 나타난다. 이 떠다니는 패널은
캔버스를 가리고, 노트 창이 열려 있으면 사라져 "재생 컨트롤이 어디 있는지" 일관성이 없다.

원하는 모습: 하나의 플레이어를 **둘로 분할**해 좌측 패널(`SidePanel`, 작업표시줄)에 심는다.

- **항상 보여야 하는 부분**(재생 + 앞/뒤 건너뛰기) → 레일 기본 공간 윗부분, `전체` 카테고리 위.
- **곡 제목 + 진행바** → 호버 시 펼쳐지는 `.main` 영역, 노트 목록(`일정체크`) 위.

## 결정된 동작 (브레인스토밍 확정)

1. **기본 패널(레일 컨트롤)은 항상 표시** — 노트 창 열림/닫힘과 무관. 세션이 한 번도
   없었던 경우(앱 첫 사용)에만 버튼 비활성. 세션은 **localStorage에 지속**되어 새로고침
   후에도 마지막 곡이 복원된다.
2. **재생 버튼은 언제나 재생** — 큐가 소진된 상태(마지막 곡 끝)에서 재생을 누르면
   목록의 처음(0번)부터 재시작한다.
3. **확장 패널(제목+진행바)은 곡이 로드돼 있으면 표시**(일시정지 포함). 단 **10분간
   재생이 없으면(일시정지 유지) 자동 숨김**. 재생 재개 시 복귀. 레일 기본 패널은 영향 없음.
4. **정지(✕) 버튼 없음** — 세션은 다른 노트 재생 전까지 유지. 일시정지로 충분.

## 아키텍처

기존 전역 상태 모델 재사용:

- `lib/music/musicPlayer.svelte.ts` — 모듈 `$state` 싱글톤(큐/인덱스/재생여부/시간/활성노트).
  노트 닫힘에도 생존.
- `lib/music/musicAudio.svelte.ts` — 단일 `<audio>` 엔진, `installMusicAudio()`가
  `$effect.root`로 설치(+layout).
- `lib/music/musicProgress.ts` — 노트별 이어듣기 위치(트랙 url + currentTime) localStorage 맵.

이 위에 두 개의 데스크탑 전용 UI 컴포넌트와 한 개의 세션 지속 모듈을 추가하고,
떠다니는 미니 플레이어를 제거한다.

### 컴포넌트 1 — `RailMusicControls.svelte` (기본 패널)

- 위치: `SidePanel.svelte`의 `.rail` 안, `.workspace-switcher`와 `.rail-chips` 사이.
- 내용: `⏮  ▶/⏸  ⏭` 세 버튼만. 좁은 레일(기본 80px, 최소 60px)에 밀착 — 작은 원형
  버튼, 재생 버튼은 accent 색. 가로 한 줄, 버튼 사이 최소 gap.
- 가시성: **항상 렌더**. `musicPlayer.queue.length === 0`이면 버튼 `disabled`.
- 핸들러:
  - 재생/일시정지 → `musicPlayer.resumeOrRestart()` (신규) + `resumePlaybackFromGesture()`
    (iOS 제스처 언락; 데스크탑은 무해).
  - 이전 → `musicPlayer.prev()`. 다음 → `musicPlayer.next()`. (둘 다 제스처 언락 동반.)
- 의존: `musicPlayer`(전역), `resumePlaybackFromGesture`(musicAudio). props 없음.

### 컴포넌트 2 — `RailNowPlaying.svelte` (확장 패널)

- 위치: `SidePanel.svelte`의 `.main` 안, `.header`(검색/＋새 노트)와 `.list` 사이 →
  첫 노트(`일정체크`) 바로 위. `.main`은 기존대로 `.side-panel:hover` 시 clip-path로 펼쳐짐.
- 내용: 곡 제목(`track.display`) + 노트 이름(`activeNoteName`) + seek `<input range>` +
  시간(`currentTime`/`duration`). DesktopMiniPlayer의 `.title`/`.name`/`.seek` 마크업·서식 재사용.
- 가시성: `queue.length > 0 && !timedOut`. `timedOut`은 10분 타임아웃 로컬 상태:
  - `isPlaying === true` → `timedOut = false`, 타이머 클리어.
  - `isPlaying === false`로 전이 → 10분(600_000ms) `setTimeout` 시작 → 만료 시 `timedOut = true`.
  - seek 등 사용자 상호작용 시 타이머 리셋(재생 아니어도 다시 10분).
  - 컴포넌트 언마운트 시 타이머 클리어.
- seek → `musicPlayer.requestSeek(value)`.
- 의존: `musicPlayer`(전역). props 없음.

### 모듈 3 — `musicSession.svelte.ts` (세션 지속, 신규)

순수 헬퍼 + 설치 함수를 한 파일에(`$effect`는 룬이라 `.svelte.ts` 필요):

- 저장 키: `'tomboy.musicSession'`. 스냅샷 형태:
  ```ts
  type MusicSessionSnapshot = {
    activeNoteGuid: string;
    activeNoteName: string;
    queue: MusicTrack[];     // url + display
    currentIndex: number;
  };
  ```
  `currentTime`은 저장하지 않는다 — 노트별 이어듣기 위치는 기존 `musicProgress`가 담당.
- `saveSession(snap)` / `loadSession(): MusicSessionSnapshot | null` — JSON round-trip,
  손상/구버전 페이로드는 null 폴백(musicProgress 패턴 모방).
- `installMusicSession(): () => void`:
  1. 클라이언트면 `loadSession()` → 있으면 `musicPlayer.restoreSession(snap)` (부팅 복원).
  2. `$effect.root`로 `musicPlayer.activeNoteGuid / activeNoteName / queue / currentIndex`를
     읽어 변동 시 `saveSession(...)` (가벼운 디바운스). 빈 큐면 키 삭제.
  3. 정리 함수 반환(+layout `onMount` 정리에서 호출).
- `+layout.svelte`에서 `installMusicAudio()` 옆에 설치/해제.

### `musicPlayer.svelte.ts` 추가 메서드

- `restoreSession(snap: MusicSessionSnapshot): void`
  - `tracks` 비어 있으면 무시.
  - `queue = snap.queue; activeNoteGuid = snap.activeNoteGuid; activeNoteName = snap.activeNoteName;`
  - `currentIndex = clampIndex(snap.currentIndex)`; `isPlaying = false; currentTime = 0; duration = 0;`
  - `loadProgress(guid)` 결과의 `trackUrl`이 현재 트랙과 일치하면 `pendingRestore = entry.currentTime`,
    아니면 0. (이어듣기 위치는 첫 재생 시 `resume()`이 `resumeAt`으로 승격.)
  - **자동재생 안 함** — isPlaying false 유지.
  - `shuffle`이면 `rebuildShuffle(true)`.
- `resumeOrRestart(): void` — 레일 재생 버튼 진입점.
  - `queue.length === 0` → return.
  - `isPlaying` → `pause()` (기존; 위치 저장).
  - 아니면(일시정지/대기) **소진 판정**:
    - 소진 = `currentIndex < 0` **또는** (재생 순서상 마지막 인덱스 && `duration > 0` &&
      `currentTime >= duration - 0.5`).
    - 소진이면 `play(firstInPlayOrder)` (셔플 고려; 비셔플이면 0).
    - 아니면 `resume()` (pendingRestore가 있으면 resumeAt 승격 → 엔진이 이어듣기 seek).

`reportEnded` / `next` / `prev`의 전역 동작은 변경하지 않는다(반복/셔플 의미 보존).
"목록 처음부터 재시작"은 레일 재생 버튼의 `resumeOrRestart` 소진 판정에서만 발생.

### 제거 / 정리

- `lib/editor/musicNote/DesktopMiniPlayer.svelte` 삭제.
- `DesktopWorkspace.svelte` — `<DesktopMiniPlayer />` mount + import 제거.
- `miniPlayerVisibility.ts` — `desktopMiniPlayerVisible` 제거.
- 유지: 모바일 `miniPlayerVisible`, `GlobalMiniPlayer.svelte`, `miniPlayerDrag.ts`
  (`GlobalMiniPlayer`가 계속 사용).

### 설정 가이드

`app/src/routes/settings/+page.svelte`의 음악 노트 가이드 카드(~line 1960 "전역 미니
플레이어" 항목)를 갱신: 데스크탑은 **좌측 작업표시줄에 재생 컨트롤(전체 위)** + **호버 시
곡 제목·진행바(노트 목록 위)**로 분리돼 노트 창과 무관하게 항상 조작 가능, 새로고침 후에도
마지막 곡 복원, 10분 무재생 시 곡 정보 자동 숨김. 모바일/일반 화면은 기존 떠다니는 미니
플레이어 유지.

## 데이터 흐름

```
[앱 부팅] +layout onMount
  installMusicAudio()      → <audio> 엔진 effect.root
  installMusicSession()
    └ loadSession() → musicPlayer.restoreSession(snap)   (isPlaying=false)
    └ effect.root: musicPlayer 세션 필드 변동 → saveSession()

[레일 ▶ 클릭] RailMusicControls.onPlayPause
  └ musicPlayer.resumeOrRestart()
       ├ 소진 → play(0)
       └ 아니면 resume() → resumeAt 승격
  └ musicAudio effect → audio.src/seek/play

[큐/노트 전환] musicPlayer.setQueue/playNote/next/prev
  └ session effect → saveSession()   (지속)

[호버] .side-panel:hover → .main clip-path 펼침 → RailNowPlaying 노출
  └ queue>0 && !timedOut 일 때 제목+진행바
```

## 부수효과 (의도적)

세션 지속/복원은 `musicPlayer` 전역이라 **모바일에도 적용**. 새로고침 후 모바일
`GlobalMiniPlayer`가 마지막 세션을 복원해 표시한다(이전엔 세션 소실로 미표시). 재생 이어듣기
개선으로 간주하고 그대로 둔다. 데스크탑 한정이 필요하면 복원 호출에 모드 게이트를 추가할 수 있다.

## 테스트

- `tests/unit/music/musicSession.test.ts` (신규) — `saveSession`/`loadSession` round-trip,
  손상 페이로드 null 폴백, 빈 큐 키 삭제. fake localStorage.
- `tests/unit/music/musicPlayer.test.ts` (확장):
  - `restoreSession` — 상태 채우고 `isPlaying === false`(자동재생 안 함), pendingRestore 매칭.
  - `resumeOrRestart` — 소진 상태 → `currentIndex === 0 && isPlaying`; 중간 일시정지 →
    같은 인덱스 resume; 빈 큐 → no-op; 재생 중 → pause.
- `tests/unit/music/miniPlayerVisibility.test.ts` — `desktopMiniPlayerVisible` 케이스 제거.
- (가능하면) `RailMusicControls` 렌더 테스트 — 빈 큐 시 버튼 disabled.

수동: `npm run dev` → 데스크탑에서 음악 노트 재생 → 노트 닫기 → 레일 컨트롤 동작/호버
제목 확인 → 새로고침 후 복원 확인 → 10분 타임아웃(타이머 단축으로 확인 가능).

## 영향 파일

신규:
- `app/src/lib/editor/musicNote/RailMusicControls.svelte`
- `app/src/lib/editor/musicNote/RailNowPlaying.svelte`
- `app/src/lib/music/musicSession.svelte.ts`
- `app/tests/unit/music/musicSession.test.ts`

수정:
- `app/src/lib/music/musicPlayer.svelte.ts` (restoreSession, resumeOrRestart)
- `app/src/lib/desktop/SidePanel.svelte` (두 컴포넌트 mount)
- `app/src/routes/+layout.svelte` (installMusicSession)
- `app/src/lib/desktop/DesktopWorkspace.svelte` (DesktopMiniPlayer 제거)
- `app/src/lib/editor/musicNote/miniPlayerVisibility.ts` (desktopMiniPlayerVisible 제거)
- `app/src/routes/settings/+page.svelte` (가이드 카드)
- `app/tests/unit/music/musicPlayer.test.ts`, `miniPlayerVisibility.test.ts`

삭제:
- `app/src/lib/editor/musicNote/DesktopMiniPlayer.svelte`
