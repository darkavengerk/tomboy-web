import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import {
	toggleCheckboxAt,
	insertChecklistBlock
} from '$lib/editor/checklist/commands.js';

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

/** 첫 listItem 의 절대 위치. */
function firstLiPos(editor: Editor): number {
	let pos = -1;
	editor.state.doc.descendants((node, p) => {
		if (pos >= 0) return false;
		if (node.type.name === 'listItem') {
			pos = p;
			return false;
		}
		return true;
	});
	return pos;
}

describe('toggleCheckboxAt', () => {
	it('flips checked from false to true and back', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				P('체크리스트:'),
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							attrs: { checked: false, tomboyTrailingNewline: true },
							content: [P('우유')]
						}
					]
				}
			]
		});
		const liPos = firstLiPos(e);
		expect(toggleCheckboxAt(e, liPos)).toBe(true);
		expect(e.state.doc.nodeAt(liPos)!.attrs.checked).toBe(true);
		expect(toggleCheckboxAt(e, liPos)).toBe(true);
		expect(e.state.doc.nodeAt(liPos)!.attrs.checked).toBe(false);
		// 토글이 다른 속성(tomboyTrailingNewline)을 보존해야 한다 — 라운드트립
		// 충실성 속성이라 누락되면 Dropbox 동기화 노트가 어긋난다.
		expect(e.state.doc.nodeAt(liPos)!.attrs.tomboyTrailingNewline).toBe(true);
	});

	it('returns false for a non-listItem position', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목')] });
		expect(toggleCheckboxAt(e, 0)).toBe(false);
	});
});

describe('insertChecklistBlock', () => {
	it('inserts 체크리스트: + empty bullet after the caret block', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), P('본문')] });
		const bodyStart = e.state.doc.child(0).nodeSize + 1;
		e.commands.setTextSelection(bodyStart + 1);
		insertChecklistBlock(e);
		expect(e.state.doc.childCount).toBe(4);
		expect(e.state.doc.child(2).textContent).toBe('체크리스트:');
		expect(e.state.doc.child(3).type.name).toBe('bulletList');
		expect(e.state.doc.child(3).firstChild!.textContent).toBe('');
	});

	it('replaces an empty non-title paragraph in place', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), P(''), P('')] });
		const targetStart = e.state.doc.child(0).nodeSize + 1;
		e.commands.setTextSelection(targetStart);
		insertChecklistBlock(e);
		expect(e.state.doc.childCount).toBe(4);
		expect(e.state.doc.child(1).textContent).toBe('체크리스트:');
		expect(e.state.doc.child(2).type.name).toBe('bulletList');
	});

	it('never replaces the title (index 0)', () => {
		const e = makeEditor({ type: 'doc', content: [P('')] });
		e.commands.setTextSelection(1);
		insertChecklistBlock(e);
		expect(e.state.doc.childCount).toBe(3);
		expect(e.state.doc.child(0).textContent).toBe('');
		expect(e.state.doc.child(1).textContent).toBe('체크리스트:');
		expect(e.state.doc.child(2).type.name).toBe('bulletList');
	});
});
