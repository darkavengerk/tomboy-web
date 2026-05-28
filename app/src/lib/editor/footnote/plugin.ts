/**
 * 각주 클릭 핸들러 플러그인.
 *
 * footnoteMarker 노드는 NodeView (node.ts) 가 .tomboy-fn-ref / .tomboy-fn-def
 * DOM 을 렌더한다. 이 플러그인은 클릭 시 짝(ref↔def) 으로 부드럽게 스크롤만 한다.
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
	type FootnoteMatch
} from './footnotes.js';

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

export function createFootnotePlugin(
	options: FootnotePluginOptions
): Plugin<FootnotePluginState> {
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
		props: {
			handleDOMEvents: {
				mousedown(view, event) {
					const target = event.target;
					const fnEl =
						target instanceof Element
							? target.closest('.tomboy-fn-ref, .tomboy-fn-def')
							: null;
					if (!fnEl) return false;
					event.preventDefault();
					const st = footnotePluginKey.getState(view.state);
					if (!st) return true;
					let pos: number | null = null;
					try {
						pos = view.posAtDOM(fnEl, 0);
					} catch {
						pos = null;
					}
					const hit = pos != null ? findFootnoteAt(st.matches, pos) : null;
					if (hit) {
						const partner = findFootnotePartner(st.matches, hit);
						if (partner) scrollToMatch(view, partner);
						else
							options.onMissing(
								hit.label,
								hit.isDefinitionMarker ? 'definition' : 'reference'
							);
					}
					return true;
				}
			}
		}
	});
}
