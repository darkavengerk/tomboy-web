# 노트 차트 기능 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 노트 본문 어디서든 `[x]Chart:<type> 제목` 블록을 쓰면 `DATA::` 데이터 노트의 CSV/TSV를 읽어 인라인 차트를 그린다.

**Architecture:** 순수 파싱/변환 계층(`lib/chart/`)과 에디터 통합 계층(`lib/editor/chartBlock/`)을 분리한다. 파싱 계층은 ChartSpec 파서·데이터 노트 파서·변환 파이프라인·Chart.js config 빌더로 구성되며 전부 순수 함수라 단위 테스트로 검증한다. 통합 계층은 geoMap과 동일한 ProseMirror 위젯 데코레이션 패턴으로, 체크된 블록 자리에 `<canvas>`를 mount하고 Chart.js를 동적 import 한다.

**Tech Stack:** SvelteKit, TipTap 3 / ProseMirror, Chart.js(신규, 동적 import), vitest. CSV/TSV는 기존 `tableBlock/parseTable.ts` 재사용.

---

## File Structure

```
app/src/lib/chart/
├── chartSpec.ts           # 타입 + 토큰 어휘 상수
├── parseChartBlock.ts     # (headerText, configLines[]) → ChartSpec
├── parseDataNote.ts       # JSONContent → DataTable[]
├── transformData.ts       # ChartSpec + DataTable → { labels, series }
├── buildChartConfig.ts    # ChartSpec + 변환결과 → Chart.js config 객체
└── renderChart.ts         # 컨테이너 + config → Chart.js 동적 import mount/destroy, 에러 카드

app/src/lib/editor/chartBlock/
├── findChartRegions.ts    # doc 워커: 차트 블록 영역 + 토큰 위치 탐지
└── chartBlockPlugin.ts    # ProseMirror 플러그인: 렌더/토글/설정노출

app/src/lib/editor/chartBlockExtension.ts   # Extension.create 래퍼
app/src/lib/editor/extensions.ts            # (수정) ChartBlockExtension 등록
app/package.json                            # (수정) chart.js 의존성
```

테스트: `app/tests/unit/chart/` 미러 경로.

---

### Task 1: ChartSpec 타입 + 차트 블록 파서

**Goal:** 차트 헤더 텍스트와 설정 라인 배열을 받아 `ChartSpec`을 만드는 순수 파서.

**Files:**
- Create: `app/src/lib/chart/chartSpec.ts`
- Create: `app/src/lib/chart/parseChartBlock.ts`
- Test: `app/tests/unit/chart/parseChartBlock.test.ts`

**Acceptance Criteria:**
- [ ] `[x] Chart:bar 월별 매출` 헤더에서 type=bar, title="월별 매출", checked=true 추출
- [ ] `DATA::월별 매출 데이터` 라인 → dataNoteTitle (접두사 포함 전체) 추출
- [ ] `[ ]last:15, [x]all` → range {kind:'all'} (체크된 것 우선)
- [ ] `묶기:30` + `방식:평균` → bin {count:30, method:'average'}
- [ ] `x:월`, `y:매출, 비용` → xColumn='월', yColumns=['매출','비용']
- [ ] `[x]stacked`, `[x]곡선`, `[x]점표시`, `[x]범례`, `[x]값표시` → 각 불리언 true
- [ ] `점크기:5`, `색상:#3b82f6, #ef4444`, `x축:월`, `y축:금액`, `y최소:0`, `y최대:1000`, `높이:240` 추출
- [ ] 알 수 없는 토큰/카테고리 라벨 라인("범위", "축/표시")은 조용히 무시
- [ ] 미지정 옵션 기본값: range {kind:'all'}, stacked/smooth/showPoints/showValues=false, showLegend=true, height=240

**Verify:** `cd app && npx vitest run tests/unit/chart/parseChartBlock.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 타입과 토큰 어휘 정의**

`app/src/lib/chart/chartSpec.ts`:

```ts
export type ChartType = 'bar' | 'line' | 'area' | 'scatter';
export type RangeKind = 'all' | 'last' | 'first';
export type AggMethod = 'average' | 'sum' | 'max' | 'min' | 'count';

export interface ChartSpec {
	type: ChartType;
	title: string;
	checked: boolean;
	dataNoteTitle: string;
	range: { kind: RangeKind; n?: number };
	xColumn?: string;
	yColumns?: string[];
	bin?: { count: number; method: AggMethod };
	stacked: boolean;
	smooth: boolean;
	showPoints: boolean;
	pointRadius?: number;
	colors?: string[];
	palette?: string;
	showLegend: boolean;
	showValues: boolean;
	xAxisLabel?: string;
	yAxisLabel?: string;
	yMin?: number;
	yMax?: number;
	height: number;
}

export const CHART_TYPES: ChartType[] = ['bar', 'line', 'area', 'scatter'];
export const DEFAULT_HEIGHT = 240;
export const DATA_NOTE_PREFIX = 'DATA::';

/** Korean aggregation method label → AggMethod. */
export const AGG_METHODS: Record<string, AggMethod> = {
	평균: 'average',
	합계: 'sum',
	최대: 'max',
	최소: 'min',
	개수: 'count'
};

/** Matches the chart header line: [x] Chart:bar Some Title */
export const CHART_HEADER_RE = /^\[([ xX])\]\s*Chart:(\w+)\s+(.+)$/;

export function isChartType(s: string): s is ChartType {
	return (CHART_TYPES as string[]).includes(s);
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`app/tests/unit/chart/parseChartBlock.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseChartHeader, parseChartBlock } from '../../../src/lib/chart/parseChartBlock';

describe('parseChartHeader', () => {
	it('parses type, title, checked', () => {
		expect(parseChartHeader('[x] Chart:bar 월별 매출')).toEqual({
			type: 'bar',
			title: '월별 매출',
			checked: true
		});
	});
	it('unchecked + line type', () => {
		expect(parseChartHeader('[ ]Chart:line 추세')).toEqual({
			type: 'line',
			title: '추세',
			checked: false
		});
	});
	it('returns null for non-chart line', () => {
		expect(parseChartHeader('그냥 텍스트')).toBeNull();
	});
	it('returns null for unknown type', () => {
		expect(parseChartHeader('[x]Chart:pie 비율')).toBeNull();
	});
});

describe('parseChartBlock', () => {
	const header = '[x] Chart:bar 월별 매출';
	it('extracts data note title and defaults', () => {
		const spec = parseChartBlock(header, ['DATA::월별 매출 데이터'])!;
		expect(spec.dataNoteTitle).toBe('DATA::월별 매출 데이터');
		expect(spec.range).toEqual({ kind: 'all' });
		expect(spec.stacked).toBe(false);
		expect(spec.showLegend).toBe(true);
		expect(spec.height).toBe(240);
	});
	it('picks checked range option', () => {
		const spec = parseChartBlock(header, ['DATA::d', '[ ]last:15, [x]all'])!;
		expect(spec.range).toEqual({ kind: 'all' });
		const spec2 = parseChartBlock(header, ['DATA::d', '[x]last:15, [ ]all'])!;
		expect(spec2.range).toEqual({ kind: 'last', n: 15 });
	});
	it('parses binning, columns, toggles, axis options', () => {
		const spec = parseChartBlock(header, [
			'DATA::d',
			'x:월',
			'y:매출, 비용',
			'묶기:30',
			'방식:평균',
			'[x]stacked',
			'[x]곡선, [x]점표시',
			'점크기:5',
			'색상:#3b82f6, #ef4444',
			'[x]범례, [x]값표시',
			'x축:월, y축:금액',
			'y최소:0, y최대:1000',
			'높이:300',
			'범위'
		])!;
		expect(spec.xColumn).toBe('월');
		expect(spec.yColumns).toEqual(['매출', '비용']);
		expect(spec.bin).toEqual({ count: 30, method: 'average' });
		expect(spec.stacked).toBe(true);
		expect(spec.smooth).toBe(true);
		expect(spec.showPoints).toBe(true);
		expect(spec.pointRadius).toBe(5);
		expect(spec.colors).toEqual(['#3b82f6', '#ef4444']);
		expect(spec.showValues).toBe(true);
		expect(spec.xAxisLabel).toBe('월');
		expect(spec.yAxisLabel).toBe('금액');
		expect(spec.yMin).toBe(0);
		expect(spec.yMax).toBe(1000);
		expect(spec.height).toBe(300);
	});
	it('returns null when header invalid', () => {
		expect(parseChartBlock('nope', ['DATA::d'])).toBeNull();
	});
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/chart/parseChartBlock.test.ts`
Expected: FAIL — `parseChartBlock`/`parseChartHeader` not exported.

- [ ] **Step 4: 파서 구현**

`app/src/lib/chart/parseChartBlock.ts`:

```ts
import {
	AGG_METHODS,
	CHART_HEADER_RE,
	DATA_NOTE_PREFIX,
	DEFAULT_HEIGHT,
	isChartType,
	type AggMethod,
	type ChartSpec,
	type ChartType
} from './chartSpec';

export interface ChartHeader {
	type: ChartType;
	title: string;
	checked: boolean;
}

/** Parse the first line. Returns null if it is not a valid chart header. */
export function parseChartHeader(line: string): ChartHeader | null {
	const m = CHART_HEADER_RE.exec(line.trim());
	if (!m) return null;
	const type = m[2].toLowerCase();
	if (!isChartType(type)) return null;
	return {
		type,
		title: m[3].trim(),
		checked: m[1].toLowerCase() === 'x'
	};
}

interface Token {
	checked: boolean | null; // null = no checkbox prefix
	key: string; // lowercased keyword before ':' or the bare keyword
	value: string; // text after ':' (trimmed), '' if none
	raw: string;
}

/** Split a config line into comma-separated tokens, peeling off [ ]/[x] prefixes. */
function tokenize(line: string): Token[] {
	return line
		.split(',')
		.map((chunk) => chunk.trim())
		.filter((chunk) => chunk.length > 0)
		.map((chunk): Token => {
			let checked: boolean | null = null;
			let rest = chunk;
			const cb = /^\[([ xX])\]\s*/.exec(chunk);
			if (cb) {
				checked = cb[1].toLowerCase() === 'x';
				rest = chunk.slice(cb[0].length);
			}
			const colon = rest.indexOf(':');
			if (colon >= 0) {
				return {
					checked,
					key: rest.slice(0, colon).trim().toLowerCase(),
					value: rest.slice(colon + 1).trim(),
					raw: rest
				};
			}
			return { checked, key: rest.trim().toLowerCase(), value: '', raw: rest };
		});
}

function num(value: string): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function splitList(value: string): string[] {
	return value
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Build a ChartSpec from the header line and the flattened config lines.
 * Category-label lines (범위, 축/표시 …) carry no recognized token and are ignored.
 */
export function parseChartBlock(headerLine: string, configLines: string[]): ChartSpec | null {
	const header = parseChartHeader(headerLine);
	if (!header) return null;

	const spec: ChartSpec = {
		type: header.type,
		title: header.title,
		checked: header.checked,
		dataNoteTitle: '',
		range: { kind: 'all' },
		stacked: false,
		smooth: false,
		showPoints: false,
		showValues: false,
		showLegend: true,
		height: DEFAULT_HEIGHT
	};

	for (const line of configLines) {
		const trimmed = line.trim();
		if (trimmed.startsWith(DATA_NOTE_PREFIX)) {
			spec.dataNoteTitle = trimmed;
			continue;
		}
		for (const t of tokenize(line)) {
			applyToken(spec, t);
		}
	}
	return spec;
}

function applyToken(spec: ChartSpec, t: Token): void {
	// range options carry a checkbox; only the checked one wins.
	if (t.key === 'all' && t.checked) {
		spec.range = { kind: 'all' };
		return;
	}
	if (t.key === 'last' && t.checked) {
		spec.range = { kind: 'last', n: num(t.value) };
		return;
	}
	if (t.key === 'first' && t.checked) {
		spec.range = { kind: 'first', n: num(t.value) };
		return;
	}
	if (t.checked === false) return; // unchecked toggle → ignore

	switch (t.key) {
		case 'x':
			if (t.value) spec.xColumn = t.value;
			return;
		case 'y':
			if (t.value) spec.yColumns = splitList(t.value);
			return;
		case '묶기': {
			const n = num(t.value);
			if (n) spec.bin = { count: n, method: spec.bin?.method ?? 'average' };
			return;
		}
		case '방식': {
			const method: AggMethod = AGG_METHODS[t.value] ?? 'average';
			spec.bin = { count: spec.bin?.count ?? 0, method };
			return;
		}
		case 'stacked':
			spec.stacked = true;
			return;
		case '곡선':
			spec.smooth = true;
			return;
		case '점표시':
			spec.showPoints = true;
			return;
		case '점크기':
			spec.pointRadius = num(t.value);
			return;
		case '색상':
			spec.colors = splitList(t.value);
			return;
		case '팔레트':
			spec.palette = t.value;
			return;
		case '범례':
			spec.showLegend = true;
			return;
		case '값표시':
			spec.showValues = true;
			return;
		case 'x축':
			spec.xAxisLabel = t.value;
			return;
		case 'y축':
			spec.yAxisLabel = t.value;
			return;
		case 'y최소':
			spec.yMin = num(t.value);
			return;
		case 'y최대':
			spec.yMax = num(t.value);
			return;
		case '높이': {
			const n = num(t.value);
			if (n) spec.height = n;
			return;
		}
		default:
			return; // unknown token / category label → ignore
	}
}
```

> 주의: `방식:` 만 있고 `묶기:`가 없으면 bin.count=0 이 되어 변환 단계에서 무시된다(Task 3에서 count<1 가드). 의도된 동작.

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/chart/parseChartBlock.test.ts`
Expected: PASS (all)

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/chart/chartSpec.ts app/src/lib/chart/parseChartBlock.ts app/tests/unit/chart/parseChartBlock.test.ts
git commit -m "feat(chart): ChartSpec 타입 + 차트 블록 토큰 파서"
```

---

### Task 2: 데이터 노트 파서

**Goal:** 노트의 JSONContent 문서에서 ` ```csv `/` ```tsv ` 블록을 모두 찾아 DataTable 배열로 반환.

**Files:**
- Create: `app/src/lib/chart/parseDataNote.ts`
- Test: `app/tests/unit/chart/parseDataNote.test.ts`

**Acceptance Criteria:**
- [ ] 본문 2번째 줄(플레이스홀더)은 무시되고 csv/tsv 블록만 파싱
- [ ] csv 블록 → DataTable {format:'csv', columns(첫 행), rows(나머지 행)}
- [ ] tsv 블록 동일 처리, 탭 분리
- [ ] 블록이 여러 개면 각각 별도 DataTable로 배열 반환
- [ ] 닫히지 않은 펜스나 빈 블록은 건너뜀

**Verify:** `cd app && npx vitest run tests/unit/chart/parseDataNote.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/chart/parseDataNote.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { parseDataNote } from '../../../src/lib/chart/parseDataNote';

/** Helper: build a doc of plain paragraphs from text lines. */
function doc(lines: string[]): JSONContent {
	return {
		type: 'doc',
		content: lines.map((text) => ({
			type: 'paragraph',
			content: text === '' ? [] : [{ type: 'text', text }]
		}))
	};
}

describe('parseDataNote', () => {
	it('parses a single csv block, ignoring placeholder line', () => {
		const d = doc(['DATA::예제', '', '```csv', '월,매출', '1월,100', '2월,200', '```']);
		const tables = parseDataNote(d);
		expect(tables).toHaveLength(1);
		expect(tables[0]).toEqual({
			format: 'csv',
			columns: ['월', '매출'],
			rows: [
				['1월', '100'],
				['2월', '200']
			]
		});
	});

	it('parses tsv with tab separators', () => {
		const d = doc(['DATA::t', '', '```tsv', 'a\tb', 'x\t1', '```']);
		const tables = parseDataNote(d);
		expect(tables[0].format).toBe('tsv');
		expect(tables[0].columns).toEqual(['a', 'b']);
		expect(tables[0].rows).toEqual([['x', '1']]);
	});

	it('returns multiple tables for multiple blocks', () => {
		const d = doc(['DATA::m', '', '```csv', 'a', '1', '```', '중간 텍스트', '```csv', 'b', '2', '```']);
		expect(parseDataNote(d)).toHaveLength(2);
	});

	it('skips an unclosed fence', () => {
		const d = doc(['```csv', 'a', '1']);
		expect(parseDataNote(d)).toEqual([]);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/chart/parseDataNote.test.ts`
Expected: FAIL — `parseDataNote` not exported.

- [ ] **Step 3: 구현**

`app/src/lib/chart/parseDataNote.ts`:

```ts
import type { JSONContent } from '@tiptap/core';
import {
	detectFenceFormat,
	isFenceClose,
	parseTableRows,
	type TableFormat
} from '../editor/tableBlock/parseTable';

export interface DataTable {
	format: TableFormat;
	columns: string[];
	rows: string[][];
}

/** Concatenate the text of a paragraph's inline children. */
function paragraphText(node: JSONContent): string {
	if (!node.content) return '';
	return node.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

/**
 * Walk top-level paragraphs of a note document and extract every fenced
 * csv/tsv block as a DataTable. The first row of each block is the header.
 */
export function parseDataNote(doc: JSONContent): DataTable[] {
	const tables: DataTable[] = [];
	const nodes = doc.content ?? [];
	let i = 0;
	while (i < nodes.length) {
		const text = paragraphText(nodes[i]);
		const format = detectFenceFormat(text);
		if (!format) {
			i++;
			continue;
		}
		// collect body lines until the closing fence
		const body: string[] = [];
		let j = i + 1;
		let closed = false;
		for (; j < nodes.length; j++) {
			const line = paragraphText(nodes[j]);
			if (isFenceClose(line)) {
				closed = true;
				break;
			}
			body.push(line);
		}
		if (closed && body.length > 0) {
			const grid = parseTableRows(body, format);
			if (grid.length > 0) {
				tables.push({ format, columns: grid[0], rows: grid.slice(1) });
			}
		}
		i = closed ? j + 1 : j;
	}
	return tables;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/chart/parseDataNote.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/chart/parseDataNote.ts app/tests/unit/chart/parseDataNote.test.ts
git commit -m "feat(chart): DATA:: 노트 csv/tsv 블록 파서"
```

---

### Task 3: 데이터 변환 파이프라인 (범위 → 열 매핑 → 묶기)

**Goal:** ChartSpec + DataTable을 받아 차트용 `{ labels, series }`를 만드는 순수 변환.

**Files:**
- Create: `app/src/lib/chart/transformData.ts`
- Test: `app/tests/unit/chart/transformData.test.ts`

**Acceptance Criteria:**
- [ ] 기본 매핑: 첫 열=x축 레이블, 나머지 각 열=계열(계열명=헤더)
- [ ] `xColumn`/`yColumns` 지정 시 해당 열로 재지정
- [ ] range last:N / first:N / all 로 행 슬라이스
- [ ] bin {count:N, method} 적용 시 연속 행을 N구간으로 묶어 집계, 구간 레이블=구간 첫 x값
- [ ] 집계 method 평균/합계/최대/최소/개수 정확
- [ ] 지정 열이 없으면 throw (에러 메시지에 열 이름 포함)
- [ ] 비숫자 셀은 0으로 취급(개수 제외)

**Verify:** `cd app && npx vitest run tests/unit/chart/transformData.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/chart/transformData.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { transformData } from '../../../src/lib/chart/transformData';
import type { ChartSpec } from '../../../src/lib/chart/chartSpec';
import type { DataTable } from '../../../src/lib/chart/parseDataNote';

function baseSpec(over: Partial<ChartSpec> = {}): ChartSpec {
	return {
		type: 'bar',
		title: 't',
		checked: true,
		dataNoteTitle: 'DATA::d',
		range: { kind: 'all' },
		stacked: false,
		smooth: false,
		showPoints: false,
		showValues: false,
		showLegend: true,
		height: 240,
		...over
	};
}

const table: DataTable = {
	format: 'csv',
	columns: ['월', '매출', '비용'],
	rows: [
		['1월', '100', '40'],
		['2월', '200', '60'],
		['3월', '300', '90'],
		['4월', '400', '120']
	]
};

describe('transformData', () => {
	it('default mapping: first col = labels, rest = series', () => {
		const out = transformData(baseSpec(), table);
		expect(out.labels).toEqual(['1월', '2월', '3월', '4월']);
		expect(out.series).toEqual([
			{ name: '매출', values: [100, 200, 300, 400] },
			{ name: '비용', values: [40, 60, 90, 120] }
		]);
	});

	it('explicit y columns', () => {
		const out = transformData(baseSpec({ yColumns: ['비용'] }), table);
		expect(out.series).toEqual([{ name: '비용', values: [40, 60, 90, 120] }]);
	});

	it('range last:2', () => {
		const out = transformData(baseSpec({ range: { kind: 'last', n: 2 } }), table);
		expect(out.labels).toEqual(['3월', '4월']);
	});

	it('binning with average', () => {
		const out = transformData(baseSpec({ bin: { count: 2, method: 'average' } }), table);
		expect(out.labels).toEqual(['1월', '3월']); // first x of each bin
		expect(out.series[0].values).toEqual([150, 350]); // avg(100,200), avg(300,400)
	});

	it('binning with sum', () => {
		const out = transformData(baseSpec({ bin: { count: 2, method: 'sum' } }), table);
		expect(out.series[0].values).toEqual([300, 700]);
	});

	it('throws for unknown column', () => {
		expect(() => transformData(baseSpec({ yColumns: ['없음'] }), table)).toThrow(/없음/);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/chart/transformData.test.ts`
Expected: FAIL — `transformData` not exported.

- [ ] **Step 3: 구현**

`app/src/lib/chart/transformData.ts`:

```ts
import type { AggMethod, ChartSpec } from './chartSpec';
import type { DataTable } from './parseDataNote';

export interface Series {
	name: string;
	values: number[];
}
export interface ChartData {
	labels: string[];
	series: Series[];
}

function colIndex(table: DataTable, name: string): number {
	const idx = table.columns.indexOf(name);
	if (idx < 0) throw new Error(`지정한 열 '${name}'을 데이터에서 찾을 수 없습니다`);
	return idx;
}

function toNum(cell: string): number {
	const n = Number(cell);
	return Number.isFinite(n) ? n : 0;
}

function sliceRange(rows: string[][], range: ChartSpec['range']): string[][] {
	if (range.kind === 'all' || !range.n || range.n <= 0) return rows;
	if (range.kind === 'last') return rows.slice(Math.max(0, rows.length - range.n));
	return rows.slice(0, range.n); // first
}

function aggregate(values: number[], method: AggMethod): number {
	if (values.length === 0) return 0;
	switch (method) {
		case 'sum':
			return values.reduce((a, b) => a + b, 0);
		case 'max':
			return Math.max(...values);
		case 'min':
			return Math.min(...values);
		case 'count':
			return values.length;
		case 'average':
		default:
			return values.reduce((a, b) => a + b, 0) / values.length;
	}
}

/** Split [0..len) into `count` contiguous, roughly-even bins; returns [start,end) pairs. */
function binRanges(len: number, count: number): Array<[number, number]> {
	const bins: Array<[number, number]> = [];
	for (let b = 0; b < count; b++) {
		const start = Math.floor((b * len) / count);
		const end = Math.floor(((b + 1) * len) / count);
		if (end > start) bins.push([start, end]);
	}
	return bins;
}

export function transformData(spec: ChartSpec, table: DataTable): ChartData {
	const xIdx = spec.xColumn ? colIndex(table, spec.xColumn) : 0;
	const yNames =
		spec.yColumns && spec.yColumns.length > 0
			? spec.yColumns
			: table.columns.filter((_, i) => i !== xIdx);
	const yIdxs = yNames.map((n) => colIndex(table, n));

	const rows = sliceRange(table.rows, spec.range);

	if (spec.bin && spec.bin.count > 0 && rows.length > spec.bin.count) {
		const bins = binRanges(rows.length, spec.bin.count);
		const labels = bins.map(([s]) => rows[s][xIdx]);
		const series: Series[] = yNames.map((name, k) => ({
			name,
			values: bins.map(([s, e]) =>
				aggregate(
					rows.slice(s, e).map((r) => toNum(r[yIdxs[k]])),
					spec.bin!.method
				)
			)
		}));
		return { labels, series };
	}

	const labels = rows.map((r) => r[xIdx]);
	const series: Series[] = yNames.map((name, k) => ({
		name,
		values: rows.map((r) => toNum(r[yIdxs[k]]))
	}));
	return { labels, series };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/chart/transformData.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/chart/transformData.ts app/tests/unit/chart/transformData.test.ts
git commit -m "feat(chart): 범위/열매핑/묶기 변환 파이프라인"
```

---

### Task 4: Chart.js config 빌더

**Goal:** ChartSpec + ChartData → Chart.js 설정 객체(순수). Chart.js 런타임 없이 객체만 생성하므로 단위 테스트 가능.

**Files:**
- Create: `app/src/lib/chart/buildChartConfig.ts`
- Test: `app/tests/unit/chart/buildChartConfig.test.ts`

**Acceptance Criteria:**
- [ ] bar/line/area/scatter → 알맞은 Chart.js `type` (area = line + fill:true)
- [ ] series → datasets (label, data) 매핑, scatter는 `{x,y}` 포인트
- [ ] stacked → scales.x/y.stacked=true
- [ ] smooth → dataset.tension, showPoints → pointRadius, 점크기 → scatter pointRadius
- [ ] showLegend → plugins.legend.display, x축/y축 라벨, yMin/yMax → scales 범위
- [ ] colors 지정 시 dataset 색 적용, 미지정 시 기본 팔레트 순환

**Verify:** `cd app && npx vitest run tests/unit/chart/buildChartConfig.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/chart/buildChartConfig.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildChartConfig } from '../../../src/lib/chart/buildChartConfig';
import type { ChartSpec } from '../../../src/lib/chart/chartSpec';
import type { ChartData } from '../../../src/lib/chart/transformData';

function spec(over: Partial<ChartSpec> = {}): ChartSpec {
	return {
		type: 'bar',
		title: 't',
		checked: true,
		dataNoteTitle: 'DATA::d',
		range: { kind: 'all' },
		stacked: false,
		smooth: false,
		showPoints: false,
		showValues: false,
		showLegend: true,
		height: 240,
		...over
	};
}
const data: ChartData = {
	labels: ['1월', '2월'],
	series: [{ name: '매출', values: [100, 200] }]
};

describe('buildChartConfig', () => {
	it('bar config with labels and datasets', () => {
		const cfg = buildChartConfig(spec(), data);
		expect(cfg.type).toBe('bar');
		expect(cfg.data.labels).toEqual(['1월', '2월']);
		expect(cfg.data.datasets[0].label).toBe('매출');
		expect(cfg.data.datasets[0].data).toEqual([100, 200]);
	});

	it('area = line + fill', () => {
		const cfg = buildChartConfig(spec({ type: 'area' }), data);
		expect(cfg.type).toBe('line');
		expect(cfg.data.datasets[0].fill).toBe(true);
	});

	it('scatter uses {x,y} points', () => {
		const cfg = buildChartConfig(spec({ type: 'scatter' }), {
			labels: ['1', '2'],
			series: [{ name: 's', values: [10, 20] }]
		});
		expect(cfg.type).toBe('scatter');
		expect(cfg.data.datasets[0].data).toEqual([
			{ x: 1, y: 10 },
			{ x: 2, y: 20 }
		]);
	});

	it('stacked sets scale stacking', () => {
		const cfg = buildChartConfig(spec({ stacked: true }), data);
		expect(cfg.options.scales.x.stacked).toBe(true);
		expect(cfg.options.scales.y.stacked).toBe(true);
	});

	it('axis labels, range, legend', () => {
		const cfg = buildChartConfig(
			spec({ xAxisLabel: '월', yAxisLabel: '금액', yMin: 0, yMax: 500, showLegend: false }),
			data
		);
		expect(cfg.options.scales.x.title).toMatchObject({ display: true, text: '월' });
		expect(cfg.options.scales.y.min).toBe(0);
		expect(cfg.options.scales.y.max).toBe(500);
		expect(cfg.options.plugins.legend.display).toBe(false);
	});

	it('custom colors applied', () => {
		const cfg = buildChartConfig(spec({ colors: ['#abc'] }), data);
		expect(cfg.data.datasets[0].backgroundColor).toBe('#abc');
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/chart/buildChartConfig.test.ts`
Expected: FAIL — `buildChartConfig` not exported.

- [ ] **Step 3: 구현**

`app/src/lib/chart/buildChartConfig.ts`:

```ts
import type { ChartSpec, ChartType } from './chartSpec';
import type { ChartData } from './transformData';

const DEFAULT_PALETTE = [
	'#3b82f6',
	'#ef4444',
	'#10b981',
	'#f59e0b',
	'#8b5cf6',
	'#ec4899',
	'#14b8a6',
	'#f97316'
];

/** Map our ChartType to a Chart.js base type. */
function baseType(type: ChartType): 'bar' | 'line' | 'scatter' {
	if (type === 'area') return 'line';
	return type;
}

export interface ChartJsConfig {
	type: string;
	data: { labels: string[]; datasets: any[] };
	options: any;
}

export function buildChartConfig(spec: ChartSpec, data: ChartData): ChartJsConfig {
	const palette = spec.colors && spec.colors.length > 0 ? spec.colors : DEFAULT_PALETTE;

	const datasets = data.series.map((s, i) => {
		const color = palette[i % palette.length];
		const ds: any = {
			label: s.name,
			borderColor: color,
			backgroundColor: color
		};
		if (spec.type === 'scatter') {
			ds.data = s.values.map((y, idx) => ({ x: Number(data.labels[idx]) || idx, y }));
			ds.pointRadius = spec.pointRadius ?? 4;
		} else {
			ds.data = s.values;
		}
		if (spec.type === 'area') ds.fill = true;
		if (spec.type === 'line' || spec.type === 'area') {
			ds.tension = spec.smooth ? 0.4 : 0;
			ds.pointRadius = spec.showPoints ? (spec.pointRadius ?? 3) : 0;
		}
		return ds;
	});

	const xScale: any = { stacked: spec.stacked };
	const yScale: any = { stacked: spec.stacked };
	if (spec.xAxisLabel) xScale.title = { display: true, text: spec.xAxisLabel };
	if (spec.yAxisLabel) yScale.title = { display: true, text: spec.yAxisLabel };
	if (spec.yMin !== undefined) yScale.min = spec.yMin;
	if (spec.yMax !== undefined) yScale.max = spec.yMax;

	return {
		type: baseType(spec.type),
		data: { labels: data.labels, datasets },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: spec.showLegend },
				title: { display: !!spec.title, text: spec.title }
			},
			scales: { x: xScale, y: yScale }
		}
	};
}
```

> 참고: `showValues`(데이터 라벨)은 Chart.js datalabels 플러그인이 필요하다. v1에서는 config에 자리만 두지 않고 생략한다(YAGNI). 필요 시 후속 작업으로 `chartjs-plugin-datalabels` 추가. AC의 showValues 항목은 본 빌더 범위에서 제외하며, 스펙 토큰은 파서가 받아두기만 한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/chart/buildChartConfig.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/chart/buildChartConfig.ts app/tests/unit/chart/buildChartConfig.test.ts
git commit -m "feat(chart): Chart.js config 빌더"
```

---

### Task 5: 차트 블록 doc 워커

**Goal:** 에디터 doc에서 차트 블록(헤더 단락 + 뒤따르는 bulletList)을 찾아 영역 정보와 설정 라인, 토글 가능한 체크박스 위치를 반환.

**Files:**
- Create: `app/src/lib/editor/chartBlock/findChartRegions.ts`
- Test: `app/tests/unit/chart/findChartRegions.test.ts`

**Acceptance Criteria:**
- [ ] 헤더 단락(`[x]Chart:...`)을 top-level 노드에서 탐지, type 무효면 무시
- [ ] 헤더 바로 다음 bulletList의 모든 list-item 텍스트를 평탄화해 configLines로 수집(중첩 포함)
- [ ] 헤더의 `[ ]`/`[x]` 마커의 문서상 위치(checkboxPos)를 반환(토글용)
- [ ] 헤더 단락 시작/끝 pos 반환(위젯 배치용)
- [ ] 차트 블록이 없으면 빈 배열

**Verify:** `cd app && npx vitest run tests/unit/chart/findChartRegions.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/chart/findChartRegions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { findChartRegions } from '../../../src/lib/editor/chartBlock/findChartRegions';

function para(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function li(text: string, nested?: JSONContent): JSONContent {
	const content: JSONContent[] = [para(text)];
	if (nested) content.push(nested);
	return { type: 'listItem', content };
}
function ul(...items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}

describe('findChartRegions', () => {
	it('detects header + flattens nested config lines', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				para('[x] Chart:bar 제목'),
				ul(
					li('DATA::데이터'),
					li('범위', ul(li('[ ]last:15, [x]all')))
				)
			]
		};
		const regions = findChartRegions(doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].headerText).toBe('[x] Chart:bar 제목');
		expect(regions[0].checked).toBe(true);
		expect(regions[0].configLines).toEqual(['DATA::데이터', '범위', '[ ]last:15, [x]all']);
		expect(typeof regions[0].checkboxPos).toBe('number');
		expect(typeof regions[0].headerFromPos).toBe('number');
	});

	it('ignores invalid type', () => {
		const doc: JSONContent = { type: 'doc', content: [para('[x]Chart:pie x')] };
		expect(findChartRegions(doc)).toEqual([]);
	});

	it('returns empty when no chart header', () => {
		const doc: JSONContent = { type: 'doc', content: [para('hello')] };
		expect(findChartRegions(doc)).toEqual([]);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/chart/findChartRegions.test.ts`
Expected: FAIL — `findChartRegions` not exported.

- [ ] **Step 3: 구현**

`app/src/lib/editor/chartBlock/findChartRegions.ts`:

```ts
import type { JSONContent } from '@tiptap/core';
import { parseChartHeader } from '../../chart/parseChartBlock';

export interface ChartRegion {
	/** Position just inside the header paragraph (where text starts). */
	headerFromPos: number;
	/** Position at the end of the header paragraph text. */
	headerToPos: number;
	/** Position of the '[' marker char within the header text (for toggle). */
	checkboxPos: number;
	headerText: string;
	checked: boolean;
	configLines: string[];
}

function paragraphText(node: JSONContent): string {
	if (!node.content) return '';
	return node.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

/** Recursively collect the first-paragraph text of every listItem in a list. */
function collectListLines(list: JSONContent, out: string[]): void {
	for (const item of list.content ?? []) {
		if (item.type !== 'listItem') continue;
		const kids = item.content ?? [];
		if (kids[0]) out.push(paragraphText(kids[0]));
		for (const k of kids.slice(1)) {
			if (k.type === 'bulletList' || k.type === 'orderedList') collectListLines(k, out);
		}
	}
}

/**
 * Walk top-level nodes. A chart region is a paragraph whose text is a valid
 * chart header, optionally followed by a bulletList holding the config.
 *
 * Position model mirrors ProseMirror: top-level node N starts at `pos`, its
 * inner content starts at `pos + 1`. We track a running offset.
 */
export function findChartRegions(doc: JSONContent): ChartRegion[] {
	const regions: ChartRegion[] = [];
	const nodes = doc.content ?? [];
	let pos = 0; // position before current top-level node
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		const nodeSize = sizeOf(node);
		if (node.type === 'paragraph') {
			const text = paragraphText(node);
			const header = parseChartHeader(text);
			if (header) {
				const headerFromPos = pos + 1; // inside the paragraph
				const configLines: string[] = [];
				const next = nodes[i + 1];
				if (next && (next.type === 'bulletList' || next.type === 'orderedList')) {
					collectListLines(next, configLines);
				}
				regions.push({
					headerFromPos,
					headerToPos: headerFromPos + text.length,
					checkboxPos: headerFromPos + text.indexOf('['),
					headerText: text,
					checked: header.checked,
					configLines
				});
			}
		}
		pos += nodeSize;
	}
	return regions;
}

/** Approximate ProseMirror node size for offset tracking. */
function sizeOf(node: JSONContent): number {
	if (node.type === 'text') return (node.text ?? '').length;
	let inner = 0;
	for (const c of node.content ?? []) inner += sizeOf(c);
	// leaf/textblock wrapper contributes 2 (open+close); text nodes none
	return node.type ? inner + 2 : inner;
}
```

> 위치 계산은 토글/위젯 배치에 쓰인다. 단위 테스트는 `typeof number`만 확인하고, 정확한 토글 동작은 Task 7에서 브라우저로 검증한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/chart/findChartRegions.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/chartBlock/findChartRegions.ts app/tests/unit/chart/findChartRegions.test.ts
git commit -m "feat(chart): 차트 블록 doc 워커 (헤더+설정 라인 수집)"
```

---

### Task 6: Chart.js 렌더러 + 에러 카드 (동적 import)

**Goal:** 컨테이너 + ChartJsConfig를 받아 Chart.js를 동적 import 해 그리고, 파싱/데이터 에러 시 빨간 톤 인라인 에러 카드를 그린다.

**Files:**
- Modify: `app/package.json` (chart.js 의존성 추가)
- Create: `app/src/lib/chart/renderChart.ts`

**Acceptance Criteria:**
- [ ] `chart.js`가 dependencies에 추가됨
- [ ] `mountChart(container, config, height)`가 `<canvas>` 생성 후 Chart.js를 `await import('chart.js/auto')` 로 로드해 렌더, Chart 인스턴스 반환
- [ ] `destroyChart(instance)`로 정리
- [ ] `renderErrorCard(container, message)`가 한국어 메시지의 빨간 톤 카드를 그림
- [ ] 동적 import라 메인 번들 미포함 (geoMap Leaflet과 동일 패턴)

**Verify:** `cd app && npm run check` → no type errors in chart/. (Chart.js 런타임 렌더는 Task 7에서 브라우저 확인.)

**Steps:**

- [ ] **Step 1: chart.js 의존성 추가**

Run:
```bash
cd app && npm install chart.js@^4.4.0
```
Expected: `app/package.json` dependencies에 `"chart.js": "^4.4.x"` 추가, 설치 성공.

- [ ] **Step 2: 렌더러 구현**

`app/src/lib/chart/renderChart.ts`:

```ts
import type { ChartJsConfig } from './buildChartConfig';

// Chart.js instance type kept loose to avoid importing the heavy module eagerly.
export interface ChartHandle {
	destroy(): void;
}

/**
 * Mount a Chart.js chart into `container`. Chart.js is loaded on demand
 * (dynamic import) so it stays out of the main bundle — same pattern as geoMap.
 */
export async function mountChart(
	container: HTMLElement,
	config: ChartJsConfig,
	height: number
): Promise<ChartHandle | null> {
	container.innerHTML = '';
	container.style.height = `${height}px`;
	const canvas = document.createElement('canvas');
	container.appendChild(canvas);

	const { default: Chart } = await import('chart.js/auto');
	const chart = new Chart(canvas, config as never);
	return chart as unknown as ChartHandle;
}

export function destroyChart(handle: ChartHandle | null): void {
	if (handle) handle.destroy();
}

/** Render a red-toned inline error card with a Korean message. */
export function renderErrorCard(container: HTMLElement, message: string): void {
	container.innerHTML = '';
	container.style.removeProperty('height');
	const card = document.createElement('div');
	card.className = 'tomboy-chart-error';
	card.textContent = `⚠ ${message}`;
	container.appendChild(card);
}
```

- [ ] **Step 3: 에러 카드 스타일 추가**

`app/src/lib/chart/renderChart.ts` 하단에 주석으로 안내하고, 실제 CSS는 Task 7의 플러그인이 위젯 컨테이너에 클래스를 부여하므로 전역 스타일을 한 곳에 둔다. `app/src/app.css`(전역) 끝에 추가:

```css
.tomboy-chart-error {
	border: 1px solid #ef4444;
	background: #fef2f2;
	color: #b91c1c;
	border-radius: 8px;
	padding: 8px 12px;
	font-size: 0.9em;
}
.tomboy-chart-widget {
	margin: 8px 0;
	max-width: 100%;
}
```

> `app/src/app.css`가 없으면 전역 스타일 진입점(`+layout.svelte`의 `<style>` 또는 import된 css)을 찾아 동일 규칙을 추가한다.

- [ ] **Step 4: 타입 체크**

Run: `cd app && npm run check`
Expected: chart/ 관련 타입 에러 없음.

- [ ] **Step 5: 커밋**

```bash
git add app/package.json app/package-lock.json app/src/lib/chart/renderChart.ts app/src/app.css
git commit -m "feat(chart): Chart.js 동적 import 렌더러 + 에러 카드"
```

---

### Task 7: 에디터 플러그인 통합 + 체크박스 토글

**Goal:** ProseMirror 플러그인으로 차트 블록을 스캔해 체크 시 차트/에러 카드를 위젯으로 mount, 미체크 시 설정 노출. 헤더 체크박스 클릭으로 `[ ]`↔`[x]` 토글.

> **통합 위치 주의:** 이 저장소에는 `extensions.ts`가 없다. 플러그인은 `TomboyEditor.svelte`의 `extensions` 배열에 인라인 `Extension.create({...})` 블록으로 등록한다(geoMap의 `tomboyGeoMap` 블록과 동일 패턴, 파일 내 lines ~417-421 참고). 또한 데이터 노트의 JSONContent는 `getNoteEditorContent(note)`(`lib/core/noteManager.ts`)로 얻는다 — `NoteData`의 본문 필드는 `xmlContent`이며 `deserializeContent`로 디코드된다. `noteContentToJson`/`note.content` 같은 API는 없다.

**Files:**
- Create: `app/src/lib/editor/chartBlock/chartBlockPlugin.ts`
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (인라인 Extension.create 등록)

**Acceptance Criteria:**
- [ ] 체크된(`[x]`) 차트 블록 헤더 뒤에 차트 위젯(`<canvas>`)이 렌더됨
- [ ] 데이터 노트를 못 찾거나 csv 없거나 열 오류 시 그 자리에 한국어 에러 카드
- [ ] 미체크(`[ ]`)면 차트를 그리지 않고 설정 리스트 원본만 보임
- [ ] 헤더의 체크박스 클릭 시 `[ ]`↔`[x]` 텍스트 토글되어 렌더/숨김 전환
- [ ] 데이터는 렌더 시점에 `findNoteByTitle`로 1회 스냅샷, 토글/재오픈 시 갱신
- [ ] `npm run check` 통과

**Verify:** `cd app && npm run check` 통과 + `npm run dev` 로 아래 수동 시나리오 통과:
1. `DATA::예제` 노트에 ` ```csv ` 표 작성
2. 다른 노트에 `[x]Chart:bar 예제` + `- DATA::예제` 작성 → 막대 차트 렌더
3. 헤더 체크박스 해제 → 설정만 보임, 다시 체크 → 차트 복귀
4. 데이터 노트 제목 오타 → 에러 카드 표시

**Steps:**

- [ ] **Step 1: 플러그인 구현**

`app/src/lib/editor/chartBlock/chartBlockPlugin.ts`:

```ts
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { findChartRegions, type ChartRegion } from './findChartRegions';
import { parseChartBlock } from '../../chart/parseChartBlock';
import { parseDataNote } from '../../chart/parseDataNote';
import { transformData } from '../../chart/transformData';
import { buildChartConfig } from '../../chart/buildChartConfig';
import { mountChart, destroyChart, renderErrorCard, type ChartHandle } from '../../chart/renderChart';
import { findNoteByTitle, getNoteEditorContent } from '../../core/noteManager';

export const chartBlockPluginKey = new PluginKey('tomboyChartBlock');

function buildDecorations(doc: PMNode): DecorationSet {
	const regions = findChartRegions(doc.toJSON());
	const decos: Decoration[] = [];
	for (const region of regions) {
		if (!region.checked) continue; // unchecked → show config text, no widget
		decos.push(
			Decoration.widget(region.headerToPos, () => renderChartWidget(region), {
				side: 1,
				key: `chart:${region.headerFromPos}:${region.headerText}`
			})
		);
	}
	return DecorationSet.create(doc, decos);
}

/** Build the widget container and asynchronously fill it with a chart or error. */
function renderChartWidget(region: ChartRegion): HTMLElement {
	const container = document.createElement('div');
	container.className = 'tomboy-chart-widget';
	container.contentEditable = 'false';
	let handle: ChartHandle | null = null;

	void (async () => {
		const spec = parseChartBlock(region.headerText, region.configLines);
		if (!spec || !spec.dataNoteTitle) {
			renderErrorCard(container, '데이터 노트 제목(DATA::)이 필요합니다');
			return;
		}
		const note = await findNoteByTitle(spec.dataNoteTitle);
		if (!note) {
			renderErrorCard(container, `데이터 노트 '${spec.dataNoteTitle}'를 찾을 수 없습니다`);
			return;
		}
		const tables = parseDataNote(getNoteEditorContent(note));
		if (tables.length === 0) {
			renderErrorCard(container, '데이터 노트에 csv/tsv 블록이 없습니다');
			return;
		}
		try {
			const data = transformData(spec, tables[0]);
			const config = buildChartConfig(spec, data);
			handle = await mountChart(container, config, spec.height);
		} catch (err) {
			renderErrorCard(container, err instanceof Error ? err.message : '차트를 그릴 수 없습니다');
		}
	})();

	// Clean up the Chart.js instance when ProseMirror removes the widget.
	const observer = new MutationObserver(() => {
		if (!container.isConnected) {
			destroyChart(handle);
			observer.disconnect();
		}
	});
	if (container.ownerDocument?.body) {
		observer.observe(container.ownerDocument.body, { childList: true, subtree: true });
	}
	return container;
}

/** Toggle the header checkbox text [ ] <-> [x] at checkboxPos. */
function toggleHeaderCheckbox(view: EditorView, region: ChartRegion): void {
	const from = region.checkboxPos;
	const cur = view.state.doc.textBetween(from, from + 3); // "[ ]" or "[x]"
	const next = cur.toLowerCase() === '[x]' ? '[ ]' : '[x]';
	view.dispatch(view.state.tr.insertText(next, from, from + 3));
}

export function createChartBlockPlugin(): Plugin {
	return new Plugin({
		key: chartBlockPluginKey,
		state: {
			init(_, { doc }): DecorationSet {
				return buildDecorations(doc);
			},
			apply(tr, old): DecorationSet {
				if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
				return buildDecorations(tr.doc);
			}
		},
		props: {
			decorations(state): DecorationSet | undefined {
				return chartBlockPluginKey.getState(state);
			},
			handleClickOn(view, _pos, _node, _nodePos, event): boolean {
				// Toggle when the click lands on the header's checkbox text.
				const regions = findChartRegions(view.state.doc.toJSON());
				const clickPos = view.posAtCoords({ left: (event as MouseEvent).clientX, top: (event as MouseEvent).clientY });
				if (!clickPos) return false;
				for (const region of regions) {
					if (clickPos.pos >= region.checkboxPos && clickPos.pos <= region.checkboxPos + 3) {
						toggleHeaderCheckbox(view, region);
						return true;
					}
				}
				return false;
			}
		}
	});
}
```

> 데이터 스냅샷: 위젯이 mount될 때마다 `findNoteByTitle`로 1회 조회한다. 토글하거나 노트를 다시 열면 위젯 key가 바뀌어 재mount → 자동 갱신. 실시간 구독은 비범위.

- [ ] **Step 2: TomboyEditor.svelte에 인라인 등록**

`app/src/lib/editor/TomboyEditor.svelte` 상단 import 영역(다른 plugin import들 근처, 예: `createGeoMapPlugin` import 아래)에 추가:

```ts
import { createChartBlockPlugin } from "./chartBlock/chartBlockPlugin.js";
```

그리고 `extensions` 배열의 `tomboyGeoMap` 블록(`Extension.create({ name: "tomboyGeoMap", … })`) 바로 다음에 동일 패턴으로 블록을 추가:

```ts
				Extension.create({
					name: "tomboyChartBlock",
					addProseMirrorPlugins() {
						return [createChartBlockPlugin()];
					},
				}),
```

> 차트 위젯은 체크된 블록의 데이터를 표시만 하고 문서를 변형하지 않으므로 체크리스트/테이블 블록 등 다른 데코레이션 플러그인과 순서 의존성이 없다. geoMap 블록 뒤 어디든 무방.

- [ ] **Step 3: 타입 체크**

Run: `cd app && npm run check`
Expected: 에러 없음. (`findNoteByTitle` / `getNoteEditorContent`는 `lib/core/noteManager.ts`에서 export됨 — 시그니처 불일치 시 실제 export에 맞춰 수정.)

- [ ] **Step 4: 수동 브라우저 검증**

Run: `cd app && npm run dev`
위 **Verify**의 4가지 시나리오를 브라우저에서 수행하고 모두 통과 확인.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/chartBlock/chartBlockPlugin.ts app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(chart): 에디터 차트 블록 플러그인 + 체크박스 토글 통합"
```

---

## Self-Review

- **Spec coverage:**
  - 데이터 노트 DATA:: + csv/tsv 여러 블록 → Task 2 ✓
  - 차트 블록 시그니처/헤더 없이 인식 → Task 5 (top-level 단락 스캔) ✓
  - 체크 시 렌더/미체크 시 설정 노출 + 토글 → Task 7 ✓
  - 토큰 기반 옵션(range/x·y/묶기·방식/stacked/곡선·점표시/점크기/색상·팔레트/범례·값표시/축·범위·높이) → Task 1 파서 + Task 3/4 적용 ✓
  - 기본 매핑 + 재지정 → Task 3 ✓
  - binning 평균/합계/… + 구간 첫 값 레이블 → Task 3 ✓
  - bar/line/area/scatter, pie 제외 → Task 1 `CHART_TYPES`, Task 4 ✓
  - 렌더 시점 스냅샷 → Task 7 ✓
  - 인라인 에러 카드 → Task 6/7 ✓
  - Chart.js 동적 import → Task 6 ✓
  - **알려진 갭:** `값표시`(데이터 라벨)는 datalabels 플러그인 필요로 v1 빌더에서 생략(파서는 토큰 수용). Task 4 주석에 명시.
- **Placeholder scan:** 모든 코드 스텝에 실제 코드 포함, "TBD/적절히 처리" 없음.
- **Type consistency:** `ChartSpec`(Task1) → `transformData`(Task3) → `buildChartConfig`(Task4) → `renderChart`(Task6) → 플러그인(Task7) 전 구간 타입/필드명 일치. `DataTable`(Task2)은 Task3에서 소비. `ChartRegion`(Task5)은 Task7에서 소비.

## 의존성 순서

Task 1 → (2,3,4 는 1에 의존, 3은 2에 의존) → 5(1에 의존) → 6 → 7(1·2·3·4·5·6 전부에 의존).
