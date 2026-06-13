import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyInlineCheckbox } from '$lib/editor/inlineCheckbox';
import { TomboyInlineRadio } from '$lib/editor/inlineRadio';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import {
	parseNoteBundles,
	clampHeightPct,
	DEFAULT_HEIGHT_PCT
} from '$lib/editor/noteBundle/parser.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(content: object): Editor {
	currentEditor = new Editor({
		extensions: [
			StarterKit,
			...TomboyInlineCheckbox,
			...TomboyInlineRadio,
			TomboyInternalLink.configure({
				getTitles: () => [],
				getCurrentGuid: () => null,
				deferred: true // 자동 스캔 억제 — 파서 입력을 그대로 유지
			})
		],
		content
	});
	return currentEditor;
}

// --- JSON 빌더 ----------------------------------------------------------
const titleLine = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const kw = (text: string, checked = false) => ({
	type: 'paragraph',
	content: [{ type: 'inlineCheckbox', attrs: { checked } }, { type: 'text', text }]
});
/** prefix 텍스트(체크박스 앞) 포함 키워드 라인 빌더 */
const kwWith = (nodes: object[]) => ({ type: 'paragraph', content: nodes });
const cb = (checked = false) => ({ type: 'inlineCheckbox', attrs: { checked } });
const txt = (text: string, marks?: object[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const link = (t: string) => ({
	type: 'text',
	text: t,
	marks: [{ type: 'tomboyInternalLink', attrs: { target: t } }]
});
/** 단순 항목: 라디오 옵션(있으면 파서가 무시함을 검증) + 단일 링크 */
const li = (t: string, radio: boolean | null = null) => ({
	type: 'listItem',
	content: [
		{
			type: 'paragraph',
			content: [
				...(radio === null ? [] : [{ type: 'inlineRadio', attrs: { selected: radio } }]),
				link(t)
			]
		}
	]
});
/** 임의 inline 노드로 구성한 항목(+ 선택적 중첩 리스트) */
const liNodes = (nodes: object[], nested?: object) => ({
	type: 'listItem',
	content: [{ type: 'paragraph', content: nodes }, ...(nested ? [nested] : [])]
});
const list = (...items: object[]) => ({ type: 'bulletList', content: items });
const doc = (...blocks: object[]) => ({ type: 'doc', content: blocks });

describe('parseNoteBundles', () => {
	it('기본 번들: 체크박스 + 묶음:30 + 링크 리스트', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('묶음:30', true),
				list(li('노트A'), li('노트B'), li('노트C'))
			)
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(1);
		const b = bundles[0];
		expect(b.checked).toBe(true);
		expect(b.heightPct).toBe(30);
		expect(b.listPos).not.toBeNull();
		expect(b.entries.map((e) => e.title)).toEqual(['노트A', '노트B', '노트C']);
		expect(b.entries.every((e) => e.category === null)).toBe(true);
		// digits 범위가 실제 "30" 텍스트를 가리킨다
		expect(ed.state.doc.textBetween(b.digitsFrom, b.digitsTo)).toBe('30');
	});

	it('옛 표기 "노트 묶음" 하위호환', () => {
		const ed = makeEditor(doc(titleLine('호스트'), kw('노트 묶음:40', true), list(li('노트A'))));
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.checked).toBe(true);
		expect(b.heightPct).toBe(40);
		expect(b.entries.map((e) => e.title)).toEqual(['노트A']);
	});

	it('라디오가 있어도 무시하고 링크만 수집', () => {
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('묶음:', true), list(li('노트A', true), li('노트B', false)))
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.entries.map((e) => e.title)).toEqual(['노트A', '노트B']);
		// entries 에 radio/selected 필드 없음
		expect(b.entries[0]).toEqual({ title: '노트A', category: null });
	});

	it('한 항목 안 여러 링크(쉼표/공백 구분) 전부 수집', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('묶음:', true),
				list(liNodes([link('A'), txt(', '), link('B'), txt(' '), link('C')]), li('D'))
			)
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.entries.map((e) => e.title)).toEqual(['A', 'B', 'C', 'D']);
	});

	it('인접 같은 target 텍스트 노드는 한 링크로 병합', () => {
		// 같은 링크가 두 텍스트 노드로 쪼개진 경우(마크 분할) — 한 엔트리.
		const splitLink = [
			{ type: 'text', text: '노트', marks: [{ type: 'tomboyInternalLink', attrs: { target: '노트X' } }] },
			{ type: 'text', text: 'X', marks: [{ type: 'tomboyInternalLink', attrs: { target: '노트X' } }] }
		];
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('묶음:', true), list(liNodes(splitLink)))
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.entries.map((e) => e.title)).toEqual(['노트X']);
	});

	it('중첩 리스트: 부모 타이틀이 자식 카테고리', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('묶음:', true),
				list(
					liNodes([txt('프로젝트')], list(li('하위1'), li('하위2'))),
					li('루트노트')
				)
			)
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.entries).toEqual([
			{ title: '하위1', category: '프로젝트' },
			{ title: '하위2', category: '프로젝트' },
			{ title: '루트노트', category: null }
		]);
	});

	it('링크 있는 부모: 자신도 엔트리 + 자식 카테고리는 전체 타이틀(링크 포함)', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('묶음:', true),
				list(liNodes([txt('영역 '), link('A')], list(li('자식'))))
			)
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.entries).toEqual([
			{ title: 'A', category: null }, // 부모 자신의 링크 — 상위 카테고리(없음)
			{ title: '자식', category: '영역 A' } // 자식은 부모 전체 타이틀이 카테고리
		]);
	});

	it('키워드 변형: 묶음(콜론만) → 기본 50, digits 빈 범위', () => {
		const ed = makeEditor(doc(titleLine('호스트'), kw('묶음:'), list(li('노트A'))));
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.heightPct).toBe(DEFAULT_HEIGHT_PCT);
		expect(b.digitsFrom).toBe(b.digitsTo);
		expect(b.checked).toBe(false);
	});

	it('체크박스 없는 키워드 라인은 미인식', () => {
		const ed = makeEditor(
			doc(titleLine('호스트'), titleLine('묶음:50'), list(li('노트A')))
		);
		expect(parseNoteBundles(ed.state.doc)).toHaveLength(0);
	});

	it('제목 라인(index 0)은 번들 키워드로 취급하지 않음', () => {
		const ed = makeEditor(doc(kw('묶음:50'), list(li('노트A'))));
		expect(parseNoteBundles(ed.state.doc)).toHaveLength(0);
	});

	it('prefix 트리거: Done:[ ]묶음:30 — digits 오프셋 prefix 반영', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kwWith([txt('Done:'), cb(true), txt('묶음:30')]),
				list(li('노트A'))
			)
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(1);
		expect(bundles[0].checked).toBe(true);
		expect(bundles[0].heightPct).toBe(30);
		expect(ed.state.doc.textBetween(bundles[0].digitsFrom, bundles[0].digitsTo)).toBe('30');
	});

	it('prefix 다중 세그먼트 A:B: 인식, 콜론 없는 prefix 미인식', () => {
		const ok = makeEditor(
			doc(titleLine('호스트'), kwWith([txt('A:B:'), cb(), txt('묶음:')]), list(li('노트A')))
		);
		expect(parseNoteBundles(ok.state.doc)).toHaveLength(1);
		ok.destroy();
		const bad = makeEditor(
			doc(titleLine('호스트'), kwWith([txt('메모 '), cb(), txt('묶음:')]), list(li('노트A')))
		);
		expect(parseNoteBundles(bad.state.doc)).toHaveLength(0);
	});

	it('체크박스 2개 라인: 키워드 앞 체크박스 채택', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kwWith([cb(true), txt('Done:'), cb(false), txt('묶음:')]),
				list(li('노트A'))
			)
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(1);
		expect(bundles[0].checked).toBe(false); // 두 번째 체크박스
		// checkboxPos 가 두 번째 체크박스를 가리킴: 토글 시 그 노드가 inlineCheckbox 여야 함
		expect(ed.state.doc.nodeAt(bundles[0].checkboxPos)?.type.name).toBe('inlineCheckbox');
		expect(ed.state.doc.nodeAt(bundles[0].checkboxPos)?.attrs.checked).toBe(false);
	});

	it('marks 있는 prefix 도 인식', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kwWith([txt('Done:', [{ type: 'bold' }]), cb(), txt('묶음:')]),
				list(li('노트A'))
			)
		);
		expect(parseNoteBundles(ed.state.doc)).toHaveLength(1);
	});

	it('링크 마크 없는 항목 무시 + 리스트 없는 번들은 entries 빈 배열', () => {
		const plainLi = {
			type: 'listItem',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '그냥 텍스트' }] }]
		};
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('묶음:'),
				list(plainLi, li('노트A')),
				kw('묶음:70')
			)
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(2);
		expect(bundles[0].entries.map((e) => e.title)).toEqual(['노트A']);
		expect(bundles[1].entries).toEqual([]);
		expect(bundles[1].listPos).toBeNull();
		expect(bundles.map((b) => b.ordinal)).toEqual([0, 1]);
	});
});

describe('clampHeightPct', () => {
	it('20–90 클램프, NaN → 기본값', () => {
		expect(clampHeightPct(5)).toBe(20);
		expect(clampHeightPct(95)).toBe(90);
		expect(clampHeightPct(50)).toBe(50);
		expect(clampHeightPct(NaN)).toBe(DEFAULT_HEIGHT_PCT);
	});
});
