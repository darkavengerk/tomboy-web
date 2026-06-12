import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyInlineRadio } from '$lib/editor/inlineRadio';
import { TomboyInlineCheckbox } from '$lib/editor/inlineCheckbox';
import { TomboyListBox } from '$lib/editor/listBox/index.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(doc: JSONContent): Editor {
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
			...TomboyInlineCheckbox,
			...TomboyInlineRadio,
			TomboyListBox
		],
		content: doc
	});
	currentEditor = editor;
	return editor;
}

function typeText(editor: Editor, text: string) {
	for (const ch of text) {
		const { from, to } = editor.state.selection;
		const handled = editor.view.someProp('handleTextInput', (f: any) =>
			f(editor.view, from, to, ch)
		);
		if (!handled) {
			editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
		}
	}
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

/** 주어진 텍스트를 가진 텍스트 노드 시작 위치로 커서 이동. */
function caretAtItemStart(e: Editor, text: string): void {
	let pos = 0;
	e.state.doc.descendants((node, p) => {
		if (node.isText && node.text === text) pos = p;
	});
	e.commands.setTextSelection(pos);
}

function firstLi(e: Editor) {
	return e.state.doc.child(1).child(0);
}

describe('listBox input rules', () => {
	it('[[ ]] at li start → boxKind checkbox, 텍스트 삭제', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), UL(LI('우유'))] });
		caretAtItemStart(e, '우유');
		typeText(e, '[[ ]]');
		const li = firstLi(e);
		expect(li.attrs.boxKind).toBe('checkbox');
		expect(li.attrs.checked).toBe(false);
		expect(li.textContent).toBe('우유');
	});

	it('[[x]] → checked checkbox', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), UL(LI('우유'))] });
		caretAtItemStart(e, '우유');
		typeText(e, '[[x]]');
		expect(firstLi(e).attrs.boxKind).toBe('checkbox');
		expect(firstLi(e).attrs.checked).toBe(true);
	});

	it('(( )) → radio, ((o)) → selected radio', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), UL(LI('밥'), LI('면'))]
		});
		caretAtItemStart(e, '밥');
		typeText(e, '(( ))');
		caretAtItemStart(e, '면');
		typeText(e, '((o))');
		const list = e.state.doc.child(1);
		expect(list.child(0).attrs.boxKind).toBe('radio');
		expect(list.child(0).attrs.checked).toBe(false);
		expect(list.child(1).attrs.boxKind).toBe('radio');
		expect(list.child(1).attrs.checked).toBe(true);
		// 인라인 라디오 atom 으로 새지 않았는지
		let radios = 0;
		e.state.doc.descendants((n) => {
			if (n.type.name === 'inlineRadio') radios++;
		});
		expect(radios).toBe(0);
	});

	it('일반 문단에서는 무반응', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), P('본문')] });
		let pos = 0;
		e.state.doc.descendants((node, p) => {
			if (node.isText && node.text === '본문') pos = p;
		});
		e.commands.setTextSelection(pos);
		typeText(e, '[[ ]]');
		expect(e.state.doc.child(1).textContent).toBe('[[ ]]본문');
	});

	it('체크리스트: 영역 안에서는 무반응', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), UL(LI('우유'))]
		});
		caretAtItemStart(e, '우유');
		typeText(e, '(( ))');
		const li = e.state.doc.child(2).child(0);
		expect(li.attrs.boxKind).toBeNull();
		expect(li.textContent).toBe('(( ))우유');
	});

	it('li 중간에서는 무반응', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), UL(LI('우유'))] });
		let pos = 0;
		e.state.doc.descendants((node, p) => {
			if (node.isText && node.text === '우유') pos = p + node.nodeSize;
		});
		e.commands.setTextSelection(pos);
		typeText(e, '[[ ]]');
		expect(firstLi(e).attrs.boxKind).toBeNull();
	});
});

describe('listBox Backspace 해제', () => {
	it('내용 맨 앞 Backspace → 일반 불릿 복원', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				UL(LI('우유', { boxKind: 'checkbox', checked: true }))
			]
		});
		caretAtItemStart(e, '우유');
		const handled = e.commands.keyboardShortcut('Backspace');
		expect(handled).toBe(true);
		const li = firstLi(e);
		expect(li.attrs.boxKind).toBeNull();
		expect(li.attrs.checked).toBe(false);
		expect(li.textContent).toBe('우유'); // 텍스트는 안 지워짐
	});

	it('boxKind 없는 항목에서는 기본 동작으로 폴스루', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), UL(LI('우유'))] });
		caretAtItemStart(e, '우유');
		// listBox 핸들러는 boxKind 없으면 false 반환 → 기본 Backspace(리스트 해제)
		// 실행 후 bulletList 가 사라지고 문단만 남는다.
		e.commands.keyboardShortcut('Backspace');
		// 기본 동작이 발화했으면 child(1) 이 bulletList 가 아닌 paragraph 이다.
		expect(e.state.doc.child(1).type.name).toBe('paragraph');
	});
});
