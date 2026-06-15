# 타이틀바 3종 개선 — 설계

날짜: 2026-06-15 · 브랜치: tigress

세 가지 타이틀바 관련 수정을 한 묶음으로 다룬다. 셋 다 `/note/[id]` 모바일 라우트와
데스크탑 `NoteWindow` 의 타이틀바 표면을 건드린다.

## 요구사항

1. **숨은 노트 액션 버튼 노출** — 본문 첫 줄(=타이틀)이 가려지면서 자동화류 노트의
   실행 버튼이 함께 사라지는 현상을 고친다.
2. **모바일 타이틀바 상단 고정 + 컨트롤 이전** — 타이틀바를 상단 고정하고, 우상단에
   흐리게(`opacity:0.35`) 떠 있던 노트북·메뉴 버튼을 타이틀바 우측으로 옮겨 선명하게.
3. **드래그 가능한 노트 아이콘** — 타이틀 좌측에 노트 아이콘. 데스크탑은 다른 노트에
   드롭하면 그 노트에 제목 텍스트가 삽입, 모바일은 클릭 시 제목 복사.

---

## Req 1 — 숨은 노트 액션 버튼 노출

### 원인

`자동화::<id>` / `음악추출::<id>` / `remarkable://…` 시그니처는 **노트의 타이틀 줄
그 자체**다 (`parseAutomationTitle(doc.content[0])`). 각 노트 타입 플러그인은 실행
버튼을 `Decoration.widget(first.nodeSize - 1, …, { side: 1 })` 로 — 즉 **타이틀
단락 DOM 안쪽** 끝에 — 단다. 그런데 `hideTitleLine` (모바일/데스크탑/번들 전부
`true`) 이 `titleIsolationPlugin` 을 통해 첫 노드에 `.tomboy-title-hidden
{ display:none }` 을 건다. 버튼이 그 `display:none` 노드의 자식이라 함께 사라진다.

### 수정

위젯 앵커를 타이틀 **안쪽**(`first.nodeSize - 1`)에서 타이틀 **직후 top-level
경계**(`first.nodeSize`, `side: 1`)로 옮긴다. 버튼이 숨은 타이틀의 *형제* 가 되어
본문 첫 가시 요소로 렌더된다.

- `lib/editor/automationNote/automationNotePlugin.ts`
- `lib/editor/musicExtractNote/musicExtractNotePlugin.ts`
- `lib/editor/remarkableNote/remarkableNotePlugin.ts`

각 한 줄(앵커 위치) 변경. `chartBlock` 은 hrSplit 그리드 셀 보존 때문에 타이틀이
아니라 본문 헤더에 `font-size:0` 접기를 쓰므로 영향 없음 — 그 패턴과 충돌하지 않는다.
`sunoImportPlugin` 은 라인별(본문) 앵커라 무관하나 회귀 확인차 점검한다.

### 비고

`position:sticky` 타이틀바(Req 2)는 박스를 흐름에 남겨 첫 줄을 덮지 않으므로, Req 1 은
순수히 "버튼이 숨은 타이틀의 자식"이라는 원인만 고치면 된다.

---

## Req 2 — 모바일 타이틀바 상단 고정 + 컨트롤 이전

대상: `routes/note/[id]/+page.svelte` (모바일 전용 — 데스크탑 `NoteWindow` 타이틀바는
이미 창 상단 고정이라 제외).

- `.title-bar`: `position: sticky; top: var(--topnav-height); z-index:
  var(--z-sticky); background: var(--color-bg, #fff)` (불투명, 기존 하단 보더 유지).
  모바일은 body(window) 스크롤이라 sticky 가 viewport 기준으로 TopNav 아래에 붙는다.
  `--topnav-height` 는 기존 변수(`calc(clamp(44px,11vw,52px) + safe-area)`).
- 떠 있던 `.editor-meta-bar`(absolute, `opacity:0.35`, blur) 제거. **🗂 노트북 칩** 과
  **⋮ 메뉴** 버튼을 타이틀바 우측으로 이전. `opacity:1`, 흐린 `rgba(...,0.35)`·blur
  대신 선명한 색. "저장 중" 표시는 타이틀 옆 작은 save-dot 으로(데스크탑 NoteWindow
  미러).
- 타이틀바 레이아웃(좌→우): `[📄 노트아이콘] [✎ 편집] [제목 ……] [🗂 노트북] [⋮ 메뉴]`.
  옛 떠있는 블록 자리 확보용 `padding-right: clamp(84px,24vw,140px)` 제거.
- **StickyHeader 상호작용**: eq(`===`) 노트의 `StickyHeader` 도 `navOffset` 에 붙는다.
  타이틀바 높이만큼 오프셋을 더해 겹치지 않고 쌓이게 한다.

### z-index

타이틀바는 "nav 아래로 스크롤되는 in-page 스티키 크롬"이므로 `--z-sticky`(100). TopNav
`--z-nav`(200) 아래, 본문/음악바(z:5) 위. 노트북 시트(`--z-sheet` 300)·액션시트는
별도 포털이라 무관.

---

## Req 3 — 드래그 가능한 노트 아이콘

타이틀 좌측 공유 `📄` 핸들. 모바일 `.title-bar` + 데스크탑 `NoteWindow` 타이틀바 양쪽.

### 드래그 소스

- **데스크탑**(`NoteWindow`): `draggable=true` + `data-no-drag`(창 이동 포인터드래그가
  `startDrag` 에서 bail). `dragstart` → `dataTransfer.setData('application/
  x-tomboy-note-title', title)` (+ `text/plain` 폴백). 기본 드래그 이미지가 아이콘
  자신이라 "아이콘만 따라옴" 자동 충족.
- **양쪽**: 클릭 → `navigator.clipboard.writeText(title)` + 토스트.

핸들 구현은 작은 공유 컴포넌트(`NoteDragHandle.svelte`)로 두 타이틀바에서 재사용.

### 드롭 타겟

새 PM 플러그인 `lib/editor/noteTitleDrop/noteTitleDropPlugin.ts` 를 TomboyEditor 에
등록(모든 에디터 인스턴스 = 모든 창이 드롭 수용). `handleDrop(view, event)`:

1. `dataTransfer` 에 `application/x-tomboy-note-title` 없으면 `false`(기본 처리에 위임 —
   이미지 드롭 등).
2. `pos = view.posAtCoords({ left, top })`.
3. **본문 내 유효 드롭**: 해당 `pos` 에 **제목 평문** 삽입. 좌/우에 비공백 문자가
   인접하면 그 쪽(좌·우·양쪽)에 공백 한 칸 추가.
4. **데드스페이스 드롭**(문서 하단 패딩 등 캐럿이 닿지 못하는 곳): 에디터의 현재
   selection 위치에 줄바꿈(새 단락) 후 제목 삽입.
5. 평문이므로 기존 deferred 자동링크 플러그인이 제목과 일치하면 링크로 변환
   (사용자 선택 = "일반 제목 텍스트").

`event.preventDefault()` + `return true` 로 기본 드롭 억제.

---

## 파일

**신규**
- `lib/editor/noteTitleDrop/noteTitleDropPlugin.ts`
- `lib/components/NoteDragHandle.svelte` (또는 두 타이틀바 인라인)
- 본 스펙 + 설정 가이드 카드

**변경**
- `lib/editor/automationNote/automationNotePlugin.ts` (Req 1)
- `lib/editor/musicExtractNote/musicExtractNotePlugin.ts` (Req 1)
- `lib/editor/remarkableNote/remarkableNotePlugin.ts` (Req 1)
- `routes/note/[id]/+page.svelte` (Req 2 + 핸들)
- `lib/desktop/NoteWindow.svelte` (핸들)
- `lib/editor/TomboyEditor.svelte` (드롭 플러그인 등록)
- `lib/editor/eqHeader/StickyHeader.svelte` (오프셋)
- `routes/settings/+page.svelte` (가이드 카드 — CLAUDE.md 요구)

## 테스트

- vitest: 드롭 플러그인 공백 로직(인접 텍스트→공백, 데드스페이스→줄바꿈 폴백);
  앵커 이전 후 데코레이션(버튼이 숨은 타이틀의 자식이 아니라 top-level 형제).
- 수동: 모바일 sticky + 복사, 데스크탑 창↔창 드래그.

## 결정 사항

- 삽입 형식 = **일반 제목 텍스트**(자동링크가 후처리). 명시적 링크 마크 아님.
- 삽입 위치 = **드롭 지점** + 인접 공백 보정 / 데드스페이스 시 현재 커서 + 줄바꿈 폴백.
- ✎ 편집 버튼은 📄 아이콘과 함께 유지. 데스크탑 아이콘 클릭도 복사(모바일과 동일).
