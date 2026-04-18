import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

interface PluginState {
	active: boolean;
}

interface Meta {
	active?: boolean;
}

export const sendListItemPluginKey = new PluginKey<PluginState>('tomboySendListItem');

export interface SendListItemOptions {
	/** Invoked when a list item's 보내기 button is clicked. */
	onSend: (liPos: number, liNode: PMNode) => void;
}

function buildDecorations(
	doc: PMNode,
	onSend: SendListItemOptions['onSend']
): DecorationSet {
	const decos: Decoration[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name !== 'listItem') return;
		decos.push(
			Decoration.widget(
				pos + 1,
				(view, getPos) => {
					const btn = document.createElement('button');
					btn.type = 'button';
					btn.className = 'tomboy-send-li-btn';
					btn.textContent = '보내기';
					btn.setAttribute('contenteditable', 'false');
					btn.setAttribute('data-no-drag', '');
					btn.addEventListener('mousedown', (e) => {
						e.preventDefault();
						e.stopPropagation();
					});
					btn.addEventListener('click', (e) => {
						e.preventDefault();
						e.stopPropagation();
						const p = getPos();
						if (p == null) return;
						const liPos = p - 1;
						const liNode = view.state.doc.nodeAt(liPos);
						if (!liNode || liNode.type.name !== 'listItem') return;
						onSend(liPos, liNode);
					});
					return btn;
				},
				{ side: -1, ignoreSelection: true, key: 'tomboy-send-li' }
			)
		);
	});
	return DecorationSet.create(doc, decos);
}

export function createSendListItemPlugin(options: SendListItemOptions): Plugin {
	return new Plugin<PluginState>({
		key: sendListItemPluginKey,
		state: {
			init(): PluginState {
				return { active: false };
			},
			apply(tr, prev): PluginState {
				const meta = tr.getMeta(sendListItemPluginKey) as Meta | undefined;
				if (meta && typeof meta.active === 'boolean') {
					return { active: meta.active };
				}
				return prev;
			}
		},
		props: {
			decorations(state) {
				const s = sendListItemPluginKey.getState(state);
				if (!s?.active) return null;
				return buildDecorations(state.doc, options.onSend);
			},
			attributes(state): Record<string, string> {
				const s = sendListItemPluginKey.getState(state);
				return s?.active ? { class: 'tomboy-send-active' } : {};
			}
		}
	});
}
