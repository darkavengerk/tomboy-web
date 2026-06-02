import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';
import {
	createFootnoteClaudePlugin,
	footnoteClaudeKey,
	markActive,
	markIdle,
	setFootnoteStep
} from '$lib/editor/footnote/claudePlugin.js';

let editor: Editor | null = null;
afterEach(() => {
	editor?.destroy();
	editor = null;
});

function makeEditor(content: unknown, fill: (...a: unknown[]) => void): Editor {
	const e = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem,
			...TomboyFootnote,
			Extension.create({
				name: 'tomboyFootnoteClaudeTest',
				addProseMirrorPlugins() {
					return [createFootnoteClaudePlugin({ fill: fill as never })];
				}
			})
		],
		content: content as never
	});
	editor = e;
	return e;
}

function docPreTrigger() {
	return {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
			{
				type: 'paragraph',
				content: [
					{ type: 'text', text: '본문 ' },
					{ type: 'footnoteMarker', attrs: { label: '1' } }
				]
			},
			{
				type: 'paragraph',
				content: [
					{ type: 'footnoteMarker', attrs: { label: '1' } },
					{ type: 'text', text: '설명해줘 @claude' }
				]
			}
		]
	};
}

function typeSpaceAtDefEnd(e: Editor) {
	const doc = e.state.doc;
	let insertAt = -1;
	doc.descendants((node, pos) => {
		if (node.type.name === 'footnoteMarker') {
			const $a = doc.resolve(pos + 1);
			if ($a.index(0) === 2) insertAt = $a.end();
		}
		return true;
	});
	e.view.dispatch(e.state.tr.insertText(' ', insertAt));
}

describe('createFootnoteClaudePlugin — 트리거', () => {
	it('@claude 끝공백 입력 시 fill 1회 호출', () => {
		const fill = vi.fn();
		const e = makeEditor(docPreTrigger(), fill);
		typeSpaceAtDefEnd(e);
		expect(fill).toHaveBeenCalledTimes(1);
		expect(fill.mock.calls[0][1]).toBe('1');
		expect(fill.mock.calls[0][2]).toBe('설명해줘');
	});

	it('이미 active면 재호출 안 함', () => {
		const fill = vi.fn();
		const e = makeEditor(docPreTrigger(), fill);
		markActive(e.view, '1');
		typeSpaceAtDefEnd(e);
		expect(fill).not.toHaveBeenCalled();
	});

	it('복원 텍스트(@claude, 끝공백 없음)는 트리거 아님', () => {
		const fill = vi.fn();
		const e = makeEditor(docPreTrigger(), fill);
		e.view.dispatch(e.state.tr.insertText('x', 1));
		expect(fill).not.toHaveBeenCalled();
	});
});

describe('잠금/스텝 메타', () => {
	it('markActive/markIdle 로 active 집합 갱신', () => {
		const e = makeEditor(docPreTrigger(), vi.fn());
		markActive(e.view, '1');
		expect(footnoteClaudeKey.getState(e.state)!.active).toContain('1');
		markIdle(e.view, '1');
		expect(footnoteClaudeKey.getState(e.state)!.active).not.toContain('1');
	});

	it('setFootnoteStep 가 step/stepLabel 갱신 + 위젯 데코 생성', () => {
		const e = makeEditor(docPreTrigger(), vi.fn());
		setFootnoteStep(e.view, '1', {
			kind: 'thinking',
			label: '생각 중',
			body: ''
		});
		const st = footnoteClaudeKey.getState(e.state)!;
		expect(st.stepLabel).toBe('1');
		expect(st.step?.label).toBe('생각 중');
		expect(e.view.dom.querySelector('.thinking-display')).not.toBeNull();
	});
});
