# 데스크탑 달력 — 날짜 노트 열기 + 이전 년도 히스토리 기록 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데스크탑 달력에서 셀을 클릭하면 그날의 날짜 노트(`YYYY-MM-DD`)를 열고, 이전 년도 같은 날짜의 히스토리 기록을 노트 푸터·달력 셀·목록에 표시하며, 날짜 노트가 없으면 임시 오버레이로 대체한다.

**Architecture:** 새 순수 모듈 `historyChain.ts`가 허브 `히스토리 기록` 노트(`SEND_TARGET_GUID`)의 `YYYY - 히스토리 기록` 링크를 따라가 이전 년도 노트를 파싱, `(월,일)` 버킷 맵을 만든다(모듈 캐시 + noteListCache 무효화 구독). 이 맵을 세 소비처가 읽는다 — 날짜 노트 푸터(`DateNoteFooter` → `NoteWindow`), 달력 셀 인라인(`CalendarView`), 임시 오버레이(`EphemeralDateOverlay`). 클릭 라우팅은 `CalendarView`가 `onopendate`/`ondayselect`(배지) 두 콜백으로 분리하고 `CalendarWindow`가 배선한다. 알림용 `parseScheduleNote`/`DAY_PREFIX_RE`는 건드리지 않는다.

**Tech Stack:** SvelteKit + Svelte 5 runes, TypeScript, TipTap JSONContent, vitest + @testing-library/svelte, IndexedDB(idb).

**Spec:** `docs/superpowers/specs/2026-07-16-calendar-date-note-history-design.md`

---

## File Structure

**신규**
- `app/src/lib/desktop/calendar/historyChain.ts` — 히스토리 체인 파서/로더(순수 + IDB 로더). 핵심.
- `app/src/lib/desktop/calendar/PrevYearRecords.svelte` — 이전 년도 기록 프레젠테이션(년도별 그룹, 우측정렬·흐림).
- `app/src/lib/desktop/calendar/DateNoteFooter.svelte` — 제목→날짜 파싱 + 체인 로드 + `PrevYearRecords`.
- `app/src/lib/desktop/EphemeralDateOverlay.svelte` — 날짜 노트 없을 때 임시 도킹 오버레이(req 5).
- `app/tests/unit/desktop/calendar/historyChain.test.ts` — 순수 함수 유닛 테스트.
- `app/tests/unit/desktop/calendar/DateNoteFooter.test.ts` — 컴포넌트 렌더(seed IDB).

**수정**
- `app/src/lib/schedule/parseSchedule.ts` — `extractMonthListItems`에 `export` 추가(동작 불변, 재사용).
- `app/src/lib/desktop/calendar/CalendarView.svelte` — `onopendate` prop, 셀 클릭/배지 분리, 이전 년도 셀 라인.
- `app/src/lib/desktop/CalendarWindow.svelte` — `onopendate` 배선, `prevYearTitles` 계산, `EphemeralDateOverlay`.
- `app/src/lib/desktop/DayNotesBundleOverlay.svelte` — `prevYearTitles` prop 병합.
- `app/src/lib/desktop/NoteWindow.svelte` — 날짜 노트일 때 `DateNoteFooter` 마운트.
- `app/src/routes/settings/+page.svelte` — 가이드 카드(설정 → 가이드 → 노트 탭).

**작업 디렉터리:** 모든 명령은 `app/`에서 실행. 타입 체크 `npm run check`, 테스트 `npm run test`.

---

### Task 1: `historyChain.ts` — 히스토리 체인 파서/로더 (+ 유닛 테스트)

**Goal:** 허브 노트의 년도 링크를 따라 이전 년도 노트를 파싱, `(월,일)` 버킷 맵을 만드는 순수 모듈 + 제목/날짜 헬퍼를 만든다.

**Files:**
- Modify: `app/src/lib/schedule/parseSchedule.ts:163` (`function extractMonthListItems` → `export function extractMonthListItems`)
- Create: `app/src/lib/desktop/calendar/historyChain.ts`
- Test: `app/tests/unit/desktop/calendar/historyChain.test.ts`

**Acceptance Criteria:**
- [ ] `parseHistoryDayLine`이 `9일(월) 물주기`→`{day:9,label:'물주기'}`, `3(토) 트리하우스`→`{day:3,label:'트리하우스'}`, 마커(`9*(토)`, `25(월*)`, `(수, 한글날)`), 범위(`10일(수) - 15일(월) X`→day 10) 처리, 잘못된 일(예: 2월 30일)은 `null`.
- [ ] `parseHistoryYearNote`이 월 내림차순 문서에서도 모든 월 항목 수집.
- [ ] `extractHistoryYearLinks`이 `2025 - 히스토리 기록`만 뽑고 `2026년`·본문 링크는 제외, 연도 내림차순.
- [ ] `recordsForDate`이 `year < target`만 남기고 연도 내림차순 정렬.
- [ ] `parseDateTitle`/`isDateTitle`이 `2026-07-16`은 파싱, `2026-13-01`(잘못된 월)은 `null`/`false`.
- [ ] `npm run check` 통과.

**Verify:** `npm run test -- historyChain` → 모든 테스트 PASS. `npm run check` → 0 errors.

**Steps:**

- [ ] **Step 1: `extractMonthListItems`를 export로**

`app/src/lib/schedule/parseSchedule.ts:163`, `function extractMonthListItems(` 를 `export function extractMonthListItems(` 로 변경(본문 불변).

- [ ] **Step 2: 실패 테스트 작성** — `app/tests/unit/desktop/calendar/historyChain.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import {
	parseHistoryDayLine,
	parseHistoryYearNote,
	extractHistoryYearLinks,
	recordsForDate,
	parseDateTitle,
	isDateTitle,
	type HistoryChain
} from '$lib/desktop/calendar/historyChain.js';

// helper: build a `N월` + bulletList doc
function monthDoc(sections: Array<{ month: string; items: string[] }>): JSONContent {
	const content: JSONContent[] = [];
	for (const s of sections) {
		content.push({ type: 'paragraph', content: [{ type: 'text', text: s.month }] });
		content.push({
			type: 'bulletList',
			content: s.items.map((t) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
			}))
		});
	}
	return { type: 'doc', content };
}

describe('parseHistoryDayLine', () => {
	it('parses prev-year `일` form', () => {
		expect(parseHistoryDayLine('9일(월) 물주기', 2019, 12)).toEqual({ day: 9, label: '물주기' });
	});
	it('parses current-year form without 일', () => {
		expect(parseHistoryDayLine('3(토) 트리하우스', 2026, 1)).toEqual({ day: 3, label: '트리하우스' });
	});
	it('tolerates repeat markers and weekday extras', () => {
		expect(parseHistoryDayLine('9*(토) 클로드 결제일', 2026, 5)).toEqual({ day: 9, label: '클로드 결제일' });
		expect(parseHistoryDayLine('25(월*) 엄마집', 2026, 5)).toEqual({ day: 25, label: '엄마집' });
		expect(parseHistoryDayLine('9일(수, 한글날) 비자', 2019, 10)).toEqual({ day: 9, label: '비자' });
	});
	it('parses a range line using the leading day', () => {
		expect(parseHistoryDayLine('10일(수) - 15일(월) 보웬 방문', 2019, 7)).toEqual({
			day: 10,
			label: '- 15일(월) 보웬 방문'
		});
	});
	it('rejects invalid calendar days', () => {
		expect(parseHistoryDayLine('30일(월) x', 2019, 2)).toBeNull(); // no Feb 30
	});
	it('rejects empty labels', () => {
		expect(parseHistoryDayLine('9일(월)', 2019, 12)).toBeNull();
	});
});

describe('parseHistoryYearNote', () => {
	it('collects every month regardless of order', () => {
		const doc = monthDoc([
			{ month: '12월', items: ['9일(월) 물주기'] },
			{ month: '11월', items: ['9일(토) 한국 도착'] }
		]);
		const entries = parseHistoryYearNote(doc, 2019);
		expect(entries).toEqual([
			{ year: 2019, month: 12, day: 9, label: '물주기' },
			{ year: 2019, month: 11, day: 9, label: '한국 도착' }
		]);
	});
});

describe('extractHistoryYearLinks', () => {
	it('picks only `YYYY - 히스토리 기록` links, descending', () => {
		const xml =
			'<note-content>히스토리 기록' +
			'<link:internal>2024 - 히스토리 기록</link:internal>' +
			'<link:internal>2025 - 히스토리 기록</link:internal>' +
			'<link:internal>2026년</link:internal>' +
			'<link:internal>오리지널스</link:internal></note-content>';
		expect(extractHistoryYearLinks(xml)).toEqual([
			{ year: 2025, title: '2025 - 히스토리 기록' },
			{ year: 2024, title: '2024 - 히스토리 기록' }
		]);
	});
});

describe('recordsForDate', () => {
	it('keeps years < target, descending', () => {
		const chain: HistoryChain = {
			entries: [],
			byMonthDay: new Map([
				[
					'07-16',
					[
						{ year: 2019, month: 7, day: 16, label: '재동이 한국 방문' },
						{ year: 2024, month: 7, day: 16, label: '독서모임' },
						{ year: 2026, month: 7, day: 16, label: '올해 것' }
					]
				]
			])
		};
		expect(recordsForDate(chain, 2026, 7, 16)).toEqual([
			{ year: 2024, month: 7, day: 16, label: '독서모임' },
			{ year: 2019, month: 7, day: 16, label: '재동이 한국 방문' }
		]);
	});
	it('empty for a day with no bucket', () => {
		expect(recordsForDate({ entries: [], byMonthDay: new Map() }, 2026, 1, 1)).toEqual([]);
	});
});

describe('parseDateTitle / isDateTitle', () => {
	it('parses valid date titles', () => {
		expect(parseDateTitle('2026-07-16')).toEqual({ year: 2026, month: 7, day: 16 });
		expect(isDateTitle('2026-07-16')).toBe(true);
	});
	it('rejects non-date / invalid', () => {
		expect(parseDateTitle('2026-13-01')).toBeNull();
		expect(isDateTitle('히스토리 기록')).toBe(false);
	});
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npm run test -- historyChain`
Expected: FAIL — `historyChain.js` 없음 / export 미정의.

- [ ] **Step 4: `historyChain.ts` 구현** — `app/src/lib/desktop/calendar/historyChain.ts`

```ts
/**
 * 히스토리 기록 체인 로더/파서.
 *
 * 허브 노트 `히스토리 기록`(= SEND_TARGET_GUID)의 `YYYY - 히스토리 기록` 내부
 * 링크를 따라가 각 이전 년도 노트를 파싱, (월,일) 키로 버킷한다. 달력 셀·날짜
 * 노트 푸터·임시 오버레이가 "이전 년도 같은 날짜 기록"을 이걸로 얻는다.
 *
 * 알림용 parseScheduleNote/DAY_PREFIX_RE 는 건드리지 않는다 — 이전 년도 형식
 * (`9일(월)`)과 마커까지 흡수하는 전용 파서를 여기 둔다.
 */
import type { JSONContent } from '@tiptap/core';
import { getNote } from '$lib/storage/noteStore.js';
import { findNoteByTitle } from '$lib/core/noteManager.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { extractLinkTargets } from '$lib/core/backlinkIndex.js';
import { extractMonthListItems } from '$lib/schedule/parseSchedule.js';
import { SEND_TARGET_GUID } from '$lib/editor/sendListItem/transferListItem.js';
import { onInvalidate } from '$lib/stores/noteListCache.js';

export interface HistoryEntry {
	year: number;
	month: number; // 1-based
	day: number;
	label: string;
}

export interface HistoryChain {
	entries: HistoryEntry[];
	/** key = `${MM}-${DD}` (zero-padded). */
	byMonthDay: Map<string, HistoryEntry[]>;
}

// 이전 년도 형식(`9일(월)`) + 마커(`9*(토)`, `(월*)`, `(수, 한글날)`)까지 흡수.
// 캡처: 1=일자 숫자, 2=라벨. `일?` 로 선택적 '일', `*{0,2}` 로 `9*`/`25*` 마커.
const HISTORY_DAY_RE = /^\s*(\d{1,2})일?\*{0,2}\s*(?:\([^)]*\))?\s*(.*)$/;
const YEAR_LINK_RE = /^(\d{4}) - 히스토리 기록$/;
const DATE_TITLE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

function isValidDay(year: number, month: number, day: number): boolean {
	if (day < 1 || day > 31) return false;
	const d = new Date(year, month - 1, day);
	return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

export function parseHistoryDayLine(
	text: string,
	year: number,
	month: number
): { day: number; label: string } | null {
	const m = HISTORY_DAY_RE.exec(text);
	if (!m) return null;
	const day = parseInt(m[1], 10);
	if (!isValidDay(year, month, day)) return null;
	const label = m[2].trim();
	if (label.length === 0) return null;
	return { day, label };
}

export function parseHistoryYearNote(doc: JSONContent, year: number): HistoryEntry[] {
	const out: HistoryEntry[] = [];
	for (let month = 1; month <= 12; month++) {
		for (const line of extractMonthListItems(doc, month)) {
			const parsed = parseHistoryDayLine(line, year, month);
			if (parsed) out.push({ year, month, day: parsed.day, label: parsed.label });
		}
	}
	return out;
}

export function extractHistoryYearLinks(xml: string): { year: number; title: string }[] {
	const out: { year: number; title: string }[] = [];
	for (const target of extractLinkTargets(xml)) {
		const m = YEAR_LINK_RE.exec(target.trim());
		if (m) out.push({ year: parseInt(m[1], 10), title: target.trim() });
	}
	return out.sort((a, b) => b.year - a.year);
}

export function parseDateTitle(title: string): { year: number; month: number; day: number } | null {
	const m = DATE_TITLE_RE.exec(title.trim());
	if (!m) return null;
	const year = parseInt(m[1], 10);
	const month = parseInt(m[2], 10);
	const day = parseInt(m[3], 10);
	if (!isValidDay(year, month, day)) return null;
	return { year, month, day };
}

export function isDateTitle(title: string): boolean {
	return parseDateTitle(title) !== null;
}

export function recordsForDate(
	chain: HistoryChain,
	year: number,
	month: number,
	day: number
): HistoryEntry[] {
	const key = `${pad(month)}-${pad(day)}`;
	return (chain.byMonthDay.get(key) ?? [])
		.filter((e) => e.year < year)
		.sort((a, b) => b.year - a.year);
}

// --- IDB 로더 (모듈 캐시 + noteListCache 무효화 구독) ---
let cache: Promise<HistoryChain> | null = null;
let invalidateInstalled = false;

function installInvalidation(): void {
	if (invalidateInstalled) return;
	invalidateInstalled = true;
	onInvalidate(() => {
		cache = null;
	});
}

async function buildChain(): Promise<HistoryChain> {
	const entries: HistoryEntry[] = [];
	const hub = await getNote(SEND_TARGET_GUID);
	if (hub) {
		const links = extractHistoryYearLinks(hub.xmlContent);
		const resolved = await Promise.all(
			links.map((l) => findNoteByTitle(l.title).then((n) => ({ l, n })))
		);
		for (const { l, n } of resolved) {
			if (!n) continue;
			try {
				const doc = deserializeContent(n.xmlContent);
				entries.push(...parseHistoryYearNote(doc, l.year));
			} catch {
				/* corrupt note — skip */
			}
		}
	}
	const byMonthDay = new Map<string, HistoryEntry[]>();
	for (const e of entries) {
		const key = `${pad(e.month)}-${pad(e.day)}`;
		const bucket = byMonthDay.get(key);
		if (bucket) bucket.push(e);
		else byMonthDay.set(key, [e]);
	}
	return { entries, byMonthDay };
}

export function loadHistoryChain(): Promise<HistoryChain> {
	installInvalidation();
	if (!cache) cache = buildChain();
	return cache;
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npm run test -- historyChain`
Expected: PASS (모든 케이스).

- [ ] **Step 6: 타입 체크**

Run: `npm run check`
Expected: 0 errors.

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/schedule/parseSchedule.ts app/src/lib/desktop/calendar/historyChain.ts app/tests/unit/desktop/calendar/historyChain.test.ts
git commit -m "feat(calendar): 히스토리 체인 파서/로더 — 이전 년도 같은 날짜 기록"
```

---

### Task 2: `PrevYearRecords.svelte` + `DateNoteFooter.svelte` (+ 컴포넌트 테스트)

**Goal:** 이전 년도 기록을 년도별 그룹·우측정렬·흐리게 그리는 프레젠테이션 컴포넌트와, 제목→날짜 파싱 후 체인을 로드해 그걸 렌더하는 래퍼를 만든다.

**Files:**
- Create: `app/src/lib/desktop/calendar/PrevYearRecords.svelte`
- Create: `app/src/lib/desktop/calendar/DateNoteFooter.svelte`
- Test: `app/tests/unit/desktop/calendar/DateNoteFooter.test.ts`

**Acceptance Criteria:**
- [ ] `PrevYearRecords`이 `records` 없으면 아무것도 안 그리고, 있으면 년도별 그룹으로 우측정렬·흐린 목록을 그린다.
- [ ] `DateNoteFooter`이 seed된 IDB(허브 + `2024 - 히스토리 기록`)에서 `2026-07-16` 제목에 대해 `2024` 라벨을 렌더.
- [ ] 날짜 아닌 제목/기록 없음이면 `DateNoteFooter`이 빈 렌더.
- [ ] `npm run check` 통과.

**Verify:** `npm run test -- DateNoteFooter` → PASS. `npm run check` → 0 errors.

**Steps:**

- [ ] **Step 1: `PrevYearRecords.svelte` 구현** — `app/src/lib/desktop/calendar/PrevYearRecords.svelte`

```svelte
<script lang="ts">
	/** 이전 년도 같은 날짜 기록 — 년도별 그룹, 우측정렬·흐리게. 입력은 이미
	 *  필터(연도<대상)·정렬(연도 내림차순)된 records. */
	import type { HistoryEntry } from './historyChain.js';

	interface Props {
		records: HistoryEntry[];
	}
	let { records }: Props = $props();

	const groups = $derived.by(() => {
		const m = new Map<number, HistoryEntry[]>();
		for (const r of records) {
			const b = m.get(r.year);
			if (b) b.push(r);
			else m.set(r.year, [r]);
		}
		// records 가 이미 연도 내림차순 → Map 삽입순서가 그대로 내림차순.
		return [...m.entries()];
	});
</script>

{#if records.length > 0}
	<div class="prev-years">
		{#each groups as [year, items] (year)}
			<div class="py-group">
				<span class="py-year">{year}</span>
				<ul class="py-list">
					{#each items as it, i (i)}
						<li>{it.label}</li>
					{/each}
				</ul>
			</div>
		{/each}
	</div>
{/if}

<style>
	.prev-years {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px 10px;
		text-align: right;
		color: #9aa0a6;
		font-size: 0.72rem;
		line-height: 1.35;
	}
	.py-group {
		display: flex;
		align-items: baseline;
		justify-content: flex-end;
		gap: 6px;
	}
	.py-year {
		flex-shrink: 0;
		font-weight: 700;
		color: #b0b4b8;
	}
	.py-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.py-list li {
		white-space: normal;
		word-break: break-word;
	}
</style>
```

- [ ] **Step 2: `DateNoteFooter.svelte` 구현** — `app/src/lib/desktop/calendar/DateNoteFooter.svelte`

```svelte
<script lang="ts">
	/** 날짜 노트(`YYYY-MM-DD`) 하단에 붙는 읽기전용 이전 년도 기록 패널.
	 *  에디터 도큐먼트/XML 은 절대 건드리지 않는다(별도 패널). 제목이 날짜가
	 *  아니거나 기록이 없으면 아무것도 렌더하지 않는다. */
	import { onMount } from 'svelte';
	import { onInvalidate } from '$lib/stores/noteListCache.js';
	import {
		loadHistoryChain,
		recordsForDate,
		parseDateTitle,
		type HistoryEntry
	} from './historyChain.js';
	import PrevYearRecords from './PrevYearRecords.svelte';

	interface Props {
		title: string;
	}
	let { title }: Props = $props();

	let records = $state<HistoryEntry[]>([]);
	let token = 0;

	async function load() {
		const d = parseDateTitle(title);
		if (!d) {
			records = [];
			return;
		}
		const t = ++token;
		const chain = await loadHistoryChain();
		if (t !== token) return;
		records = recordsForDate(chain, d.year, d.month, d.day);
	}

	$effect(() => {
		void title;
		void load();
	});
	onMount(() => onInvalidate(() => void load()));
</script>

{#if records.length > 0}
	<div class="date-note-footer">
		<PrevYearRecords {records} />
	</div>
{/if}

<style>
	.date-note-footer {
		flex-shrink: 0;
		border-top: 1px solid #ececec;
		max-height: 40%;
		overflow-y: auto;
	}
</style>
```

- [ ] **Step 3: 컴포넌트 테스트 작성** — `app/tests/unit/desktop/calendar/DateNoteFooter.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/svelte';
import DateNoteFooter from '$lib/desktop/calendar/DateNoteFooter.svelte';
import { putNote } from '$lib/storage/noteStore.js';
import { SEND_TARGET_GUID } from '$lib/editor/sendListItem/transferListItem.js';
import { createEmptyNote } from '$lib/core/note.js';

// 허브 노트 xml — 2024 년도 링크 하나.
function hubXml(): string {
	return (
		'<note-content version="0.1">히스토리 기록\n' +
		'<link:internal>2024 - 히스토리 기록</link:internal></note-content>'
	);
}
// 2024 년도 노트 xml — 7월 16일 항목.
function yearXml(): string {
	return (
		'<note-content version="0.1">2024 - 히스토리 기록\n2024\n7월\n' +
		'<list><list-item dir="ltr">16일(화) 독서모임</list-item></list></note-content>'
	);
}

async function seedNote(guid: string, title: string, xml: string) {
	const n = createEmptyNote(guid);
	n.title = title;
	n.xmlContent = xml;
	await putNote(n);
}

describe('DateNoteFooter', () => {
	beforeEach(async () => {
		await seedNote(SEND_TARGET_GUID, '히스토리 기록', hubXml());
		await seedNote('year-2024-guid', '2024 - 히스토리 기록', yearXml());
	});
	afterEach(() => {
		// fake-indexeddb 는 vitest setup 에서 매 테스트 초기화(기존 패턴).
	});

	it('renders prev-year records for a date title', async () => {
		const { findByText } = render(DateNoteFooter, { props: { title: '2026-07-16' } });
		expect(await findByText('독서모임')).toBeTruthy();
		expect(await findByText('2024')).toBeTruthy();
	});

	it('renders nothing for a non-date title', () => {
		const { container } = render(DateNoteFooter, { props: { title: '아무 노트' } });
		expect(container.querySelector('.date-note-footer')).toBeNull();
	});
});
```

> 참고: fake-indexeddb 초기화 + `putNote`/`createEmptyNote` 임포트 경로는 기존 IDB-touching 테스트(`tests/unit/home.test.ts`, `favorite.test.ts`)와 동일 패턴. 만약 `createEmptyNote`/`putNote` export 시그니처가 다르면 그 테스트를 참고해 맞춘다. `loadHistoryChain`은 모듈 캐시를 쓰므로, 캐시 오염이 보이면 테스트에서 첫 렌더 전에 seed를 마치고(위처럼 beforeEach) noteListCache 무효화가 캐시를 비우는지 확인.

- [ ] **Step 4: 테스트 실행**

Run: `npm run test -- DateNoteFooter`
Expected: PASS (2 케이스). 실패 시 seed 경로/캐시 초기화부터 점검.

- [ ] **Step 5: 타입 체크**

Run: `npm run check`
Expected: 0 errors.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/desktop/calendar/PrevYearRecords.svelte app/src/lib/desktop/calendar/DateNoteFooter.svelte app/tests/unit/desktop/calendar/DateNoteFooter.test.ts
git commit -m "feat(calendar): 이전 년도 기록 패널(PrevYearRecords + DateNoteFooter)"
```

---

### Task 3: `NoteWindow`에 날짜 노트 푸터 마운트 (req 2)

**Goal:** 데스크탑 노트 창에서 제목이 날짜(`YYYY-MM-DD`)인 노트를 열면 에디터 아래에 `DateNoteFooter`가 붙는다.

**Files:**
- Modify: `app/src/lib/desktop/NoteWindow.svelte` (import 추가 ~line 108 근처, derived 추가 ~line 258 근처, 마운트 ~line 1490 뒤)

**Acceptance Criteria:**
- [ ] `isDateNote` derived가 `note.title`이 날짜 제목일 때만 true.
- [ ] 에디터 `{:else}` 브랜치 안, `ChatSendBar`/`RemarkableActionBar` 블록 뒤에서 `isDateNote`일 때 `<DateNoteFooter title={note?.title ?? ''} />` 마운트(`.body` 내부).
- [ ] `npm run check` 통과.

**Verify:** `npm run check` → 0 errors. 수동: `npm run dev` → 데스크탑에서 `YYYY-MM-DD` 노트 창을 열면 에디터 아래 흐린 이전 년도 기록 패널이 보인다(해당 날짜에 이전 년도 기록이 있을 때).

**Steps:**

- [ ] **Step 1: import 추가** — `app/src/lib/desktop/NoteWindow.svelte`, `findAdjacentDateNotes` import(108행) 아래에 추가

```ts
import DateNoteFooter from './calendar/DateNoteFooter.svelte';
import { isDateTitle } from './calendar/historyChain.js';
```

- [ ] **Step 2: derived 추가** — `dedicatedKind` derived(258행) 근처, `<script>` 안 아무 파생 블록 뒤에 추가

```ts
const isDateNote = $derived(!!note && isDateTitle(note.title));
```

- [ ] **Step 3: 푸터 마운트** — 에디터 브랜치의 `ChatSendBar`/`RemarkableActionBar` 블록(현재 ~1479–1490행)의 닫는 `{/if}` 바로 다음, `{:else}`(노트 불러올 수 없음, ~1491행) 앞에 삽입

```svelte
			{#if isDateNote}
				<DateNoteFooter title={note?.title ?? ''} />
			{/if}
```

삽입 위치 맥락(변경 후):
```svelte
				{#if editorComponent?.getEditor() && llmBridgeUrl && llmBridgeToken}
					<ChatSendBar ... />
					<RemarkableActionBar ... />
				{/if}
				{#if isDateNote}
					<DateNoteFooter title={note?.title ?? ''} />
				{/if}
			{:else}
				<div class="loading">노트를 불러올 수 없습니다.</div>
			{/if}
```

- [ ] **Step 4: 타입 체크**

Run: `npm run check`
Expected: 0 errors.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/desktop/NoteWindow.svelte
git commit -m "feat(calendar): 날짜 노트 창에 이전 년도 기록 푸터 마운트"
```

---

### Task 4: `CalendarView` — 셀 클릭→날짜 노트 + 배지=목록 + 이전 년도 셀 라인 (req 1, 3)

**Goal:** 셀 본문 클릭은 `onopendate`(날짜 노트), 개수 배지 클릭은 `ondayselect`(목록)로 분리하고, 다이어리 모드 셀에 이전 년도 같은 날짜 기록을 흐리게·우측정렬로 표기한다.

**Files:**
- Modify: `app/src/lib/desktop/calendar/CalendarView.svelte`

**Acceptance Criteria:**
- [ ] 새 prop `onopendate: (date: string) => void`.
- [ ] `clickCell`이 in-month 셀이면 개수 무관하게 `onopendate(cell.key)` 호출(spill-over는 기존대로 월 이동).
- [ ] 개수 배지가 별도 클릭 타깃(`stopPropagation` → `ondayselect`). 셀은 `<div role="button" tabindex="0">`(버튼 중첩 제거), Enter/Space로도 열림.
- [ ] 다이어리 모드 셀에 `year < viewYear`인 같은 (월,일) 기록이 흐리게·우측정렬로(상위 2줄 + `+N`) 표시.
- [ ] `npm run check` 통과.

**Verify:** `npm run check` → 0 errors. 수동: `npm run dev` → 달력에서 셀 본문 클릭=날짜 노트 열림, 배지 클릭=목록, 이전 년도 기록 있는 날에 흐린 라인 표시.

**Steps:**

- [ ] **Step 1: import + prop + 상태 추가** — `CalendarView.svelte` `<script>`

`loadDiaryDayMap` import(18행) 아래:
```ts
import { loadHistoryChain, recordsForDate, type HistoryChain } from './historyChain.js';
```

`Props` 인터페이스(20–25행)에 콜백 추가:
```ts
	interface Props {
		/** 다이어리 모드(셀에 일정/히스토리 항목 표기). */
		diary?: boolean;
		/** 셀 본문 클릭 — 그날 날짜 노트(제목 YYYY-MM-DD)를 연다. */
		onopendate: (date: string) => void;
		/** 개수 배지 클릭 — 그날 생성된 노트 목록을 넘긴다. */
		ondayselect: (date: string, notes: CalendarNote[]) => void;
	}
```
구조분해(27행):
```ts
	let { diary = false, onopendate, ondayselect }: Props = $props();
```

- [ ] **Step 2: 히스토리 체인 로드 상태** — `diaryMap` 블록(43–57행) 뒤에 추가

```ts
	let historyChain = $state<HistoryChain | null>(null);
	async function loadHistory() {
		historyChain = await loadHistoryChain();
	}

	function prevYearsFor(cell: MonthCell) {
		if (!diary || !cell.inMonth || !historyChain) return [];
		return recordsForDate(historyChain, viewYear, cell.date.getMonth() + 1, cell.day);
	}
```

- [ ] **Step 3: onMount 로드 배선** — 기존 `onMount`(64–71행)에 `loadHistory` 추가

```ts
	onMount(() => {
		void loadNotes();
		void loadHistory();
		// 어떤 노트든 생성/삭제/변경으로 목록 캐시가 무효화되면 개수 + 다이어리 + 히스토리 갱신.
		return onInvalidate(() => {
			void loadNotes();
			void loadDiary();
			void loadHistory();
		});
	});
```

- [ ] **Step 4: 클릭 핸들러 분리** — `clickCell`(104–111행) 교체 + 배지 핸들러 추가

```ts
	function clickCell(cell: MonthCell) {
		if (!cell.inMonth) {
			viewYear = cell.date.getFullYear();
			viewMonth = cell.date.getMonth();
			return;
		}
		onopendate(cell.key);
	}
	function clickBadge(e: MouseEvent, cell: MonthCell) {
		e.stopPropagation();
		ondayselect(cell.key, dayMap.get(cell.key) ?? []);
	}
	function cellKeydown(e: KeyboardEvent, cell: MonthCell) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			clickCell(cell);
		}
	}
```

- [ ] **Step 5: 셀 마크업 — 버튼→div(role=button), 배지→button, 이전 년도 라인** — 셀 블록(132–159행) 교체

```svelte
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="cell"
				role="button"
				tabindex="0"
				class:out={!cell.inMonth}
				class:today={cell.isToday}
				class:has={cell.count > 0}
				class:sun={cell.date.getDay() === 0}
				class:sat={cell.date.getDay() === 6}
				onclick={() => clickCell(cell)}
				onkeydown={(e) => cellKeydown(e, cell)}
				data-no-drag
			>
				<span class="cell-day">{cell.day}</span>
				{#if cell.count > 0}
					<button
						type="button"
						class="cell-count"
						onclick={(e) => clickBadge(e, cell)}
						aria-label="{cell.key} 노트 목록"
						title="이 날의 노트 목록"
						data-no-drag>{cell.count}</button
					>
				{/if}
				{#if diary && entries.length > 0}
					<span class="cell-entries">
						{#each entries.slice(0, MAX_ENTRY_LINES) as e, i (i)}
							<span class="cell-entry" class:hist={e.source === 'history'}>
								{#if e.time}<b>{fmtTime(e.time)}</b> {/if}{e.label}
							</span>
						{/each}
						{#if entries.length > MAX_ENTRY_LINES}
							<span class="cell-more">+{entries.length - MAX_ENTRY_LINES}</span>
						{/if}
					</span>
				{/if}
				{#if diary}
					{@const pys = prevYearsFor(cell)}
					{#if pys.length > 0}
						<span class="cell-prev">
							{#each pys.slice(0, 2) as p, i (i)}
								<span class="cell-prev-line"><b>{p.year}</b> {p.label}</span>
							{/each}
							{#if pys.length > 2}
								<span class="cell-prev-more">+{pys.length - 2}</span>
							{/if}
						</span>
					{/if}
				{/if}
			</div>
```

- [ ] **Step 6: 스타일 추가** — `<style>` 안 `.cell-more`(343–347행) 뒤에 추가

```css
	.cell-count {
		border: none;
		cursor: pointer;
	}
	.cell-count:hover {
		filter: brightness(1.1);
	}

	.cell-prev {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-height: 0;
		overflow: hidden;
		text-align: right;
		margin-top: auto;
	}
	.cell-prev-line {
		font-size: 0.55rem;
		line-height: 1.2;
		color: #b0b4b8;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cell-prev-line b {
		font-weight: 700;
		color: #c4c8cc;
	}
	.cell-prev-more {
		font-size: 0.52rem;
		color: #c4c8cc;
		text-align: right;
	}
```

> 기존 `.cell-count`는 `position:absolute; top/right`로 이미 셀 우상단에 뜬다(295–308행). `<button>`으로 바뀌어도 그 규칙이 그대로 적용되도록 위 추가 규칙은 배경/폰트를 덮지 않고 border/cursor만 얹는다.

- [ ] **Step 7: 타입 체크**

Run: `npm run check`
Expected: 0 errors. (`onopendate` 필수 prop이 됐으니 Task 5에서 CalendarWindow가 넘기기 전까진 CalendarWindow에서 타입 에러가 날 수 있음 — Task 5와 함께 해소. 이 태스크 단독 check는 CalendarView 자체 에러 0을 확인하고, CalendarWindow 에러는 Task 5에서 잡는다.)

- [ ] **Step 8: 커밋**

```bash
git add app/src/lib/desktop/calendar/CalendarView.svelte
git commit -m "feat(calendar): 셀 클릭→날짜 노트, 배지=목록 분리 + 이전 년도 셀 라인"
```

---

### Task 5: `CalendarWindow` 배선 + `EphemeralDateOverlay` (req 1 분기, req 5)

**Goal:** 셀 클릭 시 날짜 노트가 있으면 실제 창을, 없으면 임시 오버레이(이전 년도 기록 + "만들기")를 연다.

**Files:**
- Create: `app/src/lib/desktop/EphemeralDateOverlay.svelte`
- Modify: `app/src/lib/desktop/CalendarWindow.svelte`

**Acceptance Criteria:**
- [ ] `CalendarWindow`이 `onopendate={handleOpenDate}`를 `CalendarView`에 넘긴다.
- [ ] `handleOpenDate(title)`: `findNoteByTitle` → 있으면 `openWindow(guid)`, 없으면 `ephemeralDate = title`.
- [ ] `EphemeralDateOverlay`이 달력 오른쪽에 도킹, 이전 년도 기록(없으면 안내문) + "이 날짜 노트 만들기" 버튼(→ `createNote` → 열기 → 닫기).
- [ ] `npm run check` 통과.

**Verify:** `npm run check` → 0 errors. 수동: 없는 날짜 셀 클릭 → 임시 오버레이 + 이전 년도 기록; "만들기" → 그 날짜 노트 생성·열림(푸터 포함). 있는 날짜 셀 클릭 → 실제 노트 창.

**Steps:**

- [ ] **Step 1: `EphemeralDateOverlay.svelte` 구현** — `app/src/lib/desktop/EphemeralDateOverlay.svelte`

```svelte
<script lang="ts">
	/** 날짜 노트가 아직 없는 날을 눌렀을 때 뜨는 임시 오버레이(req 5).
	 *  이전 년도 같은 날짜 기록을 보여주고(없으면 안내문), "이 날짜 노트 만들기"로
	 *  실제 날짜 노트를 생성해 연다. DayNotesBundleOverlay 의 도킹/드래그/리사이즈
	 *  스켈레톤을 그대로 따른다(portal → --z-modal). */
	import { onMount } from 'svelte';
	import { portal } from '$lib/utils/portal.js';
	import { createNote } from '$lib/core/noteManager.js';
	import { pushToast } from '$lib/stores/toast.js';
	import {
		loadHistoryChain,
		recordsForDate,
		parseDateTitle,
		type HistoryEntry
	} from './calendar/historyChain.js';
	import PrevYearRecords from './calendar/PrevYearRecords.svelte';
	import { startPointerDrag, type Geometry } from './dragResize.js';
	import ResizeHandles from './ResizeHandles.svelte';

	interface Props {
		/** YYYY-MM-DD. */
		date: string;
		onclose: () => void;
		/** 만든/여는 노트 제목을 넘긴다(호스트가 openByTitle). */
		onopennote: (title: string) => void;
		anchor?: { x: number; y: number; width: number; height: number };
	}
	let { date, onclose, onopennote, anchor }: Props = $props();

	const WIN_DEFAULT_WIDTH = 340;
	const WIN_DEFAULT_HEIGHT = 360;
	const WIN_MIN = { width: 240, height: 200 };
	const DOCK_GAP = 8;

	let records = $state<HistoryEntry[]>([]);
	let creating = $state(false);
	let geo = $state<Geometry>({ x: 0, y: 0, width: WIN_DEFAULT_WIDTH, height: WIN_DEFAULT_HEIGHT });

	async function loadRecords() {
		const d = parseDateTitle(date);
		if (!d) {
			records = [];
			return;
		}
		const chain = await loadHistoryChain();
		records = recordsForDate(chain, d.year, d.month, d.day);
	}

	async function handleCreate() {
		if (creating) return;
		creating = true;
		try {
			await createNote(date); // 날짜 제목 → `년`+일정 시드(noteManager)
			onclose();
			onopennote(date);
		} catch (e) {
			pushToast((e as Error).message ?? '노트를 만들 수 없습니다.', { kind: 'error' });
			creating = false;
		}
	}

	function startTitleDrag(e: PointerEvent) {
		const t = e.target as HTMLElement | null;
		if (t?.closest('[data-no-drag]')) return;
		const origX = geo.x;
		const origY = geo.y;
		startPointerDrag(e, {
			onMove: (dx, dy) => {
				geo = { ...geo, x: Math.max(0, origX + dx), y: Math.max(0, origY + dy) };
			}
		});
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}

	onMount(() => {
		void loadRecords();
		if (typeof window === 'undefined') return;
		const width = WIN_DEFAULT_WIDTH;
		const height = WIN_DEFAULT_HEIGHT;
		let x: number;
		let y: number;
		if (anchor) {
			x = anchor.x + anchor.width + DOCK_GAP;
			if (x + width > window.innerWidth) {
				const leftX = anchor.x - DOCK_GAP - width;
				x = leftX >= 0 ? leftX : Math.max(0, window.innerWidth - width);
			}
			y = Math.max(0, Math.min(anchor.y, window.innerHeight - height));
		} else {
			x = Math.max(0, Math.round((window.innerWidth - width) / 2));
			y = Math.max(0, Math.round((window.innerHeight - height) / 2));
		}
		geo = { x, y, width, height };
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="ed-overlay"
	use:portal
	style={`left:${geo.x}px; top:${geo.y}px; width:${geo.width}px; height:${geo.height}px;`}
>
	<header class="ed-header" onpointerdown={startTitleDrag}>
		<span class="ed-tag">{date}</span>
		<button type="button" class="ed-close" onclick={onclose} aria-label="닫기" data-no-drag>✕</button>
	</header>

	<div class="ed-body">
		{#if records.length > 0}
			<PrevYearRecords {records} />
		{:else}
			<p class="ed-msg">이 날짜의 이전 년도 기록이 없습니다.</p>
		{/if}
	</div>

	<footer class="ed-foot">
		<button type="button" class="ed-create" onclick={handleCreate} disabled={creating} data-no-drag>
			이 날짜 노트 만들기
		</button>
	</footer>

	<ResizeHandles base={() => geo} min={WIN_MIN} onresize={(g) => (geo = g)} />
</div>

<style>
	.ed-overlay {
		position: fixed;
		z-index: var(--z-modal);
		display: flex;
		flex-direction: column;
		background: var(--color-bg, #fff);
		border: 1px solid var(--color-border, #d4d8dc);
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		overflow: hidden;
	}
	.ed-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--color-border, #e4e8ec);
		background: var(--color-bg-secondary, #f5f6f7);
		cursor: grab;
		user-select: none;
		touch-action: none;
		flex-shrink: 0;
	}
	.ed-tag {
		font-size: 0.78rem;
		font-weight: 700;
		color: #fff;
		background: var(--color-accent, #4a7);
		border-radius: 4px;
		padding: 2px 6px;
	}
	.ed-close {
		width: 30px;
		height: 30px;
		border: none;
		background: none;
		border-radius: 50%;
		font-size: 1rem;
		color: var(--color-text-secondary, #666);
		cursor: pointer;
	}
	.ed-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}
	.ed-msg {
		margin: 0;
		padding: 30px 16px;
		text-align: center;
		color: var(--color-text-secondary, #888);
		font-size: 0.9rem;
	}
	.ed-foot {
		flex-shrink: 0;
		padding: 8px 10px;
		border-top: 1px solid var(--color-border, #e4e8ec);
	}
	.ed-create {
		width: 100%;
		padding: 8px;
		border: 1px solid var(--color-accent, #4a7);
		background: var(--color-accent, #4a7);
		color: #fff;
		border-radius: 6px;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.ed-create:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
```

- [ ] **Step 2: `CalendarWindow` import + 상태 추가** — `CalendarWindow.svelte` `<script>`

`DayNotesBundleOverlay` import(12행) 아래:
```ts
import EphemeralDateOverlay from './EphemeralDateOverlay.svelte';
import { findNoteByTitle } from '$lib/core/noteManager.js';
```
`selectedNotes` 상태(58행) 아래:
```ts
	let ephemeralDate = $state<string | null>(null);
```

- [ ] **Step 3: `handleOpenDate` 추가** — `handleDaySelect`(60–63행) 아래

```ts
	async function handleOpenDate(title: string) {
		const note = await findNoteByTitle(title);
		if (note) {
			desktopSession.openWindow(note.guid);
			return;
		}
		ephemeralDate = title;
	}
```

- [ ] **Step 4: `CalendarView`에 `onopendate` 전달** — 122행

```svelte
	<CalendarView diary={diaryMode} onopendate={handleOpenDate} ondayselect={handleDaySelect} />
```

- [ ] **Step 5: `EphemeralDateOverlay` 렌더** — `DayNotesBundleOverlay` 블록(131–140행) 뒤에 추가

```svelte
{#if ephemeralDate}
	<EphemeralDateOverlay
		date={ephemeralDate}
		anchor={{ x, y, width, height }}
		onclose={() => (ephemeralDate = null)}
		onopennote={openNote}
	/>
{/if}
```

- [ ] **Step 6: 타입 체크**

Run: `npm run check`
Expected: 0 errors (Task 4의 `onopendate` 필수 prop도 여기서 해소).

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/desktop/EphemeralDateOverlay.svelte app/src/lib/desktop/CalendarWindow.svelte
git commit -m "feat(calendar): 셀 클릭→날짜 노트 열기 분기 + 없을 때 임시 오버레이(req 5)"
```

---

### Task 6: 목록에 이전 년도 날짜 노트 포함 (req 4)

**Goal:** 개수 배지로 여는 "그날 목록"에 이전 년도 같은 날짜 노트(`2025-07-16` 등, 존재하는 것만)를 병합한다.

**Files:**
- Modify: `app/src/lib/desktop/DayNotesBundleOverlay.svelte`
- Modify: `app/src/lib/desktop/CalendarWindow.svelte`

**Acceptance Criteria:**
- [ ] `DayNotesBundleOverlay`에 `prevYearTitles?: string[]` prop; `titles`가 [그날 생성 노트 제목 + prevYearTitles] 중복 제거 병합.
- [ ] `CalendarWindow`이 배지 클릭 시 히스토리 체인의 연도 집합으로 `YYYY-MM-DD` 후보를 만들어 존재하는 것만 `prevYearTitles`로 전달.
- [ ] 빈-메시지/개수는 병합된 `titles` 기준.
- [ ] `npm run check` 통과.

**Verify:** `npm run check` → 0 errors. 수동: 이전 년도 `2025-07-16` 노트가 있는 상태에서 7/16 배지 클릭 → 목록에 그 노트가 포함.

**Steps:**

- [ ] **Step 1: `DayNotesBundleOverlay` prop + 병합** — `DayNotesBundleOverlay.svelte`

`Props` 인터페이스(23–35행)에 추가:
```ts
		/** 이전 년도 같은 날짜 노트 제목(존재하는 것만). 목록에 병합. */
		prevYearTitles?: string[];
```
구조분해(37행):
```ts
	let { date, notes, onclose, onopennote, windowed = true, anchor, prevYearTitles = [] }: Props = $props();
```
`titles` derived(45행) 교체:
```ts
	const titles = $derived.by(() => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const t of [...notes.map((n) => n.title.trim()), ...prevYearTitles]) {
			if (t && !seen.has(t)) {
				seen.add(t);
				out.push(t);
			}
		}
		return out;
	});
```
(`count`·`spec`은 `titles` 파생이라 자동 반영. 빈-메시지 조건 `!spec || count === 0`도 동일.)

- [ ] **Step 2: `CalendarWindow` — prevYearTitles 계산** — `CalendarWindow.svelte`

import에 `loadHistoryChain`, `parseDateTitle` 추가(Task 5의 `findNoteByTitle` import 옆):
```ts
import { findNoteByTitle } from '$lib/core/noteManager.js';
import { loadHistoryChain, parseDateTitle } from './calendar/historyChain.js';
```
상태 추가(`ephemeralDate` 근처):
```ts
	let prevYearTitles = $state<string[]>([]);
```
`handleDaySelect`(60–63행) 교체:
```ts
	async function handleDaySelect(date: string, notes: CalendarNote[]) {
		selectedDate = date;
		selectedNotes = notes;
		prevYearTitles = [];
		const d = parseDateTitle(date);
		if (!d) return;
		const chain = await loadHistoryChain();
		const mmdd = date.slice(5); // "MM-DD"
		const years = [...new Set(chain.entries.map((e) => e.year))]
			.filter((y) => y < d.year)
			.sort((a, b) => b - a);
		const found = await Promise.all(
			years.map((y) => {
				const t = `${y}-${mmdd}`;
				return findNoteByTitle(t).then((n) => (n ? t : null));
			})
		);
		// selectedDate 가 그새 바뀌었으면 버린다(빠른 연속 클릭 가드).
		if (selectedDate === date) {
			prevYearTitles = found.filter((t): t is string => !!t);
		}
	}
```

- [ ] **Step 3: `DayNotesBundleOverlay`에 prop 전달** — 131–140행 블록

```svelte
{#if selectedDate}
	<DayNotesBundleOverlay
		windowed
		date={selectedDate}
		notes={selectedNotes}
		{prevYearTitles}
		anchor={{ x, y, width, height }}
		onclose={() => (selectedDate = null)}
		onopennote={openNote}
	/>
{/if}
```

- [ ] **Step 4: 타입 체크**

Run: `npm run check`
Expected: 0 errors.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/desktop/DayNotesBundleOverlay.svelte app/src/lib/desktop/CalendarWindow.svelte
git commit -m "feat(calendar): 목록에 이전 년도 같은 날짜 노트 병합(req 4)"
```

---

### Task 7: 설정 가이드 카드 + 최종 검증

**Goal:** 새 달력 동작을 설정 → 가이드(노트 탭)에 문서화하고, 전체 타입 체크·테스트·수동 확인.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (guideSubTab `notes` 블록)

**Acceptance Criteria:**
- [ ] 설정 → 가이드 → 노트 탭에 달력 새 동작을 설명하는 `<details class="guide-card">` 추가(기존 카드 패턴: `<summary>` + `<p class="info-text">` + `<ul class="guide-list">`).
- [ ] `npm run check` 통과, `npm run test` 전체 통과.

**Verify:** `npm run check` → 0 errors. `npm run test` → 전체 PASS. 수동: 설정 → 가이드 → 노트 탭에 새 카드 노출.

**Steps:**

- [ ] **Step 1: 가이드 카드 삽입 위치 찾기**

Run: `grep -n "guideSubTab === 'notes'\|guide-card" app/src/routes/settings/+page.svelte | head`
Expected: `notes` 서브탭 블록과 기존 `guide-card` 예시 위치. 그 블록 안, 기존 카드들 사이/끝에 아래 카드를 삽입한다(기존 카드 마크업을 미러링).

- [ ] **Step 2: 가이드 카드 추가** — `notes` 서브탭 블록 내부

```svelte
<details class="guide-card">
	<summary>달력 — 날짜 노트 + 이전 년도 기록</summary>
	<p class="info-text">
		데스크탑 달력에서 날짜 셀을 누르면 그날의 날짜 노트(제목 <code>YYYY-MM-DD</code>)가 열립니다.
		노트가 없으면 임시 창이 뜨고, 거기서 바로 그 날짜 노트를 만들 수 있습니다.
	</p>
	<ul class="guide-list">
		<li>셀 <b>본문</b> 클릭 = 그날 날짜 노트 열기.</li>
		<li>셀 우상단 <b>개수 배지</b> 클릭 = 그날 생성된 노트 + 이전 년도 같은 날짜 노트 목록.</li>
		<li>
			날짜 노트를 열면 하단에 <b>이전 년도 같은 날짜</b>의 「히스토리 기록」 항목이 흐리게(우측정렬)
			표시됩니다. 달력 셀에도 같은 기록이 흐리게 붙습니다.
		</li>
		<li>
			출처: <code>히스토리 기록</code> 노트의 <code>YYYY - 히스토리 기록</code> 링크를 따라간
			각 연도 노트. 데스크탑 전용.
		</li>
	</ul>
</details>
```

> `<code>`/`<b>` 클래스가 기존 카드와 다르면 그 카드 스타일에 맞춘다(`snippet`/`info-text` 등). 목적은 발견 가능성 — 문구는 기존 톤(한국어)에 맞춰 조정 가능.

- [ ] **Step 3: 전체 검증**

Run: `npm run check`
Expected: 0 errors.

Run: `npm run test`
Expected: 전체 PASS(신규 `historyChain`/`DateNoteFooter` 포함).

- [ ] **Step 4: 수동 스모크(선택, 권장)**

Run: `npm run dev` → 데스크탑 `/desktop` → 달력 위젯(빈 캔버스 더블클릭 또는 기존 방식)에서:
1. 이전 년도 기록 있는 날 셀 본문 클릭 → 날짜 노트(있으면) 또는 임시 오버레이(없으면) + 이전 년도 기록.
2. 개수 있는 날 배지 클릭 → 목록(+ 이전 년도 날짜 노트).
3. 날짜 노트 창 하단 이전 년도 푸터.

- [ ] **Step 5: 커밋**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(settings): 달력 날짜 노트/이전 년도 기록 가이드 카드"
```

---

## Self-Review

**Spec coverage:**
- Req 1 (셀 클릭→날짜 노트) → Task 4(클릭 라우팅) + Task 5(find→open/ephemeral). ✓
- Req 2 (날짜 노트 이전 년도 푸터) → Task 2(컴포넌트) + Task 3(NoteWindow 마운트). ✓
- Req 3 (달력 셀 이전 년도) → Task 4(셀 라인 + 체인 로드). ✓
- Req 4 (목록 별도 버튼 + 이전 년도 노트) → Task 4(배지 트리거) + Task 6(prevYearTitles 병합). ✓
- Req 5 (없을 때 임시 노트) → Task 5(EphemeralDateOverlay). ✓
- 파서/체인 코어 → Task 1. 가이드 문서화 → Task 7. ✓

**Type consistency:** `HistoryEntry`/`HistoryChain`/`recordsForDate`/`parseDateTitle`/`isDateTitle`/`loadHistoryChain`/`parseHistoryYearNote`/`parseHistoryDayLine`/`extractHistoryYearLinks`는 Task 1에서 정의, 이후 태스크에서 동일 이름/시그니처로 소비. `onopendate`/`ondayselect`/`prevYearTitles` prop 이름 Task 4/5/6 일치. ✓

**Placeholder scan:** 코드 스텝은 실제 코드 포함. Task 7 카드 문구는 조정 가능하지만 완전한 마크업 제공. ✓

**의존성:** T2←T1, T3←T2, T4←T1, T5←T1·T4, T6←T1·T5, T7←T3·T4·T5·T6.

**주의(불변식):**
- `parseScheduleNote`/`DAY_PREFIX_RE` 수정 금지 — 새 히스토리 파서 분리, `extractMonthListItems`는 `export`만.
- 날짜 노트 푸터는 에디터 밖 패널 — `.note` XML/`pendingDoc`/캐럿 불변.
- 셀 배지 버튼 중첩 방지(셀=div role=button, 배지=button).
- 히스토리 체인 = 모듈 캐시 1회 + `onInvalidate` 무효화; 달 이동마다 재읽기 금지.
- 모든 UI 문자열 한국어.
