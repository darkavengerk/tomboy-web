# `===` 고정 헤더 (sticky header) 설계

작성일: 2026-06-03 · 브랜치: po

## 개요

`---`(수평선/분할/접기) 마커 계열에 형제 마커 `===`를 추가한다. 한 라인에
단독으로 `===`(3개 이상)가 있으면 **굵은 수평선**으로 렌더되고, 그 선보다 위에
있는 내용이 **스크롤 시 상단에 고정되는 헤더**가 된다.

- `===` 위 영역 = 헤더. 스크롤하더라도 화면 상단에 항상 보인다.
- `===` 가 스크롤 경계를 결정한다(아래가 스크롤 본문).
- 한 문서에 의미 있는 `===` 는 하나뿐. 2개 이상이면 **가장 위의 것만** 고정
  경계로 동작하고, 나머지는 그냥 굵은 선으로만 표시된다.

기존 `---` 의 split/fold 와 달리 동작은 **노트 내용(XML)에 내재**한다. 토글이
아니라 `===` 텍스트의 존재 자체가 기능을 켠다. localStorage 토글도, 동기화도
없다.

## 핵심 제약 (왜 이 구조인가)

1. **ProseMirror 자식 DOM 을 래핑하면 안 된다.** `view.dom` 의 직속 자식을 별도
   `<div>` 로 감싸면 PM 의 mutation observer 가 깨진다(tomboy-hrsplit 의
   "Known dead ends" 참고). 따라서 헤더 영역을 별도 스크롤 팬으로 분리하는
   접근은 불가능하다.
2. **스크롤 컨테이너가 표면마다 다르다.** 모바일 `/note/[id]` 는 window/body 가
   스크롤된다(에디터 자체는 내부 스크롤 없음). 데스크톱 `NoteWindow` 는 자체
   `overflow` 스크롤 컨테이너를 가진다.

이 둘 때문에 "헤더 영역을 그 자리에서 편집 가능하게 고정"하는 방식 대신,
**에디터 밖 형제 오버레이에 헤더 DOM 을 복제(clone)** 해 고정하는 미러 방식을
택한다. 미러는 읽기 전용이며, 편집은 위로 스크롤해 실제 헤더에서 한다. 미러를
클릭하면 컨테이너를 맨 위로 스크롤한다.

## 채택 방식: 라이브 DOM 복제 미러

선택지 비교:

- **A. 라이브 에디터 DOM 복제 (채택)** — 플러그인이 `={3,}` 경계 라인을
  감지하고, `view.dom` 밖 형제 오버레이가 헤더 블록의 렌더된 DOM 을
  `cloneNode(true)` 로 복제해 고정한다. 링크/이미지/마크/지오 카드까지 실제
  렌더와 동일하게 보이고, 매 트랜잭션마다 헤더 부분만 싸게 갱신한다. PM 의
  no-wrap 규칙을 건드리지 않는다.
- B. 헤더 JSON → `tiptapToHtml` 직렬화 — 디커플링되지만 이미지/커스텀 블록
  (geo, terminal, datetime 마크)이 실제 렌더와 어긋난다. 기각.
- C. 실제 헤더 블록에 stacked `position:sticky` — "고정 중 편집" 경로로,
  사용자가 배제한 안. 기각.

## 컴포넌트

### 1. `eqHeaderPlugin.ts` (`app/src/lib/editor/eqHeader/`)

마커 감지 + 데코레이션 + 경계 통지.

- `isEqualsParagraph(node: PMNode): boolean` — `paragraph` 이고 `textContent`
  를 trim 한 값이 `^={3,}$` 인지. (`hrSplit` 의 `isDashParagraph` 와 동형.)
- `findEqBoundary(doc: PMNode): number | null` — top-level **인덱스 1 이상**
  중 첫 번째 `===` 문단의 인덱스. 없으면 `null`. 인덱스 0(제목)은 절대 마커가
  아니다. 순수 함수, 단위 테스트 대상.
- ProseMirror Plugin:
  - 모든 `===` 문단에 `.tomboy-eq-marker` node 데코레이션(굵은 선, 리터럴
    텍스트는 `::before` 로 가리고 선을 그림 — `.tomboy-hr-marker` 와 동일 기법).
  - 경계(첫 번째)에만 추가로 `.tomboy-eq-marker-active`. → 2번째 이후 `===`
    는 굵은 선으로만 표시.
  - 문서가 바뀌면 버전 카운터를 올리고 `onChange(boundaryIndex | null)` 호출
    (미러가 재복제 시점을 알도록). `hrSplit` 의 closure 콜백 주입 패턴 재사용.
- 데코레이션은 **attribute(class)만** 부여. 구조 변경/위젯 없음.

### 2. `StickyHeader.svelte` (`app/src/lib/editor/eqHeader/`)

고정 미러 오버레이.

- Props:
  - `editor`(또는 `view` 접근자) — 헤더 DOM 출처
  - `boundaryIndex: number | null`
  - `version: number` — 재복제 트리거
  - `scrollContainer: HTMLElement | Window` — 표면별 스크롤 컨테이너
- 동작:
  - top-level 자식 DOM `[0, boundaryIndex)` 를 `cloneNode(true)` 로 복제해
    비편집(`contenteditable=false`, 포인터로 텍스트 선택만) 컨테이너에 채움.
  - 불투명 배경, `max-height` = 컨테이너의 40% + 내부 `overflow-y:auto`.
  - **가시성:** 최상단에서는 숨김(실제 헤더와 중복 방지). `===` 라인이
    컨테이너 상단 위로 스크롤되어 올라간 경우에만 표시
    (IntersectionObserver 또는 marker 엘리먼트 top 과 컨테이너 top 비교).
  - 위치: window 스크롤(모바일)이면 `position: fixed`(컨테이너 가로폭/좌측에
    맞춤), NoteWindow 면 스크롤 컨테이너 안에서 `position: sticky; top:0`.
  - **클릭 → 컨테이너를 맨 위로 smooth scroll.**
  - `version`/`boundaryIndex` 변화 시 재복제. `boundaryIndex === null` 이면
    렌더 안 함.

### 3. `TomboyEditor.svelte` 배선

- `eqHeaderPlugin` 등록(`addProseMirrorPlugins`, hrSplit 와 동일 패턴), closure
  로 `onChange`/version 수신.
- `.tomboy-eq-marker` / `.tomboy-eq-marker-active` CSS 호스팅(굵은 선; `---`
  보다 두껍고 진하게).
- `<StickyHeader>` 마운트.
- 새 옵션 prop `scrollContainer?: () => HTMLElement | Window`(기본값 window).
  `/note/[id]` 는 기본값, `NoteWindow` 는 자신의 스크롤 엘리먼트를 전달.

## 데이터 흐름

```
타이핑/로드 → PM doc 변경 → eqHeaderPlugin.view().update()
  → findEqBoundary(doc) 계산, version++, onChange(idx)
  → TomboyEditor closure 가 boundaryIndex/version 상태 갱신
  → StickyHeader $effect: 헤더 DOM 재복제
스크롤 → IntersectionObserver/scroll → 미러 show/hide 토글
미러 클릭 → scrollContainer.scrollTo({top:0, behavior:'smooth'})
```

## 영속성

없음. `===` 는 리터럴 노트 내용이라 다른 텍스트처럼 `.note` XML 에
round-trip 된다. 고정 동작은 내재적이며 토글/저장/동기화 상태가 없다.

## 범위 밖 / 엣지

- 데스크톱 `---` split 와의 상호작용은 현행 유지. `===` 는 hrSplit 입장에서
  그냥 `'block'` 이므로 분할 컬럼의 일반 블록으로 취급된다. 실사용에서 둘을
  같이 쓰지 않으므로 추가 통합은 하지 않는다.
- 경계 인덱스 ≥ 1 규칙 때문에 제목 바로 아래의 `===` 는 제목만 헤더로 고정.
- `===` 가 문서에 없으면 미러는 전혀 마운트되지 않음(`boundaryIndex === null`).

## 문서화 (CLAUDE.md 규칙)

설정 → 가이드의 editor 서브탭에 `<details class="guide-card">` 추가:
짧은 `<summary>`, 한 줄 `info-text` 소개, `===` 스니펫, 제약/주의를 담은
`guide-list`(굵은 선·상단 고정·클릭 시 맨 위로·문서당 1개 등).

## 테스트

- 단위 테스트 `app/tests/unit/editor/eqHeaderBoundary.test.ts`:
  - `isEqualsParagraph`: `===`/`====` 인식, `==`/`= =`/혼합 텍스트 거부.
  - `findEqBoundary`: 인덱스 0 제외(제목), 첫 `===` 선택, 다중 `===` 시
    최상단 선택, 없으면 `null`.
- 미러 복제/가시성/스크롤은 실제 브라우저 레이아웃 의존 → `npm run dev` +
  브라우저(모바일 뷰 + 데스크톱 NoteWindow)에서 수동 검증.
- `npm run check`(svelte-check) 타입 통과.

## 파일 요약

신규:
- `app/src/lib/editor/eqHeader/eqHeaderPlugin.ts`
- `app/src/lib/editor/eqHeader/StickyHeader.svelte`
- `app/tests/unit/editor/eqHeaderBoundary.test.ts`

수정:
- `app/src/lib/editor/TomboyEditor.svelte` (플러그인 등록, CSS, StickyHeader,
  `scrollContainer` prop)
- `app/src/lib/desktop/NoteWindow.svelte` (스크롤 컨테이너 전달)
- `app/src/routes/settings/+page.svelte` (가이드 카드)
