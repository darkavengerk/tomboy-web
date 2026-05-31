# 노트 차트 기능 설계

작성일: 2026-05-30

## 목표

노트에 차트를 그리는 기능. 두 부분으로 구성된다.

1. **데이터 노트** — 타이틀이 `DATA::`로 시작하는, 차트 입력 전용 CSV/TSV 노트.
2. **차트 블록** — 아무 노트에서나 `[ ]Chart:<type> …` 형식으로 작성하면 자동으로 차트가 그려지는 인라인 위젯.

## 기존 코드 재사용

- **CSV/TSV 파싱**: `app/src/lib/editor/tableBlock/parseTable.ts`의 `detectFenceFormat()` / `isFenceClose()` / `parseTableRows()`를 그대로 재사용. 데이터 노트의 ` ```csv `/` ```tsv ` 블록은 이미 테이블로 렌더된다.
- **인라인 위젯 패턴**: `tableBlock` / `geoMap`의 ProseMirror 위젯 데코레이션 + 순수 DOM 패턴.
- **체크박스**: `app/src/lib/editor/checklist/`의 `listItem.attrs.checked` + 위젯 토글 패턴.
- **타이틀 조회**: `findNoteByTitle()` (async, `lib/core/noteManager.ts`), 필요 시 `lookupGuidByTitle()` (sync, `ensureTitleIndexReady()` 선행).
- **동적 import lazy-load**: `geoMap`의 Leaflet 지연 로딩과 동일하게 Chart.js를 차트 렌더 시점에만 `import()`.

## 파일 구조

```
app/src/lib/chart/
├── chartSpec.ts           # 타입 정의 (ChartSpec, ChartType, RangeOption, AggMethod…)
├── parseChartBlock.ts     # 차트 블록(리스트) → ChartSpec
├── parseDataNote.ts       # DATA:: 노트 → DataTable[] (블록별 1개씩)
├── transformData.ts       # 범위 → 열 매핑 → 묶기(집계) 파이프라인
├── buildChartConfig.ts    # ChartSpec + DataTable → Chart.js config 객체
└── renderChart.ts         # 컨테이너에 Chart.js 동적 import + mount/destroy

app/src/lib/editor/chartBlock/
├── findChartRegions.ts    # doc 워커: [ ]Chart: 블록 영역 탐지
└── chartBlockPlugin.ts    # ProseMirror 플러그인: 체크 시 차트 렌더, 미체크 시 설정 노출
```

## 1. 데이터 노트 (DATA::)

- **타이틀**: `DATA::<데이터 제목>` 으로 시작. 타이틀 접두사 기반 식별은 이 저장소의 첫 사례 — 본문이 아니라 제목으로 찾는다. `DATA::`는 순전히 차트가 찾기 위한 조회 키.
- **2번째 줄**: 플레이스홀더. 비어도 되고 내용이 있어도 되며 파서는 무시한다.
- **3번째 줄부터**: 하나 이상의 ` ```csv ` / ` ```tsv ` 블록.
- 데이터 노트 자체엔 차트 관련 추가 렌더링이 없다(기존 테이블 렌더링만 적용).
- **블록이 여러 개면 각각이 별도의 DataTable**이 된다. 차트 블록은 기본적으로 첫 블록을 쓰되, 필요 시 인덱스를 지정할 수 있다(향후 확장; v1은 첫 블록 기본 + 블록별 개별 차트 작성은 사용자가 차트 블록을 여러 개 쓰는 방식으로 충족).

`parseDataNote(doc)` 은 본문을 스캔해 csv/tsv 블록마다 `{ format, columns: string[], rows: string[][] }` 를 반환한다.

## 2. 차트 블록 문법

```
[x] Chart:bar 월별 매출
  - DATA::월별 매출 데이터          ← 필수 (데이터 노트 제목)
  - 범위
    - [ ]last:15, [ ]first:20, [x]all
  - 열 지정
    - x:월
    - y:매출, 비용
  - 묶기
    - 묶기:30
    - 방식:평균
  - 누적
    - [x]stacked
  - 선
    - [x]곡선, [x]점표시
  - 점
    - 점크기:5
  - 색상
    - 색상:#3b82f6, #ef4444
  - 축/표시
    - [x]범례, [x]값표시
    - x축:월, y축:금액
    - y최소:0, y최대:1000
    - 높이:240
```

### 첫 줄 (시그니처)

- `[ ]Chart:<type> <차트 제목>` — **헤더 노트 없이 이 줄 자체가 시그니처**. 노트의 아무 위치에서나 인식된다.
- `type` ∈ `bar | line | area | scatter` (v1). `pie`는 v1 제외.
- **`[x]` 체크됨 → 차트 렌더.** **`[ ]` 미체크 → 설정 리스트 원본 노출(편집 모드).**

### 하위 항목 = 토큰 기반 파싱

- **카테고리 이름 줄("범위", "열 지정", "묶기" 등)은 사람이 읽기 위한 라벨일 뿐 파서는 무시**한다. 파서는 실제 **토큰**만 인식한다.
- 토큰 이름이 전역적으로 고유하므로 중첩 깊이/그룹핑 방식과 무관하게 동작한다.
- **첫 하위 항목의 `DATA::…` 는 필수** (데이터 노트 제목).
- 고정 선택지(range, stacked 등): `[ ]a, [x]b` 체크박스 — 체크된 것 적용(range는 단일선택).
- 자유값(x/y 열, 묶기, 축 이름, 높이 등): `key:value` 텍스트.

### 토큰표

| 토큰 | 적용 | 형식 | 비고 |
|---|---|---|---|
| `DATA::…` | 데이터 노트 (필수) | 첫 하위 항목 | 제목으로 IDB 조회 |
| `last:N` / `first:N` / `all` | 범위 | 체크박스 단일선택 | 어느 행을 그릴지 |
| `x:` | x축 열 재지정 | 자유값 | 미지정 시 첫 열 |
| `y:` | 계열 열 재지정 | 자유값 (쉼표=다중) | 미지정 시 나머지 열 전부 |
| `묶기:N` | binning 구간 수 | 자유값 | N개 구간으로 묶음 |
| `방식:` | 집계 함수 | `평균`\|`합계`\|`최대`\|`최소`\|`개수` | 기본 평균 |
| `stacked` | 누적 | 체크박스 | bar/area |
| `곡선` | 곡선 보간(smooth) | 체크박스 | line/area |
| `점표시` | 데이터 점 마커 | 체크박스 | line/area |
| `점크기:N` | 점 크기 | 자유값 | scatter |
| `색상:` | 계열별 색 | 자유값 (쉼표 구분) | 미지정 시 기본 팔레트 |
| `팔레트:` | 팔레트 선택 | 자유값 | `색상:`의 대안 |
| `범례` | 범례 표시 | 체크박스 | |
| `값표시` | 데이터 라벨(점 위 값) | 체크박스 | |
| `x축:` / `y축:` | 축 이름 | 자유값 | |
| `y최소:` / `y최대:` | y축 범위 고정 | 자유값 | |
| `높이:` | 차트 높이(px) | 자유값 | 기본 240 |

타입별로 해당 없는 토큰은 **조용히 무시**한다(chatNote가 cross-backend 헤더를 무시하는 것과 동일 컨벤션).

## 3. 데이터 → 축 매핑

- **기본 규칙**: 첫 행 = 헤더(계열 이름 / 범례), 첫 열 = x축 레이블, 나머지 각 열 = 하나의 계열.
- **재지정**: `x:열이름`, `y:열1,열2` 로 덮어쓴다.
- scatter는 x·y 둘 다 숫자 값으로 해석한다.

## 4. 데이터 변환 파이프라인 (`transformData.ts`)

처리 순서: **범위 선택 → 열 매핑 → 묶기(집계) → Chart.js 데이터셋**.

- **범위**: `last:N`/`first:N`/`all` 로 행 슬라이스.
- **열 매핑**: x축 열 + 계열 열들 추출.
- **묶기(binning)**: `묶기:N` 이 있으면 연속된 행을 N개 구간으로 균등 분할하고 각 구간을 `방식:`(평균/합계/최대/최소/개수)으로 집계. **구간 x축 레이블 = 구간의 첫 x값.** 점 개수가 많을 때 표현을 압축하는 용도.

## 5. 렌더링 동작 (`chartBlockPlugin.ts`)

- doc을 스캔해 차트 블록 영역을 찾는다(`findChartRegions`, 체크리스트 영역 탐지 패턴 차용).
- 첫 줄이 `[x]`면 위젯 데코레이션으로 `<canvas>` 컨테이너를 mount → `renderChart()`가 Chart.js를 **동적 import** 후 그린다. `responsive: true`로 모바일 폭에 맞춤. 높이는 `높이:` 또는 기본 240px.
- 첫 줄이 `[ ]`면 차트를 그리지 않고 설정 리스트 원본을 그대로 노출(편집 모드).
- **데이터 읽기 = 렌더 시점 스냅샷.** 체크 토글하거나 노트를 다시 열면 데이터 노트를 다시 조회해 갱신. 실시간 구독 없음.
- 위젯 destroy 시 Chart.js 인스턴스를 `chart.destroy()`로 정리(geoMap의 Leaflet cleanup과 동일).

## 6. 에러 처리

데이터 노트를 못 찾거나(제목 불일치), csv/tsv 블록이 없거나, 지정한 열이 데이터에 없을 때 → **차트 자리에 빨간 톤 인라인 에러 카드**를 그린다. 한국어 메시지. 예:

- "데이터 노트 'DATA::월별 매출 데이터'를 찾을 수 없습니다"
- "데이터 노트에 csv/tsv 블록이 없습니다"
- "지정한 열 '월'을 데이터에서 찾을 수 없습니다"

설정 리스트는 그대로 보인다.

## 7. 테스트

- `parseChartBlock` / `parseDataNote` / `transformData` / `buildChartConfig` — 순수 함수 단위 테스트 (vitest, `app/tests/unit/` 미러 경로).
- `findChartRegions` — doc 워커 테스트.
- Chart.js mount(`renderChart`)는 동적 import라 단위 테스트에서 제외, 수동 `npm run dev` + 브라우저 확인.

## 의존성

- **Chart.js** 신규 추가 (`app/package.json`). 차트 렌더 시점에만 동적 import 되므로 메인 번들에 미포함.

## 비범위 (YAGNI)

- `pie`/`doughnut` 차트.
- 실시간 데이터 구독(데이터 노트 변경 시 자동 갱신).
- 데이터 노트 블록 인덱스 명시 지정(여러 블록은 차트 블록을 여러 개 작성해 충족).
- 자동 데이터 축소(묶기는 명시 옵션일 때만 동작).
- 차트 이미지 export.
