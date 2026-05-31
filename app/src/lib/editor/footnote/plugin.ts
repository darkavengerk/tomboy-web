/**
 * 각주 클릭/미리보기 플러그인.
 *
 * footnoteMarker 노드는 NodeView (node.ts) 가 .tomboy-fn-ref / .tomboy-fn-def
 * DOM 을 렌더한다. 이 플러그인은 마커 상호작용을 처리한다:
 *  - 설명 마커: 클릭/탭 → 짝(참조)으로 즉시 스크롤.
 *  - 참조 마커(데스크탑): hover → 설명 미리보기(버튼 없음), 클릭 → 이동.
 *  - 참조 마커(모바일): 탭 → 설명 미리보기 + "이동" 버튼(탭만으론 이동 안 함).
 *
 * mousedown 에서 가로채는 이유: 클릭으로 인한 PM 기본 selection 변경이
 * 모바일에서 키보드를 띄워 본문을 가리는 문제를 막기 위함.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner,
	getDefinitionPreviewText,
	type FootnoteMatch
} from './footnotes.js';
import { FootnotePreview } from './preview.js';

export interface FootnotePluginOptions {
	/** 짝(참조/설명)을 찾지 못했을 때. kind 는 클릭한 마커의 역할. */
	onMissing: (label: string, kind: 'reference' | 'definition') => void;
}

export interface FootnotePluginState {
	matches: FootnoteMatch[];
}

export const footnotePluginKey = new PluginKey<FootnotePluginState>('tomboyFootnote');

function scrollToMatch(view: EditorView, target: FootnoteMatch): void {
	// atomic 노드는 nodeSize=1 — target.from + 1 = 노드 직후. domAtPos 는
	// 그 위치 텍스트/요소를 반환. closest 로 단락/리스트 항목을 찾는다.
	const { node } = view.domAtPos(target.from + 1);
	const el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
	if (!el) return;
	const block = el.closest('p, li, h1, h2, h3, h4, h5, h6') ?? el;
	block.scrollIntoView({ behavior: 'smooth', block: 'center' });
	block.classList.add('tomboy-fn-flash');
	window.setTimeout(() => block.classList.remove('tomboy-fn-flash'), 1200);
}

/** 터치/호버 불가 환경(모바일)이면 true. matchMedia 미지원 시 데스크탑으로 폴백. */
function isTouchDevice(): boolean {
	try {
		return (
			typeof window !== 'undefined' &&
			typeof window.matchMedia === 'function' &&
			window.matchMedia('(hover: none), (pointer: coarse)').matches
		);
	} catch {
		return false;
	}
}

/** 각주 DOM 요소에 대응하는 매치를 찾는다(없으면 null). */
function footnoteHitFor(
	view: EditorView,
	matches: FootnoteMatch[],
	fnEl: HTMLElement
): FootnoteMatch | null {
	let pos: number | null = null;
	try {
		pos = view.posAtDOM(fnEl, 0);
	} catch {
		pos = null;
	}
	return pos != null ? findFootnoteAt(matches, pos) : null;
}

export function createFootnotePlugin(
	options: FootnotePluginOptions
): Plugin<FootnotePluginState> {
	const preview = new FootnotePreview();
	// 세션 중 기기 타입은 바뀌지 않으므로 한 번만 평가.
	const isTouch = isTouchDevice();
	let hoverTimer: number | null = null;
	const clearHoverTimer = () => {
		if (hoverTimer != null) {
			window.clearTimeout(hoverTimer);
			hoverTimer = null;
		}
	};

	// 짝으로 이동(없으면 onMissing). 데스크탑 클릭/설명 마커 공용.
	const jumpToPartner = (view: EditorView, hit: FootnoteMatch) => {
		preview.hide();
		const st = footnotePluginKey.getState(view.state);
		if (!st) return;
		const partner = findFootnotePartner(st.matches, hit);
		if (partner) {
			scrollToMatch(view, partner);
		} else {
			options.onMissing(
				hit.label,
				hit.isDefinitionMarker ? 'definition' : 'reference'
			);
		}
	};

	// 참조 마커의 설명 미리보기 표시(짝 없으면 안내 문구).
	const showRefPreview = (
		view: EditorView,
		anchorEl: HTMLElement,
		hit: FootnoteMatch,
		withJumpButton: boolean
	) => {
		const st = footnotePluginKey.getState(view.state);
		if (!st) return;
		const partner = findFootnotePartner(st.matches, hit);
		if (partner) {
			const text = getDefinitionPreviewText(view.state.doc, partner);
			preview.show(anchorEl, text, {
				withJumpButton,
				onJump: () => scrollToMatch(view, partner)
			});
		} else {
			preview.show(anchorEl, '설명을 찾을 수 없습니다', {
				withJumpButton,
				missing: true
			});
		}
	};

	return new Plugin<FootnotePluginState>({
		key: footnotePluginKey,
		state: {
			init(_, state) {
				return { matches: findFootnoteMatches(state.doc) };
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				return { matches: findFootnoteMatches(newState.doc) };
			}
		},
		view() {
			return {
				destroy() {
					clearHoverTimer();
					preview.hide();
				}
			};
		},
		props: {
			handleDOMEvents: {
				// 탭/클릭은 mousedown 단계에서 처리한다. preventDefault 로
				// 에디터 포커스/캐럿 이동을 막아(모바일 키보드 방지) true 반환.
				mousedown(view, event) {
					const target = event.target;
					const fnEl =
						target instanceof Element
							? target.closest('.tomboy-fn-ref, .tomboy-fn-def')
							: null;
					if (!(fnEl instanceof HTMLElement)) return false;
					event.preventDefault();
					const st = footnotePluginKey.getState(view.state);
					if (!st) return true;
					const hit = footnoteHitFor(view, st.matches, fnEl);
					if (!hit) return true;
					// 설명 마커: 양쪽 플랫폼 모두 즉시 이동.
					if (hit.isDefinitionMarker) {
						jumpToPartner(view, hit);
						return true;
					}
					// 참조 마커: 모바일은 미리보기 + 이동 버튼, 데스크탑은 즉시 이동.
					if (isTouch) {
						showRefPreview(view, fnEl, hit, true);
					} else {
						jumpToPartner(view, hit);
					}
					return true;
				},
				// 데스크탑 hover: 참조 마커 위에서 미리보기(버튼 없는 표시 전용).
				mouseover(view, event) {
					if (isTouch) return false;
					const target = event.target;
					const fnEl =
						target instanceof Element
							? target.closest('.tomboy-fn-ref')
							: null;
					if (!(fnEl instanceof HTMLElement)) return false;
					const st = footnotePluginKey.getState(view.state);
					if (!st) return false;
					const hit = footnoteHitFor(view, st.matches, fnEl);
					if (!hit || hit.isDefinitionMarker) return false;
					clearHoverTimer();
					hoverTimer = window.setTimeout(() => {
						hoverTimer = null;
						showRefPreview(view, fnEl, hit, false);
					}, 120);
					return false;
				},
				mouseout(view, event) {
					if (isTouch) return false;
					const target = event.target;
					const fnEl =
						target instanceof Element
							? target.closest('.tomboy-fn-ref')
							: null;
					if (!fnEl) return false;
					const related = event.relatedTarget;
					// 같은 마커 내부 이동이면 무시.
					if (related instanceof Node && fnEl.contains(related)) {
						return false;
					}
					clearHoverTimer();
					preview.hide();
					return false;
				}
			}
		}
	});
}
