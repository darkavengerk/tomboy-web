# 마크다운 테이블 (GFM) — 설계 문서

작성일: 2026-06-09
관련 기능: 에디터 인라인 테이블 블록 (`app/src/lib/editor/tableBlock/`)

## 목표

노트 본문에 **표준 GitHub-flavored markdown 테이블 문법**으로 표를 그릴 수 있게 한다.

```
| 헤더1 | 헤더2 |
| --- | --- |
| 값1 | 값2 |
| 값3 | 값4 |
```

기존 CSV/TSV 테이블 블록(` ```csv ` / ` ```tsv ` 펜스)과 **상호작용·렌더링 엔진을 공유**하고, 마크다운 고유 부분(네이티브 탐지·구분선·정렬)만 추가한다. 중복 구현을 피해 유지보수성을 높이는 것이 핵심 제약이다.

## 핵심 결정 (브레인스토밍 합의)

1. **네이티브 인식** — 펜스 없이 본문의 `| ... |` + 구분선행(`| --- |`)으로 탐지. 진짜 마크다운 문법.
2. **구분선행 필수** — 오인식 방지. 헤더 다음 줄이 구분선행이어야 표로 인정.
3. **정렬 지원** — `:---`(왼쪽) / `:---:`(가운데) / `---:`(오른쪽)을 열별 `text-align`으로.
4. **상호작용 CSV/TSV 동일** — 토글(소스 보기), 더블클릭 셀 편집, Ctrl 모드 행/열 추가·삭제.
5. **접근 A (dialect 확장)** — 기존 `tableBlock` 모듈에 `'markdown'` 포맷 추가. 플러그인 상태머신·렌더·셀편집 엔진은 단일 유지.
6. **Alt+T 단축키** — 커서 위치에 빈 2×2 마크다운 테이블 삽입.

## 아키텍처: 무엇을 공유하고 무엇만 새로 짓나

기존 `app/src/lib/editor/tableBlock/` 구조:

| 파일 | 역할 | 마크다운 영향 |
|---|---|---|
| `tableBlockPlugin.ts` | ProseMirror 플러그인 — 상태머신, 토글/편집/Ctrl-ops UI, 데코레이션 | **공유** (region 병합 + 정렬/구분선 데코만 추가) |
| `findTableRegions.ts` | 펜스 기반 region 탐지 | **신규 함수 추가** `findMarkdownTableRegions` |
| `parseTable.ts` | 행/셀 파싱, blank-row 규칙 | **markdown 분기 추가** + 구분선/정렬 헬퍼 |
| `cellEdit.ts` | 셀 편집 범위 계산 + commit | **markdown 분기** (`findCellEditRange`), `commitCellEdit` 무변경 |
| `tableOps.ts` | 행/열 추가·삭제 트랜잭션 | **markdown 분기** (열 ops가 구분선 동기화) |
| `renderInlines.ts` | 인라인 노드 → DOM (마크) | **무변경** |

### 공유 (수정 0 또는 최소)
- 플러그인 상태머신 전체(토글 set, editing target, ctrl-held, 데코 생성 루프) — `TableRegion` 추상화 위에서 동작하므로 포맷 무관
- `renderInlinesToDom` — 마크→DOM 매핑 그대로
- `splitInlinesByChar`, `trimInlines`, `parseInlineCells` 코어 — 구분자만 `|`
- `commitCellEdit`(cellEdit), `deleteRowOp`(tableOps) — 포맷 무관

### 마크다운 고유 (신규)
- 네이티브 region 탐지 (펜스 대신 헤더+구분선 run)
- 구분선 파싱 + 정렬 추출
- 바깥 파이프(outer pipe) strip — `| a | b |` → `['a','b']`
- 열 ops의 구분선행 동기화

## 데이터 모델 변경

### `parseTable.ts`
```ts
export type TableFormat = 'csv' | 'tsv' | 'markdown';
export type Alignment = 'left' | 'center' | 'right' | null;
```

### `findTableRegions.ts` — `TableRegion`에 옵셔널 2필드
```ts
export interface TableRegion {
  // ... 기존 필드 ...
  align?: Alignment[];                // 열별 정렬 (markdown만; csv/tsv undefined)
  separatorParaRange?: BodyParaRange; // `| --- |` 단락 (markdown만)
}
```

**불변식:** 마크다운 region의 `cells` / `rows` / `bodyParaRanges`는 **헤더행 + 데이터행만** 담는다. 구분선행(`| --- |`)은 제외되고 `separatorParaRange`로 따로 추적된다. 이로써 셀편집·행삭제의 행 인덱스가 CSV/TSV와 동일한 의미(`0 = 헤더, 1+ = 데이터`)를 유지하고 기존 엔진이 그대로 동작한다.

## 탐지 규칙 (오인식·기존기능 충돌 방지)

`findMarkdownTableRegions(doc)`:

1. top-level 단락을 순회한다 (`collectTopLevelParagraphs` 재사용).
2. 단락 P가 **헤더**이려면: `P`에 `|` 포함 **그리고** 바로 다음 단락이 **구분선행**.
3. **구분선행** 정의: 바깥 파이프 strip 후 각 셀이 `/^\s*:?-+:?\s*$/`이고, **원문에 `|`가 최소 1개 포함**.
4. 헤더+구분선 이후, `|`를 포함하는 연속 단락을 데이터행으로 흡수. `|` 없는 단락 / 빈 단락 / 펜스 줄을 만나면 run 종료.
5. `TableRegion` 생성: `format:'markdown'`, `align`(구분선에서 파싱), `cells`/`rows`(헤더+데이터), `bodyParaRanges`(헤더+데이터 단락), `separatorParaRange`, `openFromPos`=헤더 단락 from, `closeToPos`=마지막 데이터행 to (데이터 0행이면 구분선 to).

**충돌 방지 불변식:**
- ⚠️ **구분선행에 `|` 필수** → 기존 `hrSplit` 기능(`---` 단독 → 세로 분할선)과 분리. `---`만 있으면 HR-split, `| --- |`면 테이블.
- 헤더행에도 `|` 필수 → 1열 테이블도 `| h |` 형태여야 함.
- **펜스(` ```csv ` / ` ```tsv `) 내부 단락은 마크다운 탐지에서 제외.** 먼저 펜스 region 범위를 구해 그 안의 단락 인덱스를 마크다운 탐지가 건너뛴다. 두 기능의 region이 겹치지 않음.
- 최소 테이블 = 헤더 + 구분선 (데이터 0행). 헤더만 있는 표로 렌더.

## 바깥 파이프 처리 (GFM)

마크다운 셀 분리 규칙:
1. 단락 텍스트를 trim.
2. 맨 앞이 `|`면 1개 제거, 맨 끝이 `|`면 1개 제거.
3. `|`로 분리.
4. 각 셀 trim.

마크 보존을 위해 인라인 노드 배열에도 동일하게: 새 헬퍼 `stripOuterPipeInlines(inlines)`가 edge 텍스트 노드에서 바깥 `|`(및 인접 공백)를 제거한 뒤 기존 `splitInlinesByChar(inlines, '|')` → `trimInlines` 재사용.

예: `| a || b |` → 바깥 strip → `a || b` → split → `['a','','b']` (중간 빈 셀 보존).

## 셀 경계 계산 통합 (회귀 위험 관리)

`findCellEditRange`(cellEdit)와 `deleteColOp`(tableOps)가 각자 char-offset을 계산한다. 마크다운은 바깥 파이프 때문에 셀의 텍스트 내 시작/끝 오프셋이 CSV와 다르다.

**해결:** 단일 헬퍼로 추출하여 둘이 공유한다.
```ts
// parseTable.ts (또는 cellEdit 인접)
// text 안에서 각 논리 셀의 [start, end) char 오프셋을 반환.
// csv/tsv: 구분자 split 기준. markdown: 바깥 파이프 보정 + 셀 내부 trim 경계.
export function cellCharRanges(text: string, format: TableFormat): { start: number; end: number }[]
```
`findCellEditRange`/`deleteColOp`가 이 헬퍼로 재작성된다. **CSV/TSV 동작은 바이트 동일 유지**(기존 단위 테스트가 회귀 가드).

## Ctrl-ops 마크다운 분기 (`tableOps.ts`)

- `deleteRowOp` — 변경 없음. 구분선은 `bodyParaRanges`에 없어 안전.
- `appendRowOp` — 마크다운: `|  |  |` 형태 빈 행을 마지막 데이터행 뒤(`bodyParaRanges` 마지막 `.to`, 없으면 `separatorParaRange.to`)에 삽입. 열 수 = 헤더 열 수.
- `appendColOp` — 데이터행 각각에 빈 셀 추가 **그리고** `separatorParaRange`에 `---` 셀 추가(열 수 동기화). 바깥 파이프 형태 유지.
- `deleteColOp` — 데이터행에서 열 제거 **그리고** `separatorParaRange`에서 같은 열 제거. 바깥 파이프 오프셋은 `cellCharRanges`로 계산.

## 렌더링 (`tableBlockPlugin.ts`)

- `rebuildState`가 `findTableRegions(doc)`(펜스) + `findMarkdownTableRegions(doc)`(네이티브) 두 결과를 **위치 순으로 병합**. 둘 다 `TableRegion`이므로 이후 데코/렌더 루프는 분기 없음.
- 테이블 렌더 함수(`renderTable`/`fillCell`)에 `region.align` 전달 → `align[c]` 있으면 해당 th/td에 `style="text-align:…"`.
- hidden 데코: 마크다운 region은 **구분선 단락도 hidden 집합에 포함**(헤더+구분선+데이터 전부 가림).
- 토글 off(소스 보기) 시 구분선 포함 원문 그대로 노출 — 정상.

## Alt+T 단축키

- **신규 `insertTable.ts`** (`insertDate.ts` / `insertProcessBlock` 패턴):
  ```
  |  |  |
  | --- | --- |
  |  |  |
  ```
  세 단락 삽입(헤더 빈 2셀 + 구분선 2열 + 데이터 빈 2셀) = **2열 × 2행(헤더+데이터) 시각 그리드**. 삽입 즉시 네이티브 탐지로 렌더. 셀 입력은 기존 더블클릭 편집.
- **등록**: `TomboyEditor.svelte` Alt 블록(`event.altKey && !ctrl && !meta && !shift`)에 `event.code === "KeyT"` → `preventDefault()` + `insertTable(ed)` + `return true`. (KeyT 미사용 확인됨; KeyJ/KeyP/KeyR/KeyC 충돌 없음.)

## 가이드 카드 (CLAUDE.md 필수)

`app/src/routes/settings/+page.svelte`의 `guideSubTab: editor`에 `<details class="guide-card">` 추가:
- `<summary>`: 마크다운 표
- intro `<p class="info-text">`: 문법 한 줄 설명
- `<pre class="snippet">`: 정렬 포함 예시
- `<ul class="guide-list">`: 구분선행 필수, 정렬(`:---`/`:--:`/`--:`), `Alt+T` 빈 표 생성, 더블클릭 셀 편집, Ctrl 모드 행/열 추가삭제, `---` 단독은 HR-split(세로 분할)이라는 주의점

## 테스트 (vitest, `app/tests/unit/` 미러)

- `parseTable.markdown.test.ts`: 구분선 탐지(`isSeparatorRow`), 정렬 파싱(`parseAlignments`), 바깥파이프 strip, 마크 보존 셀 분리, `cellCharRanges`(csv/tsv/markdown).
- `findMarkdownTableRegions.test.ts`: run 탐지, 구분선 필수, 헤더-only 테이블, 펜스 내부 무시, `---` 단독 비탐지, 연속 표 분리.
- `tableOps.markdown.test.ts`: 열 추가/삭제 시 구분선 동기화, 행 추가 위치.
- `cellEdit.markdown.test.ts`: 마크다운 셀 범위(바깥파이프 오프셋), commit.
- **기존 CSV/TSV 테스트 전부 통과**(회귀 가드) — `cellCharRanges` 리팩터가 csv/tsv 동작을 바꾸지 않음을 보장.

## 영향 범위 / 비목표

- **비목표:** 펜스 방식 마크다운 입력, 셀 병합(colspan/rowspan), 표 정렬 UI 버튼, Dropbox/Firestore 동기화 변경(표는 순수 텍스트라 round-trip 무영향).
- **`.note` XML 무변경:** 표는 일반 단락 텍스트이므로 Tomboy 데스크탑 round-trip 그대로.
- **기존 CSV/TSV:** 동작 불변. 공유 코드 리팩터는 바이트 동일 보장.

## 파일 변경 요약

| 파일 | 변경 |
|---|---|
| `parseTable.ts` | `TableFormat`에 `'markdown'`, `Alignment` 타입, `isSeparatorRow`/`parseAlignments`/`stripOuterPipeInlines`/`cellCharRanges` 추가, `parseTableRows`/`parseInlineCells` markdown 분기 |
| `findTableRegions.ts` | `TableRegion`에 `align?`/`separatorParaRange?`, `findMarkdownTableRegions` 신규 (+ 펜스 범위 제외 헬퍼) |
| `cellEdit.ts` | `findCellEditRange` markdown 분기(`cellCharRanges` 사용) |
| `tableOps.ts` | `appendRowOp`/`appendColOp`/`deleteColOp` markdown 분기(구분선 동기화) |
| `tableBlockPlugin.ts` | region 병합, `align` 렌더, 구분선 hidden 데코 |
| `insertTable.ts` | **신규** — 빈 2×2 표 삽입 |
| `TomboyEditor.svelte` | Alt 블록에 `KeyT` → `insertTable` |
| `settings/+page.svelte` | 가이드 카드 (editor 탭) |
| `app/tests/unit/...` | 신규 마크다운 테스트 4종 |
