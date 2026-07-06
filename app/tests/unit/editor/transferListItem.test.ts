import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import {
	appendLiToLiveEditor,
	appendListItemToDocJson,
	applySourceSideEdits
} from '$lib/editor/sendListItem/transferListItem.js';
import {
	findMonthBulletList,
	parsePrefix,
	recurrenceFromParse
} from '$lib/editor/sendListItem/recurringCopy.js';

function para(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function li(text: string): JSONContent {
	return { type: 'listItem', content: [para(text)] };
}
function bullet(items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}

const WD = ['일', '월', '화', '수', '목', '금', '토'] as const;
function wd(year: number, month: number, day: number): string {
	return WD[new Date(year, month - 1, day).getDay()];
}
function liTexts(list: JSONContent | undefined): (string | undefined)[] {
	return (list?.content ?? []).map(
		(it) => (it.content?.[0]?.content?.[0] as { text?: string } | undefined)?.text
	);
}

describe('appendListItemToDocJson (마지막 섹션이 현재 월일 때만 추가)', () => {
	it('마지막 섹션이 현재 월이면 그 리스트에 정렬 삽입', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [para('6월'), bullet([li('3(금) a'), li('15(월) c')])]
		};
		const out = appendListItemToDocJson(doc, li('9(목) b'), 6);
		expect(liTexts(out.content?.[1])).toEqual(['3(금) a', '9(목) b', '15(월) c']);
	});

	it('마지막 섹션이 다른 월이면 거슬러 찾지 않고 끝에 현재 월 섹션을 새로 만든다', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [para('6월'), bullet([li('1(월) a'), li('2(화) b')])]
		};
		const out = appendListItemToDocJson(doc, li('5(화) x'), 7);
		// 6월 섹션 그대로
		expect(liTexts(out.content?.[1])).toEqual(['1(월) a', '2(화) b']);
		// 끝에 7월 헤더 + 리스트
		const n = out.content?.length ?? 0;
		expect((out.content?.[n - 2]?.content?.[0] as { text?: string })?.text).toBe('7월');
		expect(out.content?.[n - 1]?.type).toBe('bulletList');
		expect(liTexts(out.content?.[n - 1])).toEqual(['5(화) x']);
	});

	it('앞쪽에 (작년) 같은 월 섹션이 있어도 거기 넣지 않고 끝에 새로 만든다', () => {
		// 헤더에 연도가 없으므로 위로 거슬러 찾으면 작년 7월에 들어가는 버그가 난다.
		const doc: JSONContent = {
			type: 'doc',
			content: [
				para('7월'),
				bullet([li('1(화) 작년것')]),
				para('6월'),
				bullet([li('10(금) a')])
			]
		};
		const out = appendListItemToDocJson(doc, li('5(화) x'), 7);
		// 앞쪽 7월(작년)은 건드리지 않음
		expect(liTexts(out.content?.[1])).toEqual(['1(화) 작년것']);
		// 6월 그대로
		expect(liTexts(out.content?.[3])).toEqual(['10(금) a']);
		// 끝에 새 7월
		const n = out.content?.length ?? 0;
		expect((out.content?.[n - 2]?.content?.[0] as { text?: string })?.text).toBe('7월');
		expect(liTexts(out.content?.[n - 1])).toEqual(['5(화) x']);
	});

	it('월 헤더가 하나도 없으면 현재 월 섹션을 생성한다', () => {
		const doc: JSONContent = { type: 'doc', content: [para('빈 노트')] };
		const out = appendListItemToDocJson(doc, li('5(화) x'), 7);
		expect((out.content?.[1]?.content?.[0] as { text?: string })?.text).toBe('7월');
		expect(out.content?.[2]?.type).toBe('bulletList');
		expect(liTexts(out.content?.[2])).toEqual(['5(화) x']);
	});

	it('마지막 섹션 헤더가 현재 월인데 리스트가 없으면 헤더 뒤에 리스트를 넣는다', () => {
		const doc: JSONContent = { type: 'doc', content: [para('메모'), para('7월')] };
		const out = appendListItemToDocJson(doc, li('5(화) x'), 7);
		expect(out.content?.[2]?.type).toBe('bulletList');
		expect(liTexts(out.content?.[2])).toEqual(['5(화) x']);
	});

	it('날짜 없는 항목은 현재 월 리스트 안에서 제자리 고정', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [para('6월'), bullet([li('헤더 메모'), li('15(월) c')])]
		};
		const out = appendListItemToDocJson(doc, li('2(수) a'), 6);
		expect(liTexts(out.content?.[1])).toEqual(['헤더 메모', '2(수) a', '15(월) c']);
	});

	it('입력 doc을 변형하지 않는다', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [para('6월'), bullet([li('3(금) a')])]
		};
		const before = JSON.stringify(doc);
		appendListItemToDocJson(doc, li('1(수) b'), 6);
		expect(JSON.stringify(doc)).toBe(before);
	});
});

describe('appendLiToLiveEditor (라이브 에디터 — 마지막 섹션 기준)', () => {
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
	// 상단 → 하단 순서로 모든 `N월` 섹션과 그 바로 뒤 리스트 항목을 나열한다.
	function sections(editor: Editor): { month: number; items: string[] }[] {
		const out: { month: number; items: string[] }[] = [];
		let cur: { month: number; items: string[] } | null = null;
		editor.state.doc.forEach((child) => {
			const t =
				child.type.name === 'paragraph' || child.type.name === 'heading'
					? child.textContent
					: '';
			const m = /^\s*(\d{1,2})월\s*$/.exec(t);
			if (m) {
				cur = { month: parseInt(m[1], 10), items: [] };
				out.push(cur);
				return;
			}
			if (child.type.name === 'bulletList' && cur && cur.items.length === 0) {
				child.forEach((liNode) => cur!.items.push(liNode.firstChild?.textContent ?? ''));
			}
		});
		return out;
	}
	afterEach(() => {
		currentEditor?.destroy();
		currentEditor = null;
	});

	it('마지막 섹션이 현재 월이면 그 리스트에 정렬 삽입', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [para('6월'), bullet([li('3(금) a'), li('15(월) c')])]
		});
		const ok = appendLiToLiveEditor(editor, li('9(목) b'), 6);
		expect(ok).toBe(true);
		expect(sections(editor)).toEqual([{ month: 6, items: ['3(금) a', '9(목) b', '15(월) c'] }]);
	});

	it('마지막 섹션이 다른 월이면 끝에 현재 월 섹션을 새로 만든다', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [para('6월'), bullet([li('1(월) a')])]
		});
		const ok = appendLiToLiveEditor(editor, li('5(화) x'), 7);
		expect(ok).toBe(true);
		expect(sections(editor)).toEqual([
			{ month: 6, items: ['1(월) a'] },
			{ month: 7, items: ['5(화) x'] }
		]);
	});

	it('앞쪽에 (작년) 같은 월 섹션이 있어도 끝에 새로 만든다', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				para('7월'),
				bullet([li('1(화) 작년것')]),
				para('6월'),
				bullet([li('10(금) a')])
			]
		});
		const ok = appendLiToLiveEditor(editor, li('5(화) x'), 7);
		expect(ok).toBe(true);
		expect(sections(editor)).toEqual([
			{ month: 7, items: ['1(화) 작년것'] },
			{ month: 6, items: ['10(금) a'] },
			{ month: 7, items: ['5(화) x'] }
		]);
	});
});

describe('applySourceSideEdits (source editor recurrence + sort)', () => {
	let currentEditor: Editor | null = null;
	const year = new Date().getFullYear();

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

	it('monthly: 다음 달 섹션에 정렬된 위치로 삽입, 원본은 이번 달에서 삭제', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				para(`${5}월`),
				bullet([li('25*(수) 가스점검'), li('3(금) 등산')]),
				para('6월'),
				bullet([li('1(월) 친구'), li('30(화) 마감')])
			]
		});
		const outcome = send(editor, '25*(수) 가스점검');
		expect(outcome.status).toBe('recurred');
		// 5월: 원본 제거 → 등산만
		expect(monthTexts(editor, 5)).toEqual(['3(금) 등산']);
		// 6월: 25*가 1과 30 사이로 정렬되어 삽입
		expect(monthTexts(editor, 6)).toEqual([
			'1(월) 친구',
			`25*(${wd(year, 6, 25)}) 가스점검`,
			'30(화) 마감'
		]);
	});

	it('everyNWeeks 같은 달 유지: 원본 삭제 + 복제본 추가 후 같은 리스트 정렬', () => {
		// 15 + 14일 = 29일 (같은 5월). May는 31일까지 → 유효.
		const editor = makeEditor({
			type: 'doc',
			content: [
				para('5월'),
				bullet([li('1(수) a'), li('8(수) b'), li('15(수**) routine')])
			]
		});
		const outcome = send(editor, '15(수**) routine');
		expect(outcome.status).toBe('recurred');
		// 15 제거, 29 추가, 정렬 → [1, 8, 29], 마커 ** 보존
		expect(monthTexts(editor, 5)).toEqual([
			'1(수) a',
			'8(수) b',
			`29(${wd(year, 5, 29)}**) routine`
		]);
	});

	it('마커 없는 항목: 반복 없음, 원본만 삭제(sent)', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [para('5월'), bullet([li('3(금) 등산'), li('9(목) 빨래')])]
		});
		const outcome = send(editor, '3(금) 등산');
		expect(outcome.status).toBe('sent');
		expect(monthTexts(editor, 5)).toEqual(['9(목) 빨래']);
	});
});
