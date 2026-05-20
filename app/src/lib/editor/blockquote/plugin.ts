/**
 * 인용 ProseMirror 플러그인 — 표시 전용.
 *
 * 인용 단락마다 <p> 에 .tomboy-quote 노드 데코를, 맨 앞 '> ' 2자에
 * 폭 0 마커 숨김 데코를 단다. 문서를 변형하지 않는다. 연속 인용의
 * 시각적 연결은 CSS 인접 형제 선택자가 처리한다.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

import { findQuotedParagraphs } from './blockquote.js';

export const blockquotePluginKey = new PluginKey<DecorationSet>(
	'tomboyBlockquote'
);

function buildDecorations(doc: PMNode): DecorationSet {
	const decos: Decoration[] = [];
	for (const q of findQuotedParagraphs(doc)) {
		decos.push(
			Decoration.node(q.paraPos, q.paraPos + q.paraNode.nodeSize, {
				class: 'tomboy-quote'
			})
		);
		decos.push(
			Decoration.inline(q.textStart, q.textStart + 2, {
				class: 'tomboy-quote-marker'
			})
		);
	}
	return DecorationSet.create(doc, decos);
}

export function createBlockquotePlugin(): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: blockquotePluginKey,
		state: {
			init(_, state) {
				return buildDecorations(state.doc);
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				return buildDecorations(newState.doc);
			}
		},
		props: {
			decorations(state) {
				return blockquotePluginKey.getState(state) ?? null;
			}
		}
	});
}
