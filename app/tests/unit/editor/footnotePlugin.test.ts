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
	vi.useRealTimers();
	// 미리보기 팝오버는 document.body 에 붙으므로 잔해 제거.
	document.querySelectorAll('.tomboy-fn-preview').forEach((el) => el.remove());
	// matchMedia 목 해제 — 기본(데스크탑)은 jsdom 에 matchMedia 가 없는 상태.
	(window as Window & { matchMedia?: typeof window.matchMedia }).matchMedia =
		originalMatchMedia;
});

const originalMatchMedia = (
	window as Window & { matchMedia?: typeof window.matchMedia }
).matchMedia;

/** isTouchDevice() 판정을 강제 — makeEditor(플러그인 생성) 전에 호출해야 한다. */
function mockMatchMedia(matches: boolean): void {
	(window as Window & { matchMedia?: typeof window.matchMedia }).matchMedia = ((
		query: string
	) => ({
		matches,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false
	})) as unknown as typeof window.matchMedia;
}

/** 각주 요소에 mouseover / mouseout 이벤트를 디스패치한다. */
function dispatchMouse(
	e: Editor,
	selector: string,
	type: 'mouseover' | 'mouseout',
	relatedTarget: Element | null = null
): void {
	const el = e.view.dom.querySelector(selector);
	if (!el) throw new Error(`footnote element not found: ${selector}`);
	el.dispatchEvent(
		new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget })
	);
}

/**
 * 단락 빌더 — 문자열은 text 노드, `{ fn }` 객체는 footnoteMarker 노드.
 * 예: `P('본문 ', { fn: '7' }, ' 끝')`
 *   → paragraph[text('본문 '), footnoteMarker(label=7), text(' 끝')]
 * 빈 문자열은 무시되므로 마커로만 구성된 단락은 `P({ fn: '7' }, ' 정의')`.
 */
type Part = string | { fn: string };
const P = (...parts: Part[]): JSONContent => {
	const content: JSONContent[] = [];
	for (const p of parts) {
		if (typeof p === 'string') {
			if (p.length > 0) content.push({ type: 'text', text: p });
		} else {
			content.push({ type: 'footnoteMarker', attrs: { label: p.fn } });
		}
	}
	return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};

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
		const e = makeEditor([
			P('제목'),
			P('가', { fn: '7' }, ' 나', { fn: '8' })
		]);
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
		// 노드 기반 삽입 — text 가 아닌 footnoteMarker 노드 자체를 넣는다.
		e.commands.insertContentAt(e.state.doc.content.size - 1, [
			{ type: 'text', text: ' ' },
			{ type: 'footnoteMarker', attrs: { label: '9' } }
		]);
		const st = footnotePluginKey.getState(e.state)!;
		expect(st.matches).toHaveLength(1);
		expect(st.matches[0].label).toBe('9');
	});

	it('renders a reference label as a superscript', () => {
		const e = makeEditor([P('제목'), P('본문 ', { fn: '7' }, ' 끝')]);
		expect(e.view.dom.querySelector('sup.tomboy-fn-ref')).not.toBeNull();
		expect(e.view.dom.querySelector('.tomboy-fn-def')).toBeNull();
	});

	it('renders a definition marker label at normal size, not a superscript', () => {
		const e = makeEditor([P('제목'), P({ fn: '7' }, ' 설명 내용')]);
		expect(e.view.dom.querySelector('.tomboy-fn-def')).not.toBeNull();
		expect(e.view.dom.querySelector('sup.tomboy-fn-ref')).toBeNull();
	});
});

describe('footnote plugin tap (mousedown)', () => {
	it('calls onMissing for a reference with no definition', () => {
		const onMissing = vi.fn();
		const e = makeEditor([P('제목'), P('본문 ', { fn: '7' })], onMissing);
		tapFootnote(e, 'sup.tomboy-fn-ref');
		expect(onMissing).toHaveBeenCalledWith('7', 'reference');
	});

	it('calls onMissing for a definition marker with no reference', () => {
		const onMissing = vi.fn();
		const e = makeEditor([P('제목'), P({ fn: '7' }, ' 설명만 있음')], onMissing);
		tapFootnote(e, '.tomboy-fn-def');
		expect(onMissing).toHaveBeenCalledWith('7', 'definition');
	});

	it('does not call onMissing when a partner exists', () => {
		const onMissing = vi.fn();
		const e = makeEditor(
			[P('제목'), P('본문 ', { fn: '7' }), P({ fn: '7' }, ' 설명')],
			onMissing
		);
		tapFootnote(e, 'sup.tomboy-fn-ref');
		expect(onMissing).not.toHaveBeenCalled();
	});

	it('prevents the default on a footnote tap (no editor focus → no mobile keyboard)', () => {
		const e = makeEditor([
			P('제목'),
			P('본문 ', { fn: '7' }),
			P({ fn: '7' }, ' 설명')
		]);
		const event = tapFootnote(e, 'sup.tomboy-fn-ref');
		expect(event.defaultPrevented).toBe(true);
	});
});

describe('footnote 미리보기 — 모바일(탭)', () => {
	it('참조 탭 → 이동하지 않고 미리보기 + 이동 버튼 표시', () => {
		mockMatchMedia(true);
		const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
		const e = makeEditor([
			P('제목'),
			P('본문 ', { fn: '7' }),
			P({ fn: '7' }, ' 설명 내용')
		]);
		tapFootnote(e, 'sup.tomboy-fn-ref');
		const popover = document.querySelector('.tomboy-fn-preview');
		expect(popover).not.toBeNull();
		expect(popover!.textContent).toContain('설명 내용');
		expect(document.querySelector('.tomboy-fn-preview-jump')).not.toBeNull();
		// 탭만으로는 이동하지 않는다.
		expect(scroll).not.toHaveBeenCalled();
		scroll.mockRestore();
	});

	it('이동 버튼 탭 → scrollIntoView 호출 + 미리보기 닫힘', () => {
		mockMatchMedia(true);
		const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
		const e = makeEditor([
			P('제목'),
			P('본문 ', { fn: '7' }),
			P({ fn: '7' }, ' 설명 내용')
		]);
		tapFootnote(e, 'sup.tomboy-fn-ref');
		const btn = document.querySelector(
			'.tomboy-fn-preview-jump'
		) as HTMLButtonElement;
		btn.click();
		expect(scroll).toHaveBeenCalled();
		expect(document.querySelector('.tomboy-fn-preview')).toBeNull();
		scroll.mockRestore();
	});

	it('짝 없는 참조 탭 → 안내 문구 + 버튼 없음 + onMissing 미호출', () => {
		mockMatchMedia(true);
		const onMissing = vi.fn();
		const e = makeEditor([P('제목'), P('본문 ', { fn: '7' })], onMissing);
		tapFootnote(e, 'sup.tomboy-fn-ref');
		const popover = document.querySelector('.tomboy-fn-preview');
		expect(popover).not.toBeNull();
		expect(popover!.classList.contains('tomboy-fn-preview-missing')).toBe(true);
		expect(document.querySelector('.tomboy-fn-preview-jump')).toBeNull();
		expect(onMissing).not.toHaveBeenCalled();
	});

	it('설명 마커 탭은 모바일에서도 즉시 이동(미리보기 없음)', () => {
		mockMatchMedia(true);
		const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
		const e = makeEditor([
			P('제목'),
			P('본문 ', { fn: '7' }),
			P({ fn: '7' }, ' 설명')
		]);
		tapFootnote(e, '.tomboy-fn-def');
		expect(scroll).toHaveBeenCalled();
		expect(document.querySelector('.tomboy-fn-preview')).toBeNull();
		scroll.mockRestore();
	});
});

describe('footnote 미리보기 — 데스크탑(hover)', () => {
	it('참조 hover → 120ms 후 버튼 없는 미리보기 표시', () => {
		vi.useFakeTimers();
		mockMatchMedia(false);
		const e = makeEditor([
			P('제목'),
			P('본문 ', { fn: '7' }),
			P({ fn: '7' }, ' 설명 내용')
		]);
		dispatchMouse(e, 'sup.tomboy-fn-ref', 'mouseover');
		expect(document.querySelector('.tomboy-fn-preview')).toBeNull();
		vi.advanceTimersByTime(120);
		const popover = document.querySelector('.tomboy-fn-preview');
		expect(popover).not.toBeNull();
		expect(popover!.textContent).toContain('설명 내용');
		expect(popover!.classList.contains('tomboy-fn-preview-static')).toBe(true);
		expect(document.querySelector('.tomboy-fn-preview-jump')).toBeNull();
	});

	it('hover 후 mouseout(마커 밖) → 미리보기 닫힘', () => {
		vi.useFakeTimers();
		mockMatchMedia(false);
		const e = makeEditor([
			P('제목'),
			P('본문 ', { fn: '7' }),
			P({ fn: '7' }, ' 설명 내용')
		]);
		dispatchMouse(e, 'sup.tomboy-fn-ref', 'mouseover');
		vi.advanceTimersByTime(120);
		expect(document.querySelector('.tomboy-fn-preview')).not.toBeNull();
		dispatchMouse(e, 'sup.tomboy-fn-ref', 'mouseout', e.view.dom);
		expect(document.querySelector('.tomboy-fn-preview')).toBeNull();
	});

	it('데스크탑 참조 클릭은 미리보기 없이 즉시 이동', () => {
		mockMatchMedia(false);
		const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
		const e = makeEditor([
			P('제목'),
			P('본문 ', { fn: '7' }),
			P({ fn: '7' }, ' 설명')
		]);
		tapFootnote(e, 'sup.tomboy-fn-ref');
		expect(scroll).toHaveBeenCalled();
		expect(document.querySelector('.tomboy-fn-preview')).toBeNull();
		scroll.mockRestore();
	});
});
