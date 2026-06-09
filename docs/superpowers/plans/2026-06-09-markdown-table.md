# 마크다운 테이블 (GFM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 CSV/TSV `tableBlock` 엔진을 공유하면서 표준 GFM 마크다운 테이블(`| h |` + 구분선 + 정렬)을 네이티브 인식·렌더하고, Alt+T로 빈 2×2 표를 삽입한다.

**Architecture:** `app/src/lib/editor/tableBlock/`에 `'markdown'`을 세 번째 `TableFormat`으로 추가한다. 플러그인 상태머신·셀편집·렌더 엔진은 단일 유지하고, 마크다운 고유 부분(네이티브 영역 탐지, 구분선/정렬, 바깥 파이프)만 새 함수/분기로 더한다. CSV/TSV 코드 경로는 바이트 동일하게 보존(기존 단위 테스트가 회귀 가드).

**Tech Stack:** SvelteKit, TipTap 3 / ProseMirror, TypeScript, vitest + @testing-library/svelte.

**Spec:** `docs/superpowers/specs/2026-06-09-markdown-table-design.md`

---

### Task 1: 마크다운 파싱 프리미티브 (parseTable.ts)

**Goal:** `parseTable.ts`에 마크다운 포맷·정렬 타입과 순수 파싱 헬퍼(구분선 탐지, 정렬 파싱, 바깥 파이프 strip, 셀 경계 계산, 행 레이아웃)를 추가하고 `parseTableRows`/`parseInlineCells`에 markdown 분기를 더한다.

**Files:**
- Modify: `app/src/lib/editor/tableBlock/parseTable.ts`
- Test: `app/tests/unit/editor/parseTableMarkdown.test.ts` (create)

**Acceptance Criteria:**
- [ ] `TableFormat`이 `'csv' | 'tsv' | 'markdown'`이고 `Alignment` 타입이 export됨
- [ ] `isSeparatorRow('| --- | :--: |')` → true, `isSeparatorRow('---')` → false (파이프 없음), `isSeparatorRow('| a | b |')` → false
- [ ] `parseAlignments('| :--- | :--: | ---: | --- |')` → `['left','center','right',null]`
- [ ] `stripOuterPipeInlines`가 단일/다중 텍스트노드에서 바깥 파이프 1개씩만 제거하고 마크 보존
- [ ] `markdownRowLayout('| a | b |')`가 raw 셀 청크 2개와 `hasLead/hasTrail=true` 반환
- [ ] `cellCharRanges`가 csv/tsv 기존 의미와 일치하고 markdown은 바깥 파이프 보정된 trimmed 범위 반환
- [ ] `parseTableRows([...], 'markdown')`가 바깥 파이프 제거 + `|` 분리 + trim, 구분선/빈행 skip
- [ ] `parseInlineCells([...], 'markdown')`가 마크 보존하며 동일 분리
- [ ] **기존 `parseTable.test.ts` 전부 통과** (csv/tsv 무변경)

**Verify:** `cd app && npm run test -- parseTable` → 신규 + 기존 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/editor/parseTableMarkdown.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
	isSeparatorRow,
	parseAlignments,
	stripOuterPipeInlines,
	markdownRowLayout,
	cellCharRanges,
	parseTableRows,
	parseInlineCells
} from '$lib/editor/tableBlock/parseTable.js';
import type { JSONContent } from '@tiptap/core';

describe('isSeparatorRow', () => {
	it('recognises a pipe-delimited dash row', () => {
		expect(isSeparatorRow('| --- | --- |')).toBe(true);
		expect(isSeparatorRow('| :--- | :--: | ---: |')).toBe(true);
		expect(isSeparatorRow('---|---')).toBe(true);
	});
	it('rejects a bare dash row (that is HR-split, not a table)', () => {
		expect(isSeparatorRow('---')).toBe(false);
		expect(isSeparatorRow('  ---  ')).toBe(false);
	});
	it('rejects a data row', () => {
		expect(isSeparatorRow('| a | b |')).toBe(false);
		expect(isSeparatorRow('| 1 | 2 |')).toBe(false);
	});
	it('rejects an empty / pipe-only row', () => {
		expect(isSeparatorRow('')).toBe(false);
		expect(isSeparatorRow('|  |')).toBe(false);
	});
});

describe('parseAlignments', () => {
	it('maps colon markers to alignment', () => {
		expect(parseAlignments('| :--- | :--: | ---: | --- |')).toEqual([
			'left',
			'center',
			'right',
			null
		]);
	});
	it('handles no outer pipes', () => {
		expect(parseAlignments(':--:|--:')).toEqual(['center', 'right']);
	});
});

describe('stripOuterPipeInlines', () => {
	it('drops one leading and one trailing pipe, single node', () => {
		const out = stripOuterPipeInlines([{ type: 'text', text: '| a | b |' }]);
		expect(out.map((n) => n.text).join('')).toBe(' a | b ');
	});
	it('preserves marks while stripping', () => {
		const inlines: JSONContent[] = [
			{ type: 'text', text: '| ' },
			{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
			{ type: 'text', text: ' |' }
		];
		const out = stripOuterPipeInlines(inlines);
		expect(out[0].text).toBe(' ');
		expect(out[1].marks?.[0].type).toBe('bold');
		expect(out[2].text).toBe(' ');
	});
});

describe('markdownRowLayout', () => {
	it('splits raw chunks and flags outer pipes', () => {
		const l = markdownRowLayout('| a | b |');
		expect(l.hasLead).toBe(true);
		expect(l.hasTrail).toBe(true);
		expect(l.cells.map((c) => 'a | b |'.length >= 0)).toHaveLength(2);
		// raw chunk contents
		expect('| a | b |'.slice(l.cells[0].start, l.cells[0].end)).toBe(' a ');
		expect('| a | b |'.slice(l.cells[1].start, l.cells[1].end)).toBe(' b ');
	});
	it('handles missing outer pipes', () => {
		const l = markdownRowLayout('a | b');
		expect(l.hasLead).toBe(false);
		expect(l.hasTrail).toBe(false);
		expect(l.cells).toHaveLength(2);
	});
});

describe('cellCharRanges — markdown', () => {
	it('returns trimmed content ranges accounting for outer pipes', () => {
		const text = '| alpha | beta |';
		const ranges = cellCharRanges(text, 'markdown');
		expect(text.slice(ranges[0].start, ranges[0].end)).toBe('alpha');
		expect(text.slice(ranges[1].start, ranges[1].end)).toBe('beta');
	});
	it('zero-width range for an empty cell', () => {
		const text = '| a |  |';
		const ranges = cellCharRanges(text, 'markdown');
		expect(ranges[1].start).toBe(ranges[1].end);
	});
});

describe('parseTableRows / parseInlineCells — markdown', () => {
	it('parses rows, stripping outer pipes and trimming', () => {
		expect(parseTableRows(['| a | b |', '| 1 | 2 |'], 'markdown')).toEqual([
			['a', 'b'],
			['1', '2']
		]);
	});
	it('skips a separator row defensively', () => {
		expect(parseTableRows(['| a | b |', '| --- | --- |'], 'markdown')).toEqual([
			['a', 'b']
		]);
	});
	it('preserves marks in inline cells', () => {
		const para: JSONContent = {
			type: 'paragraph',
			content: [
				{ type: 'text', text: '| ' },
				{ type: 'text', text: 'x', marks: [{ type: 'bold' }] },
				{ type: 'text', text: ' | y |' }
			]
		};
		const cells = parseInlineCells([para], 'markdown');
		expect(cells[0][0][0].marks?.[0].type).toBe('bold');
		expect(cells[0][1][0].text).toBe('y');
	});
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npm run test -- parseTableMarkdown` → FAIL (`isSeparatorRow` 등 미정의)

- [ ] **Step 3: 구현** — `app/src/lib/editor/tableBlock/parseTable.ts` 수정

`TableFormat` 라인 교체 + 타입 추가:
```ts
export type TableFormat = 'csv' | 'tsv' | 'markdown';
export type Alignment = 'left' | 'center' | 'right' | null;
```

`sepFor` 헬퍼 추가(파일 상단, 타입 다음):
```ts
/** Cell separator character for a format. Markdown uses the pipe. */
function sepFor(format: TableFormat): string {
	if (format === 'csv') return ',';
	if (format === 'tsv') return '\t';
	return '|';
}
```

파일 끝에 마크다운 헬퍼 추가:
```ts
/**
 * A markdown separator row (` | --- | :--: | ` etc.) — the row that turns a
 * pipe-delimited line into a real table. Each cell must be `:?-+:?` after
 * outer-pipe stripping, AND the raw line must contain at least one `|`. The
 * pipe requirement is load-bearing: it disambiguates from the `hrSplit`
 * feature, where a bare `---` line means a vertical column divider.
 */
export function isSeparatorRow(line: string): boolean {
	if (!line.includes('|')) return false;
	const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
	const cells = inner.split('|').map((c) => c.trim());
	if (cells.length === 0) return false;
	return cells.every((c) => /^:?-+:?$/.test(c));
}

/** Parse per-column alignment from a markdown separator row. */
export function parseAlignments(line: string): Alignment[] {
	const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
	return inner.split('|').map((raw) => {
		const c = raw.trim();
		const left = c.startsWith(':');
		const right = c.endsWith(':');
		if (left && right) return 'center';
		if (right) return 'right';
		if (left) return 'left';
		return null;
	});
}

/**
 * Drop exactly one leading and one trailing `|` from an inline-node array
 * (GFM optional outer pipes), preserving marks. Inner spacing is left for
 * per-cell `trimInlines` to handle.
 */
export function stripOuterPipeInlines(inlines: JSONContent[]): JSONContent[] {
	const out = inlines.map((n) => ({ ...n }));
	for (let i = 0; i < out.length; i++) {
		const n = out[i];
		if (n.type !== 'text' || typeof n.text !== 'string') break;
		if (n.text.trim().length === 0) continue;
		n.text = n.text.replace(/^(\s*)\|/, '$1');
		break;
	}
	for (let i = out.length - 1; i >= 0; i--) {
		const n = out[i];
		if (n.type !== 'text' || typeof n.text !== 'string') break;
		if (n.text.trim().length === 0) continue;
		n.text = n.text.replace(/\|(\s*)$/, '$1');
		break;
	}
	return out;
}

export interface MarkdownRowLayout {
	hasLead: boolean;
	hasTrail: boolean;
	/** Raw (untrimmed) inter-pipe chunk bounds in the original text. */
	cells: { start: number; end: number }[];
}

/**
 * Locate the raw cell chunks of a markdown row in `text` coordinates,
 * reporting whether outer pipes are present. Used by cell-range and
 * column-op math so the pipe bookkeeping lives in one place.
 */
export function markdownRowLayout(text: string): MarkdownRowLayout {
	const leadWs = text.length - text.replace(/^\s+/, '').length;
	const trailWs = text.length - text.replace(/\s+$/, '').length;
	let i = leadWs;
	let j = text.length - trailWs;
	let hasLead = false;
	let hasTrail = false;
	if (i < j && text[i] === '|') {
		hasLead = true;
		i++;
	}
	if (j > i && text[j - 1] === '|') {
		hasTrail = true;
		j--;
	}
	const cells: { start: number; end: number }[] = [];
	let cellStart = i;
	for (let k = i; k < j; k++) {
		if (text[k] === '|') {
			cells.push({ start: cellStart, end: k });
			cellStart = k + 1;
		}
	}
	cells.push({ start: cellStart, end: j });
	return { hasLead, hasTrail, cells };
}

/**
 * Per-cell editable-content ranges in `text` coordinates for a row of the
 * given format. Single source of truth for cell-edit and column-delete math.
 *
 *  - tsv: full inter-tab chunk, untrimmed.
 *  - csv / markdown: trimmed content; an all-whitespace cell collapses to a
 *    zero-width range at its logical caret slot (after leading whitespace).
 *  - markdown additionally strips outer pipes via `markdownRowLayout`.
 */
export function cellCharRanges(
	text: string,
	format: TableFormat
): { start: number; end: number }[] {
	if (format === 'markdown') {
		const layout = markdownRowLayout(text);
		return layout.cells.map(({ start, end }) => {
			const raw = text.slice(start, end);
			const lead = raw.length - raw.replace(/^\s+/, '').length;
			const trimmed = raw.trim();
			if (trimmed.length === 0) {
				return { start: start + lead, end: start + lead };
			}
			return { start: start + lead, end: start + lead + trimmed.length };
		});
	}
	const sep = sepFor(format);
	const parts = text.split(sep);
	const out: { start: number; end: number }[] = [];
	let offset = 0;
	for (const cell of parts) {
		if (format === 'tsv') {
			out.push({ start: offset, end: offset + cell.length });
		} else {
			const lead = cell.length - cell.replace(/^\s+/, '').length;
			const trimmed = cell.trim();
			if (trimmed.length === 0) {
				out.push({ start: offset + lead, end: offset + lead });
			} else {
				out.push({ start: offset + lead, end: offset + lead + trimmed.length });
			}
		}
		offset += cell.length + sep.length;
	}
	return out;
}
```

`parseTableRows`에 markdown 분기 추가 (기존 함수 본문의 루프 내부, csv/tsv 분기 옆):
```ts
export function parseTableRows(lines: string[], format: TableFormat): string[][] {
	const sep = sepFor(format);
	const out: string[][] = [];
	for (const raw of lines) {
		if (isBlankRow(raw, sep)) continue;
		if (format === 'markdown') {
			if (isSeparatorRow(raw)) continue;
			const inner = raw.trim().replace(/^\|/, '').replace(/\|$/, '');
			out.push(inner.split('|').map((c) => c.trim()));
		} else if (format === 'csv') {
			out.push(raw.split(',').map((c) => c.trim()));
		} else {
			out.push(raw.split('\t'));
		}
	}
	return out;
}
```
(주의: 기존 `const sep = format === 'csv' ? ',' : '\t';` 라인을 `const sep = sepFor(format);`로 교체.)

`parseInlineCells`에 markdown 분기:
```ts
export function parseInlineCells(
	bodyParagraphs: JSONContent[],
	format: TableFormat
): JSONContent[][][] {
	const rows: JSONContent[][][] = [];
	const sep = sepFor(format);
	for (const para of bodyParagraphs) {
		const inlines = para.content ?? [];
		const plain = inlines
			.filter((n) => n.type === 'text')
			.map((n) => n.text ?? '')
			.join('');
		if (isBlankRow(plain, sep)) continue;
		if (format === 'markdown') {
			if (isSeparatorRow(plain)) continue;
			const stripped = stripOuterPipeInlines(inlines);
			const cells = splitInlinesByChar(stripped, '|');
			rows.push(cells.map((c) => trimInlines(c)));
		} else {
			const cells = splitInlinesByChar(inlines, sep);
			rows.push(format === 'csv' ? cells.map((c) => trimInlines(c)) : cells);
		}
	}
	return rows;
}
```
(기존 `const sep = format === 'csv' ? ',' : '\t';`를 `sepFor(format)`로 교체.)

- [ ] **Step 4: 통과 확인** — Run: `cd app && npm run test -- parseTable` → 신규 + 기존 PASS

- [ ] **Step 5: 커밋**
```bash
git add app/src/lib/editor/tableBlock/parseTable.ts app/tests/unit/editor/parseTableMarkdown.test.ts
git commit -m "feat(table): 마크다운 파싱 프리미티브(구분선·정렬·바깥파이프·셀범위)"
```

---

### Task 2: 마크다운 영역 탐지 (findTableRegions.ts)

**Goal:** `TableRegion`에 `align?`/`separatorParaRange?`를 추가하고, 펜스 대신 헤더+구분선+데이터 run을 인식하는 `findMarkdownTableRegions(doc)`를 구현한다. CSV/TSV 펜스 내부 단락은 제외한다.

**Files:**
- Modify: `app/src/lib/editor/tableBlock/findTableRegions.ts`
- Test: `app/tests/unit/editor/findMarkdownTableRegions.test.ts` (create)

**Acceptance Criteria:**
- [ ] `TableRegion.align?: Alignment[]`, `TableRegion.separatorParaRange?: BodyParaRange` 추가
- [ ] `| h1 | h2 |` + `| --- | --- |` + 데이터행을 region 1개로 탐지 (`format:'markdown'`)
- [ ] `cells`/`rows`/`bodyParaRanges`가 헤더+데이터만 포함, 구분선 제외; `separatorParaRange`가 구분선 단락 지정
- [ ] `align`이 구분선에서 파싱됨
- [ ] 헤더+구분선만(데이터 0행) 있는 표도 탐지
- [ ] `---` 단독 행(파이프 없음)은 표로 탐지 안 함
- [ ] ` ```csv ` 펜스 내부의 파이프 라인은 마크다운 표로 탐지 안 함
- [ ] 연속한 두 표(빈 줄로 구분)는 별개 region 2개

**Verify:** `cd app && npm run test -- findMarkdownTableRegions` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/editor/findMarkdownTableRegions.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { findMarkdownTableRegions } from '$lib/editor/tableBlock/findTableRegions.js';

function makeEditor(lines: string[]): Editor {
	return new Editor({
		extensions: [Document, Paragraph, Text],
		content: {
			type: 'doc',
			content: lines.map((line) =>
				line.length === 0
					? { type: 'paragraph' }
					: { type: 'paragraph', content: [{ type: 'text', text: line }] }
			)
		}
	});
}

describe('findMarkdownTableRegions', () => {
	it('returns nothing for plain text', () => {
		const ed = makeEditor(['hello', 'world']);
		expect(findMarkdownTableRegions(ed.state.doc)).toEqual([]);
	});

	it('detects a header + separator + data table', () => {
		const ed = makeEditor([
			'intro',
			'| 이름 | 값 |',
			'| --- | --- |',
			'| 1 | 가 |',
			'| 2 | 나 |',
			'after'
		]);
		const r = findMarkdownTableRegions(ed.state.doc);
		expect(r).toHaveLength(1);
		expect(r[0].format).toBe('markdown');
		expect(r[0].rows).toEqual([
			['이름', '값'],
			['1', '가'],
			['2', '나']
		]);
		// header + 2 data rows = 3 bodyParaRanges; separator excluded
		expect(r[0].bodyParaRanges).toHaveLength(3);
		expect(r[0].separatorParaRange).toBeTruthy();
	});

	it('parses alignment from the separator', () => {
		const ed = makeEditor(['| a | b | c |', '| :--- | :--: | ---: |', '| 1 | 2 | 3 |']);
		const r = findMarkdownTableRegions(ed.state.doc);
		expect(r[0].align).toEqual(['left', 'center', 'right']);
	});

	it('detects a header-only table (no data rows)', () => {
		const ed = makeEditor(['| a | b |', '| --- | --- |']);
		const r = findMarkdownTableRegions(ed.state.doc);
		expect(r).toHaveLength(1);
		expect(r[0].rows).toEqual([['a', 'b']]);
		expect(r[0].bodyParaRanges).toHaveLength(1);
	});

	it('does NOT treat a bare --- line as a table (hrSplit, not a table)', () => {
		const ed = makeEditor(['heading', '---', 'body']);
		expect(findMarkdownTableRegions(ed.state.doc)).toEqual([]);
	});

	it('ignores pipe lines inside a csv fence', () => {
		const ed = makeEditor(['```csv', '| not | a | md table |', '| --- | --- | --- |', '```']);
		expect(findMarkdownTableRegions(ed.state.doc)).toEqual([]);
	});

	it('separates two consecutive tables split by a blank line', () => {
		const ed = makeEditor([
			'| a | b |',
			'| --- | --- |',
			'| 1 | 2 |',
			'',
			'| c | d |',
			'| --- | --- |',
			'| 3 | 4 |'
		]);
		expect(findMarkdownTableRegions(ed.state.doc)).toHaveLength(2);
	});
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npm run test -- findMarkdownTableRegions` → FAIL (미정의)

- [ ] **Step 3: 구현** — `app/src/lib/editor/tableBlock/findTableRegions.ts` 수정

import에 마크다운 헬퍼 추가:
```ts
import {
	detectFenceFormat,
	isBlankRow,
	isFenceClose,
	isSeparatorRow,
	parseAlignments,
	parseTableRows,
	parseInlineCells,
	type Alignment,
	type TableFormat
} from './parseTable.js';
```

`TableRegion` 인터페이스에 필드 추가:
```ts
export interface TableRegion {
	// ... 기존 필드 ...
	openLine: string;
	/** Per-column alignment (markdown only; undefined for csv/tsv). */
	align?: Alignment[];
	/** The `| --- |` separator paragraph (markdown only) — column ops keep
	 *  it in sync with the data rows. Not part of `bodyParaRanges`. */
	separatorParaRange?: BodyParaRange;
}
```

파일 끝에 추가 (펜스 제외 헬퍼 + 마크다운 탐지):
```ts
/**
 * Paragraph indices that fall INSIDE a ` ```csv ` / ` ```tsv ` fenced region
 * (inclusive of the fence lines). Markdown detection skips these so the two
 * table features never claim the same paragraphs.
 */
function fencedParaIndices(paras: ParaInfo[]): Set<number> {
	const inside = new Set<number>();
	let i = 0;
	while (i < paras.length) {
		if (!detectFenceFormat(paras[i].text)) {
			i++;
			continue;
		}
		let j = i + 1;
		let foundClose = false;
		while (j < paras.length) {
			if (isFenceClose(paras[j].text)) {
				foundClose = true;
				break;
			}
			if (detectFenceFormat(paras[j].text) !== null) break;
			j++;
		}
		if (!foundClose) {
			i = Math.max(j, i + 1);
			continue;
		}
		for (let k = i; k <= j; k++) inside.add(paras[k].idx);
		i = j + 1;
	}
	return inside;
}

function bodyRange(p: ParaInfo): BodyParaRange {
	return { from: p.from, to: p.to, textFrom: p.from + 1, textTo: p.to - 1 };
}

/**
 * Native GFM markdown tables: a header paragraph containing `|`, immediately
 * followed by a separator row (`| --- |`), then zero or more data paragraphs
 * containing `|`. No fences. The separator row is tracked separately and is
 * NOT part of `cells` / `rows` / `bodyParaRanges`, so row indices keep the
 * `0 = header, 1+ = data` meaning shared with the csv/tsv engine.
 */
export function findMarkdownTableRegions(doc: PMNode): TableRegion[] {
	const paras = collectTopLevelParagraphs(doc);
	const fenced = fencedParaIndices(paras);
	const regions: TableRegion[] = [];
	let i = 0;
	while (i < paras.length) {
		const header = paras[i];
		const sepP = paras[i + 1];
		const isHeader =
			!fenced.has(header.idx) &&
			header.text.includes('|') &&
			!isSeparatorRow(header.text) &&
			header.text.trim().length > 0 &&
			sepP &&
			!fenced.has(sepP.idx) &&
			isSeparatorRow(sepP.text);
		if (!isHeader) {
			i++;
			continue;
		}
		// Absorb consecutive data paragraphs that still look like table rows.
		let j = i + 2;
		while (
			j < paras.length &&
			!fenced.has(paras[j].idx) &&
			paras[j].text.includes('|') &&
			!isSeparatorRow(paras[j].text) &&
			paras[j].text.trim().length > 0
		) {
			j++;
		}
		const dataParas = paras.slice(i + 2, j);
		const contentParas = [header, ...dataParas]; // header + data (no separator)
		const lines = contentParas.map((p) => p.text);
		const json = contentParas.map((p) => p.json);
		const lastData = dataParas.length > 0 ? dataParas[dataParas.length - 1] : sepP;
		regions.push({
			format: 'markdown',
			rows: parseTableRows(lines, 'markdown'),
			cells: parseInlineCells(json, 'markdown'),
			bodyParaRanges: contentParas.map(bodyRange),
			separatorParaRange: bodyRange(sepP),
			align: parseAlignments(sepP.text),
			openParaIdx: header.idx,
			closeParaIdx: lastData.idx,
			openFromPos: header.from,
			closeToPos: lastData.to,
			openLine: header.text
		});
		i = j;
	}
	return regions;
}
```

- [ ] **Step 4: 통과 확인** — Run: `cd app && npm run test -- findMarkdownTableRegions findTableRegions` → 신규 + 기존 PASS

- [ ] **Step 5: 커밋**
```bash
git add app/src/lib/editor/tableBlock/findTableRegions.ts app/tests/unit/editor/findMarkdownTableRegions.test.ts
git commit -m "feat(table): 마크다운 네이티브 영역 탐지 + 정렬/구분선 추적"
```

---

### Task 3: 마크다운 셀 편집 범위 (cellEdit.ts)

**Goal:** `findCellEditRange`를 `cellCharRanges`로 위임해 markdown(바깥 파이프 보정)을 지원하고, csv/tsv 동작은 동일하게 보존한다.

**Files:**
- Modify: `app/src/lib/editor/tableBlock/cellEdit.ts`
- Test: `app/tests/unit/editor/cellEditMarkdown.test.ts` (create)

**Acceptance Criteria:**
- [ ] markdown 행 `| alpha | beta |`의 col 1 편집 범위가 정확히 `beta`를 가리킴
- [ ] markdown 빈 셀은 zero-width 범위(`from === to`)
- [ ] csv/tsv 범위 계산이 기존과 동일 (회귀 없음)
- [ ] `commitCellEdit`이 markdown 셀에 새 텍스트를 정확히 삽입

**Verify:** `cd app && npm run test -- cellEdit tableBlockPlugin` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/editor/cellEditMarkdown.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { findMarkdownTableRegions } from '$lib/editor/tableBlock/findTableRegions.js';
import { findCellEditRange, commitCellEdit } from '$lib/editor/tableBlock/cellEdit.js';

function makeEditor(lines: string[]): Editor {
	return new Editor({
		extensions: [Document, Paragraph, Text],
		content: {
			type: 'doc',
			content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
		}
	});
}

describe('findCellEditRange — markdown', () => {
	it('points at the trimmed content of a cell', () => {
		const ed = makeEditor(['| alpha | beta |', '| --- | --- |']);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		const range = findCellEditRange(ed.state.doc, region, 0, 1)!;
		expect(ed.state.doc.textBetween(range.from, range.to, '')).toBe('beta');
	});

	it('returns a zero-width range for an empty cell', () => {
		const ed = makeEditor(['| a |  |', '| --- | --- |']);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		const range = findCellEditRange(ed.state.doc, region, 0, 1)!;
		expect(range.from).toBe(range.to);
	});

	it('commit replaces only the targeted cell', () => {
		const ed = makeEditor(['| alpha | beta |', '| --- | --- |']);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		const tr = commitCellEdit(ed.state, region, 0, 1, 'BETA')!;
		ed.view.dispatch(tr);
		expect(ed.state.doc.firstChild!.textContent).toBe('| alpha | BETA |');
	});
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npm run test -- cellEditMarkdown` → FAIL

- [ ] **Step 3: 구현** — `cellEdit.ts`의 `findCellEditRange` 본문을 `cellCharRanges` 위임으로 교체

import 수정:
```ts
import { cellCharRanges } from './parseTable.js';
```

`findCellEditRange` 교체:
```ts
export function findCellEditRange(
	doc: PMNode,
	region: TableRegion,
	rowIdx: number,
	colIdx: number
): CellRange | null {
	const para = region.bodyParaRanges[rowIdx];
	if (!para) return null;
	const text = doc.textBetween(para.textFrom, para.textTo, '');
	const ranges = cellCharRanges(text, region.format);
	if (colIdx < 0 || colIdx >= ranges.length) return null;
	const { start, end } = ranges[colIdx];
	return { from: para.textFrom + start, to: para.textFrom + end };
}
```

(`commitCellEdit`은 변경 없음 — 범위만 사용.)

- [ ] **Step 4: 통과 확인** — Run: `cd app && npm run test -- cellEdit tableBlockPlugin` → 신규 + 기존 PASS (csv/tsv 회귀 가드)

- [ ] **Step 5: 커밋**
```bash
git add app/src/lib/editor/tableBlock/cellEdit.ts app/tests/unit/editor/cellEditMarkdown.test.ts
git commit -m "feat(table): 셀 편집 범위를 cellCharRanges로 통합 + 마크다운 지원"
```

---

### Task 4: 마크다운 행/열 구조 편집 (tableOps.ts)

**Goal:** `appendRowOp`/`appendColOp`/`deleteColOp`에 markdown 분기를 더해 열 추가/삭제 시 구분선 행도 동기화한다. csv/tsv 경로는 무변경.

**Files:**
- Modify: `app/src/lib/editor/tableBlock/tableOps.ts`
- Test: `app/tests/unit/editor/tableOpsMarkdown.test.ts` (create)

**Acceptance Criteria:**
- [ ] `appendRowOp` markdown이 헤더 열 수에 맞는 `|  |  |` 빈 행을 마지막 데이터행 뒤(데이터 없으면 구분선 뒤)에 삽입
- [ ] `appendColOp` markdown이 모든 데이터행에 빈 셀 + 구분선행에 `---` 셀을 추가(열 수 동기화)
- [ ] `deleteColOp` markdown이 데이터행 + 구분선행에서 같은 열 제거
- [ ] `deleteRowOp` 무변경 (헤더는 UI에서 삭제 불가)
- [ ] csv/tsv `tableOps.test.ts` 전부 통과

**Verify:** `cd app && npm run test -- tableOps` → 신규 + 기존 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/editor/tableOpsMarkdown.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { findMarkdownTableRegions } from '$lib/editor/tableBlock/findTableRegions.js';
import { appendRowOp, appendColOp, deleteColOp } from '$lib/editor/tableBlock/tableOps.js';

function makeEditor(lines: string[]): Editor {
	return new Editor({
		extensions: [Document, Paragraph, Text],
		content: {
			type: 'doc',
			content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
		}
	});
}
function lines(ed: Editor): string[] {
	const out: string[] = [];
	ed.state.doc.forEach((n) => out.push(n.textContent));
	return out;
}

describe('tableOps — markdown', () => {
	it('appendRow adds an empty row after the last data row', () => {
		const ed = makeEditor(['| a | b |', '| --- | --- |', '| 1 | 2 |']);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		ed.view.dispatch(appendRowOp(ed.state, region));
		expect(lines(ed)).toEqual(['| a | b |', '| --- | --- |', '| 1 | 2 |', '|  |  |']);
	});

	it('appendCol adds a cell to every data row AND the separator', () => {
		const ed = makeEditor(['| a | b |', '| --- | --- |', '| 1 | 2 |']);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		ed.view.dispatch(appendColOp(ed.state, region));
		const out = lines(ed);
		// header + data rows gain an empty cell; separator gains a --- cell
		expect(out[0].split('|').length).toBe(4 + 1); // | a | b |  | → 5 pipe-splits
		expect(out[1]).toContain('---');
		expect(out[1].match(/---/g)!.length).toBe(3);
	});

	it('deleteCol removes the column from data rows and the separator', () => {
		const ed = makeEditor(['| a | b | c |', '| --- | --- | --- |', '| 1 | 2 | 3 |']);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		ed.view.dispatch(deleteColOp(ed.state, region, 1)!);
		const after = findMarkdownTableRegions(ed.state.doc)[0];
		expect(after.rows).toEqual([
			['a', 'c'],
			['1', '3']
		]);
		expect(after.align).toHaveLength(2);
	});
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npm run test -- tableOpsMarkdown` → FAIL

- [ ] **Step 3: 구현** — `tableOps.ts` 수정

import 추가:
```ts
import { markdownRowLayout } from './parseTable.js';
```

`appendRowOp`에 markdown 분기 (함수 시작부):
```ts
export function appendRowOp(state: EditorState, region: TableRegion): Transaction {
	if (region.format === 'markdown') {
		const colCount = Math.max(1, region.cells.reduce((m, r) => Math.max(m, r.length), 0));
		const text = '|' + '  |'.repeat(colCount); // 2 cols → "|  |  |"
		const insertAt =
			region.bodyParaRanges.length > 0
				? region.bodyParaRanges[region.bodyParaRanges.length - 1].to
				: (region.separatorParaRange?.to ?? region.openFromPos + 1);
		const tr = state.tr;
		const para = state.schema.nodes.paragraph.create(null, state.schema.text(text));
		tr.insert(insertAt, para);
		return tr;
	}
	// ... 기존 csv/tsv 본문 그대로 ...
}
```

`appendColOp`에 markdown 분기:
```ts
export function appendColOp(state: EditorState, region: TableRegion): Transaction {
	if (region.format === 'markdown') {
		const tr = state.tr;
		// Build the list of paragraphs to extend: all data rows + separator.
		// Reverse order so earlier positions stay valid.
		const targets = [...region.bodyParaRanges];
		if (region.separatorParaRange) targets.push(region.separatorParaRange);
		targets.sort((a, b) => a.from - b.from);
		for (let r = targets.length - 1; r >= 0; r--) {
			const para = targets[r];
			const text = state.doc.textBetween(para.textFrom, para.textTo, '');
			const isSep = region.separatorParaRange && para.from === region.separatorParaRange.from;
			const layout = markdownRowLayout(text);
			const ins = isSep
				? layout.hasTrail
					? ' --- |'
					: ' | --- |'
				: layout.hasTrail
					? '  |'
					: ' |  |';
			tr.insertText(ins, para.textTo);
		}
		return tr;
	}
	// ... 기존 csv/tsv 본문 그대로 ...
}
```

`deleteColOp`에 markdown 분기:
```ts
export function deleteColOp(
	state: EditorState,
	region: TableRegion,
	colIdx: number
): Transaction | null {
	if (colIdx < 0) return null;
	if (region.format === 'markdown') {
		const tr = state.tr;
		let touched = false;
		const targets = [...region.bodyParaRanges];
		if (region.separatorParaRange) targets.push(region.separatorParaRange);
		targets.sort((a, b) => a.from - b.from);
		for (let r = targets.length - 1; r >= 0; r--) {
			const para = targets[r];
			const text = state.doc.textBetween(para.textFrom, para.textTo, '');
			const layout = markdownRowLayout(text);
			if (colIdx >= layout.cells.length) continue;
			// Delete the cell chunk plus one adjacent internal pipe.
			let startChar: number;
			let endChar: number;
			if (colIdx > 0) {
				// pipe before this cell sits at the previous cell's `end`.
				startChar = layout.cells[colIdx - 1].end; // the '|'
				endChar = layout.cells[colIdx].end;
			} else if (layout.cells.length > 1) {
				startChar = layout.cells[0].start;
				endChar = layout.cells[1].start; // includes the '|' after cell 0
			} else {
				startChar = layout.cells[0].start;
				endChar = layout.cells[0].end;
			}
			tr.delete(para.textFrom + startChar, para.textFrom + endChar);
			touched = true;
		}
		return touched ? tr : null;
	}
	// ... 기존 csv/tsv 본문 그대로 ...
}
```

- [ ] **Step 4: 통과 확인** — Run: `cd app && npm run test -- tableOps` → 신규 + 기존 PASS

- [ ] **Step 5: 커밋**
```bash
git add app/src/lib/editor/tableBlock/tableOps.ts app/tests/unit/editor/tableOpsMarkdown.test.ts
git commit -m "feat(table): 마크다운 행/열 구조 편집(구분선 동기화)"
```

---

### Task 5: 플러그인 통합 — region 병합 + 정렬 렌더 (tableBlockPlugin.ts)

**Goal:** `rebuildState`가 펜스 + 마크다운 region을 위치 순으로 병합하고, 렌더가 `region.align`을 th/td `text-align`으로 적용하며, 정렬 변경 시 위젯이 재빌드되도록 한다.

**Files:**
- Modify: `app/src/lib/editor/tableBlock/tableBlockPlugin.ts`
- Test: `app/tests/unit/editor/tableBlockMarkdown.test.ts` (create)

**Acceptance Criteria:**
- [ ] 마크다운 표가 렌더되어 `.tomboy-table-block-table`이 DOM에 생성됨
- [ ] 정렬 지정 열의 th/td에 `style.textAlign`이 `left/center/right`로 설정됨
- [ ] 펜스 표와 마크다운 표가 같은 문서에 공존
- [ ] 마크다운 표의 구분선 단락이 hidden 데코로 가려짐(체크 상태)
- [ ] 기존 `tableBlockPlugin.test.ts`, `tableCellRender.test.ts` 통과

**Verify:** `cd app && npm run test -- tableBlock tableCellRender` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/editor/tableBlockMarkdown.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Extension } from '@tiptap/core';
import { createTableBlockPlugin } from '$lib/editor/tableBlock/tableBlockPlugin.js';

function makeEditor(lines: string[]): Editor {
	const el = document.createElement('div');
	return new Editor({
		element: el,
		extensions: [
			Document,
			Paragraph,
			Text,
			Extension.create({
				name: 'tomboyTableBlock',
				addProseMirrorPlugins() {
					return [createTableBlockPlugin()];
				}
			})
		],
		content: {
			type: 'doc',
			content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
		}
	});
}

describe('tableBlockPlugin — markdown', () => {
	it('renders a markdown table', () => {
		const ed = makeEditor(['| a | b |', '| --- | --- |', '| 1 | 2 |']);
		expect(ed.view.dom.querySelector('.tomboy-table-block-table')).toBeTruthy();
	});

	it('applies column alignment to cells', () => {
		const ed = makeEditor(['| a | b | c |', '| :--- | :--: | ---: |', '| 1 | 2 | 3 |']);
		const ths = ed.view.dom.querySelectorAll('.tomboy-table-block-table th');
		expect((ths[0] as HTMLElement).style.textAlign).toBe('left');
		expect((ths[1] as HTMLElement).style.textAlign).toBe('center');
		expect((ths[2] as HTMLElement).style.textAlign).toBe('right');
	});

	it('coexists with a csv fence table', () => {
		const ed = makeEditor([
			'```csv',
			'x,y',
			'```',
			'',
			'| a | b |',
			'| --- | --- |',
			'| 1 | 2 |'
		]);
		expect(ed.view.dom.querySelectorAll('.tomboy-table-block-table').length).toBe(2);
	});
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npm run test -- tableBlockMarkdown` → FAIL

- [ ] **Step 3: 구현** — `tableBlockPlugin.ts` 수정

import 수정:
```ts
import { findTableRegions, findMarkdownTableRegions, type TableRegion } from './findTableRegions.js';
```

`rebuildState`의 region 수집 교체:
```ts
const regions = [...findTableRegions(doc), ...findMarkdownTableRegions(doc)].sort(
	(a, b) => a.openFromPos - b.openFromPos
);
```

`regionContentHash`에 alignment를 섞어 정렬-only 변경 시 위젯 재빌드 보장 (함수 끝 `return` 직전):
```ts
	if (region.align) {
		for (const a of region.align) {
			h = (h ^ (a ? a.charCodeAt(0) : 0x2d)) >>> 0;
			h = Math.imul(h, 16777619) >>> 0;
		}
	}
	return h.toString(36);
```

`fillCell`에 정렬 적용 (함수 시작, `data-table-block-*` 설정 직후):
```ts
	host.setAttribute('data-table-block-row', String(rowIdx));
	host.setAttribute('data-table-block-col', String(colIdx));
	const align = region.align?.[colIdx];
	if (align) host.style.textAlign = align;
```

(구분선 hidden: `buildDecorations`의 `Decoration.inline/​node(r.openFromPos, r.closeToPos, …)`가 헤더~마지막 데이터행 전체 범위를 덮으므로 그 사이의 구분선 단락은 자동으로 가려진다. 추가 코드 불필요 — 마크다운 region의 `closeToPos`가 마지막 데이터행 `to`이고 구분선은 그 범위 내부.)

- [ ] **Step 4: 통과 확인** — Run: `cd app && npm run test -- tableBlock tableCellRender` → 신규 + 기존 PASS

- [ ] **Step 5: 커밋**
```bash
git add app/src/lib/editor/tableBlock/tableBlockPlugin.ts app/tests/unit/editor/tableBlockMarkdown.test.ts
git commit -m "feat(table): 플러그인에 마크다운 region 병합 + 열 정렬 렌더"
```

---

### Task 6: Alt+T 빈 표 삽입 (insertTable.ts + TomboyEditor.svelte)

**Goal:** 커서 위치에 빈 2×2 마크다운 표(헤더+구분선+데이터1)를 삽입하는 `insertTable` 헬퍼를 만들고 Alt+T에 바인딩한다.

**Files:**
- Create: `app/src/lib/editor/insertTable.ts`
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (import + Alt 블록)
- Test: `app/tests/unit/editor/insertTable.test.ts` (create)

**Acceptance Criteria:**
- [ ] `insertTable(editor)`가 현재 문단 뒤에 `|  |  |` / `| --- | --- |` / `|  |  |` 세 문단을 삽입
- [ ] 삽입된 내용이 `findMarkdownTableRegions`로 2열 표(헤더1+데이터1)로 탐지됨
- [ ] `TomboyEditor.svelte`의 Alt 블록에 `event.code === "KeyT"` → `insertTable(ed)` 추가, KeyT 외 단축키 영향 없음

**Verify:** `cd app && npm run test -- insertTable && npm run check`

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/editor/insertTable.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { insertTable } from '$lib/editor/insertTable.js';
import { findMarkdownTableRegions } from '$lib/editor/tableBlock/findTableRegions.js';

function makeEditor(): Editor {
	return new Editor({
		extensions: [Document, Paragraph, Text],
		content: { type: 'doc', content: [{ type: 'paragraph' }] }
	});
}

describe('insertTable', () => {
	it('inserts an empty 2x2 markdown table', () => {
		const ed = makeEditor();
		insertTable(ed);
		const region = findMarkdownTableRegions(ed.state.doc)[0];
		expect(region).toBeTruthy();
		expect(region.rows).toEqual([
			['', ''],
			['', '']
		]);
		expect(region.align).toHaveLength(2);
	});
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npm run test -- insertTable` → FAIL

- [ ] **Step 3: 구현** — `app/src/lib/editor/insertTable.ts` 생성

```ts
/**
 * Insert an empty 2×2 markdown table at the cursor. "2×2" = a header row plus
 * one data row (the separator row is structural). The native markdown table
 * detector renders it immediately; the user fills cells via double-click.
 *
 * Bound to Alt+T in TomboyEditor.
 */
import type { Editor } from '@tiptap/core';

const TABLE_LINES = ['|  |  |', '| --- | --- |', '|  |  |'];

export function insertTable(editor: Editor): boolean {
	const nodes = TABLE_LINES.map((line) => ({
		type: 'paragraph',
		content: [{ type: 'text', text: line }]
	}));
	return editor
		.chain()
		.focus()
		.insertContent(nodes)
		.run();
}
```

- [ ] **Step 4: TomboyEditor.svelte 배선** — import 추가 (다른 insert 헬퍼 import 근처, 예: line 103 인근):
```ts
import { insertTable } from "./insertTable.js";
```

Alt 블록(`event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey` 내부, 다른 `event.code === "KeyX"` 분기 옆, KeyC 분기 뒤)에 추가:
```ts
						// 빈 마크다운 표 삽입.
						if (event.code === "KeyT") {
							event.preventDefault();
							insertTable(ed);
							return true;
						}
```

- [ ] **Step 5: 통과 확인** — Run: `cd app && npm run test -- insertTable && npm run check` → PASS, 타입 에러 없음

- [ ] **Step 6: 커밋**
```bash
git add app/src/lib/editor/insertTable.ts app/src/lib/editor/TomboyEditor.svelte app/tests/unit/editor/insertTable.test.ts
git commit -m "feat(table): Alt+T로 빈 2×2 마크다운 표 삽입"
```

---

### Task 7: 가이드 카드 (설정 → 가이드 → 에디터)

**Goal:** 마크다운 표 기능을 `설정 → 가이드 → 에디터` 탭에 `<details class="guide-card">`로 문서화한다 (CLAUDE.md 필수 요구).

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (`guideSubTab === 'editor'` 섹션, 기존 CSV/TSV 카드 뒤)

**Acceptance Criteria:**
- [ ] `guideSubTab === 'editor'` 섹션에 마크다운 표 guide-card 1장 추가
- [ ] 문법 예시(`pre.snippet`), 정렬, Alt+T, 더블클릭 편집, Ctrl 행/열, `---` 단독은 HR-split이라는 주의점 포함
- [ ] `npm run check` 통과(Svelte 구문 오류 없음)

**Verify:** `cd app && npm run check` → 에러 없음; `npm run dev` → 설정 → 가이드 → 에디터에 카드 표시

**Steps:**

- [ ] **Step 1: 카드 추가** — `app/src/routes/settings/+page.svelte`의 CSV/TSV `</details>` (현재 line 1889 인근) 바로 뒤에 삽입:

```svelte
				<details class="guide-card">
					<summary>표 (마크다운) — 본문 안의 GFM 표</summary>
					<p class="info-text">
						GitHub 마크다운 표 문법을 그대로 씁니다. 펜스 없이, 헤더 줄 바로 아래에
						<strong>구분선 줄</strong>(<code>| --- | --- |</code>)이 있으면 자동으로 표로
						렌더됩니다. 원본 텍스트는 보존되어 Tomboy XML로 라운드트립됩니다.
					</p>
					<pre class="snippet">| 헤더1 | 헤더2 | 헤더3 |
| :--- | :--: | ---: |
| 가 | 나 | 다 |
| 라 | 마 | 바 |</pre>
					<ul class="guide-list">
						<li><strong>구분선 줄 필수</strong>: 헤더 다음 줄이 <code>| --- |</code> 형태여야 표로
							인식됩니다. 구분선이 없으면 일반 문단으로 보입니다.</li>
						<li><strong>정렬</strong>: 구분선에 콜론을 붙여 열을 정렬합니다 —
							<code>:---</code>(왼쪽), <code>:--:</code>(가운데), <code>--:</code>(오른쪽).</li>
						<li><strong>바깥 파이프는 선택</strong>: <code>| a | b |</code>와 <code>a | b</code> 모두
							인식되며, 셀 양끝 공백은 트림됩니다.</li>
						<li><kbd>Alt</kbd>+<kbd>T</kbd> — 커서 위치에 빈 2×2 표를 삽입합니다.</li>
						<li>셀 안의 <strong>굵게 · 기울임 · 링크</strong> 등 마크는 보존됩니다.</li>
						<li>⚠️ <strong><code>---</code> 한 줄만</strong> 있으면 표가 아니라
							<strong>세로 분할선(HR 분할)</strong>입니다. 표 구분선은 반드시 파이프를
							포함해야 합니다.</li>
					</ul>
					<p class="info-text">조작 (CSV/TSV 표와 동일):</p>
					<ul class="guide-list">
						<li>표 좌측 상단 체크박스 — 켜면 표 렌더, 끄면 원본 마크다운으로 펼쳐 직접 편집.</li>
						<li><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>을 누르고 있으면 행/열 추가 + 버튼과 삭제 X 버튼이
							나타납니다. 열을 추가·삭제하면 구분선 줄도 함께 맞춰집니다.</li>
						<li>셀 더블 클릭 — 해당 셀만 인라인 편집.</li>
					</ul>
				</details>
```

- [ ] **Step 2: 검증** — Run: `cd app && npm run check` → 에러 없음

- [ ] **Step 3: 커밋**
```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(table): 설정 가이드에 마크다운 표 카드 추가"
```

---

### Task 8: 전체 회귀 + 수동 검증

**Goal:** 전체 테스트 스위트와 타입 체크를 돌려 회귀가 없음을 확인하고, dev 서버에서 마크다운 표를 실제로 렌더·편집해 본다.

**Files:** (없음 — 검증 전용)

**Acceptance Criteria:**
- [ ] `cd app && npm run test` 전체 PASS (기존 OCR teardown flake 제외 — known harmless)
- [ ] `cd app && npm run check` 타입 에러 0
- [ ] dev에서 마크다운 표 렌더 / 정렬 / Alt+T / 토글 / 셀편집 / Ctrl 행열 동작 확인

**Verify:** `cd app && npm run test && npm run check`

**Steps:**

- [ ] **Step 1: 전체 테스트** — Run: `cd app && npm run test`. Expected: 모든 table 관련 + 기존 스위트 PASS. (메모리: `runOcrInEditor.test.ts`의 "1 error" teardown flake는 알려진 무해 항목.)

- [ ] **Step 2: 타입 체크** — Run: `cd app && npm run check`. Expected: 0 errors.

- [ ] **Step 3: 수동 검증** — `cd app && npm run dev` 후 새 노트에서:
  - `| h1 | h2 |` / `| :---: | ---: |` / `| 1 | 2 |` 입력 → 가운데/오른쪽 정렬 표 렌더 확인
  - Alt+T → 빈 2×2 표 삽입 확인
  - 좌상단 체크박스로 소스 토글, 셀 더블클릭 편집, Ctrl 눌러 행/열 추가·삭제(구분선 동기화) 확인
  - 같은 노트에 ` ```csv ` 표와 마크다운 표 공존 확인
  - `---` 한 줄만 입력 시 표가 아닌 HR 분할로 동작(또는 일반 문단) 확인

- [ ] **Step 4: graphify 업데이트** (선택) — Run: `graphify update .`

---

## 자체 검토 (Self-Review)

**Spec coverage:**
- 네이티브 탐지 + 구분선 필수 → Task 2 ✓
- 정렬 지원 → Task 1(파싱) + Task 5(렌더) ✓
- 상호작용 CSV/TSV 동일(토글/편집/Ctrl) → Task 3,4,5 ✓
- 접근 A 코드 공유(단일 플러그인/렌더/편집) → Task 5에서 region 병합, 엔진 재사용 ✓
- 바깥 파이프 처리 → Task 1 `stripOuterPipeInlines`/`markdownRowLayout`/`cellCharRanges` ✓
- `cellCharRanges` 통합(회귀 가드) → Task 1 정의 + Task 3 위임, csv/tsv 기존 테스트 통과 명시 ✓
- hrSplit 충돌 방지(`|` 필수) → Task 1 `isSeparatorRow`, Task 2 탐지 ✓
- 펜스 내부 제외 → Task 2 `fencedParaIndices` ✓
- Alt+T 빈 2×2 → Task 6 ✓
- 가이드 카드 → Task 7 ✓
- 테스트 4종 + 회귀 → Task 1–5 각 테스트 + Task 8 ✓
- `.note` XML 무변경 / Dropbox 무영향 → 표는 순수 텍스트, 변경 코드 없음(비목표 그대로) ✓

**Type consistency:** `findMarkdownTableRegions`(Task 2)는 Task 5 import와 일치. `cellCharRanges`(Task 1) 시그니처가 Task 3/4 사용처와 일치. `markdownRowLayout`(Task 1)의 `cells`/`hasTrail`가 Task 4 사용과 일치. `Alignment`/`separatorParaRange`(Task 2)가 Task 5 렌더와 일치.

**Placeholder scan:** TODO/TBD 없음. 모든 코드 스텝에 실제 코드 포함.

**의존성:** Task 2←1, Task 3←1·2, Task 4←1·2, Task 5←2·3·4, Task 6←2, Task 7←5·6, Task 8←전체.
