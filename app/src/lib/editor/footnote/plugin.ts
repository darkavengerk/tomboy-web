/**
 * 각주 ProseMirror 플러그인 — 표시 전용.
 *
 * 모든 [^N] 매치에 인라인 데코레이션을 단다([^ 와 ] 는 폭 0으로 접고
 * 가운데 라벨은 <sup> 로 감싼다). 클릭하면 짝(참조↔설명)으로 스크롤한다.
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
		// 라벨 → <sup class="tomboy-fn-ref">.
		decos.push(
			Decoration.inline(m.from + 2, m.to - 1, {
				nodeName: 'sup',
				class: 'tomboy-fn-ref'
			})
		);
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
			handleClick(view, pos) {
				const st = footnotePluginKey.getState(view.state);
				if (!st) return false;
				const hit = findFootnoteAt(st.matches, pos);
				if (!hit) return false;
				const partner = findFootnotePartner(st.matches, hit);
				if (!partner) {
					options.onMissing(
						hit.label,
						hit.isDefinitionMarker ? 'definition' : 'reference'
					);
					return true;
				}
				scrollToMatch(view, partner);
				return true;
			}
		}
	});
}
