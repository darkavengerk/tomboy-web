import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';

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
			TomboyListItem
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

function docWith(li: JSONContent): JSONContent {
	return {
		type: 'doc',
		content: [P('제목'), { type: 'bulletList', content: [li] }]
	};
}

/** 주어진 텍스트 끝으로 커서 이동. */
function caretAfter(e: Editor, text: string): void {
	let pos = 0;
	e.state.doc.descendants((node, p) => {
		if (node.isText && node.text === text) pos = p + node.nodeSize;
	});
	e.commands.setTextSelection(pos);
}

describe('boxKind split inheritance', () => {
	it('checkbox 항목 분할 → 새 항목 boxKind 상속, checked 리셋', () => {
		const e = makeEditor(
			docWith({
				type: 'listItem',
				attrs: { boxKind: 'checkbox', checked: true },
				content: [P('우유')]
			})
		);
		caretAfter(e, '우유');
		e.commands.splitListItem('listItem');
		const list = e.state.doc.child(1);
		expect(list.childCount).toBe(2);
		expect(list.child(0).attrs.boxKind).toBe('checkbox');
		expect(list.child(0).attrs.checked).toBe(true);
		expect(list.child(1).attrs.boxKind).toBe('checkbox');
		expect(list.child(1).attrs.checked).toBe(false);
	});

	it('radio 항목 분할 → 새 항목 radio, 미선택', () => {
		const e = makeEditor(
			docWith({
				type: 'listItem',
				attrs: { boxKind: 'radio', checked: true },
				content: [P('밥')]
			})
		);
		caretAfter(e, '밥');
		e.commands.splitListItem('listItem');
		const list = e.state.doc.child(1);
		expect(list.child(1).attrs.boxKind).toBe('radio');
		expect(list.child(1).attrs.checked).toBe(false);
	});

	it('일반 항목 분할은 boxKind null 유지', () => {
		const e = makeEditor(docWith({ type: 'listItem', content: [P('빵')] }));
		caretAfter(e, '빵');
		e.commands.splitListItem('listItem');
		const list = e.state.doc.child(1);
		expect(list.child(1).attrs.boxKind).toBeNull();
	});
});
