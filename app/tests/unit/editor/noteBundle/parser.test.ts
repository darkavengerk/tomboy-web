import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyInlineCheckbox } from '$lib/editor/inlineCheckbox';
import { TomboyInlineRadio } from '$lib/editor/inlineRadio';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import {
	parseNoteBundles,
	clampHeightPct,
	DEFAULT_HEIGHT_PCT,
	type BundleNode,
	type BundleEntry
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
const kwWith = (nodes: object[]) => ({ type: 'paragraph', content: nodes });
const cb = (checked = false) => ({ type: 'inlineCheckbox', attrs: { checked } });
const txt = (text: string, marks?: object[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const link = (t: string) => ({
	type: 'text',
	text: t,
	marks: [{ type: 'tomboyInternalLink', attrs: { target: t } }]
});
/** 단순 잎 항목: 선택적 라디오(파서가 무시함을 검증) + 단일 링크 */
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
/** 임의 inline 노드 항목(+ 선택적 중첩 리스트) */
const liNodes = (nodes: object[], nested?: object) => ({
	type: 'listItem',
	content: [{ type: 'paragraph', content: nodes }, ...(nested ? [nested] : [])]
});
const list = (...items: object[]) => ({ type: 'bulletList', content: items });
const doc = (...blocks: object[]) => ({ type: 'doc', content: blocks });

const leaf = (t: string): BundleNode => ({ label: t, link: t, children: [] });
const ent = (title: string, category: string | null = null): BundleEntry => ({ title, category });

// ── 'tab' (탭:) — 재귀 트리 ───────────────────────────────────────────────
describe('parseNoteBundles — 탭(tree)', () => {
	it('기본: 체크박스 + 탭:30 + 잎 리스트 → kind tab, tree 채움, entries 빈', () => {
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('탭:30', true), list(li('노트A'), li('노트B'), li('노트C')))
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(1);
		const b = bundles[0];
		expect(b.kind).toBe('tab');
		expect(b.checked).toBe(true);
		expect(b.heightPct).toBe(30);
		expect(b.listPos).not.toBeNull();
		expect(b.tree).toEqual([leaf('노트A'), leaf('노트B'), leaf('노트C')]);
		expect(b.entries).toEqual([]);
		expect(ed.state.doc.textBetween(b.digitsFrom, b.digitsTo)).toBe('30');
	});

	it('옛 표기 "노트 탭" 하위호환', () => {
		const ed = makeEditor(doc(titleLine('호스트'), kw('노트 탭:40', true), list(li('노트A'))));
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.kind).toBe('tab');
		expect(b.heightPct).toBe(40);
		expect(b.tree).toEqual([leaf('노트A')]);
	});

	it('라디오가 있어도 무시하고 링크만 잎으로', () => {
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('탭:', true), list(li('노트A', true), li('노트B', false)))
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.tree).toEqual([leaf('노트A'), leaf('노트B')]);
	});

	it('한 항목 안 여러 링크(쉼표/공백) 전부 형제 잎', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('탭:', true),
				list(liNodes([link('A'), txt(', '), link('B'), txt(' '), link('C')]), li('D'))
			)
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.tree).toEqual([leaf('A'), leaf('B'), leaf('C'), leaf('D')]);
	});

	it('인접 같은 target 텍스트 노드는 한 잎으로 병합', () => {
		const splitLink = [
			{ type: 'text', text: '노트', marks: [{ type: 'tomboyInternalLink', attrs: { target: '노트X' } }] },
			{ type: 'text', text: 'X', marks: [{ type: 'tomboyInternalLink', attrs: { target: '노트X' } }] }
		];
		const ed = makeEditor(doc(titleLine('호스트'), kw('탭:', true), list(liNodes(splitLink))));
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.tree).toEqual([leaf('노트X')]);
	});

	it('중첩 리스트: 부모 = 카테고리 노드(label=전체 타이틀, children=하위)', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('탭:', true),
				list(liNodes([txt('프로젝트')], list(li('하위1'), li('하위2'))), li('루트노트'))
			)
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.tree).toEqual([
			{ label: '프로젝트', link: null, children: [leaf('하위1'), leaf('하위2')] },
			leaf('루트노트')
		]);
	});

	it('링크 있는 부모: 자기 링크가 children 첫 잎 + label 은 전체 타이틀', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('탭:', true),
				list(liNodes([txt('영역 '), link('A')], list(li('자식'))))
			)
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.tree).toEqual([
			{ label: '영역 A', link: null, children: [leaf('A'), leaf('자식')] }
		]);
	});

	it('3단계 중첩 재귀', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('탭:', true),
				list(liNodes([txt('A')], list(liNodes([txt('B')], list(li('C'))))))
			)
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.tree).toEqual([
			{
				label: 'A',
				link: null,
				children: [{ label: 'B', link: null, children: [leaf('C')] }]
			}
		]);
	});

	it('키워드 변형: 탭(콜론만) → 기본 50, digits 빈 범위', () => {
		const ed = makeEditor(doc(titleLine('호스트'), kw('탭:'), list(li('노트A'))));
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.heightPct).toBe(DEFAULT_HEIGHT_PCT);
		expect(b.digitsFrom).toBe(b.digitsTo);
		expect(b.checked).toBe(false);
	});

	it('prefix 트리거: Done:[ ]탭:30', () => {
		const ed = makeEditor(
			doc(titleLine('호스트'), kwWith([txt('Done:'), cb(true), txt('탭:30')]), list(li('노트A')))
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(1);
		expect(bundles[0].kind).toBe('tab');
		expect(bundles[0].heightPct).toBe(30);
		expect(ed.state.doc.textBetween(bundles[0].digitsFrom, bundles[0].digitsTo)).toBe('30');
	});

	it('체크박스 2개 라인: 키워드 앞 체크박스 채택', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kwWith([cb(true), txt('Done:'), cb(false), txt('탭:')]),
				list(li('노트A'))
			)
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(1);
		expect(bundles[0].checked).toBe(false);
		expect(ed.state.doc.nodeAt(bundles[0].checkboxPos)?.type.name).toBe('inlineCheckbox');
	});

	it('링크 없는 항목 무시 + 리스트 없는 번들은 tree 빈 배열', () => {
		const plainLi = {
			type: 'listItem',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '그냥 텍스트' }] }]
		};
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('탭:'), list(plainLi, li('노트A')), kw('탭:70'))
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(2);
		expect(bundles[0].tree).toEqual([leaf('노트A')]);
		expect(bundles[1].tree).toEqual([]);
		expect(bundles[1].listPos).toBeNull();
		expect(bundles.map((b) => b.ordinal)).toEqual([0, 1]);
	});
});

// ── 'bundle' (묶음:) — 평탄 엔트리(서류함) ─────────────────────────────────
describe('parseNoteBundles — 묶음(entries)', () => {
	it('기본: 묶음:30 → kind bundle, entries 채움, tree 빈', () => {
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('묶음:30', true), list(li('노트A'), li('노트B')))
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.kind).toBe('bundle');
		expect(b.heightPct).toBe(30);
		expect(b.entries).toEqual([ent('노트A'), ent('노트B')]);
		expect(b.tree).toEqual([]);
	});

	it('옛 표기 "노트 묶음" 하위호환', () => {
		const ed = makeEditor(doc(titleLine('호스트'), kw('노트 묶음:40', true), list(li('노트A'))));
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.kind).toBe('bundle');
		expect(b.heightPct).toBe(40);
		expect(b.entries).toEqual([ent('노트A')]);
	});

	it('한 항목 안 여러 링크 전부 엔트리', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('묶음:', true),
				list(liNodes([link('A'), txt(', '), link('B')]), li('C'))
			)
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.entries).toEqual([ent('A'), ent('B'), ent('C')]);
	});

	it('중첩 리스트 = 카테고리 평탄화: 자식 엔트리에 부모 타이틀 category', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('묶음:', true),
				list(liNodes([txt('프로젝트')], list(li('하위1'), li('하위2'))), li('루트노트'))
			)
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.entries).toEqual([
			ent('하위1', '프로젝트'),
			ent('하위2', '프로젝트'),
			ent('루트노트')
		]);
	});

	it('링크 있는 부모: 자신은 부모 category 로, 자식은 부모 타이틀 category', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('묶음:', true),
				list(liNodes([txt('영역 '), link('A')], list(li('자식'))))
			)
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		// 부모 항목 A 는 자기 category(null), 자식은 부모 타이틀 '영역 A'
		expect(b.entries).toEqual([ent('A'), ent('자식', '영역 A')]);
	});
});

// ── kind 무관 / 미인식 ────────────────────────────────────────────────────
describe('parseNoteBundles — 미인식 / 제목 라인', () => {
	it('체크박스 없는 키워드 라인은 미인식 (탭/묶음 모두)', () => {
		const a = makeEditor(doc(titleLine('호스트'), titleLine('탭:50'), list(li('노트A'))));
		expect(parseNoteBundles(a.state.doc)).toHaveLength(0);
		const b = makeEditor(doc(titleLine('호스트'), titleLine('묶음:50'), list(li('노트A'))));
		expect(parseNoteBundles(b.state.doc)).toHaveLength(0);
	});

	it('제목 라인(index 0)은 번들 키워드로 취급하지 않음', () => {
		const a = makeEditor(doc(kw('탭:50'), list(li('노트A'))));
		expect(parseNoteBundles(a.state.doc)).toHaveLength(0);
		const b = makeEditor(doc(kw('묶음:50'), list(li('노트A'))));
		expect(parseNoteBundles(b.state.doc)).toHaveLength(0);
	});

	it('prefix 콜론 없으면 미인식', () => {
		const bad = makeEditor(
			doc(titleLine('호스트'), kwWith([txt('메모 '), cb(), txt('탭:')]), list(li('노트A')))
		);
		expect(parseNoteBundles(bad.state.doc)).toHaveLength(0);
	});

	it('탭/묶음 혼합 문서: 각자 kind 로 파싱', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('탭:50', true),
				list(li('T1')),
				kw('묶음:60', true),
				list(li('B1'))
			)
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(2);
		expect(bundles[0].kind).toBe('tab');
		expect(bundles[0].tree).toEqual([leaf('T1')]);
		expect(bundles[1].kind).toBe('bundle');
		expect(bundles[1].entries).toEqual([ent('B1')]);
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
