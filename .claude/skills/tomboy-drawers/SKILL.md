---
name: tomboy-drawers
description: Use when working on the 데스크탑 서랍 (desktop drawers) feature — F2(상단, 위에서 내려옴) / F3(오른쪽) 전역 슬라이드-인 패널. 2×2 작업공간과 무관한 별도 surface 2개에 노트를 주차(특히 터미널 접속 노트)하고 필요할 때 키로 펼친다. 서랍은 WorkspaceState[] 평행 surface(자체 windows[]+geometryByGuid+nextZ+폭/높이/왼쪽 오프셋)로, SurfaceRef 추상화와 `*On(ref,…)` surface-aware 뮤테이터로 캔버스와 같은 머신을 재사용. 핵심 불변식: 가시성(visible)과 라이브니스(active)를 분리 — 서랍을 열면 캔버스 노트는 active=false(Firebase attach/에디터 레지스트리 양보)지만 hidden=false(뒤에 그대로 보임). 노트 이동은 MOVE 시맨틱(surface별 geometry 독립). 닫기(✕)는 서랍 열림 시 방향 화살표(F2 ↑ / F3 →)로 바뀌어 stashToActiveDrawer; 캔버스 창을 서랍 패널로 드래그-드롭해도 들어감. 영속 v4(drawers+drawerWidths+옵셔널 drawerHeights/drawerLefts, v3/v2 하위호환).
---

# 데스크탑 서랍 (F2 / F3)

ddterm에서 착안한 전역 슬라이드-인 패널 2개. **F2 = 상단**(위에서 내려옴, 폭·높이·왼쪽
여백 조절), **F3 = 오른쪽**(폭 조절). 2×2 작업공간(`currentWorkspaceIndex`)과 무관하게
**전역**으로 유지된다. 주 용도: 터미널 접속 노트를 주차해 두고(서랍 닫혀도 WS 살아 있음)
필요할 때 키로 펼쳐 확인.

## 경로
- `app/src/lib/desktop/session.svelte.ts` — 서랍 상태/뮤테이터/영속 + `dropDraggedWindow`/`drawerViewportRect` (코어)
- `app/src/lib/desktop/DrawerOverlay.svelte` — 슬라이드-인 패널 + 리사이즈 그립 + 서랍 노트 `ondragend`
- `app/src/lib/desktop/DesktopWorkspace.svelte` — F2/F3 키, 캔버스 가시성/라이브니스 분기, `.drag-layer` 호스트, `handleCanvasDragEnd`
- `app/src/lib/desktop/NoteWindow.svelte` — `surface`/`hidden`/`stashArrow` props + `beginLift`(드래그 리프트) + `use:dragLift`
- `app/src/lib/desktop/dragLift.ts` — 드래그 중 `.note-window`를 `.drag-layer`로 reparent하는 Svelte 액션(플레이스홀더 복원)
- `app/src/app.css` — `--z-drawer: 350`, `--z-drag: 450` (`--z-sheet` 300 < `--z-drawer` < `--z-menu` 400 < `--z-drag` 450 < `--z-banner` 500)
- 테스트: `app/tests/unit/desktop/{drawerState,moveWindowToSurface,drawerPersist,dropDraggedWindow,dragLift}.test.ts`
- 설계: `docs/superpowers/specs/2026-06-20-desktop-drawers-design.md`,
  `docs/superpowers/specs/2026-06-26-drawer-drag-lift-design.md`,
  `docs/superpowers/plans/2026-06-20-desktop-drawers.md`

## 상태 모델 (session.svelte.ts)
서랍은 작업공간과 **구조적으로 같은** `WorkspaceState`(`windows[]` + `geometryByGuid` +
`nextZ`) 배열이다 — 같은 머신을 그대로 재사용.

```ts
let drawers = $state<WorkspaceState[]>(…)   // DRAWER_COUNT(=2)개, 인덱스 0=상단 1=오른쪽
let activeDrawer = $state<number | null>(null) // 열린 서랍(=라이브 surface), null=캔버스 라이브
let drawerWidths  = $state<number[]>(…)   // 둘 다 사용 (기본 상단 760 / 오른쪽 480)
let drawerHeights = $state<number[]>(…)   // 상단만 사용 (기본 380)
let drawerLefts   = $state<number[]>(…)   // 상단만 사용 (레일 우측 핸들로부터 왼쪽 여백, 기본 100)
```

**SurfaceRef** = `{ kind:'workspace'|'drawer'; index }`. `surfaceState(ref)`가 알맞은
`WorkspaceState`를 돌려주고, 모든 surface-aware 뮤테이터(`moveWindowOn`/`updateGeometryOn`/
`focusWindowOn`/`closeWindowOn`/`togglePinOn`/`sendToBackOn`)가 ref로 대상 surface를 지정.
`NoteWindow`에 `surface` prop이 있으면 리사이즈/핀/뒤로보내기가 `*On(surface,…)`로,
없으면(캔버스) 레거시 현재-작업공간 호출로 라우팅.

## 핵심 불변식 — 가시성 ≠ 라이브니스 (load-bearing)
서랍을 열어도 **뒤의 캔버스 노트는 그대로 보여야 한다**(패널은 오버레이). 이를 위해
`NoteWindow`의 두 개념을 **반드시 분리**한다:

- **`active` = 라이브니스**: Firebase attach + 전역 에디터 레지스트리 + 스냅샷 소스 +
  focusRequest 반응만 게이트. 캔버스 노트 `active = isCurrentWs && activeDrawer === null`.
  같은 guid가 캔버스와 열린 서랍에 동시에 있을 때 **한 마운트만 라이브**가 되도록(레지스트리
  last-write-wins/이중 attach 충돌 방지) — 서랍이 열리면 캔버스는 라이브를 양보.
- **`hidden` = 가시성**(`class:hidden` → display:none): 캔버스 노트 `hidden = !isCurrentWs`
  (작업공간 전환만 숨김). **서랍 열림은 가시성에 영향 없음.** 미지정 시 `!active`로 폴백
  (그래프 뷰 등 레거시 호출 호환).

⚠️ `class:hidden={!active}`로 되돌리면 = **F2/F3 누르는 순간 캔버스 노트 전부 사라지는**
원래 버그 재발(c4c9989a 이후 ~bb64f85a에서 수정). 절대 다시 합치지 말 것.

- Settings/Admin/History 창은 서랍 충돌이 없으므로 `active = isCurrentWs`(서랍 상태 무관) —
  서랍 열려도 숨지 않음.
- 서랍 내 `NoteWindow`는 `active={open}`(닫히면 양보) + `hidden={false}` — 패널 자체가
  `transform`으로 화면 밖에 나갈 뿐 display:none이 아니라서 **레이아웃/치수 유지**(터미널
  xterm fit 등 measurement 보존, keep-alive).
- 터미널 WS는 `active`와 **무관**(TerminalView는 `terminalConnectMode`로만 게이트) — 서랍을
  열고 닫아도, 작업공간을 전환해도 연결 유지.

## Geometry — surface별 독립 + 상단 서랍 2.5D
- **surface별 `geometryByGuid` 독립.** 같은 노트를 캔버스/서랍/다른 서랍에 둬도 각자 위치·크기.
  `moveWindowToSurface(from,to,guid,drop?)`는 **MOVE**(원본에서 제거, 원본 pose 캐시 → 재진입
  복원). 첫 진입은 target 캐시 → `drop` 좌표(클램프) → 기본 슬롯 순.
- **서랍 패널 크기**(노트 창이 아니라 패널 자체):
  - 상단(F2): 왼쪽 여백(`drawerLefts`) + 폭(`drawerWidths`) + 높이(`drawerHeights`).
    CSS `left: calc(var(--rail-width) + var(--drawer-left))`, `width`, `height`, `top:0`,
    `transform: translateY(-110%)` → `.open` translate(0).
  - 오른쪽(F3): 폭만. `right:0; top:0; bottom:0`, `translateX(110%)`.
- **상단 왼쪽 그립 = resize-from-left.** `setDrawerLeftKeepRight(i,px)`가 **오른쪽 변 고정**한
  채 왼쪽 변만 이동(left+width 원자 갱신). 기본 왼쪽 여백 100, 최소 16(절대 0 아님) —
  레일 우측의 리사이즈 핸들(x≈railWidth)을 항상 비워 서랍 조절이 레일 조절과 안 겹치게.
- **크기 상한 없음.** 폭/높이 클램프는 **바닥값 100만**(0/슬리버 방지), 위로는 무제한.
  `clampDrawerWidth/Height`는 `Math.max(MIN, round)`, max 없음.

## 펼침/넣기 UX
- **F2/F3 키**(DesktopWorkspace `onKey`, 무수식어, preventDefault): `toggleDrawer(0|1)` —
  닫혀 있으면 열고, 열린 그놈이면 닫고, 반대 서랍이 열려 있으면 그쪽으로 전환. **한 번에 하나.**
- **닫기 버튼 → 방향 화살표.** 서랍 열리면 캔버스 노트의 ✕가 화살표로 바뀜:
  `stashArrowDir` = 0→`'up'`(↑) / 1→`'right'`(→). 클릭 = `stashToActiveDrawer(guid)`
  (= 현재 작업공간 → 열린 서랍 MOVE). `stashArrow`는 `visible`일 때만 표시.
- **드래그-드롭 (drag-lift, 양방향).** 모든 이동 핸들(타이틀바 `startDrag`, Alt-드래그
  `handleWindowPointerDown`, 전용 번들 `handleBundleTitleDrag`)이 `beginLift(e)`로 합쳐짐.
  3px 임계 넘으면 `lifted=true` → `use:dragLift`(dragLift.ts)가 `.note-window`를 최상위
  `.drag-layer`(`--z-drag: 450`)로 **reparent** → 서랍 패널(350)/메뉴(400) 위로 떠서
  `.canvas`/`.drawer`의 스태킹 봉인+`overflow:hidden`을 벗어남. 드래그 중엔 surface
  지오메트리 불변, `liftPos`(뷰포트 좌표)로만 위치(`.drag-layer`가 `position:fixed;inset:0`라
  absolute가 뷰포트와 일치). 놓으면 `onEnd:(pointer)=>ondragend(guid,pointer,winTopLeft)` →
  `dropDraggedWindow(from,guid,winTopLeft,pointer,railWidth)`(세션)가 열린 서랍 뷰포트
  사각형(`drawerViewportRect`)으로 **포인터** 히트테스트 → 대상 surface 결정. winTopLeft를
  대상-로컬로 변환(캔버스 `-railWidth`, 서랍 `-rect.left/top`). 같은 surface면 `moveWindowOn`
  (재마운트 없음, 에디터 보존), 다른 surface면 `moveWindowToSurface` + 직후
  `updateGeometryOn`로 **드롭 위치·드래그 크기 강제**(MOVE의 기억-포즈 복원을 덮음 — 드래그는
  WYSIWYG, 버튼 stash/eject는 기억-포즈 유지). 4 케이스 대칭: 캔버스→캔버스, 캔버스→서랍,
  **서랍→캔버스(드래그 아웃, 신규)**, 서랍→서랍. 양쪽 NoteWindow 모두 `ondragend` 배선됨.
  dragLift는 플레이스홀더 주석으로 원위치 복원(리프트 중 형제 재배열에 견고), cross-surface는
  컴포넌트 unmount → `destroy()`가 플레이스홀더만 청소. `.lifting` 클래스가
  `pointer-events:auto`(드래그-레이어는 `none`).
  ⚠️ **물리 이동은 원자적 `Node.prototype.moveBefore()`(Chrome 133+) 사용 — 절대 plain
  `appendChild`/`insertBefore` 로 되돌리지 말 것.** reparent 시 노드를 detach 하면 하위
  스크롤 컨테이너(임베디드 묶음/탭 `.bundle-body`, 노트 에디터, xterm 뷰포트)의 `scrollTop`
  이 0 으로 리셋되고 contenteditable 포커스/캐럿이 날아간다(같은-surface 재배치도 발생 —
  "드래그하면 번들 스크롤 맨 위로" 버그). moveBefore 는 detach 없이 옮겨 이 전부를 보존.
  moveBefore 없는 브라우저(Firefox)는 `atomicMove` 가 스크롤/포커스/Range 스냅샷→plain
  이동→복원으로 폴백. (남은 케이스: cross-surface 드롭은 진짜 remount 라 번들의
  component-local `activePath`/`k`/`winStart` 는 여전히 초기화 — 별도 과제.)
- **꺼내기(⏏) 버튼 = stash의 역방향.** 서랍 안 노트 타이틀바엔 ✕ 옆에 `oneject` prop이
  세팅된 경우(서랍 창만)에만 ⏏ 버튼이 뜬다. 클릭 = `ejectFromDrawer(drawerIndex, guid)`
  (= 서랍 → 현재 작업공간 MOVE). 캔버스 창엔 `oneject` 미전달이라 안 보임. 서랍은 **열린 채
  유지**(stash가 서랍을 닫지 않는 것과 대칭) — 꺼낸 노트는 서랍 패널 뒤 캔버스에 그려지고
  서랍을 닫으면 보인다. ⏏는 비파괴라 close-btn 빨강 hover 대신 중립(파랑) hover.
- `focusedNoteGuid`/`closeWindowOn` 등은 **활성 surface**(서랍 열림 시 그 서랍, 아니면 캔버스)
  기준으로 동작 — Esc 닫기 캐스케이드도 서랍 내에서 순환.

## 영속 (PersistedV4)
- `VERSION = 4`. 스냅샷에 `drawers`(작업공간과 같은 sanitize) + `drawerWidths` +
  **옵셔널** `drawerHeights`/`drawerLefts`(상단 높이/왼쪽은 나중 추가 — 구 v4 블롭 호환).
- `$state.snapshot` 필수(Svelte 프록시는 structured-clone 불가). `activeDrawer`는 **영속 안 함**
  (열림 상태는 세션 한정 — 리로드 시 항상 닫힘).
- 로드: v4면 drawers/폭 복원, heights/lefts는 있으면 클램프·없으면 기본. **v3/v2**는 서랍 없음
  → 빈 서랍 + 기본 폭/높이/왼쪽. `collectExistingGuids`가 서랍 windows도 스캔(삭제된 노트 드롭).

## z / 스태킹 (CLAUDE.md "z-index 레이어 규약" 참고)
- 패널 = `--z-drawer: 350`(시트와 메뉴 사이). 새 토큰은 스케일에만 추가, 하드코딩 금지.
- **드래그-리프트 호스트 `.drag-layer` = `--z-drag: 450`**(메뉴 400 ↔ 배너 500). `.desktop-root`
  (position:fixed → 자체 스태킹 컨텍스트) 안에서 형제인 서랍(350)보다 위라 리프트된 노트가
  서랍 패널을 덮는다. body-포털된 메뉴(`--z-menu`)는 `.desktop-root` **밖**이라 숫자와 무관히
  여전히 위(드래그 중엔 메뉴가 안 떠서 무관). 빈 레이어는 `pointer-events:none`이라 클릭 안 막음.
- **그립 z = 2000001** — `.drawer`(position:fixed + z-index → 자체 스태킹 컨텍스트)에 봉인되어
  바깥과 숫자로 안 겨룸. 컨텍스트 안에서 in-drawer 창(핀=DESKTOP_PINNED_Z 1e6+nextZ)보다도
  위에 있어 항상 잡힘.
- **`transform`은 position:fixed 자손의 컨테이닝 블록을 만든다** → 서랍 안에 inline
  `position:fixed`로 떠야 하는 메뉴(`EditorContextMenu`)는 서랍 transform에 갇혀 위치가 틀어짐.
  반드시 `use:portal`로 `<body>` 탈출(이미 적용). 새로 서랍 안에서 fixed 오버레이를 띄우면
  같은 함정 — 포털 필수.

## 함정
- 캔버스 active를 `activeDrawer===null`까지 묶는 건 **라이브니스에만**. 가시성에 섞지 말 것(위 버그).
- 서랍 열고 닫을 때마다 캔버스 노트들의 Firebase attach/detach 처닝 발생(설계상 허용 — 닫으면 재attach).
- 서랍 노트 기본 진입 pose는 노트 저장 geometry를 **무시**하고 서랍 독자 `geometryByGuid` 사용 —
  노트가 서랍보다 크면 `overflow:hidden`으로 잘림(사용자가 서랍 안에서 리사이즈).
