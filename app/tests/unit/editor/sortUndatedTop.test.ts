import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import {
	appendListItemToDocJson,
	applySourceSideEdits
} from '$lib/editor/sendListItem/transferListItem.js';
import {
	findMonthBulletList,
	parsePrefix,
	recurrenceFromParse,
	scheduleDayOf,
	sortListItemsByDay
} from '$lib/editor/sendListItem/recurringCopy.js';

// 사용자 보고: 리스트 상단에 날짜와 무관한 텍스트("이런저런 메모")가 있는데
// 보내기 후 정렬이 이상한 위치로 갔다. 날짜 없는 상단 텍스트가 정렬과 충돌하는지
// 확인하는 회귀 테스트.

function para(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function li(text: string): JSONContent {
	return { type: 'listItem', content: [para(text)] };
}
function bullet(items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}
function firstText(it: JSONContent): string {
	return (it.content?.[0]?.content?.[0] as { text?: string } | undefined)?.text ?? '';
}
function liTexts(list: JSONContent | undefined): string[] {
	return (list?.content ?? []).map(firstText);
}

describe('scheduleDayOf — 날짜 없는 상단 텍스트가 일 번호로 오인되지 않아야', () => {
	it('숫자로 시작하는 평범한 메모는 null(정렬에서 제자리 고정)', () => {
		// 모두 "일정 항목"이 아니라 그냥 설명/헤더성 텍스트.
		expect(scheduleDayOf(li('1순위 목표'))).toBeNull(); // 숫자+한글 붙음
		expect(scheduleDayOf(li('2026 계획'))).toBeNull(); // 네자리 연도
		expect(scheduleDayOf(li('10월 정리'))).toBeNull();
		expect(scheduleDayOf(li('3줄 요약'))).toBeNull();
		expect(scheduleDayOf(li('-- 구분선 --'))).toBeNull();
		expect(scheduleDayOf(li('이번 주 할 일'))).toBeNull();
	});

	it('숫자 + 공백 + 글자 형태(파렌 마커 아님)도 null — 이전 버그의 핵심 케이스', () => {
		// 예전 정규식은 "숫자 다음 공백"을 일 번호로 오인해 이 줄들이 정렬에 끌려가
		// 이상한 위치로 이동했다. 이제는 모두 제자리 고정.
		expect(scheduleDayOf(li('1 단계 목표'))).toBeNull();
		expect(scheduleDayOf(li('7 월 정리'))).toBeNull();
		expect(scheduleDayOf(li('10 시 기상'))).toBeNull();
		expect(scheduleDayOf(li('30 분 운동'))).toBeNull();
		expect(scheduleDayOf(li('5 (오늘)'))).toBeNull(); // 숫자와 ( 사이 공백
		expect(scheduleDayOf(li('2 *중요*'))).toBeNull();
	});

	it('진짜 일정 줄(파렌 마커)은 일 번호를 뽑는다(대조군)', () => {
		expect(scheduleDayOf(li('3(금) 등산'))).toBe(3);
		expect(scheduleDayOf(li('25*(수) 가스점검'))).toBe(25);
	});

	it('sortListItemsByDay: 숫자로 시작하는 상단 메모는 고정, 날짜 항목만 정렬', () => {
		// 예전 버그: "1 단계 목표"가 day=1로 오인되어 맨 위로 끌려가고 "30 분 운동"이
		// day=30으로 맨 아래로 밀렸다. 이제 둘 다 제자리 고정.
		const out = sortListItemsByDay([
			li('1 단계 목표'),
			li('30 분 스트레칭'),
			li('20(토) 기존'),
			li('5(목) 기존2')
		]);
		expect(out.map(firstText)).toEqual([
			'1 단계 목표', // idx0 고정
			'30 분 스트레칭', // idx1 고정
			'5(목) 기존2', // 날짜 슬롯: 5
			'20(토) 기존' // 날짜 슬롯: 20
		]);
	});
});

describe('appendListItemToDocJson — 상단 날짜없는 텍스트 + 보내기 정렬', () => {
	it('상단 메모 블록은 위에 고정, 날짜 항목만 그 아래에서 정렬', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				para('6월'),
				bullet([
					li('이번 달 메모'),
					li('잊지 말 것'),
					li('20(토) 기존'),
					li('5(목) 기존2')
				])
			]
		};
		const out = appendListItemToDocJson(doc, li('9(월) 새것'), 6);
		// 메모 2줄은 상단 고정, 날짜는 [5,9,20] 정렬
		expect(liTexts(out.content?.[1])).toEqual([
			'이번 달 메모',
			'잊지 말 것',
			'5(목) 기존2',
			'9(월) 새것',
			'20(토) 기존'
		]);
	});

	it('여러 번 연속 보내기에도 상단 메모 고정 유지', () => {
		let doc: JSONContent = {
			type: 'doc',
			content: [para('6월'), bullet([li('헤더'), li('10(금) a')])]
		};
		doc = appendListItemToDocJson(doc, li('3(화) b'), 6);
		doc = appendListItemToDocJson(doc, li('25(토) c'), 6);
		doc = appendListItemToDocJson(doc, li('7(수) d'), 6);
		expect(liTexts(doc.content?.[1])).toEqual([
			'헤더',
			'3(화) b',
			'7(수) d',
			'10(금) a',
			'25(토) c'
		]);
	});
});

describe('applySourceSideEdits — 상단 메모 있는 월 섹션에 반복 복제본 삽입', () => {
	let currentEditor: Editor | null = null;
	const year = new Date().getFullYear();
	const WD = ['일', '월', '화', '수', '목', '금', '토'] as const;
	const wd = (y: number, m: number, d: number) => WD[new Date(y, m - 1, d).getDay()];

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
	function findLiPos(editor: Editor, match: string): number {
		let pos = -1;
		editor.state.doc.descendants((node, p) => {
			if (pos >= 0) return false;
			if (node.type.name !== 'listItem') return true;
			if ((node.firstChild?.textContent ?? '') === match) {
				pos = p;
				return false;
			}
			return true;
		});
		if (pos < 0) throw new Error(`listItem not found: ${match}`);
		return pos;
	}
	function monthTexts(editor: Editor, month: number): string[] {
		const list = findMonthBulletList(editor.state.doc, month);
		if (!list) return [];
		const out: string[] = [];
		list.node.forEach((child) => out.push(child.firstChild?.textContent ?? ''));
		return out;
	}
	function send(editor: Editor, match: string) {
		const pos = findLiPos(editor, match);
		const node = editor.state.doc.nodeAt(pos)!;
		const fp = JSON.stringify(node.toJSON());
		const parsed = parsePrefix(node.firstChild?.textContent ?? '');
		const spec = parsed ? recurrenceFromParse(parsed) : null;
		return applySourceSideEdits(editor, pos, fp, node.nodeSize, spec);
	}

	afterEach(() => {
		currentEditor?.destroy();
		currentEditor = null;
	});

	it('다음 달 섹션 상단에 메모가 있어도 복제본은 날짜 자리로, 메모는 고정', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				para('5월'),
				bullet([li('25*(수) 가스점검'), li('3(금) 등산')]),
				para('6월'),
				bullet([li('다음 달 준비물'), li('1(월) 친구'), li('30(화) 마감')])
			]
		});
		const outcome = send(editor, '25*(수) 가스점검');
		expect(outcome.status).toBe('recurred');
		expect(monthTexts(editor, 5)).toEqual(['3(금) 등산']);
		// 메모는 상단 고정, 25는 1과 30 사이
		expect(monthTexts(editor, 6)).toEqual([
			'다음 달 준비물',
			'1(월) 친구',
			`25*(${wd(year, 6, 25)}) 가스점검`,
			'30(화) 마감'
		]);
	});
});
