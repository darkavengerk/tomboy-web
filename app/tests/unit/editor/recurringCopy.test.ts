import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import type { JSONContent } from '@tiptap/core';
import {
	buildRecurredLiJson,
	findContainingMonth,
	findMonthBulletList,
	nextMonthOf,
	planMonthInsert,
	parsePrefix,
	recurrenceFromParse,
	computeTargetDate,
	scheduleDayOf,
	sortListItemsByDay
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

describe('planMonthInsert', () => {
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
		const plan = planMonthInsert(editor.state.doc, 6);
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
		const plan = planMonthInsert(editor.state.doc, 6);
		expect(plan.kind).toBe('new-list-after-header');
	});

	it('falls back to appending a new section at doc end when no header exists', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [para('5월'), bullet([li('15(월) * 카드값 확인')])]
		});
		const plan = planMonthInsert(editor.state.doc, 6);
		expect(plan.kind).toBe('new-section-at-end');
		expect(plan.insertPos).toBe(editor.state.doc.content.size);
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
			weekStars: 0,
			rest: ' 가스점검'
		});
	});

	it('주간 마커 `25(수*)` 를 분해한다 (요일 뒤 * 1개)', () => {
		expect(parsePrefix('25(수*) 화분 물주기')).toEqual({
			leadingWs: '',
			day: 25,
			monthMark: '',
			weekday: '수',
			weekStars: 1,
			rest: ' 화분 물주기'
		});
	});

	it('N주 마커 `25(수**)` 를 분해한다 (* 개수 = 주)', () => {
		expect(parsePrefix('25(수**) 책반납')).toEqual({
			leadingWs: '',
			day: 25,
			monthMark: '',
			weekday: '수',
			weekStars: 2,
			rest: ' 책반납'
		});
	});

	it('마커 없는 줄도 분해한다(weekStars/monthMark 비어있음)', () => {
		const p = parsePrefix('25(수) 그냥 일정');
		expect(p?.day).toBe(25);
		expect(p?.monthMark).toBe('');
		expect(p?.weekStars).toBe(0);
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

	it('월간/주간(*1)/N주(*N)/없음을 판별한다', () => {
		expect(spec('25*(수) a')).toEqual({ kind: 'monthly' });
		expect(spec('25(수*) a')).toEqual({ kind: 'everyNWeeks', weeks: 1 });
		expect(spec('25(수**) a')).toEqual({ kind: 'everyNWeeks', weeks: 2 });
		expect(spec('25(수***) a')).toEqual({ kind: 'everyNWeeks', weeks: 3 });
		expect(spec('25(수) a')).toBeNull();
	});

	it('월간 마커와 요일 마커가 둘 다 있으면 monthly 우선', () => {
		expect(spec('25*(수*) a')).toEqual({ kind: 'monthly' });
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

	it('everyNWeeks weeks=1: +7일, 월 넘어감', () => {
		expect(computeTargetDate(2026, 5, 25, { kind: 'everyNWeeks', weeks: 1 })).toEqual({
			year: 2026,
			month: 6,
			day: 1
		});
	});

	it('everyNWeeks weeks=2: +14일', () => {
		expect(computeTargetDate(2026, 5, 25, { kind: 'everyNWeeks', weeks: 2 })).toEqual({
			year: 2026,
			month: 6,
			day: 8
		});
	});

	it('everyNWeeks: 연 경계 넘어감', () => {
		expect(computeTargetDate(2026, 12, 28, { kind: 'everyNWeeks', weeks: 1 })).toEqual({
			year: 2027,
			month: 1,
			day: 4
		});
	});

	it('계산된 날짜의 요일은 Date와 일치(스모크)', () => {
		const t = computeTargetDate(2026, 5, 25, { kind: 'everyNWeeks', weeks: 1 });
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

	it('weekly(*1): 파렌 안 `*` 유지, 일 번호+요일 재계산', () => {
		const out = buildRecurredLiJson(li('25(수*) 화분 물주기'), { year: 2026, month: 6, day: 1 });
		expect(firstText(out)).toBe(`1(${wd(2026, 6, 1)}*) 화분 물주기`);
	});

	it('everyNWeeks(*2): 파렌 안 `**` 유지', () => {
		const out = buildRecurredLiJson(li('25(수**) 책반납'), { year: 2026, month: 6, day: 8 });
		expect(firstText(out)).toBe(`8(${wd(2026, 6, 8)}**) 책반납`);
	});

	it('day prefix 없으면 그대로', () => {
		const out = buildRecurredLiJson(li('카드값 확인 *'), { year: 2026, month: 6, day: 1 });
		expect(firstText(out)).toBe('카드값 확인 *');
	});

	it('입력을 변형하지 않는다', () => {
		const src = li('25(수*) 화분 물주기');
		const before = JSON.stringify(src);
		buildRecurredLiJson(src, { year: 2026, month: 6, day: 1 });
		expect(JSON.stringify(src)).toBe(before);
	});
});

describe('scheduleDayOf', () => {
	it('파렌 마커 형태(N(요일) / N*(요일))에서 일 번호를 뽑는다', () => {
		expect(scheduleDayOf(li('16(토) 빨래'))).toBe(16);
		expect(scheduleDayOf(li('3(수*) 화분'))).toBe(3);
		expect(scheduleDayOf(li('1*(수) 가스'))).toBe(1);
	});

	it('일 번호 없는 항목은 null', () => {
		expect(scheduleDayOf(li('노트 열심히 만드는 달'))).toBeNull();
		expect(scheduleDayOf(li('100 세자리'))).toBeNull();
		expect(scheduleDayOf(li(''))).toBeNull();
	});

	it('숫자로 시작하는 평범한 텍스트는 null(파렌 마커가 아니므로 정렬 제외)', () => {
		// 숫자와 `(`/`*(` 사이에 공백이 있거나 파렌이 없으면 일정 줄이 아니다.
		expect(scheduleDayOf(li('1 단계 목표'))).toBeNull();
		expect(scheduleDayOf(li('7 월 정리'))).toBeNull();
		expect(scheduleDayOf(li('10 시 기상'))).toBeNull();
		expect(scheduleDayOf(li('30 분 운동'))).toBeNull();
		expect(scheduleDayOf(li('5 (오늘)'))).toBeNull();
		expect(scheduleDayOf(li('12 (점심)'))).toBeNull();
		// 파렌 없는 "16 빨래"도 평범한 텍스트와 구분 불가 → 정렬 제외(제자리 고정).
		expect(scheduleDayOf(li('16 빨래'))).toBeNull();
	});
});

describe('sortListItemsByDay', () => {
	const texts = (items: JSONContent[]) => items.map((it) => firstText(it));

	it('날짜 있는 항목을 일 번호 오름차순으로 정렬', () => {
		const out = sortListItemsByDay([li('15(월) c'), li('3(금) a'), li('9(목) b')]);
		expect(texts(out)).toEqual(['3(금) a', '9(목) b', '15(월) c']);
	});

	it('날짜 없는 항목은 원래 인덱스에 고정, 날짜 항목만 재배치', () => {
		// 인덱스: [3, 없음, 1, 2] → 없음은 idx1 고정, 나머지 슬롯에 [1,2,3]
		const out = sortListItemsByDay([li('3(금) c'), li('메모'), li('1(수) a'), li('2(목) b')]);
		expect(texts(out)).toEqual(['1(수) a', '메모', '2(목) b', '3(금) c']);
	});

	it('동일 일 번호는 원래 순서 유지(stable)', () => {
		const out = sortListItemsByDay([li('5(월) 두번째'), li('2(금) x'), li('5(월) 첫번째…아님')]);
		expect(texts(out)).toEqual(['2(금) x', '5(월) 두번째', '5(월) 첫번째…아님']);
	});

	it('입력 배열을 변형하지 않는다', () => {
		const input = [li('3(금) a'), li('1(수) b')];
		const before = JSON.stringify(input);
		sortListItemsByDay(input);
		expect(JSON.stringify(input)).toBe(before);
	});
});

describe('findMonthBulletList (flat shape)', () => {
	it('해당 월의 bulletList 노드와 위치를 찾는다', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				para('5월'),
				bullet([li('1(금) 등산')]),
				para('6월'),
				bullet([li('1(월) 친구')])
			]
		});
		const found = findMonthBulletList(editor.state.doc, 6);
		expect(found).not.toBeNull();
		expect(found!.node.type.name).toBe('bulletList');
		// 위치의 노드가 실제로 6월 리스트인지 확인
		expect(editor.state.doc.nodeAt(found!.pos)?.firstChild?.firstChild?.textContent).toBe(
			'1(월) 친구'
		);
	});

	it('헤더만 있고 리스트가 없으면 null', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [para('5월'), bullet([li('1(금) 등산')]), para('6월')]
		});
		expect(findMonthBulletList(editor.state.doc, 6)).toBeNull();
	});

	it('헤더 자체가 없으면 null', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [para('5월'), bullet([li('1(금) 등산')])]
		});
		expect(findMonthBulletList(editor.state.doc, 7)).toBeNull();
	});
});
