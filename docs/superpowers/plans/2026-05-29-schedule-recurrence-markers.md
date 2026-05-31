# 일정 노트 반복 마커 세분화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "보내기" 버튼의 자동-재추가 동작을 마커 위치에 따라 월간(`25*(수)`)·주간(`25(수)*`)·N주(`25(수)^2`)로 세분화하고, 라벨 안의 `*`는 무시한다.

**Architecture:** 세 마커를 "목표 절대 날짜 계산 → 그 월 섹션에 삽입"으로 통일한다(접근 A). 순수 파서/날짜 계산(`recurringCopy.ts`)을 먼저 추가하고, 복제본 빌더를 추가한 뒤, `transferListItem.ts`를 새 API로 갈아끼우고 옛 substring 경로를 제거한다. autoWeekday는 `25*(수)` 형태를 인식하도록 확장한다. 각 커밋은 타입체크·테스트 green 상태를 유지한다.

**Tech Stack:** SvelteKit, TipTap 3 / ProseMirror, TypeScript, vitest + @testing-library/svelte.

설계 문서: `docs/superpowers/specs/2026-05-29-schedule-recurrence-markers-design.md`

---

### Task 1: 마커 파서 + 목표 날짜 계산 (순수 함수)

**Goal:** `recurringCopy.ts`에 위치 마커 파서·반복 종류 판별·목표 절대 날짜 계산 순수 함수를 **추가**한다(기존 함수 제거/리네임 없음 → build green).

**Files:**
- Modify: `app/src/lib/editor/sendListItem/recurringCopy.ts`
- Test: `app/tests/unit/editor/recurringCopy.test.ts`

**Acceptance Criteria:**
- [ ] `parsePrefix` 가 `25*(수) 가스점검` / `25(수)* 화분 물주기` / `25(수)^2 책반납` / `25(수) 그냥` 을 올바른 토큰으로 분해한다.
- [ ] `parsePrefix` 가 day 번호 prefix가 없는 줄(`카드값 확인 *`)에 `null`을 반환한다(라벨 안 `*` 무시).
- [ ] `recurrenceFromParse` 가 monthly/weekly/everyNWeeks/`null` 을 규칙대로 반환하고, 둘 다 있을 때(`25*(수)*`) monthly를 우선한다.
- [ ] `computeTargetDate` 가 monthly(일 유지, 12월→1월 연 +1), weekly(+7일, 월 넘어감), everyNWeeks(+7N일)를 정확히 계산한다.
- [ ] 기존 테스트 전부 통과(기존 export는 그대로).

**Verify:** `cd app && npx vitest run tests/unit/editor/recurringCopy.test.ts` → 전부 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 추가**

`app/tests/unit/editor/recurringCopy.test.ts` 상단 import에 새 이름을 추가:

```ts
import {
	buildNextMonthLiJson,
	containsRecurringMarker,
	findContainingMonth,
	nextMonthOf,
	planNextMonthInsert,
	parsePrefix,
	recurrenceFromParse,
	computeTargetDate
} from '$lib/editor/sendListItem/recurringCopy.js';
```

파일 끝에 다음 describe 블록을 추가:

```ts
// 같은 Date 산술로 기대 요일을 계산(하드코딩 금지).
const WD = ['일', '월', '화', '수', '목', '금', '토'] as const;
function wd(year: number, month: number, day: number): string {
	return WD[new Date(year, month - 1, day).getDay()];
}

describe('parsePrefix', () => {
	it('월간 마커 `25*(수)` 를 분해한다', () => {
		expect(parsePrefix('25*(수) 가스점검')).toEqual({
			leadingWs: '',
			day: 25,
			monthMark: '*',
			weekday: '수',
			weekMark: '',
			rest: ' 가스점검'
		});
	});

	it('주간 마커 `25(수)*` 를 분해한다', () => {
		expect(parsePrefix('25(수)* 화분 물주기')).toEqual({
			leadingWs: '',
			day: 25,
			monthMark: '',
			weekday: '수',
			weekMark: '*',
			rest: ' 화분 물주기'
		});
	});

	it('N주 마커 `25(수)^2` 를 분해한다', () => {
		expect(parsePrefix('25(수)^2 책반납')).toEqual({
			leadingWs: '',
			day: 25,
			monthMark: '',
			weekday: '수',
			weekMark: '^2',
			rest: ' 책반납'
		});
	});

	it('마커 없는 줄도 분해한다(weekMark/monthMark 비어있음)', () => {
		const p = parsePrefix('25(수) 그냥 일정');
		expect(p?.day).toBe(25);
		expect(p?.monthMark).toBe('');
		expect(p?.weekMark).toBe('');
	});

	it('day prefix가 없으면 null (라벨 안 * 무시)', () => {
		expect(parsePrefix('카드값 확인 *')).toBeNull();
		expect(parsePrefix('')).toBeNull();
	});
});

describe('recurrenceFromParse', () => {
	const spec = (text: string) => {
		const p = parsePrefix(text);
		return p ? recurrenceFromParse(p) : null;
	};

	it('월간/주간/N주/없음을 판별한다', () => {
		expect(spec('25*(수) a')).toEqual({ kind: 'monthly' });
		expect(spec('25(수)* a')).toEqual({ kind: 'weekly' });
		expect(spec('25(수)^2 a')).toEqual({ kind: 'everyNWeeks', weeks: 2 });
		expect(spec('25(수) a')).toBeNull();
	});

	it('월간과 요일 마커가 둘 다 있으면 monthly 우선', () => {
		expect(spec('25*(수)* a')).toEqual({ kind: 'monthly' });
	});
});

describe('computeTargetDate', () => {
	it('monthly: 일 번호 유지, 월 +1', () => {
		expect(computeTargetDate(2026, 5, 25, { kind: 'monthly' })).toEqual({
			year: 2026,
			month: 6,
			day: 25
		});
	});

	it('monthly: 12월 → 다음 해 1월', () => {
		expect(computeTargetDate(2026, 12, 15, { kind: 'monthly' })).toEqual({
			year: 2027,
			month: 1,
			day: 15
		});
	});

	it('weekly: +7일, 월 넘어감', () => {
		// 5/25 + 7 = 6/1
		expect(computeTargetDate(2026, 5, 25, { kind: 'weekly' })).toEqual({
			year: 2026,
			month: 6,
			day: 1
		});
	});

	it('everyNWeeks: +7N일', () => {
		// 5/25 + 14 = 6/8
		expect(computeTargetDate(2026, 5, 25, { kind: 'everyNWeeks', weeks: 2 })).toEqual({
			year: 2026,
			month: 6,
			day: 8
		});
	});

	it('weekly: 연 경계 넘어감', () => {
		// 12/28 + 7 = 다음 해 1/4
		expect(computeTargetDate(2026, 12, 28, { kind: 'weekly' })).toEqual({
			year: 2027,
			month: 1,
			day: 4
		});
	});

	it('계산된 날짜의 요일은 Date와 일치(스모크)', () => {
		const t = computeTargetDate(2026, 5, 25, { kind: 'weekly' });
		expect(wd(t.year, t.month, t.day)).toBe(wd(2026, 6, 1));
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/recurringCopy.test.ts`
Expected: FAIL — `parsePrefix is not a function` 등 새 함수 미정의.

- [ ] **Step 3: `recurringCopy.ts`에 순수 함수 추가**

`recurringCopy.ts`의 `nextMonthOf` 함수 **바로 아래**(28행 다음)에 추가:

```ts
export type RecurrenceSpec =
	| { kind: 'monthly' }
	| { kind: 'weekly' }
	| { kind: 'everyNWeeks'; weeks: number };

export interface PrefixParse {
	/** 선행 공백. */
	leadingWs: string;
	/** 일 번호. */
	day: number;
	/** 일 번호와 `(` 사이의 `*` (월간 마커) 또는 `''`. */
	monthMark: string;
	/** 파렌 안의 요일 글자(틀렸거나 쓰레기일 수 있음). */
	weekday: string;
	/** `)` 바로 뒤의 `*` / `^N` (요일 마커) 또는 `''`. */
	weekMark: string;
	/** 라벨(선행 공백 포함). */
	rest: string;
}

// 일정 줄 prefix: [공백][일][*?]([요일])[*|^N]?[라벨]
const PREFIX_RE = /^(\s*)(\d{1,2})(\*?)\(([^)]*)\)(\*|\^\d{1,2})?(.*)$/;

/** 일정 줄의 prefix를 구조 분해한다. day 번호 prefix가 없으면 null. */
export function parsePrefix(text: string): PrefixParse | null {
	const m = PREFIX_RE.exec(text);
	if (!m) return null;
	return {
		leadingWs: m[1],
		day: parseInt(m[2], 10),
		monthMark: m[3] ?? '',
		weekday: m[4],
		weekMark: m[5] ?? '',
		rest: m[6] ?? ''
	};
}

/**
 * 분해된 prefix에서 반복 종류를 판별한다.
 * - 날짜 옆 `*` → monthly (요일 마커보다 우선)
 * - 요일 옆 `*` → weekly
 * - 요일 옆 `^N` (N ≥ 1) → everyNWeeks
 * - 그 외 → null (반복 아님)
 */
export function recurrenceFromParse(p: PrefixParse): RecurrenceSpec | null {
	if (p.monthMark === '*') return { kind: 'monthly' };
	if (p.weekMark === '*') return { kind: 'weekly' };
	const m = /^\^(\d{1,2})$/.exec(p.weekMark);
	if (m) {
		const weeks = parseInt(m[1], 10);
		if (weeks >= 1) return { kind: 'everyNWeeks', weeks };
	}
	return null;
}

/**
 * 항목에 적힌 날짜(섹션 월 + 일 번호 + 기준 연도)로부터 반복 목표 날짜를 계산한다.
 * - monthly: 일 번호 유지, 월 +1 (12월 → 다음 해 1월).
 * - weekly / everyNWeeks: 기준일 + 7×주 일 (JS Date가 월·연 넘어감 처리).
 */
export function computeTargetDate(
	baseYear: number,
	baseMonth: number,
	baseDay: number,
	spec: RecurrenceSpec
): { year: number; month: number; day: number } {
	if (spec.kind === 'monthly') {
		const { month, yearOffset } = nextMonthOf(baseMonth);
		return { year: baseYear + yearOffset, month, day: baseDay };
	}
	const weeks = spec.kind === 'weekly' ? 1 : spec.weeks;
	const d = new Date(baseYear, baseMonth - 1, baseDay + 7 * weeks);
	return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/recurringCopy.test.ts`
Expected: PASS (신규 + 기존 전부)

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/sendListItem/recurringCopy.ts app/tests/unit/editor/recurringCopy.test.ts
git commit -m "feat(schedule): 위치 마커 파서 + 목표 날짜 계산 추가"
```

---

### Task 2: 반복 복제본 빌더 (`buildRecurredLiJson`)

**Goal:** 목표 날짜로 prefix(일 번호 + 요일)를 다시 쓰면서 마커를 원위치 보존하는 `buildRecurredLiJson`을 **추가**한다(기존 `buildNextMonthLiJson` 유지 → green).

**Files:**
- Modify: `app/src/lib/editor/sendListItem/recurringCopy.ts`
- Test: `app/tests/unit/editor/recurringCopy.test.ts`

**Acceptance Criteria:**
- [ ] monthly: `25*(수) 가스점검` → 목표 `{2026,6,25}` 적용 시 `25*(<6/25 요일>) 가스점검` (날짜 옆 `*` 유지).
- [ ] weekly: `25(수)* 화분 물주기` → 목표 `{2026,6,1}` 적용 시 `1(<6/1 요일>)* 화분 물주기` (요일 옆 `*` 유지).
- [ ] everyNWeeks: `25(수)^2 책반납` → 목표 `{2026,6,8}` 적용 시 `8(<6/8 요일>)^2 책반납` (`^2` 유지).
- [ ] day prefix가 없으면 텍스트 변경 없음.
- [ ] 입력 JSON을 변형하지 않는다.

**Verify:** `cd app && npx vitest run tests/unit/editor/recurringCopy.test.ts` → 전부 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 추가**

import에 `buildRecurredLiJson` 추가:

```ts
import {
	buildNextMonthLiJson,
	buildRecurredLiJson,
	containsRecurringMarker,
	findContainingMonth,
	nextMonthOf,
	planNextMonthInsert,
	parsePrefix,
	recurrenceFromParse,
	computeTargetDate
} from '$lib/editor/sendListItem/recurringCopy.js';
```

파일 끝에 describe 추가(`li`, `wd` 헬퍼는 이미 파일에 있음):

```ts
function firstText(j: JSONContent): string | undefined {
	return (j.content?.[0]?.content?.[0] as { text?: string } | undefined)?.text;
}

describe('buildRecurredLiJson', () => {
	it('monthly: 날짜 옆 `*` 유지, 요일 재계산', () => {
		const out = buildRecurredLiJson(li('25*(수) 가스점검'), { year: 2026, month: 6, day: 25 });
		expect(firstText(out)).toBe(`25*(${wd(2026, 6, 25)}) 가스점검`);
	});

	it('weekly: 요일 옆 `*` 유지, 일 번호+요일 재계산', () => {
		const out = buildRecurredLiJson(li('25(수)* 화분 물주기'), { year: 2026, month: 6, day: 1 });
		expect(firstText(out)).toBe(`1(${wd(2026, 6, 1)})* 화분 물주기`);
	});

	it('everyNWeeks: `^2` 유지', () => {
		const out = buildRecurredLiJson(li('25(수)^2 책반납'), { year: 2026, month: 6, day: 8 });
		expect(firstText(out)).toBe(`8(${wd(2026, 6, 8)})^2 책반납`);
	});

	it('day prefix 없으면 그대로', () => {
		const out = buildRecurredLiJson(li('카드값 확인 *'), { year: 2026, month: 6, day: 1 });
		expect(firstText(out)).toBe('카드값 확인 *');
	});

	it('입력을 변형하지 않는다', () => {
		const src = li('25(수)* 화분 물주기');
		const before = JSON.stringify(src);
		buildRecurredLiJson(src, { year: 2026, month: 6, day: 1 });
		expect(JSON.stringify(src)).toBe(before);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/recurringCopy.test.ts`
Expected: FAIL — `buildRecurredLiJson is not a function`.

- [ ] **Step 3: 구현 추가**

`recurringCopy.ts` import에 `getWeekdayChar` 추가(기존 `transformDayPrefixLine` import은 Task 3까지 유지):

```ts
import { transformDayPrefixLine, getWeekdayChar } from '$lib/schedule/autoWeekday.js';
```

파일 끝(`buildNextMonthLiJson` 아래)에 추가:

```ts
/**
 * `liJson`을 복제하고 첫 문단 prefix를 `target` 날짜로 다시 쓴다.
 * 일 번호와 요일을 `target`으로 갱신하되, 마커(`*`/`^N`)는 원위치 그대로 보존한다.
 * day prefix가 없으면 텍스트를 건드리지 않는다. 목표 날짜가 무효면(예: 30일 달의
 * 31일) 요일 재계산을 생략하고 기존 요일 글자를 유지한다.
 */
export function buildRecurredLiJson(
	liJson: JSONContent,
	target: { year: number; month: number; day: number }
): JSONContent {
	const cloned = JSON.parse(JSON.stringify(liJson)) as JSONContent;
	const firstPara = cloned.content?.[0];
	if (firstPara?.type === 'paragraph') {
		const firstChild = firstPara.content?.[0];
		if (firstChild?.type === 'text' && typeof firstChild.text === 'string') {
			const p = parsePrefix(firstChild.text);
			if (p) {
				let weekday = p.weekday;
				try {
					weekday = getWeekdayChar(target.year, target.month, target.day);
				} catch {
					// 무효한 목표 날짜 — 기존 요일 글자 유지
				}
				firstChild.text = `${p.leadingWs}${target.day}${p.monthMark}(${weekday})${p.weekMark}${p.rest}`;
			}
		}
	}
	return cloned;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/recurringCopy.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/sendListItem/recurringCopy.ts app/tests/unit/editor/recurringCopy.test.ts
git commit -m "feat(schedule): 반복 복제본 빌더 buildRecurredLiJson 추가"
```

---

### Task 3: transferListItem 배선 + 옛 substring 경로 제거

**Goal:** `transferListItem.ts`를 위치 마커 기반으로 갈아끼우고(목표 월 섹션 삽입 + 반복 종류별 토스트), `recurringCopy.ts`의 옛 `containsRecurringMarker`/`buildNextMonthLiJson`/`RECURRING_MARKER`를 제거하고 `planNextMonthInsert`→`planMonthInsert`(+ 타입)로 리네임한다.

**Files:**
- Modify: `app/src/lib/editor/sendListItem/transferListItem.ts`
- Modify: `app/src/lib/editor/sendListItem/recurringCopy.ts`
- Test: `app/tests/unit/editor/recurringCopy.test.ts`

**Acceptance Criteria:**
- [ ] `25*(수)` 보내기 → 다음 달 같은 일에 삽입 + "다음 달에도 추가했어요" 토스트.
- [ ] `25(수)*` 보내기 → +7일 날짜의 월 섹션에 삽입 + "다음 주에도 추가했어요".
- [ ] `25(수)^2` 보내기 → +14일 날짜의 월 섹션에 삽입 + "N주 뒤에도 추가했어요".
- [ ] 마커 없는 항목 / 라벨 안 `*` 항목은 재추가 없이 "보냈습니다."만.
- [ ] `containsRecurringMarker`, `buildNextMonthLiJson`, `RECURRING_MARKER` export 제거; `planMonthInsert`/`MonthInsertPlan`로 리네임.
- [ ] `npm run check` 타입 에러 없음, recurringCopy 테스트 전부 PASS.

**Verify:** `cd app && npx vitest run tests/unit/editor/recurringCopy.test.ts && npm run check` → PASS + 타입 에러 0

**Steps:**

- [ ] **Step 1: `recurringCopy.ts` 정리(제거 + 리네임)**

다음을 **삭제**: `export const RECURRING_MARKER`, `containsRecurringMarker` 함수, `buildNextMonthLiJson` 함수, 그리고 더 이상 쓰지 않는 `transformDayPrefixLine` import(=> `import { getWeekdayChar } from '$lib/schedule/autoWeekday.js';` 한 줄만 남김).

`NextMonthInsertPlan` 타입과 `planNextMonthInsert` 함수를 리네임:

```ts
export type MonthInsertPlan =
	| { kind: 'append-to-list'; insertPos: number }
	| { kind: 'new-list-after-header'; insertPos: number }
	| { kind: 'new-section-at-end'; insertPos: number };
```

```ts
export function planMonthInsert(doc: PMNode, targetMonth: number): MonthInsertPlan {
```

함수 본문 안의 `nextMonth` 참조를 `targetMonth`로 일괄 치환(동작 동일). `nextMonthOf`, `findContainingMonth`, `parsePrefix`, `recurrenceFromParse`, `computeTargetDate`, `buildRecurredLiJson`는 유지.

- [ ] **Step 2: `transferListItem.ts` import 교체**

기존 recurringCopy import 블록(4–17행 부근)을 교체:

```ts
import {
	buildRecurredLiJson,
	computeTargetDate,
	findContainingMonth,
	parsePrefix,
	planMonthInsert,
	recurrenceFromParse,
	type MonthInsertPlan,
	type RecurrenceSpec
} from './recurringCopy.js';
```

- [ ] **Step 3: `buildInsertionNodes` 시그니처 리네임**

`NextMonthInsertPlan`→`MonthInsertPlan`, 파라미터 `nextMonth`→`targetMonth`:

```ts
function buildInsertionNodes(
	schema: Schema,
	plan: MonthInsertPlan,
	liJson: JSONContent,
	targetMonth: number
): PMNode[] | null {
	const liNode = buildSchemaNode(schema, liJson);
	if (!liNode) return null;
	if (plan.kind === 'append-to-list') {
		return [liNode];
	}
	const bulletList = schema.nodes.bulletList;
	if (!bulletList) return null;
	const list = bulletList.create(null, [liNode]);
	if (plan.kind === 'new-list-after-header') {
		return [list];
	}
	const paragraph = schema.nodes.paragraph;
	if (!paragraph) return null;
	const headerText = schema.text(`${targetMonth}월`);
	const header = paragraph.create(null, [headerText]);
	return [header, list];
}
```

- [ ] **Step 4: `applySourceSideEdits` 재작성**

기존 `applySourceSideEdits`(151–190행)를 통째로 교체:

```ts
type SourceEditOutcome =
	| { status: 'sent' }
	| { status: 'recurred'; spec: RecurrenceSpec }
	| { status: 'displaced' };

/**
 * 소스 쪽 편집(반복 복제본 삽입 + 원본 삭제)을 단일 트랜잭션으로 적용해 한 번의
 * Ctrl+Z로 되돌릴 수 있게 한다. spec이 있으면 항목에 적힌 날짜로 목표 날짜를
 * 계산해 해당 월 섹션에 복제본을 삽입한다.
 */
function applySourceSideEdits(
	sourceEditor: Editor,
	liPos: number,
	originalFingerprint: string,
	expectedSize: number,
	spec: RecurrenceSpec | null
): SourceEditOutcome {
	const { state } = sourceEditor;
	const current = state.doc.nodeAt(liPos);
	const stillMatches =
		current &&
		current.type.name === 'listItem' &&
		JSON.stringify(current.toJSON()) === originalFingerprint;
	if (!stillMatches) return { status: 'displaced' };

	const tr = state.tr;
	let recurredSpec: RecurrenceSpec | null = null;

	if (spec) {
		const baseMonth = findContainingMonth(state.doc, liPos);
		const parsed = parsePrefix(current.firstChild?.textContent ?? '');
		if (baseMonth !== null && parsed) {
			const baseYear = new Date().getFullYear();
			const target = computeTargetDate(baseYear, baseMonth, parsed.day, spec);
			const liJson = buildRecurredLiJson(current.toJSON(), target);
			const plan = planMonthInsert(state.doc, target.month);
			const nodes = buildInsertionNodes(state.schema, plan, liJson, target.month);
			if (nodes) {
				const insertPos =
					plan.kind === 'new-section-at-end' ? state.doc.content.size : plan.insertPos;
				tr.insert(insertPos, nodes);
				recurredSpec = spec;
			}
		}
	}

	const mappedLiPos = tr.mapping.map(liPos);
	tr.delete(mappedLiPos, mappedLiPos + expectedSize);
	sourceEditor.view.dispatch(tr);
	return recurredSpec ? { status: 'recurred', spec: recurredSpec } : { status: 'sent' };
}

function recurredToastMessage(spec: RecurrenceSpec): string {
	switch (spec.kind) {
		case 'monthly':
			return '보냈습니다. 다음 달에도 추가했어요.';
		case 'weekly':
			return '보냈습니다. 다음 주에도 추가했어요.';
		case 'everyNWeeks':
			return `보냈습니다. ${spec.weeks}주 뒤에도 추가했어요.`;
	}
}
```

- [ ] **Step 5: `transferListItem` 본문 교체**

`transferListItem`(204–243행)에서 `recurring` 계산과 토스트 분기를 교체:

```ts
export async function transferListItem(
	sourceEditor: Editor,
	liPos: number,
	liNode: PMNode
): Promise<void> {
	const liJson = liNode.toJSON();
	const originalFingerprint = JSON.stringify(liJson);
	const expectedSize = liNode.nodeSize;
	const parsed = parsePrefix(liNode.firstChild?.textContent ?? '');
	const spec = parsed ? recurrenceFromParse(parsed) : null;

	try {
		await writeToDestination(liJson);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		pushToast(`보내기 실패: ${msg}`, { kind: 'error' });
		return;
	}

	if (sourceEditor.isDestroyed) {
		pushToast('보냈습니다.');
		return;
	}

	const outcome = applySourceSideEdits(
		sourceEditor,
		liPos,
		originalFingerprint,
		expectedSize,
		spec
	);
	if (outcome.status === 'recurred') {
		pushToast(recurredToastMessage(outcome.spec));
	} else if (outcome.status === 'sent') {
		pushToast('보냈습니다.');
	} else {
		pushToast('보냈습니다. 원본 위치가 바뀌어 수동으로 정리하세요.', {
			kind: 'error'
		});
	}
}
```

또한 파일 상단 docstring의 "contains `*`" 설명을 위치 마커 설명으로 갱신(주석만).

- [ ] **Step 6: 테스트 파일 정리**

`recurringCopy.test.ts`에서:
- import 블록의 `buildNextMonthLiJson`, `containsRecurringMarker` 제거, `planNextMonthInsert`→`planMonthInsert` 로 변경. 최종 import:

```ts
import {
	buildRecurredLiJson,
	findContainingMonth,
	nextMonthOf,
	planMonthInsert,
	parsePrefix,
	recurrenceFromParse,
	computeTargetDate
} from '$lib/editor/sendListItem/recurringCopy.js';
```

- `describe('containsRecurringMarker', ...)` 블록 전체 삭제.
- `describe('buildNextMonthLiJson', ...)` 블록 전체 삭제(대체는 Task 2의 `buildRecurredLiJson`).
- `describe('planNextMonthInsert', ...)` → 이름과 호출을 `planMonthInsert`로 변경:

```ts
describe('planMonthInsert', () => {
	it('appends to the existing target-month bullet list', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				para('5월'),
				bullet([li('15(월) * 카드값 확인')]),
				para('6월'),
				bullet([li('1(월) 친구 만나기')])
			]
		});
		const plan = planMonthInsert(editor.state.doc, 6);
		expect(plan.kind).toBe('append-to-list');
	});

	it('creates a new bullet list when the target-month header has none', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [para('5월'), bullet([li('15(월) * 카드값 확인')]), para('6월')]
		});
		const plan = planMonthInsert(editor.state.doc, 6);
		expect(plan.kind).toBe('new-list-after-header');
	});

	it('falls back to a new section at doc end when no header exists', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [para('5월'), bullet([li('15(월) * 카드값 확인')])]
		});
		const plan = planMonthInsert(editor.state.doc, 6);
		expect(plan.kind).toBe('new-section-at-end');
		expect(plan.insertPos).toBe(editor.state.doc.content.size);
	});
});
```

- [ ] **Step 7: 테스트 + 타입체크 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/recurringCopy.test.ts && npm run check`
Expected: 테스트 전부 PASS, `npm run check` 타입 에러 0.

- [ ] **Step 8: 커밋**

```bash
git add app/src/lib/editor/sendListItem/recurringCopy.ts app/src/lib/editor/sendListItem/transferListItem.ts app/tests/unit/editor/recurringCopy.test.ts
git commit -m "feat(schedule): 보내기 반복을 위치 마커(월간/주간/^N)로 세분화"
```

---

### Task 4: autoWeekday가 `25*(수)` 형태 처리

**Goal:** 자동 요일 채우기/교정이 일 번호와 `(` 사이의 `*`(월간 마커)를 허용하고 출력에 보존하도록 `autoWeekday.ts` 정규식을 확장한다.

**Files:**
- Modify: `app/src/lib/schedule/autoWeekday.ts`
- Test: `app/tests/unit/schedule/autoWeekday.test.ts`

**Acceptance Criteria:**
- [ ] `25*(틀린요일)` 입력 시 요일을 교정하고 `*`를 보존(`25*(<정답>)`).
- [ ] `25*(<정답요일>)` 은 변경 없음(idempotent).
- [ ] 기존 `*` 없는 케이스 동작 불변(전체 autoWeekday 테스트 통과).

**Verify:** `cd app && npx vitest run tests/unit/schedule/autoWeekday.test.ts` → 전부 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 추가**

`app/tests/unit/schedule/autoWeekday.test.ts` 끝에 추가:

```ts
describe('transformDayPrefixLine — 월간 마커 *', () => {
	it('일 번호와 파렌 사이의 *를 보존하며 요일 교정', () => {
		// Apr 12 2026 정답 요일 = APR12_WD
		const wrong = APR12_WD === '월' ? '화' : '월';
		const res = transformDayPrefixLine(`12*(${wrong}) 가스점검`, Y, M);
		expect(res.changed).toBe(true);
		expect(res.output).toBe(`12*(${APR12_WD}) 가스점검`);
	});

	it('이미 정답이면 변경 없음(idempotent)', () => {
		const res = transformDayPrefixLine(`12*(${APR12_WD}) 가스점검`, Y, M);
		expect(res.changed).toBe(false);
		expect(res.output).toBe(`12*(${APR12_WD}) 가스점검`);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/schedule/autoWeekday.test.ts`
Expected: FAIL — `12*(...)`가 매치되지 않아 출력이 입력 그대로(`changed: false`)로 나옴.

- [ ] **Step 3: 정규식 확장**

`autoWeekday.ts`의 두 정규식에 일 번호 뒤 선택적 `*` 그룹을 추가:

```ts
// Number-then-parens (no gap): optional leading ws, digits, optional `*`, parens group, rest.
const WITH_PARENS_RE = /^(\s*)(\d{1,2})(\*?)(\([^)]*\))(.*)$/;
// Number-then-space-then-parens: optional `*`, gap between digit and open paren.
const SPACE_BEFORE_PARENS_RE = /^(\s*)(\d{1,2})(\*?)(\s+)(\([^)]*\))(.*)$/;
```

`SPACE_BEFORE_PARENS_RE` 분기 교체:

```ts
	const spaceParensMatch = SPACE_BEFORE_PARENS_RE.exec(input);
	if (spaceParensMatch) {
		const [, leadingWs, dayStr, star, , parensGroup, rest] = spaceParensMatch;
		const day = parseInt(dayStr, 10);
		if (!isValidDate(year, month, day)) return unchanged;
		const wd = getWeekdayChar(year, month, day);
		return { changed: true, output: `${leadingWs}${day}${star}(${wd})${rest}` };
	}
```

`WITH_PARENS_RE` 분기 교체:

```ts
	const parensMatch = WITH_PARENS_RE.exec(input);
	if (parensMatch) {
		const [, leadingWs, dayStr, star, parensGroup, rest] = parensMatch;
		const day = parseInt(dayStr, 10);
		if (!isValidDate(year, month, day)) return unchanged;
		const wd = getWeekdayChar(year, month, day);
		const inner = parensGroup.slice(1, -1).trim();
		if (inner === wd) return unchanged; // already correct (ignoring surrounding spaces)
		return { changed: true, output: `${leadingWs}${day}${star}(${wd})${rest}` };
	}
```

`BARE_SPACE_RE` 분기는 변경 없음(파렌이 없는 경우라 월간 `*` 무관).

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/schedule/autoWeekday.test.ts`
Expected: PASS (신규 + 기존 전부)

- [ ] **Step 5: 플러그인 회귀 + 타입체크**

Run: `cd app && npx vitest run tests/unit/editor/autoWeekdayPlugin.test.ts && npm run check`
Expected: PASS, 타입 에러 0.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/schedule/autoWeekday.ts app/tests/unit/schedule/autoWeekday.test.ts
git commit -m "feat(schedule): autoWeekday가 25*(수) 형태(월간 마커)도 교정"
```

---

## 최종 검증 (전체)

모든 태스크 후:

```bash
cd app && npm run test && npm run check
```

브라우저 수동 확인(`npm run dev`, 일정 노트 = SEND_SOURCE_GUID):
1. `25*(수) 가스점검` 보내기 → 다음 달 섹션 25일에 동일 항목 + "다음 달에도" 토스트.
2. `25(수)* 화분 물주기` 보내기 → +7일 날짜의 월 섹션에 삽입 + "다음 주에도" 토스트.
3. `25(수)^2 책반납` 보내기 → +14일 날짜의 월 섹션에 삽입 + "2주 뒤에도" 토스트.
4. `25(수) 그냥` / `메모 * 별표` 보내기 → 재추가 없이 "보냈습니다."만.
5. 일정 노트에서 `25*` 입력 후 `(틀린요일)` → 요일 자동 교정 + `*` 보존.
