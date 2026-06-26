# 서랍 드래그-리프트 (drag-lift) 설계

2026-06-26

## 문제

데스크탑 F2(상단)/F3(오른쪽) 서랍이 열리면 패널이 `--z-drawer: 350`으로 캔버스
노트 위를 덮는다. 노트를 마우스로 옮기는 중 서랍을 여닫으면(F2/F3) 드래그 중인
노트가 패널 뒤로 가려져 어디로 옮기는지 보이지 않는다. 또 서랍 안 노트는
`overflow:hidden`에 갇혀 드래그로 꺼낼 수 없다(현재는 ⏏ 버튼만).

원하는 동작:
1. 마우스로 드래그 중인 노트는 서랍이 열리든 닫히든 **항상 맨 위**에 보인다.
2. 놓은 곳에 노트가 놓인다 — 캔버스에 있던 노트를 서랍에 놓으면 서랍으로 이동,
   서랍 노트를 캔버스에 놓으면 캔버스로 이동(양방향).
3. 마우스를 누른 채 F2/F3로 서랍을 여닫을 수 있다(드래그 중 토글).

## 핵심 제약 (왜 z만 올려선 안 되나)

- `.canvas`는 `position:fixed` → **자체 스태킹 컨텍스트**로 봉인. 안의 노트 z를
  아무리 올려도 형제인 `.drawer`(z 350)를 못 넘는다.
- `.canvas`와 `.drawer` 모두 `overflow:hidden` → 클리핑.

따라서 드래그 중인 노트를 **DOM에서 끌어올려(reparent)** 서랍보다 위 레이어에
띄워야 한다.

## 접근 (채택: A — drag-lift 레이어)

드래그 동안만 해당 노트의 `.note-window` DOM을 최상위 `.drag-layer`(서랍보다 위
`--z-drag` 토큰)로 옮긴다. **Svelte 액션으로 reparent** → 컴포넌트 인스턴스는
살아 있어 같은 surface 내 드래그에선 에디터 재생성이 없다. 놓을 때 열린 서랍
사각형과 포인터를 히트테스트해 대상 surface를 정하고 이동/지오메트리 갱신.

기각: (B) `.canvas` 봉인 해제 — 핀 캔버스 노트(z 1e6)가 서랍 위로 튀는 회귀 +
드래그-아웃 클리핑 미해결. (C) 고스트 클론 — 라이브 에디터 상태 미러 불가 + 렌더
경로 이중화.

## 컴포넌트

### `--z-drag` 토큰 (`app/src/app.css`)
- 값 450. `--z-menu`(400) ↔ `--z-banner`(500) 사이에 끼움(스케일 규약: 100 간격
  사이 wedge 허용). 드래그 중 노트는 서랍/메뉴 위, 배너/토스트/모달 아래.

### `.drag-layer` (`DesktopWorkspace.svelte`)
- `.desktop-root`의 **마지막 자식**(서랍 뒤). `position:fixed; inset:0;
  overflow:visible; pointer-events:none; z-index:var(--z-drag)`. 빈 호스트 —
  리프트된 노트만 들어와 자기 `pointer-events`를 되살린다.

### `dragLift` 액션 + 리프트 상태 (`NoteWindow.svelte`)
- 로컬 `lifted: boolean`, `liftPos: {x,y} | null`(뷰포트 좌표).
- `use:dragLift={lifted}`: true 되면 원래 부모+nextSibling 기억 후 `.drag-layer`로
  `appendChild`; false 되면 원래 슬롯으로 복귀(`insertBefore`).
- 리프트 중 스타일은 `liftPos`(뷰포트)로 위치 — `.drag-layer`가 `position:fixed;
  inset:0`이라 absolute 좌표가 뷰포트와 일치. 클리핑 없음.
- 드래그 시작(타이틀바 `startDrag`, Alt-드래그 `handleWindowPointerDown`, 전용
  번들 `handleBundleTitleDrag`)은 **~3px 임계** 넘은 뒤 리프트(클릭/포커스 시
  깜빡임 방지). `onMove`는 `liftPos`만 갱신(드래그 중 surface 지오메트리 불변).
- `onEnd`: 호스트에 `(guid, pointer, winTopLeft)` 전달 후 `lifted=false`.
- `ondragend` prop 시그니처: `(guid, pointer, winTopLeft) => void`로 확장.

### `dropDraggedWindow` (`session.svelte.ts`)
시그니처: `dropDraggedWindow(from: SurfaceRef, guid: string, winTopLeft:{x,y},
pointer:{x,y}, railWidth: number): Promise<void>`.

- 열린 서랍(`activeDrawer`)이 있으면 그 뷰포트 사각형 계산:
  - 상단(0): `left = railWidth + drawerLeft, top = 0, width = drawerWidth,
    height = drawerHeight`.
  - 오른쪽(1): `left = innerWidth - drawerWidth, top = 0, right = innerWidth,
    bottom = innerHeight`.
- 포인터가 그 사각형 안 → 대상 = 그 서랍. 아니면 → 캔버스(현재 작업공간).
- `winTopLeft`를 대상-로컬로 변환: 캔버스 `x-=railWidth`; 서랍 `x-=rect.left,
  y-=rect.top`. (음수는 기존 mutator가 ≥0 클램프.)
- 대상 === from → `moveWindowOn`(지오메트리 갱신, 재마운트 없음).
  대상 ≠ from → `moveWindowToSurface(from, to, guid, {변환좌표})`(기존 MOVE).

4 케이스 대칭: 캔버스→캔버스, 캔버스→서랍, **서랍→캔버스(신규)**, 서랍→서랍.

### 배선
- `DesktopWorkspace`: `.drag-layer` 렌더, 캔버스 NoteWindow의 `ondragend` →
  `dropDraggedWindow(from=캔버스, …, railWidth)`. 기존 `handleCanvasDragEnd`는
  이 호출로 흡수(panel-local drop → winTopLeft 기반으로 교체).
- `DrawerOverlay`: 서랍 NoteWindow에 `ondragend` 전달(현재 캔버스 전용) →
  `dropDraggedWindow(from={drawer,index}, …)`.

## 비목표 / 주의

- 새 영속 상태 없음(리프트는 일시적; 지오메트리는 기존 mutator가 영속).
- cross-surface 이동은 여전히 재마운트 → 라이브 터미널 연결 끊김(stash/eject도
  이미 그러함, 변화 없음).
- 드래그 중 F2/F3는 포인터 캡처 중에도 keydown이 떠서 동작.
- ✕→화살표 stash 버튼, ⏏ eject 버튼은 그대로 유지(드래그는 추가 수단).

## 테스트

- `dropDraggedWindow` 단위 테스트: 대상 선택 + 좌표 변환 4 케이스, 레일/가장자리
  클램프, 서랍 미개방 시 항상 캔버스. (window.innerWidth/Height는 jsdom에서 설정.)
- 마운트 테스트: 임계 넘는 드래그가 `.note-window`를 `.drag-layer`로 reparent,
  같은-surface 드롭에서 원래 슬롯으로 복귀(인스턴스 보존).
