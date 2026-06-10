# 노트별 음악 플레이어 + 전역 미니 플레이어 — 설계

작성일: 2026-06-10
상태: 디자인 확정, 구현 대기
범위: 음악 노트(`음악::`) **재생** 동작 변경. 추출(`음악추출::`)·파서·브릿지 서빙은 무관.

## 배경 / 문제

현재 음악 재생은 **단일 전역 플레이어**다.

- `app/src/lib/music/musicPlayer.svelte.ts` — 상태 룬 모듈 하나(`queue`, `currentIndex`,
  `isPlaying`, `currentTime`, `duration`, `activeNoteGuid`, `activeNoteName`, `repeat`,
  `shuffle` …). 모든 음악 노트가 공유.
- `app/src/lib/music/musicAudio.svelte.ts` — `new Audio()` **1개**를 `$effect.root()`로 위 상태에
  바인딩. `installMusicAudio()`가 `+layout.svelte`에서 1회 설치.
- `app/src/lib/editor/musicNote/MusicPlayerBar.svelte` — sticky 바, **노트마다** 마운트
  (모바일 `/note/[id]`, 데스크탑 `NoteWindow`). 전역 상태를 읽어 표시.

문제점:

1. **재생 위치 기억 없음.** 다른 노트를 재생하거나 노트를 떠나면 `currentTime`이 초기화. 다음에
   ▶ 누르면 처음부터.
2. **노트별 독립 상태 없음.** 큐가 전역 1개라 노트 전환 시 통째로 교체. 노트 A를 듣다 B를 듣고
   다시 A로 오면 A는 "어디까지 들었는지"를 잊는다.
3. **재생 중 노트를 닫으면 UI가 사라진다.** 오디오 엔진은 전역(`+layout`)이라 소리는 계속 나지만,
   `MusicPlayerBar`는 노트마다 마운트되므로 노트를 떠나면 **그 노트로 돌아갈 수단도, 컨트롤도 없다.**

## 목표

- 각 음악 노트는 **자신의 재생 위치(트랙 + 초)를 기억**한다. ▶ 누르면 처음이 아니라 **이어서 재생**.
- **동시 재생은 1개**다. 노트 B에서 재생하면 노트 A는 정지(요청 명시).
- 재생 정보는 **노트에 저장하지 않고 로컬 전용**(localStorage).
- 재생 중 노트를 닫아도 소리는 계속 나고, **그 노트로 돌아가는 수단**이 남는다.
  - 모바일/일반 라우트: 떠다니는 알약(FAB) → 펼치면 컨트롤 + 노트 열기.
  - 데스크탑 작업대(`/desktop`): 떠다니는 플레이어 창 → 노트 열기로 `NoteWindow` 복원.

## 비목표 (YAGNI)

- **다중 동시 재생 / 노트마다 `<audio>` 분리.** "동시 1개" 요구와 충돌. 엔진은 1개 유지.
- **진행상태를 노트 본문/`.note` XML에 저장.** 로컬 전용 명시.
- **반복/셔플을 노트별로 분리.** 전역 1개 유지(요청에 없음).
- **새로고침 후 자동재생 / 세션 넘는 알약 자동복원.** 브라우저 autoplay 정책 + 사용자 놀람 방지.
  새로고침 후엔 노트별 위치만 보존되어 ▶ 누르면 이어 재생된다(자동으로 소리가 나진 않음).
- **추출(`음악추출::`)·브릿지 `/files`·파서·MediaSession 메타데이터 구조 변경.** 손대지 않음.

## 접근 (택1 결과)

**A. 오디오 엔진 1개 유지 + 노트별 진행상태(localStorage) + 전역 알약/창.** ← 채택

- 단일 `<audio>` 엔진은 그대로. "노트별 독립 상태"는 **노트별 저장된 진행위치**로 구현한다.
  노트를 전환할 때 나가는 노트의 위치를 저장하고, 들어오는 노트의 위치를 복원(seek)한다.
- iOS autoplay 제스처 처리, MediaSession, 프리로드 로직은 손대지 않는다(검증된 함정 회피).

기각:

- **B. 노트마다 `<audio>` 엘리먼트 분리.** "동시 1개만 재생" 요구와 안 맞고, iOS autoplay 제스처·
  MediaSession·프리로드가 N배 복잡. 이득 없음.
- **C. 진행상태를 노트 본문에 저장.** "노트엔 저장 말고 로컬" 요구와 정면 충돌.

## 상세 설계

### 1) 노트별 진행상태 — 신규 `app/src/lib/music/musicProgress.ts`

localStorage 키 하나(`tomboy.musicProgress`)에 맵을 직렬화:

```ts
type ProgressEntry = { trackUrl: string; currentTime: number; updatedAt: number };
type ProgressMap = Record<string /* guid */, ProgressEntry>;
```

공개 API:

- `loadProgress(guid): ProgressEntry | null`
- `saveProgress(guid, trackUrl, currentTime): void` — 인메모리 맵 갱신 + **throttled flush**
  (약 5초마다, 그리고 일시정지/트랙변경/`pagehide`/`visibilitychange:hidden` 시 즉시 flush).
- `clearProgress(guid): void` — 명시적 삭제용(예: 노트 삭제 청소). **알약 ✕는 호출하지 않음**
  (✕는 활성 상태만 비우고 저장 위치는 보존 — §4·확정결정 1).

불변식:

- **트랙 식별은 URL 기준**(인덱스 아님) → 노트 재정렬·항목 추가에 강함. 복원 시 저장된 `trackUrl`을
  현재 `flatQueue`에서 찾고, 없으면(삭제됨) **0번 트랙·0초로 폴백**.
- 인메모리 맵이 진실 소스, localStorage는 영속 캐시. 모듈 로드 시 1회 파싱.
- 손상된 JSON / 용량 초과는 조용히 무시(빈 맵으로 시작). 노트 데이터가 아니므로 손실 허용.
- 노트 데이터는 일절 안 건드림(완전 로컬).

### 2) 활성 노트 전환 = 저장/복원 스왑 — `musicPlayer.svelte.ts` 수정

엔진은 1개 유지. 변경점:

- **활성화 시 스왑**: 노트 B에서 ▶(또는 트랙 클릭) →
  1. 나가는 활성 노트 A가 있으면 `saveProgress(A, A의 현재 trackUrl, currentTime)`.
  2. B 큐 설정 후 `loadProgress(B)` 조회 → 해당 `trackUrl`을 큐에서 찾아 그 인덱스로 시작 +
     **그 `currentTime`으로 seek**. 없으면 처음부터.
  3. `activeNoteGuid = B`. A는 자동 정지(엔진 1개).
- **진행 저장**: `timeupdate`(또는 `currentTime` 변화)마다 `saveProgress(activeNoteGuid, 현재
  trackUrl, currentTime)` (throttled). 트랙 끝/수동 정지/일시정지 시 즉시 flush.
- **트랙 식별 헬퍼**: 현재 재생 트랙의 URL을 얻는 접근자(이미 `queue[currentIndex].url`).
- `setQueue`(라이브 노트 편집 시 큐 재동기화)는 기존대로 현재 트랙 URL 유지 로직 보존.

기존 `activeNoteGuid`/`activeNoteName`는 이미 있으므로 재사용. 새 전역 필드 불필요.

### 3) 인-노트 바 — `MusicPlayerBar.svelte` 수정

각 노트의 sticky 바가 표시할 상태:

- **활성 노트면**: 현재 라이브 상태(지금과 동일).
- **비활성 노트면**: 그 노트의 **기억된 상태**(일시정지, 저장된 트랙·위치)를 표시.
  - 현재는 "첫 트랙 미리보기"를 보여줌 → **`loadProgress(guid)`로 이어듣기 지점**(트랙명 + 위치)을
    보여주도록 변경. 저장된 게 없으면 기존처럼 첫 트랙.
  - ▶ 누르면 §2의 스왑으로 저장 위치에서 이어 재생 + 활성 승격(다른 노트 정지).
- 제스처: 재생 토글은 탭 핸들러 내에서 `resumePlaybackFromGesture()` 동기 호출(기존 유지).

### 4) 모바일 전역 알약 — 신규 `app/src/lib/editor/musicNote/GlobalMiniPlayer.svelte`

`+layout.svelte`에 1회 마운트(전역 셸).

- **표시 조건**: 엔진에 활성 노트가 로드돼 있고(재생 중이든 일시정지든) **현재 페이지가 그 활성
  노트의 편집 페이지가 아닐 때**. 활성 노트 본문에선 sticky 인-노트 바가 풀 컨트롤이므로 알약 숨김
  (중복 방지). `isChromeless`(`/desktop/*`)에선 미표시(거긴 §5 담당).
  - "현재 활성 노트 페이지인지"는 라우트 파라미터(`/note/[id]`의 `id`)와 `activeNoteGuid` 비교로 판정.
- **접힘 알약**: 작은 알약 `♪ ⏸ ✕`.
  - 드래그 이동 가능, 위치 localStorage 기억(`tomboy.miniPlayerPos`), 기본 우하단 TopNav 위.
  - `✕` = **정지 + 해제**(`stop()` + `clearProgress`는 아님 — 진행위치는 보존, 활성 상태만 비움).
    즉 오디오 멈추고 `activeNoteGuid=null`로 알약을 닫는다. 노트의 저장 위치는 남아 다음에 그 노트에서
    이어 재생 가능.
- **펼침**(알약 탭): 카드 —
  - 트랙 제목 / 노트 이름(탭 → 그 노트로 이동), ⏮ ⏸ ⏭, seek 바, 반복/셔플 토글, **노트 열기**
    버튼(`goto('/note/' + activeNoteGuid)`), 접기 버튼.
- iOS autoplay: 재생 토글은 탭 제스처 내 `resumePlaybackFromGesture()` 동기 호출.
- **z-index**: root에서 `position:fixed` 경쟁 → `--z-*` 토큰 사용. 배너(`--z-banner` 500)·토스트
  (`--z-toast` 600) **아래**, 시트(`--z-sheet` 300)/메뉴(`--z-menu` 400) 밴드에 배치(플랜에서
  `--z-sheet` 또는 신규 `--z-miniplayer` 토큰으로 확정). TopNav(`--z-nav` 200) 위.

### 5) 데스크탑 떠다니는 플레이어 창 — `/desktop`

- **트리거**: 재생 중인 `NoteWindow`를 닫을 때. `lib/desktop/session.svelte.ts`의 close 경로에서
  `guid === musicPlayer.activeNoteGuid`이고 활성 큐가 있으면 **떠다니는 플레이어 패널**을 작업대에
  표시(세션 상태에 `floatingPlayer?: { visible, x, y }` 플래그 추가).
- **패널**(신규 컴포넌트, `DesktopWorkspace.svelte` 또는 `SidePanel` 인근에 마운트): 드래그 가능,
  풀 컨트롤 + **노트 열기**(닫혔던 `NoteWindow` 복원/포커스). 노트를 다시 열면 패널 숨김(인-노트 바가
  다시 담당).
- **z-밴드**: 작업대 `.canvas` 밴드 규약 따름(`DESKTOP_PINNED_Z` 문서 참조). 정적 타일이 아니라
  `SidePanel`/`SpreadOverlay`처럼 `.desktop-root` 형제 DOM 순서로 위에 오게 함. 윈도우 z와 충돌 금지.

### 6) 가로지르는 사항

- **새로고침 후**: 자동재생 안 함. 노트별 위치는 보존 → 노트 열고 ▶ 누르면 이어 재생.
- **가이드 문서(필수)**: 설정 → 가이드의 음악 노트 카드(`guideSubTab` `editor` 또는 `notes`)에
  "노트별 이어듣기 + 전역 미니 플레이어(닫아도 재생 유지·노트로 복귀)" 항목 추가/갱신. CLAUDE.md 규약.
- **MediaSession**: 기존 메타데이터/컨트롤 그대로. 활성 노트 스왑 시 자동으로 갱신됨(현 로직 유지).

## 변경 파일 목록

| 파일 | 변경 |
|---|---|
| `app/src/lib/music/musicProgress.ts` | **신규** — 노트별 진행상태 맵 + throttled flush + URL 폴백 |
| `app/src/lib/music/musicPlayer.svelte.ts` | 활성 전환 스왑(저장/복원), timeupdate 저장 훅, `stop()`/해제 |
| `app/src/lib/editor/musicNote/MusicPlayerBar.svelte` | 비활성 노트 = 기억된 위치 표시, ▶=이어 재생 |
| `app/src/lib/editor/musicNote/GlobalMiniPlayer.svelte` | **신규** — 모바일 알약/펼침 카드, 드래그, 표시조건 |
| `app/src/routes/+layout.svelte` | `GlobalMiniPlayer` 마운트(비-chromeless) |
| `app/src/lib/desktop/session.svelte.ts` | close 시 활성 노트면 floatingPlayer 표시, 노트 열기 훅 |
| `app/src/lib/desktop/*PlayerPanel.svelte` (위치 확정 플랜) | **신규** — 작업대 떠다니는 플레이어 |
| `app/src/lib/desktop/DesktopWorkspace.svelte` (또는 SidePanel 인근) | 패널 마운트 |
| `app/src/app.css` | 필요 시 `--z-miniplayer` 토큰 |
| `app/src/routes/settings/+page.svelte` | 가이드 카드 갱신 |

## 엣지 케이스

- **저장된 트랙 URL이 큐에 없음**(삭제/교체) → 0번·0초 폴백.
- **같은 트랙 URL이 여러 노트에 존재** → 진행은 guid별이라 독립.
- **노트 삭제** → 진행 엔트리는 고아로 남음. 다음 로드 시 그 guid 노트가 없으면 자연히 미사용. (선택적
  청소는 비목표.)
- **활성 노트 페이지에 있으면서** 인-노트 바로 재생 중 → 알약 숨김(중복 방지).
- **데스크탑에서 노트를 닫지 않고 활성 노트 그대로** → 패널 미표시(인-노트 바 담당).
- **localStorage 비활성/쿼터 초과** → 조용히 인메모리만, 영속 안 됨(기능 저하 없이 동작).

## 테스트

- `musicProgress`: 저장→로드 라운드트립, URL 폴백(없는 URL→0번/0초), throttle/즉시 flush 시점,
  손상 JSON 무시.
- `musicPlayer` 스왑: 노트 A 재생 중 B 활성화 → A 위치 저장됨 + B 복원됨(`fake` 시간/엔진 모킹).
- `GlobalMiniPlayer`: 표시조건(활성 노트 ≠ 현재 페이지일 때만), ✕=정지+해제, 마운트 렌더 테스트
  (`@testing-library/svelte`).
- `MusicPlayerBar`: 비활성 노트에서 기억된 위치 표시, ▶=이어 재생 스왑 호출.

## 확정된 결정

1. **알약 ✕ = 정지 + 해제**(오디오 정지, `activeNoteGuid` 비움; 노트 저장 위치는 보존).
2. **비활성 노트 인-노트 바 = 기억된 위치 표시**(기존 "첫 트랙 미리보기"에서 변경).
3. **기억 범위 = 트랙 + 재생위치만**. 반복/셔플은 전역 1개 유지.
4. **모바일 = 떠다니는 알약/FAB**, **데스크탑 = 떠다니는 플레이어 창**.
