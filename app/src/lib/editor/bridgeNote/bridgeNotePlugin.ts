import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isBridgeTitle } from '$lib/bridgeStatus/parseBridgeNote.js';
import { runBridgeButtonClick } from './runBridgeButtonClick.js';
import { DETAIL_BUTTONS } from '$lib/bridgeStatus/detail/registry.js';
import { openBridgeDetail } from '$lib/bridgeStatus/detail/openBridgeDetail.js';

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

function renderDetailButtons(): HTMLElement {
	const wrap = document.createElement('span');
	wrap.className = 'tomboy-bridge-detail-row';
	wrap.contentEditable = 'false';
	for (const b of DETAIL_BUTTONS) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'tomboy-bridge-detail';
		btn.contentEditable = 'false';
		btn.textContent = b.label;
		btn.addEventListener('mousedown', (e) => e.preventDefault());
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			openBridgeDetail(b.key);
		});
		wrap.appendChild(btn);
	}
	return wrap;
}

function buildDecorations(doc: PMNode): DecorationSet {
	const first = doc.firstChild;
	if (!first || !isBridgeTitle(first.textContent)) return DecorationSet.empty;
	// 제목 바로 뒤(제목 안이 아님 — titleIsolation 이 제목을 display:none 처리).
	const afterTitlePos = first.nodeSize;
	const runWidget = Decoration.widget(afterTitlePos, (view) => renderButton(view), {
		side: 1,
		key: 'bridge-run'
	});
	const detailWidget = Decoration.widget(afterTitlePos, () => renderDetailButtons(), {
		side: 1,
		key: 'bridge-detail'
	});
	return DecorationSet.create(doc, [runWidget, detailWidget]);
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
