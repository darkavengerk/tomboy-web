import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyChecklist } from '$lib/editor/checklist/index.js';
import { TomboyListBox } from '$lib/editor/listBox/index.js';
import { toggleRadioAt } from '$lib/editor/listBox/commands.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(
	doc: JSONContent,
	onToggleRadio: (liPos: number) => void = () => {}
): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem,
			TomboyChecklist,
			TomboyListBox.configure({ onToggleRadio })
		],
		content: doc
	});
	currentEditor = editor;
	return editor;
}

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});
const LI = (text: string, attrs?: Record<string, unknown>): JSONContent => ({
	type: 'listItem',
	...(attrs ? { attrs } : {}),
	content: [P(text)]
});
const UL = (...items: JSONContent[]): JSONContent => ({
	type: 'bulletList',
	content: items
});

/** doc 의 i 번째 최상위 리스트에서 j 번째 li 의 절대 위치. */
function liPosAt(e: Editor, listIdx: number, itemIdx: number): number {
	let pos = 0;
	for (let i = 0; i < listIdx; i++) pos += e.state.doc.child(i).nodeSize;
	pos += 1; // 리스트 여는 토큰
	const list = e.state.doc.child(listIdx);
	for (let j = 0; j < itemIdx; j++) pos += list.child(j).nodeSize;
	return pos;
}

describe('listBox decoration plugin', () => {
	it('checkbox 항목에 클래스 + 위젯', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				UL(LI('우유', { boxKind: 'checkbox', checked: true }), LI('빵'))
			]
		});
		const dom = e.view.dom;
		expect(dom.querySelectorAll('li.tomboy-checkbox-item')).toHaveLength(1);
		expect(
			dom.querySelectorAll('li.tomboy-checkbox-item.is-checked')
		).toHaveLength(1);
		expect(dom.querySelectorAll('.tomboy-checkbox-box')).toHaveLength(1);
	});

	it('radio 항목에 클래스 + 위젯', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				UL(
					LI('밥', { boxKind: 'radio', checked: true }),
					LI('면', { boxKind: 'radio', checked: false })
				)
			]
		});
		const dom = e.view.dom;
		expect(dom.querySelectorAll('li.tomboy-radio-item')).toHaveLength(2);
		expect(
			dom.querySelectorAll('li.tomboy-radio-item.is-selected')
		).toHaveLength(1);
		expect(dom.querySelectorAll('.tomboy-radio-box')).toHaveLength(2);
		expect(dom.querySelectorAll('.tomboy-radio-box.is-selected')).toHaveLength(1);
	});

	it('체크리스트: 영역 항목엔 listBox 데코 미적용 (이중 위젯 없음)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				P('체크리스트:'),
				// 영역 안 li 에 boxKind 가 남아 있어도 위젯은 checklist 쪽 1개
				UL(LI('우유', { boxKind: 'checkbox', checked: false }))
			]
		});
		const dom = e.view.dom;
		expect(dom.querySelectorAll('.tomboy-checkbox-box')).toHaveLength(1);
	});

	it('radio 위젯 클릭 → onToggleRadio(liPos)', () => {
		const spy = vi.fn();
		const e = makeEditor(
			{
				type: 'doc',
				content: [P('제목'), UL(LI('밥', { boxKind: 'radio', checked: false }))]
			},
			spy
		);
		const btn = e.view.dom.querySelector(
			'.tomboy-radio-box'
		) as HTMLButtonElement;
		btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(spy).toHaveBeenCalledWith(liPosAt(e, 1, 0));
	});
});

describe('toggleRadioAt', () => {
	it('형제 상호배타 — 선택 시 다른 형제 해제', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				UL(
					LI('밥', { boxKind: 'radio', checked: true }),
					LI('면', { boxKind: 'radio', checked: false }),
					LI('빵', { boxKind: 'checkbox', checked: true })
				)
			]
		});
		expect(toggleRadioAt(e, liPosAt(e, 1, 1))).toBe(true);
		const list = e.state.doc.child(1);
		expect(list.child(0).attrs.checked).toBe(false);
		expect(list.child(1).attrs.checked).toBe(true);
		// checkbox 형제는 건드리지 않는다
		expect(list.child(2).attrs.checked).toBe(true);
	});

	it('선택된 항목 재토글 → 해제 (none-selected 허용)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), UL(LI('밥', { boxKind: 'radio', checked: true }))]
		});
		toggleRadioAt(e, liPosAt(e, 1, 0));
		expect(e.state.doc.child(1).child(0).attrs.checked).toBe(false);
	});

	it('중첩 리스트는 별도 그룹', () => {
		const nested = UL(LI('자식A', { boxKind: 'radio', checked: true }));
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							attrs: { boxKind: 'radio', checked: false },
							content: [P('부모'), nested]
						},
						LI('형제', { boxKind: 'radio', checked: true })
					]
				}
			]
		});
		// 부모 li 선택 → 같은 깊이의 '형제'만 해제, 중첩 '자식A' 는 유지
		toggleRadioAt(e, liPosAt(e, 1, 0));
		const list = e.state.doc.child(1);
		expect(list.child(0).attrs.checked).toBe(true);
		expect(list.child(1).attrs.checked).toBe(false);
		const childLi = list.child(0).child(1).child(0);
		expect(childLi.attrs.checked).toBe(true);
	});

	it('radio 가 아닌 위치는 false', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), UL(LI('빵', { boxKind: 'checkbox' }))]
		});
		expect(toggleRadioAt(e, liPosAt(e, 1, 0))).toBe(false);
	});
});
