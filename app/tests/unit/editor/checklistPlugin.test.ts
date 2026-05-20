import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyChecklist } from '$lib/editor/checklist/index.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(doc: JSONContent, onToggle = () => {}): Editor {
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
			TomboyChecklist.configure({ onToggle })
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
const LI = (text: string, checked = false): JSONContent => ({
	type: 'listItem',
	attrs: { checked },
	content: [P(text)]
});
const UL = (...items: JSONContent[]): JSONContent => ({
	type: 'bulletList',
	content: items
});

describe('TomboyChecklist plugin', () => {
	it('decorates checklist-region items with checkbox class + widget', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), UL(LI('우유'), LI('빵', true))]
		});
		const dom = e.view.dom;
		expect(dom.querySelectorAll('li.tomboy-checkbox-item')).toHaveLength(2);
		expect(dom.querySelectorAll('.tomboy-checkbox-box')).toHaveLength(2);
		expect(
			dom.querySelectorAll('li.tomboy-checkbox-item.is-checked')
		).toHaveLength(1);
		expect(
			dom.querySelectorAll('.tomboy-checkbox-box.is-checked')
		).toHaveLength(1);
	});

	it('does not decorate a list outside any checklist region', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('그냥 목록'), UL(LI('우유'))]
		});
		expect(
			e.view.dom.querySelectorAll('li.tomboy-checkbox-item')
		).toHaveLength(0);
		expect(e.view.dom.querySelectorAll('.tomboy-checkbox-box')).toHaveLength(
			0
		);
	});

	it('clicking a checkbox invokes onToggle with the listItem position', () => {
		const onToggle = vi.fn();
		const e = makeEditor(
			{
				type: 'doc',
				content: [P('제목'), P('체크리스트:'), UL(LI('우유'))]
			},
			onToggle
		);
		const box = e.view.dom.querySelector(
			'.tomboy-checkbox-box'
		) as HTMLElement;
		box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(onToggle).toHaveBeenCalledTimes(1);
		const liPos = onToggle.mock.calls[0][0] as number;
		const node = e.state.doc.nodeAt(liPos);
		expect(node?.type.name).toBe('listItem');
	});
});
