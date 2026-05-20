import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import {
	TomboyFootnote,
	footnotePluginKey,
	findFootnoteMatches
} from '$lib/editor/footnote/index.js';

// jsdom 은 레이아웃을 구현하지 않아 scrollIntoView 가 없을 수 있다.
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});

function makeEditor(blocks: JSONContent[], onMissing = () => {}): Editor {
	currentEditor = new Editor({
		extensions: [StarterKit, TomboyFootnote.configure({ onMissing })],
		content: { type: 'doc', content: blocks }
	});
	return currentEditor;
}

function clickAt(e: Editor, pos: number): boolean {
	const handled = e.view.someProp('handleClick', (fn) =>
		fn(e.view, pos, new MouseEvent('click'))
	);
	return handled === true;
}

describe('footnote plugin decorations', () => {
	it('builds 3 decorations per [^N] match', () => {
		const e = makeEditor([P('제목'), P('가[^7] 나[^8]')]);
		const st = footnotePluginKey.getState(e.state)!;
		expect(st.matches).toHaveLength(2);
		expect(st.decorations.find()).toHaveLength(6);
	});

	it('produces no decorations when there are no footnotes', () => {
		const e = makeEditor([P('제목'), P('각주 없음')]);
		const st = footnotePluginKey.getState(e.state)!;
		expect(st.decorations.find()).toHaveLength(0);
	});

	it('recomputes decorations when the document changes', () => {
		const e = makeEditor([P('제목'), P('본문')]);
		expect(footnotePluginKey.getState(e.state)!.matches).toHaveLength(0);
		e.commands.insertContentAt(e.state.doc.content.size - 1, ' [^9]');
		const st = footnotePluginKey.getState(e.state)!;
		expect(st.matches).toHaveLength(1);
		expect(st.matches[0].label).toBe('9');
		expect(st.decorations.find()).toHaveLength(3);
	});
});

describe('footnote plugin click', () => {
	it('calls onMissing for a reference with no definition', () => {
		const onMissing = vi.fn();
		const e = makeEditor([P('제목'), P('본문 [^7]')], onMissing);
		const ref = findFootnoteMatches(e.state.doc)[0];
		expect(clickAt(e, ref.from + 2)).toBe(true);
		expect(onMissing).toHaveBeenCalledWith('7', 'reference');
	});

	it('calls onMissing for a definition marker with no reference', () => {
		const onMissing = vi.fn();
		const e = makeEditor([P('제목'), P('[^7] 설명만 있음')], onMissing);
		const def = findFootnoteMatches(e.state.doc)[0];
		expect(clickAt(e, def.from + 2)).toBe(true);
		expect(onMissing).toHaveBeenCalledWith('7', 'definition');
	});

	it('does not call onMissing when a partner exists', () => {
		const onMissing = vi.fn();
		const e = makeEditor(
			[P('제목'), P('본문 [^7]'), P('[^7] 설명')],
			onMissing
		);
		const ref = findFootnoteMatches(e.state.doc).find(
			(m) => !m.isDefinitionMarker
		)!;
		expect(clickAt(e, ref.from + 2)).toBe(true);
		expect(onMissing).not.toHaveBeenCalled();
	});

	it('returns false for a click outside any footnote', () => {
		const onMissing = vi.fn();
		const e = makeEditor([P('제목'), P('본문 [^7]')], onMissing);
		expect(clickAt(e, 1)).toBe(false);
		expect(onMissing).not.toHaveBeenCalled();
	});
});
