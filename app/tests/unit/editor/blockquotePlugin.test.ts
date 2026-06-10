import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import {
	TomboyBlockquote,
	blockquotePluginKey
} from '$lib/editor/blockquote/index.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});

function makeEditor(blocks: JSONContent[]): Editor {
	currentEditor = new Editor({
		// blockquote: false 는 TomboyEditor.svelte 미러 — StarterKit 기본
		// Blockquote 의 `> ` input rule 이 타이핑을 가로채면 안 된다.
		extensions: [StarterKit.configure({ blockquote: false }), TomboyBlockquote],
		content: { type: 'doc', content: blocks }
	});
	return currentEditor;
}

describe('blockquote plugin decorations', () => {
	it('builds a node + marker decoration per quoted paragraph', () => {
		const e = makeEditor([P('제목'), P('> 인용')]);
		const set = blockquotePluginKey.getState(e.state)!;
		expect(set.find()).toHaveLength(2);
	});

	it('produces no decorations without a quoted paragraph', () => {
		const e = makeEditor([P('제목'), P('보통 단락')]);
		const set = blockquotePluginKey.getState(e.state)!;
		expect(set.find()).toHaveLength(0);
	});

	it('decorates each paragraph in a consecutive quote run', () => {
		const e = makeEditor([P('제목'), P('> 첫'), P('> 둘'), P('보통')]);
		const set = blockquotePluginKey.getState(e.state)!;
		expect(set.find()).toHaveLength(4);
	});

	it('recomputes decorations when the document changes', () => {
		const e = makeEditor([P('제목'), P('보통')]);
		expect(blockquotePluginKey.getState(e.state)!.find()).toHaveLength(0);
		e.commands.insertContentAt(5, '> ');
		expect(blockquotePluginKey.getState(e.state)!.find()).toHaveLength(2);
	});
});

/**
 * 입력 룰 경유 타이핑 시뮬레이션. insertContent 와 달리 실제 키 입력은
 * handleTextInput(= ProseMirror inputrules)을 먼저 거친다 — StarterKit
 * 기본 Blockquote 익스텐션의 `^\s*>\s$` 룰이 살아 있으면 여기서 '> ' 가
 * 가로채여 텍스트가 삭제되고 PM blockquote 노드로 감싸진다.
 */
function typeText(e: Editor, text: string): void {
	for (const ch of text) {
		const view = e.view;
		const { from, to } = view.state.selection;
		const handled = view.someProp('handleTextInput', (f) =>
			f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to))
		);
		if (!handled) {
			view.dispatch(view.state.tr.insertText(ch, from, to));
		}
	}
}

describe('직접 타이핑한 "> " (input rule 경유)', () => {
	it('"> " 가 리터럴 텍스트로 남고 인용 데코를 받는다', () => {
		const e = makeEditor([P('제목'), P('')]);
		// 두 번째(빈) 단락의 콘텐츠 시작 위치로 캐럿 이동
		const paraContentStart = e.state.doc.child(0).nodeSize + 1;
		e.commands.setTextSelection(paraContentStart);

		typeText(e, '> 인용문');

		// StarterKit Blockquote input rule 이 가로채면 안 된다 —
		// 텍스트는 그대로 남고 두 번째 자식은 여전히 paragraph 다.
		expect(e.state.doc.child(1).type.name).toBe('paragraph');
		expect(e.state.doc.child(1).textContent).toBe('> 인용문');
		expect(blockquotePluginKey.getState(e.state)!.find()).toHaveLength(2);
	});

	it('스키마에 blockquote 노드 자체가 없다 (아카이버 직렬화 불가 노드)', () => {
		const e = makeEditor([P('제목')]);
		expect(e.schema.nodes.blockquote).toBeUndefined();
	});
});
