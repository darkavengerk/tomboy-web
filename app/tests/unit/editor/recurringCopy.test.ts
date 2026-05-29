import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import type { JSONContent } from '@tiptap/core';
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

let currentEditor: Editor | null = null;

function makeEditor(doc: JSONContent): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
			TomboyParagraph,
			TomboyListItem
		],
		content: doc
	});
	currentEditor = editor;
	return editor;
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function para(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function li(text: string): JSONContent {
	return { type: 'listItem', content: [para(text)] };
}

function bullet(items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}

/** Find the absolute position of the listItem whose first-paragraph text matches `match`. */
function findLiPos(editor: Editor, match: string): number {
	let pos = -1;
	editor.state.doc.descendants((node, p) => {
		if (pos >= 0) return false;
		if (node.type.name !== 'listItem') return true;
		const text = node.firstChild?.textContent ?? '';
		if (text === match) {
			pos = p;
			return false;
		}
		return true;
	});
	if (pos < 0) throw new Error(`listItem not found: ${match}`);
	return pos;
}

describe('containsRecurringMarker', () => {
	it('returns true when the line has a `*`', () => {
		expect(containsRecurringMarker('15(금) * 카드값 확인')).toBe(true);
		expect(containsRecurringMarker('*월급 입금 확인')).toBe(true);
		expect(containsRecurringMarker('1 * 2 * 3')).toBe(true);
	});

	it('returns false when there is no `*`', () => {
		expect(containsRecurringMarker('15(금) 등산 7시')).toBe(false);
		expect(containsRecurringMarker('')).toBe(false);
	});
});

describe('nextMonthOf', () => {
	it('increments the month within the same year', () => {
		expect(nextMonthOf(1)).toEqual({ month: 2, yearOffset: 0 });
		expect(nextMonthOf(11)).toEqual({ month: 12, yearOffset: 0 });
	});

	it('rolls December over to January with a year offset', () => {
		expect(nextMonthOf(12)).toEqual({ month: 1, yearOffset: 1 });
	});
});

describe('findContainingMonth (flat shape)', () => {
	it('returns the most recent month header before the li', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				para('5월'),
				bullet([li('1(금) 등산 7시'), li('15(월) * 카드값 확인')]),
				para('6월'),
				bullet([li('1(월) 친구 만나기')])
			]
		});
		const liPos = findLiPos(editor, '15(월) * 카드값 확인');
		expect(findContainingMonth(editor.state.doc, liPos)).toBe(5);
		const juneLi = findLiPos(editor, '1(월) 친구 만나기');
		expect(findContainingMonth(editor.state.doc, juneLi)).toBe(6);
	});

	it('returns null when no preceding month header exists', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [bullet([li('1(금) something')])]
		});
		const liPos = findLiPos(editor, '1(금) something');
		expect(findContainingMonth(editor.state.doc, liPos)).toBeNull();
	});
});

describe('planNextMonthInsert', () => {
	it('appends to the existing next-month bullet list', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				para('5월'),
				bullet([li('15(월) * 카드값 확인')]),
				para('6월'),
				bullet([li('1(월) 친구 만나기')])
			]
		});
		const plan = planNextMonthInsert(editor.state.doc, 6);
		expect(plan.kind).toBe('append-to-list');
	});

	it('creates a new bullet list when the next-month header has none', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				para('5월'),
				bullet([li('15(월) * 카드값 확인')]),
				para('6월')
			]
		});
		const plan = planNextMonthInsert(editor.state.doc, 6);
		expect(plan.kind).toBe('new-list-after-header');
	});

	it('falls back to appending a new section at doc end when no header exists', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [para('5월'), bullet([li('15(월) * 카드값 확인')])]
		});
		const plan = planNextMonthInsert(editor.state.doc, 6);
		expect(plan.kind).toBe('new-section-at-end');
		expect(plan.insertPos).toBe(editor.state.doc.content.size);
	});
});

describe('buildNextMonthLiJson', () => {
	it('rewrites the day-prefix weekday for the new month and keeps `*`', () => {
		// 5월 15일 2026 = 금요일, 6월 15일 2026 = 월요일
		const src = li('15(금) * 카드값 확인');
		const out = buildNextMonthLiJson(src, 2026, 6);
		const firstParaText = (
			out.content?.[0]?.content?.[0] as { text?: string } | undefined
		)?.text;
		expect(firstParaText).toBe('15(월) * 카드값 확인');
	});

	it('leaves text unchanged when the prefix is unrecognised', () => {
		const src = li('카드값 확인 *');
		const out = buildNextMonthLiJson(src, 2026, 6);
		const firstParaText = (
			out.content?.[0]?.content?.[0] as { text?: string } | undefined
		)?.text;
		expect(firstParaText).toBe('카드값 확인 *');
	});

	it('does not mutate the input JSON', () => {
		const src = li('15(금) * 카드값 확인');
		const before = JSON.stringify(src);
		buildNextMonthLiJson(src, 2026, 6);
		expect(JSON.stringify(src)).toBe(before);
	});
});

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
		expect(computeTargetDate(2026, 5, 25, { kind: 'weekly' })).toEqual({
			year: 2026,
			month: 6,
			day: 1
		});
	});

	it('everyNWeeks: +7N일', () => {
		expect(computeTargetDate(2026, 5, 25, { kind: 'everyNWeeks', weeks: 2 })).toEqual({
			year: 2026,
			month: 6,
			day: 8
		});
	});

	it('weekly: 연 경계 넘어감', () => {
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
