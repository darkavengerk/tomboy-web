import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import {
	TomboyFootnote,
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
	// 테스트 간 격리: mockTouch 가 심은 matchMedia 제거.
	(window as { matchMedia?: typeof window.matchMedia }).matchMedia = undefined;
	document
		.querySelectorAll('.tomboy-fn-preview')
		.forEach((el) => el.remove());
});

function mockTouch(isTouch: boolean): void {
	// jsdom 은 matchMedia 를 구현하지 않아 직접 심는다.
	window.matchMedia = ((q: string) => ({
		matches: isTouch,
		media: q,
		onchange: null,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
		dispatchEvent: () => false
	})) as typeof window.matchMedia;
}

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

describe('footnote plugin 모바일 미리보기', () => {
	it('참조 탭은 이동하지 않고 이동 버튼이 있는 미리보기를 띄운다', () => {
		mockTouch(true);
		const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
		const e = makeEditor([P('제목'), P('본문 [^7]'), P('[^7] 라벨7 설명')]);
		tapFootnote(e, 'sup.tomboy-fn-ref');
		// 탭만으로는 이동하지 않음.
		expect(scroll).not.toHaveBeenCalled();
		const el = document.querySelector('.tomboy-fn-preview');
		expect(el).not.toBeNull();
		expect(el!.textContent).toContain('라벨7 설명');
		// 이동 버튼 클릭 → 이동.
		(document.querySelector('.tomboy-fn-preview-jump') as HTMLButtonElement).click();
		expect(scroll).toHaveBeenCalled();
		scroll.mockRestore();
	});

	it('짝 없는 참조 탭은 안내 미리보기를 띄우고 onMissing 을 부르지 않는다', () => {
		mockTouch(true);
		const onMissing = vi.fn();
		const e = makeEditor([P('제목'), P('본문 [^7]')], onMissing);
		tapFootnote(e, 'sup.tomboy-fn-ref');
		const el = document.querySelector('.tomboy-fn-preview');
		expect(el).not.toBeNull();
		expect(el!.classList.contains('tomboy-fn-preview-missing')).toBe(true);
		expect(onMissing).not.toHaveBeenCalled();
	});

	it('설명 마커 탭은 모바일에서도 미리보기 없이 즉시 이동한다', () => {
		mockTouch(true);
		const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
		const e = makeEditor([P('제목'), P('본문 [^7]'), P('[^7] 설명')]);
		tapFootnote(e, '.tomboy-fn-def');
		expect(scroll).toHaveBeenCalled();
		expect(document.querySelector('.tomboy-fn-preview')).toBeNull();
		scroll.mockRestore();
	});
});
