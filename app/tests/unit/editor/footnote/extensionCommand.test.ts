import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import type { JSONContent } from '@tiptap/core';
import { get } from 'svelte/store';

import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';
import { toasts, _resetForTest } from '$lib/stores/toast.js';

let currentEditor: Editor | null = null;

beforeEach(() => {
	_resetForTest();
});
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

/**
 * 텍스트 안의 `[^N]` 토큰을 footnoteMarker 노드로 변환해서 paragraph content
 * 를 빌드한다. Task 6 부터 마커는 atomic 노드 — input rule (Task 7) 도입
 * 전까지는 JSONContent 단계에서 직접 노드를 박는다.
 */
const FOOTNOTE_TOKEN_RE = /\[\^([^\]\s]+)\]/g;
function p(text: string): JSONContent {
	if (!text) return { type: 'paragraph', content: [] };
	const content: JSONContent[] = [];
	let last = 0;
	FOOTNOTE_TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FOOTNOTE_TOKEN_RE.exec(text)) !== null) {
		if (m.index > last) {
			content.push({ type: 'text', text: text.slice(last, m.index) });
		}
		content.push({ type: 'footnoteMarker', attrs: { label: m[1] } });
		last = m.index + m[0].length;
	}
	if (content.length === 0) {
		return { type: 'paragraph', content: [{ type: 'text', text }] };
	}
	if (last < text.length) {
		content.push({ type: 'text', text: text.slice(last) });
	}
	return { type: 'paragraph', content };
}
function doc(...children: JSONContent[]): JSONContent {
	return { type: 'doc', content: children };
}

function makeEditor(d: JSONContent): Editor {
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
			...TomboyFootnote
		],
		content: d
	});
	currentEditor = editor;
	return editor;
}

function setCursorAt(editor: Editor, paraIndex: number, charOffset: number) {
	let absStart = 0;
	editor.state.doc.forEach((_n, offset, i) => {
		if (i === paraIndex) absStart = offset;
	});
	editor.view.dispatch(
		editor.state.tr.setSelection(
			TextSelection.near(editor.state.doc.resolve(absStart + 1 + charOffset))
		)
	);
}

describe('TomboyFootnote.commands.insertFootnote', () => {
	it('정상 경로 — 트랜잭션 dispatch, 본문 끝에 정의 단락', () => {
		const editor = makeEditor(doc(p('제목'), p('본문')));
		// charOffset 1 = '본' 뒤, '문' 앞 → 삽입 결과: '본[^1]문'
		setCursorAt(editor, 1, 1);

		const result = editor.commands.insertFootnote();
		expect(result).toBe(true);

		// footnoteMarker 노드의 textContent 는 label 만 ('1') 뱉으므로
		// `[^N]` 으로 풀어 비교한다.
		const paragraphs: string[] = [];
		editor.state.doc.forEach((n) => {
			let s = '';
			n.descendants((child) => {
				if (child.isText) s += child.text ?? '';
				else if (child.type.name === 'footnoteMarker') s += `[^${child.attrs.label}]`;
			});
			paragraphs.push(s);
		});
		expect(paragraphs).toEqual(['제목', '본[^1]문', '---', '[^1] ']);
	});

	it('in-title — false 반환 + 토스트', () => {
		const editor = makeEditor(doc(p('제목')));
		setCursorAt(editor, 0, 1);

		const result = editor.commands.insertFootnote();
		expect(result).toBe(false);
		const ts = get(toasts);
		expect(ts).toHaveLength(1);
		expect(ts[0].message).toBe('각주는 본문에서만 삽입할 수 있습니다');
		expect(ts[0].kind).toBe('error');
	});

	it('inside-existing-marker — false 반환 + 토스트', () => {
		const editor = makeEditor(doc(p('제목'), p('a [^1] b'), p('---'), p('[^1] 일')));
		// atomic 노드 시대: "마커 안" = pos === marker.from. 'a ' (2) 뒤가
		// 마커 자리. char offset 2.
		setCursorAt(editor, 1, 2);

		const result = editor.commands.insertFootnote();
		expect(result).toBe(false);
		const ts = get(toasts);
		expect(ts).toHaveLength(1);
		expect(ts[0].message).toBe('기존 각주 안에서는 삽입할 수 없습니다');
		expect(ts[0].kind).toBe('error');
	});
});
