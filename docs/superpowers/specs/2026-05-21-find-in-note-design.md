# 노트 내 찾기 (Find in Note) — 설계

작성일: 2026-05-21

## 목적

개별 노트 편집기에서 텍스트를 검색하는 기능. 사용자가 `Ctrl/Cmd+F`(데스크탑)
또는 하단 툴바 버튼(모바일)으로 찾기 바를 열고 검색어를 입력하면, 노트 본문에서
일치하는 모든 텍스트가 녹색으로 하이라이팅된다. 매치 사이를 이동하고 현재 위치를
`3 / 12` 형태로 표시한다.

## 요구사항

- `Ctrl/Cmd+F` 로 찾기 바를 열고, 텍스트 입력 시 일치 텍스트를 **녹색**으로 하이라이팅.
- 매치 **이동**: `Enter`(다음) / `Shift+Enter`(이전), 순환. 활성 매치를 화면으로 스크롤.
- **카운트 표시**: `3 / 12`. 매치 0개면 "일치 없음".
- **대소문자 무시** 검색. (한글에는 영향 없음.)
- **모바일 진입점**: 하단 툴바의 항상 보이는 행에 찾기 버튼.
- `Esc` 또는 ✕ 버튼으로 닫기.

## 핵심 불변식 (지켜야 할 것)

- **`.note` XML 라운드트립 보존** — 찾기는 절대 문서를 수정하면 안 된다. 따라서
  하이라이팅은 ProseMirror **데코레이션**으로만 구현한다. 마크(`<mark>`)를 쓰면
  문서가 바뀌어 저장이 트리거되고 XML이 오염되며 사용자의 실제 노란색
  하이라이트를 덮어쓴다 — 금지.
- 찾기 데코레이션은 뷰 계층 전용 — `onUpdate`/저장을 트리거하지 않는다.

## 아키텍처

### 채택한 접근

**ProseMirror 데코레이션 플러그인.** 매치를 인라인 데코레이션(CSS 클래스를 입힌
`<span>`)으로 그린다. 문서는 건드리지 않는다. 이 프로젝트가 이미
`imagePreview`·`hrSplit`에서 쓰는 패턴이며 모든 브라우저에서 동작한다.

기각한 대안:
- **Highlight 마크 재사용** — 문서를 수정해 저장 트리거 + XML 오염 + 실제
  하이라이트 덮어쓰기. 불변식 위반.
- **CSS Custom Highlight API (`::highlight()`)** — 빠르지만 브라우저 지원 단층.
  모바일 우선 앱에 데코레이션으로 충분하므로 불필요한 리스크.

### 배치

찾기 기능 일체를 `TomboyEditor.svelte` 내부에 둔다. 모바일 노트 라우트
(`note/[id]/+page.svelte`)와 데스크탑 `NoteWindow.svelte` 가 모두 `TomboyEditor`
를 쓰므로, 한 곳에 구현하면 양쪽에서 동작한다.

## 모듈 구조

기존 플러그인 폴더 관례(`autoLink/`·`hrSplit/`·`footnote/`)를 따라
`app/src/lib/editor/find/` 를 신설한다.

| 파일 | 책임 | 의존 |
|------|------|------|
| `find/findMatches.ts` | 순수 함수 `findMatches(doc, query): Match[]`. 텍스트블록 단위 대소문자 무시 부분 일치 스캔. | `@tiptap/pm/model` 타입만 |
| `find/findPlugin.ts` | ProseMirror 플러그인 — 상태, 데코레이션, 메타 처리, 편집 시 재스캔, 활성 매치 스크롤. | `findMatches`, `@tiptap/pm/{state,view}` |
| `find/FindBar.svelte` | 검색바 UI (표현 전용 컴포넌트). | 없음 (props/콜백만) |

수정 파일:

| 파일 | 변경 |
|------|------|
| `editor/TomboyEditor.svelte` | 플러그인 등록, `Ctrl/Cmd+F` 단축키, `<FindBar>` 렌더링, 찾기 상태 보유, `openFind()` 노출, 에디터 셸 래핑 |
| `editor/Toolbar.svelte` | 선택적 `onfind` prop + dock 행에 찾기 버튼 |
| `routes/note/[id]/+page.svelte` | `<Toolbar onfind={...}>` 배선 |
| `lib/desktop/NoteWindow.svelte` | `<Toolbar onfind={...}>` 배선 |

## 컴포넌트 상세

### `findMatches.ts` — 매칭 알고리즘

```ts
export interface FindMatch {
  from: number; // 문서 위치 (inclusive)
  to: number;   // 문서 위치 (exclusive)
}
export function findMatches(doc: ProseMirrorNode, query: string): FindMatch[];
```

- `query` 가 빈 문자열이면 `[]` 반환.
- 각 **텍스트블록**(`node.isTextblock`)에 대해:
  - 블록의 인라인 자식을 순회하며 검색용 문자열과 `오프셋 → 문서위치` 맵을 만든다.
    텍스트 노드는 각 문자가 1 위치씩, 하드브레이크 등 인라인 atom 노드는
    **매치되지 않는 자리표시 문자 1개**(`￿`)로 채워 길이를 보존한다.
  - 검색 문자열과 `query` 를 모두 소문자화하고 `indexOf` 루프로 모든 출현을 찾는다.
  - 각 매치의 시작/끝 오프셋을 맵으로 문서 위치로 환산해 `FindMatch` 로 push.
- 텍스트블록 단위로 스캔하므로 굵게가 단어 중간에 걸려도(`hel`+**`lo`**)
  매치되고, 검색어가 문단 경계를 넘지 않는다.
- 반환 배열은 문서 위치 오름차순.

### `findPlugin.ts` — 플러그인

플러그인 키: `findPluginKey`.

**상태 모양:**
```ts
interface FindState {
  query: string;
  matches: FindMatch[];
  activeIndex: number; // 매치 없으면 -1
}
```
초기값: `{ query: '', matches: [], activeIndex: -1 }`.

**메타 구동** (autoLink·hrSplit과 동일 패턴). `tr.setMeta(findPluginKey, ...)`:
- `{ query: string }` — `findMatches(doc, query)` 재스캔. `activeIndex` = 매치가
  있으면 `0`, 없으면 `-1`.
- `{ nav: 'next' | 'prev' }` — `activeIndex` 를 `matches.length` 기준 순환 증감.
  매치 0개면 무시.
- `{ close: true }` — `{ query:'', matches:[], activeIndex:-1 }` 로 초기화.

**편집 대응:** 메타가 없고 `tr.docChanged` 이며 `query` 가 비어있지 않으면
`findMatches` 로 재스캔하고 `activeIndex` 를 `[0, matches.length-1]` 로 클램프
(매치 0개면 -1).

**데코레이션** (`props.decorations`): `matches` 각각에 대해
`Decoration.inline(from, to, { class })`. 클래스는 기본 `tomboy-find-match`,
`activeIndex` 위치의 매치는 `tomboy-find-match tomboy-find-active`. 빈 매치는
`DecorationSet.empty`.

**활성 매치 스크롤** (`view` 훅): `update(view, prevState)` 에서 `activeIndex`
또는 `matches` 가 바뀌었으면 활성 매치 DOM(`view.dom` 내
`.tomboy-find-active`)을 `scrollIntoView({ block: 'center' })`. PM 선택(커서)은
옮기지 않는다 — 브라우저 Ctrl+F와 동일하게, 포커스는 검색 입력창에 둔다.

### `FindBar.svelte` — UI

표현 전용 컴포넌트. 상태를 갖지 않고 props와 콜백만 받는다.

**Props:** `query: string`, `count: number`, `activeIndex: number`.
**콜백:** `onquery(q: string)`, `onnext()`, `onprev()`, `onclose()`.

**레이아웃:** `TomboyEditor` 의 에디터 영역 우상단에 떠 있는 작은 카드.
- 검색 입력창 — 열릴 때 자동 포커스.
- 카운트 — 매치 ≥1이면 `{activeIndex+1} / {count}`, 0이면 "일치 없음"
  (단, query가 비어있으면 카운트 영역 비움).
- ↑ / ↓ 버튼 — 이전 / 다음. 매치 0개면 비활성.
- ✕ 버튼 — 닫기.
- 입력창 키 처리: `Enter` → `onnext()`, `Shift+Enter` → `onprev()`,
  `Esc` → `onclose()`. IME 조합 중(`isComposing`)에는 Enter/Esc 무시.
- 모든 문자열 한국어. 모바일에서 안 잘리도록 작은 화면 친화적 크기.

### `TomboyEditor.svelte` — 통합

- **셸 래핑:** 현재 `<div class="tomboy-editor">`(TipTap 마운트 대상) 을
  `position: relative` 인 `<div class="tomboy-editor-shell">` 로 감싼다. 셸은
  스크롤하지 않으므로 `<FindBar>` 를 셸의 절대 위치 자식으로 두면 본문이
  스크롤돼도 바가 우상단에 고정된다. `editorElement` 의 `bind:this`·클래스·
  기존 `:global(...)` CSS는 그대로 유지.
- **플러그인 등록:** 기존 패턴대로 `Extension.create({ name: 'tomboyFind',
  addProseMirrorPlugins() { return [createFindPlugin()] } })`.
- **찾기 상태** (`$state`): `findOpen: boolean`, `findQuery: string`,
  `findCount: number`, `findActiveIndex: number`.
- **트랜잭션 동기화:** `editor.on('transaction')` 에서 `findPluginKey.getState()`
  를 읽어 `findCount`/`findActiveIndex` 를 갱신 — `FindBar` 가 반응적으로 표시.
- **단축키** (`handleKeyDown`): `(ctrlKey||metaKey) && !altKey && !shiftKey &&
  key==='f'` → `event.preventDefault()`(브라우저 찾기 억제), `findOpen=true`.
  선택 영역이 비어있지 않고 **단일 텍스트블록 안**에 있으면 그 텍스트로
  `findQuery` 를 프리필하고 쿼리 메타를 디스패치한다. 그 외(빈 선택 또는 여러
  블록에 걸친 선택)에는 빈 쿼리로 연다.
- **콜백 배선:**
  - `onquery(q)` → `findQuery=q`, `tr.setMeta(findPluginKey,{query:q})` 디스패치.
  - `onnext()`/`onprev()` → `{nav:'next'|'prev'}` 디스패치.
  - `onclose()` → `findOpen=false`, `{close:true}` 디스패치.
- **공개 API:** `export function openFind()` — `getEditor()` 와 동일한 방식으로
  노출. 호스트(툴바 버튼)가 호출.
- **수명주기:** 노트 콘텐츠가 swap 되는 기존 `$effect`(setContent 경로)에서
  찾기 바를 닫는다(`findOpen=false` + `{close:true}` 디스패치) — 찾기는 노트
  단위. 닫히면 query가 비워져 데코레이션이 제거된다.

### `Toolbar.svelte` — 모바일 진입점

- 새 선택적 prop `onfind?: () => void`.
- `onfind` 가 있으면 항상 보이는 **dock 행**(`.dock`, 모바일에서 노출)에
  🔍 찾기 버튼 추가. 클릭 시 `onfind()` 호출.
- 데스크탑은 `Ctrl/Cmd+F` 단축키를 쓰며 dock은 `display:none` 이므로 버튼은
  모바일에서만 보인다.

### 호스트 배선

`note/[id]/+page.svelte` 와 `NoteWindow.svelte` 의 `<Toolbar>` 에
`onfind={() => editorComponent?.openFind()}` 추가.

## 스타일

`TomboyEditor.svelte` 의 `<style>` 에 추가 (기존 `mark` 규칙과 같은 영역):

- `.tomboy-find-match` — 연녹색 배경 (`#a5d6a7`), `border-radius: 2px`.
- `.tomboy-find-active` — 진녹색 배경 (`#66bb6a`) + 테두리 링
  (`box-shadow: 0 0 0 1px #2e7d32`). 활성 매치를 시각적으로 구별.

`FindBar` 카드는 `TomboyEditor.svelte` 내부의 scoped 스타일.

## 엣지 케이스

- **빈 쿼리** — 데코레이션 없음, 카운트 영역 비움.
- **매치 0개** — "일치 없음", 이동 버튼 비활성, `activeIndex=-1`.
- **바 열린 채 본문 편집** — `docChanged` 로 재스캔, `activeIndex` 클램프.
- **다른 노트로 이동** — 바를 닫고 상태 초기화.
- **IME 조합 중 Enter** — `isComposing` 가드로 한글 입력 확정과 이동 분리.
- **선택 텍스트가 여러 블록 걸침** — 단축키 프리필 규칙대로 빈 쿼리로 연다
  (단일 텍스트블록 선택만 프리필).

## 테스트

기존 단위 테스트는 `app/tests/unit/editor/` 에 평면 배치되므로 동일 위치에 추가.

- `findMatches.test.ts` — 순수 함수 검증:
  - 단일 매치 / 복수 매치 / 한 블록 내 연속 매치.
  - 대소문자 무시 (`apple` ↔ `Apple`/`APPLE`).
  - 단어 중간에 마크가 걸린 경우(`hel`+굵게`lo`)도 매치.
  - 무매치 / 빈 쿼리 → `[]`.
  - 하드브레이크가 자리표시 문자로 처리돼 경계를 넘는 거짓 매치가 없음.
  - 반환 위치 오름차순.
- `findPlugin.test.ts` — `EditorState` 를 구성해 `apply` 리듀서의 메타별 상태
  전이 검증: `{query}` 재스캔, `{nav}` 순환, `{close}` 초기화, `docChanged`
  재스캔 + 클램프.
- 바 UI·스크롤·`Ctrl/Cmd+F`·툴바 버튼은 `npm run dev` 로 수동 확인.

## 범위 밖 (YAGNI)

- 찾기/바꾸기(replace).
- 정규식 검색, 단어 단위 검색, 대소문자 구분 토글.
- 노트 간 전역 검색 (이미 `전체` 페이지의 검색이 담당).
- 검색어 히스토리.
