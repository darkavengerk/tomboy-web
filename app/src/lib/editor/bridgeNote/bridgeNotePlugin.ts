import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isBridgeTitle } from '$lib/bridgeStatus/parseBridgeNote.js';
import { runBridgeButtonClick } from './runBridgeButtonClick.js';

export const bridgeNotePluginKey = new PluginKey<DecorationSet>('tomboyBridgeNote');

function renderButton(view: EditorView): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'tomboy-bridge-run';
	btn.contentEditable = 'false';
	btn.textContent = '⟳ 갱신';
	btn.addEventListener('click', async (e) => {
		e.preventDefault();
		if (btn.disabled) return;
		btn.disabled = true;
		const orig = btn.textContent;
		btn.textContent = '⟳ 갱신 중…';
		try {
			await runBridgeButtonClick(view);
		} finally {
			btn.disabled = false;
			btn.textContent = orig;
		}
	});
	return btn;
}

function buildDecorations(doc: PMNode): DecorationSet {
	const first = doc.firstChild;
	if (!first || !isBridgeTitle(first.textContent)) return DecorationSet.empty;
	// 제목 바로 뒤(제목 안이 아님 — titleIsolation 이 제목을 display:none 처리).
	const afterTitlePos = first.nodeSize;
	const widget = Decoration.widget(afterTitlePos, (view) => renderButton(view), {
		side: 1,
		key: 'bridge-run'
	});
	return DecorationSet.create(doc, [widget]);
}

export function createBridgeNotePlugin(): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: bridgeNotePluginKey,
		state: {
			init(_, { doc }): DecorationSet {
				return buildDecorations(doc);
			},
			apply(tr, old): DecorationSet {
				return tr.docChanged ? buildDecorations(tr.doc) : old.map(tr.mapping, tr.doc);
			}
		},
		props: {
			decorations(state): DecorationSet | undefined {
				return bridgeNotePluginKey.getState(state);
			}
		}
	});
}
