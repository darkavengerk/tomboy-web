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
		extensions: [StarterKit, TomboyBlockquote],
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
