# 데스크탑 좌측 작업표시줄(SidePanel) 개편

날짜: 2026-06-19
대상: `/desktop` 워크스페이스의 좌측 레일(SidePanel)
파일: `app/src/lib/desktop/SidePanel.svelte`, `app/src/lib/desktop/DesktopWorkspace.svelte`, `app/src/lib/desktop/session.svelte.ts`, 신규 `app/src/lib/desktop/activeNotebooks.svelte.ts`

## 배경 / 현재 동작

데스크탑 SidePanel은 두 컬럼:

- `.rail` (항상 보임): 작업공간 스위처 → `RailMusicControls` → 노트북 칩(`전체`/`미분류`/노트북들) → `고급` 토글.
- `.main` (호버/포커스 시 clip-path로 드러남): 최소화됨 → 검색+새 노트 → `RailNowPlaying` → 노트 목록.

현재 상호작용:

- 노트북 칩 **클릭** → `selectedNotebook` 설정 → `.main`(레일 호버 시 드러남)의 목록이 그 노트북으로 필터.
- 노트 목록은 정렬 후 `keyed.slice(0, 50)`으로 50개 캡.
- `.canvas`(레일 오른쪽 빈 배경)는 클릭 핸들러 없음(드래그=벽지만).
- 작업공간 1(슬립노트)은 `[0] Slip-Box` 자동선택 + `.main` 항상 열림(`always-open`).

## 목표 (사양 4가지)

1. **호버 미리보기**: 노트북 칩에 마우스를 올리면 그 노트북 목록이 `.main`에 보임(클릭 불필요).
2. **클릭=고정/활성**: 노트북 클릭 → 활성 상태 + 상단(음악 컨트롤 밑, `전체` 위)에 고정 추가. 여러 개 가능. 원래 칩 위치도 그대로 남고 활성 표시. 다시 클릭=해제.
3. **무한 스크롤**: 50개 캡 제거. 목록 바닥에 닿으면 추가 로드.
4. **배경 클릭=잠금 열기**: 빈 캔버스 클릭 → 활성 노트북 중 최상단의 목록으로 `.main` 잠금 열림. 활성 없으면 `전체`. 다시 클릭=닫힘.

## 결정된 동작 (브레인스토밍 확정)

- **래치 호버 모델**: 칩을 호버하면 그 노트북 목록이 "래치"되어 커서가 패널(레일+main) 안에 있는 동안 유지. 패널 밖으로 나가면 기본값(최상단 활성 / 전체)으로 복귀. 다른 칩 호버 시 그쪽으로 전환. → 칩에서 목록으로 마우스를 옮겨 노트를 클릭해도 목록이 사라지지 않음.
- **고정 저장 = 작업공간별 영구**: 4개 작업공간 각각 자기 활성 노트북 셋을 기억. 새로고침해도 유지(appSettings 저장, 레일 너비와 동일 패턴).
- **고정 스트립 위치**: `RailMusicControls` 바로 밑, `rail-chips`(전체) 직상단.
- **`전체` 클릭 = 활성 전부 해제(리셋)**. `전체`는 고정 셋에 저장되지 않는 영구 폴백. 호버 시 전체 노트 미리보기.
- **새 노트 대상 노트북** = 현재 표시 중인 노트북(`displayedNotebook`). 슬립박스 특례 유지.

## 상태 모델

### 신규 모듈 `activeNotebooks.svelte.ts`

작업공간별 활성(고정) 노트북 셋 + 배경-잠금 토글을 보유하는 런 모듈(`.svelte.ts`).

노트북 키 표현 (기존 `selectedNotebook` 도메인과 동일):

- `''` = 미분류
- 문자열 = 노트북 이름
- `전체`(기존 `null`)는 **저장하지 않음** — 영구 폴백이자 "전부 해제" 버튼.

상태:

```ts
let sets = $state<Record<number, string[]>>({}); // wsIndex → 활성 키 배열(topmost first)
let lockedOpen = $state(false);                   // 배경 클릭 잠금(런타임, 비영구)
```

API:

- `list(ws): string[]` — 그 작업공간 활성 셋(순서 보존).
- `top(ws): string | undefined` — 최상단 활성 키(없으면 undefined).
- `isActive(ws, key): boolean`.
- `toggle(ws, key)` — 있으면 제거, 없으면 **맨 앞에 추가**(최신 = topmost = 기본 표시). 디바운스 영구 저장.
- `clear(ws)` — 그 작업공간 활성 셋 비움. 영구 저장.
- `load()` — appSettings `'desktop:activeNotebooks'`에서 `Record<number,string[]>` 로드. `lockedOpen`은 비영구라 로드 안 함.
- `get lockedOpen()` / `toggleLockedOpen()` / `setLockedOpen(b)`.

저장 키: `'desktop:activeNotebooks'`. 저장 패턴은 `sidePanelLayout.svelte.ts`의 디바운스(`setSetting`) 그대로 모방.

로드 시점: `session.svelte.ts:582`의 `desktopSession.load()` 내 `Promise.all([loadPersisted(), recentOpens.load(), sidePanelLayout.load()])`에 `activeNotebooks.load()` 추가.

## 컴포넌트별 변경

### 1. `SidePanel.svelte`

**제거**: `selectedNotebook` `$state` + `selectNotebook()` + 작업공간 전환 시 리셋하는 `$effect`. (작업공간별 기본값은 활성 셋 + 슬립노트 always-open 분기로 대체.)

**호버 래치 상태**:

```ts
let latched = $state<string | null | undefined>(undefined); // 마지막 호버 칩 키, undefined=없음
```

- 각 칩에 `onpointerenter={() => latched = key}` (key는 전체=null, 미분류='', 노트북=이름).
- 패널 `aside`에 `onpointerleave={() => latched = undefined}`.

**표시 노트북 파생**:

```ts
const displayedNotebook = $derived(
  latched !== undefined
    ? latched
    : (alwaysOpen ? SLIPBOX_NOTEBOOK : (activeNotebooks.top(currentWorkspace) ?? null))
);
```

`alwaysOpen`(ws1 슬립노트) 분기로 기존 슬립박스 기본값 보존. `latched`가 `null`(전체)/`''`(미분류)도 유효하므로 "없음" 센티넬은 `undefined`.

**`filteredNotes`**: `filterByNotebook(allNotes, displayedNotebook)` 사용(기존 `selectedNotebook` 자리).

**칩 클릭 동작** (rail-chips):

- `전체`(null): `activeNotebooks.clear(currentWorkspace)`.
- `미분류`('')/노트북(이름): `activeNotebooks.toggle(currentWorkspace, key)`.
- 칩 시각 표시: `.active`(녹색, 기존) = `isActive(ws, key)`(고정됨). `.viewing`(옅은 강조, 신규) = `displayedNotebook === key`(현재 표시 중).

**고정 스트립** (신규, `RailMusicControls`와 `rail-chips` 사이):

- `activeNotebooks.list(currentWorkspace)`를 칩으로 렌더(같은 `.rail-chip` 스타일, `.active`).
- 클릭=`toggle`(해제), `pointerenter`=래치(미리보기).
- 알 수 없는 키(삭제/이름변경된 노트북) 필터: `key === '' || notebooks.includes(key)`인 것만 표시.

**새 노트** (`handleNew`):

- 슬립박스 특례: `displayedNotebook === SLIPBOX_NOTEBOOK`로 분기(기존 `selectedNotebook` 자리).
- 그 외: 대상 노트북 = `displayedNotebook && displayedNotebook !== '' ? displayedNotebook : null`.

**무한 스크롤**:

- `let visibleCount = $state(50);`
- `filteredNotes`를 둘로: `fullList`(정렬만, 슬라이스 없음) + `visibleNotes = $derived(fullList.slice(0, visibleCount))`. 목록 렌더는 `visibleNotes` 사용.
- `.list`에 `onscroll`: `scrollTop + clientHeight >= scrollHeight - THRESHOLD(예: 200px)`이고 `visibleCount < fullList.length`면 `visibleCount += 50`.
- `displayedNotebook` 또는 `query` 변경 시 `visibleCount = 50` 리셋(`$effect`).

**잠금 열림 reveal**:

- `aside`에 `class:locked-open={activeNotebooks.lockedOpen}`.
- CSS: `.side-panel.locked-open .main { clip-path: inset(0 0 0 0); pointer-events: auto; }` (always-open과 동일 효과). 트랜지션은 부드럽게 유지(슬라이드 인).

### 2. `DesktopWorkspace.svelte`

**캔버스 배경 클릭**:

- `.canvas`에 `onclick={onCanvasClick}` 추가.
- `function onCanvasClick(e) { if (e.target === e.currentTarget) activeNotebooks.toggleLockedOpen(); }` — 빈 배경만(target===currentTarget=.canvas). 노트 창 클릭은 target이 창 내부라 무시. 벽지 div는 `pointer-events:none`이라 그 위 클릭도 target=.canvas로 도달.
- 닫힘 상태 `.main`은 `pointer-events:none`이라 그 위 빈 영역 클릭도 캔버스에 도달 → 잠금 열림. 잠금 열린 상태에선 `.main` 오른쪽 캔버스 클릭으로 닫힘.

## 데이터 흐름

```
호버: 칩 pointerenter → latched=key → displayedNotebook 재계산 → filteredNotes/visibleNotes 갱신
       패널 pointerleave → latched=undefined → 기본값(top active / 전체 / 슬립박스) 복귀

클릭: 칩 click → activeNotebooks.toggle/clear(ws,key) → sets 갱신(영구 저장)
       → 고정 스트립 + 칩 .active + (래치 없으면) displayedNotebook 갱신

배경: .canvas click(빈 배경) → activeNotebooks.toggleLockedOpen()
       → .side-panel.locked-open 클래스 → .main 열림/닫힘

스크롤: .list onscroll(바닥 근처) → visibleCount += 50 → visibleNotes 확장
```

## 단위 경계

- `activeNotebooks.svelte.ts`: 순수 상태/영속 모듈. 입력=작업공간 인덱스+노트북 키, 출력=활성 셋/최상단/잠금 플래그. UI 의존 없음 → 단독 테스트 가능(목록 토글 순서, clear, 영속 라운드트립).
- `SidePanel.svelte`: 래치 호버 + 표시 노트북 파생 + 무한 스크롤 + 칩/스트립 렌더. activeNotebooks 모듈과 코어 노트 조회에 의존.
- `DesktopWorkspace.svelte`: 캔버스 배경 클릭만 추가(잠금 토글 위임).

## 엣지 케이스 / 불변식

- 래치 센티넬은 `undefined`(전체=null, 미분류=''와 충돌 안 함).
- 작업공간 전환 시 `displayedNotebook`은 그 작업공간 활성 셋 기준으로 자동 재계산(별도 리셋 effect 불필요). `visibleCount` 리셋은 `displayedNotebook` 변경 effect가 처리.
- 슬립노트 ws1: `alwaysOpen` 유지 + 기본 표시=슬립박스. 활성 셋과 독립.
- 삭제/이름변경된 노트북 키는 고정 스트립에서 필터링(저장 셋은 그대로 둬도 무해, 표시만 제외).
- `lockedOpen`은 비영구(새로고침 시 닫힘). 작업공간 전환에는 유지(전역 런타임 1개) — 전환 후 새 작업공간의 기본 목록을 열린 채 표시.

## 테스트

- `activeNotebooks.svelte.ts` 단위(vitest): toggle 추가=맨앞/제거, clear, top, isActive, load/save 라운드트립(fake appSettings).
- SidePanel은 자동 e2e 없음(데스크탑 호버/클립패스). 수동 검증: `npm run dev` → /desktop에서 호버 미리보기/고정/무한 스크롤/배경 잠금.
- `npm run check`(svelte-check) 타입 통과.

## 트레이드오프 / YAGNI

- **무한 스크롤 = DOM 증가**: 기존 50 캡 주석("don't balloon DOM")의 우려를 사양이 명시적으로 뒤집음 → 수용. 가상 스크롤은 YAGNI(필요 시 후속).
- `lockedOpen` 작업공간별 분리 안 함(전역 1개) — 사양 미요구, 단순 우선.
- 가이드 문서: 데스크탑 전용 조작 UX 변경(새 노트 포맷/에디터 블록/환경요건 아님)이라 설정 가이드 카드 추가 대상 아님.
```
