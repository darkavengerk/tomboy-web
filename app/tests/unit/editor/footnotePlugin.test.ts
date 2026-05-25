import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import {
	FootnoteMarker,
	TomboyFootnoteExtension,
	footnotePluginKey
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
		extensions: [StarterKit, FootnoteMarker, TomboyFootnoteExtension.configure({ onMissing })],
		content: { type: 'doc', content: blocks }
	});
	return currentEditor;
}

/** 각주 요소에 실제 mousedown 이벤트를 디스패치한다(버블 → PM 리스너). */
function tapFootnote(e: Editor, selector: string): MouseEvent {
	const el = e.view.dom.querySelector(selector);
	if (!el) throw new Error(`footnote element not found: ${selector}`);
	const event = new MouseEvent('mousedown', {
		bubbles: true,
		cancelable: true
	});
	el.dispatchEvent(event);
	return event;
}

describe('footnote plugin state', () => {
	it('tracks matches across the document', () => {
		const e = makeEditor([P('제목'), P('가[^7] 나[^8]')]);
		const st = footnotePluginKey.getState(e.state)!;
		expect(st.matches).toHaveLength(2);
	});

	it('exposes no matches when there are no footnotes', () => {
		const e = makeEditor([P('제목'), P('각주 없음')]);
		const st = footnotePluginKey.getState(e.state)!;
		expect(st.matches).toHaveLength(0);
	});

	it('recomputes matches when the document changes', () => {
		const e = makeEditor([P('제목'), P('본문')]);
		expect(footnotePluginKey.getState(e.state)!.matches).toHaveLength(0);
		e.commands.insertContentAt(e.state.doc.content.size - 1, ' [^9]');
		const st = footnotePluginKey.getState(e.state)!;
		expect(st.matches).toHaveLength(1);
		expect(st.matches[0].label).toBe('9');
	});

	it('renders a reference label as a superscript', () => {
		const e = makeEditor([P('제목'), P('본문 [^7] 끝')]);
		expect(e.view.dom.querySelector('sup.tomboy-fn-ref')).not.toBeNull();
		expect(e.view.dom.querySelector('.tomboy-fn-def')).toBeNull();
	});

	it('renders a definition marker label at normal size, not a superscript', () => {
		const e = makeEditor([P('제목'), P('[^7] 설명 내용')]);
		expect(e.view.dom.querySelector('.tomboy-fn-def')).not.toBeNull();
		expect(e.view.dom.querySelector('sup.tomboy-fn-ref')).toBeNull();
	});
});

describe('footnote plugin tap (mousedown)', () => {
	it('calls onMissing for a reference with no definition', () => {
		const onMissing = vi.fn();
		const e = makeEditor([P('제목'), P('본문 [^7]')], onMissing);
		tapFootnote(e, 'sup.tomboy-fn-ref');
		expect(onMissing).toHaveBeenCalledWith('7', 'reference');
	});

	it('calls onMissing for a definition marker with no reference', () => {
		const onMissing = vi.fn();
		const e = makeEditor([P('제목'), P('[^7] 설명만 있음')], onMissing);
		tapFootnote(e, '.tomboy-fn-def');
		expect(onMissing).toHaveBeenCalledWith('7', 'definition');
	});

	it('does not call onMissing when a partner exists', () => {
		const onMissing = vi.fn();
		const e = makeEditor(
			[P('제목'), P('본문 [^7]'), P('[^7] 설명')],
			onMissing
		);
		tapFootnote(e, 'sup.tomboy-fn-ref');
		expect(onMissing).not.toHaveBeenCalled();
	});

	it('prevents the default on a footnote tap (no editor focus → no mobile keyboard)', () => {
		const e = makeEditor([P('제목'), P('본문 [^7]'), P('[^7] 설명')]);
		const event = tapFootnote(e, 'sup.tomboy-fn-ref');
		expect(event.defaultPrevented).toBe(true);
	});
});
