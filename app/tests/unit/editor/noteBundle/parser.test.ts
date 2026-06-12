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
const li = (t: string, radio: boolean | null) => ({
	type: 'listItem',
	content: [
		{
			type: 'paragraph',
			content: [
				...(radio === null ? [] : [{ type: 'inlineRadio', attrs: { selected: radio } }]),
				{
					type: 'text',
					text: t,
					marks: [{ type: 'tomboyInternalLink', attrs: { target: t } }]
				}
			]
		}
	]
});
const list = (...items: object[]) => ({ type: 'bulletList', content: items });
const doc = (...blocks: object[]) => ({ type: 'doc', content: blocks });

describe('parseNoteBundles', () => {
	it('기본 번들: 체크박스 + 노트 묶음:30 + 라디오/링크 리스트', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('노트 묶음:30', true),
				list(li('노트A', false), li('노트B', true), li('노트C', null))
			)
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(1);
		const b = bundles[0];
		expect(b.checked).toBe(true);
		expect(b.heightPct).toBe(30);
		expect(b.listPos).not.toBeNull();
		expect(b.entries.map((e) => e.title)).toEqual(['노트A', '노트B', '노트C']);
		expect(b.entries[0].selected).toBe(false);
		expect(b.entries[1].selected).toBe(true);
		expect(b.entries[2].radioPos).toBeNull();
		// digits 범위가 실제 "30" 텍스트를 가리킨다
		expect(ed.state.doc.textBetween(b.digitsFrom, b.digitsTo)).toBe('30');
	});

	it('키워드 변형: 노트묶음(붙임) + :N 생략 → 기본 50, digits 빈 범위', () => {
		const ed = makeEditor(doc(titleLine('호스트'), kw('노트묶음:'), list(li('노트A', null))));
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.heightPct).toBe(DEFAULT_HEIGHT_PCT);
		expect(b.digitsFrom).toBe(b.digitsTo);
		expect(b.checked).toBe(false);
	});

	it('체크박스 없는 키워드 라인은 미인식', () => {
		const ed = makeEditor(
			doc(titleLine('호스트'), titleLine('노트 묶음:50'), list(li('노트A', null)))
		);
		expect(parseNoteBundles(ed.state.doc)).toHaveLength(0);
	});

	it('제목 라인(index 0)은 번들 키워드로 취급하지 않음', () => {
		const ed = makeEditor(doc(kw('노트 묶음:50'), list(li('노트A', null))));
		expect(parseNoteBundles(ed.state.doc)).toHaveLength(0);
	});

	it('링크 마크 없는 항목 무시 + 리스트 없는 번들은 entries 빈 배열', () => {
		const plainLi = {
			type: 'listItem',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '그냥 텍스트' }] }]
		};
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('노트 묶음:'),
				list(plainLi, li('노트A', null)),
				kw('노트 묶음:70')
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
