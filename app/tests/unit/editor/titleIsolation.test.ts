import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Extension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
	createTitleIsolationPlugin,
	titleIsolationPluginKey
} from '$lib/editor/titleIsolation/titleIsolationPlugin.js';

let editor: Editor | null = null;
let el: HTMLElement | null = null;
afterEach(() => { editor?.destroy(); editor = null; el?.remove(); el = null; });

function makeEditor(enabled: boolean, content = '<p>타이틀</p><p>본문 첫 줄</p>') {
	const ext = Extension.create({
		name: 'titleIsolationTest',
		addProseMirrorPlugins() {
			return [createTitleIsolationPlugin(() => enabled)];
		}
	});
	el = document.createElement('div');
	document.body.appendChild(el);
	return new Editor({
		element: el,
		extensions: [StarterKit, ext],
		content
	});
}

describe('titleIsolation', () => {
	it('첫 노드를 .tomboy-title-hidden 으로 숨긴다', () => {
		editor = makeEditor(true);
		const firstP = editor.view.dom.querySelector('p');
		expect(firstP?.classList.contains('tomboy-title-hidden')).toBe(true);
	});

	it('첫 노드로 들어간 커서를 둘째 블록 시작으로 클램프한다', () => {
		editor = makeEditor(true);
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1))
		);
		const first = editor.state.doc.firstChild!;
		expect(editor.state.selection.from).toBe(first.nodeSize + 1);
	});

	it('둘째 줄이 비어 있으면 본문(셋째 줄) 시작으로 클램프한다', () => {
		// 타이틀 + 빈 서브타이틀 줄 + 본문 — 빈 둘째 줄을 건너뛰고 셋째 줄로.
		editor = makeEditor(true, '<p>타이틀</p><p></p><p>본문</p>');
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1))
		);
		const doc = editor.state.doc;
		const expected = doc.child(0).nodeSize + doc.child(1).nodeSize + 1;
		expect(editor.state.selection.from).toBe(expected);
	});

	it('`::` 노트는 둘째 줄이 비어도 둘째 블록 시작으로 클램프한다', () => {
		// 자동화/데이터 노트의 둘째 줄은 실제 로그 슬롯이라 건너뛰지 않는다.
		editor = makeEditor(true, '<p>자동화::x</p><p></p><p>본문</p>');
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1))
		);
		const first = editor.state.doc.firstChild!;
		expect(editor.state.selection.from).toBe(first.nodeSize + 1);
	});

	it('비활성이면 클램프하지 않는다', () => {
		editor = makeEditor(false);
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1))
		);
		expect(editor.state.selection.from).toBe(1);
		const firstP = editor.view.dom.querySelector('p');
		expect(firstP?.classList.contains('tomboy-title-hidden')).toBe(false);
	});

	it('둘째 블록 맨 앞 Backspace 를 차단한다', () => {
		editor = makeEditor(true);
		const first = editor.state.doc.firstChild!;
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, first.nodeSize + 1))
		);
		const blocked = editor.view.someProp('handleKeyDown', (f) =>
			f(editor!.view, new KeyboardEvent('keydown', { key: 'Backspace' }))
		);
		expect(blocked).toBe(true);
	});

	it('본문 중간 Backspace 는 막지 않는다', () => {
		editor = makeEditor(true);
		const first = editor.state.doc.firstChild!;
		// 둘째 블록 안 1글자 뒤(맨 앞이 아님)
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, first.nodeSize + 2))
		);
		const blocked = editor.view.someProp('handleKeyDown', (f) =>
			f(editor!.view, new KeyboardEvent('keydown', { key: 'Backspace' }))
		);
		expect(blocked).toBeFalsy();
	});
});
