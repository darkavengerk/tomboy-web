/**
 * 각주 ProseMirror 플러그인 — 표시 전용.
 *
 * 모든 [^N] 매치에 인라인 데코레이션을 단다([^ 와 ] 는 폭 0으로 접고,
 * 참조 라벨은 작은 위첨자, 설명 마커 라벨은 일반 크기로 표시).
 *
 * 각주 탭은 mousedown 에서 가로채 preventDefault 로 에디터 포커스를
 * 막은 뒤(모바일에서 키보드가 올라와 본문을 가리는 문제 방지) 곧바로
 * 짝(참조↔설명)으로 스크롤한다.
 * 문서를 변형하지 않는다.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

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
	decorations: DecorationSet;
}

export const footnotePluginKey = new PluginKey<FootnotePluginState>(
	'tomboyFootnote'
);

function buildDecorations(
	doc: PMNode,
	matches: FootnoteMatch[]
): DecorationSet {
	const decos: Decoration[] = [];
	for (const m of matches) {
		// 여는 [^ (2자) 숨김.
		decos.push(
			Decoration.inline(m.from, m.from + 2, { class: 'tomboy-fn-bracket' })
		);
		// 라벨: 참조는 작은 위첨자(<sup>), 설명 마커는 일반 크기(<span>).
		if (m.isDefinitionMarker) {
			decos.push(
				Decoration.inline(m.from + 2, m.to - 1, {
					class: 'tomboy-fn-def'
				})
			);
		} else {
			decos.push(
				Decoration.inline(m.from + 2, m.to - 1, {
					nodeName: 'sup',
					class: 'tomboy-fn-ref'
				})
			);
		}
		// 닫는 ] (1자) 숨김.
		decos.push(
			Decoration.inline(m.to - 1, m.to, { class: 'tomboy-fn-bracket' })
		);
	}
	return DecorationSet.create(doc, decos);
}

/** 대상 매치가 있는 블록으로 부드럽게 스크롤 + 약 1.2초 하이라이트. */
function scrollToMatch(view: EditorView, target: FootnoteMatch): void {
	const { node } = view.domAtPos(target.from + 2);
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
				const matches = findFootnoteMatches(state.doc);
				return {
					matches,
					decorations: buildDecorations(state.doc, matches)
				};
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				const matches = findFootnoteMatches(newState.doc);
				return {
					matches,
					decorations: buildDecorations(newState.doc, matches)
				};
			}
		},
		props: {
			decorations(state) {
				return footnotePluginKey.getState(state)?.decorations ?? null;
			},
			handleDOMEvents: {
				// 각주 탭은 mousedown 단계에서 처리한다. preventDefault 로
				// 에디터 포커스/캐럿 이동을 막아(모바일에서 키보드가 본문을
				// 가리는 문제 방지) 하고, true 를 반환해 PM 의 기본 클릭
				// 처리를 통째로 건너뛴 뒤 곧바로 짝으로 스크롤한다.
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
					const hit =
						pos != null ? findFootnoteAt(st.matches, pos) : null;
					if (hit) {
						const partner = findFootnotePartner(st.matches, hit);
						if (partner) {
							scrollToMatch(view, partner);
						} else {
							options.onMissing(
								hit.label,
								hit.isDefinitionMarker
									? 'definition'
									: 'reference'
							);
						}
					}
					return true;
				}
			}
		}
	});
}
