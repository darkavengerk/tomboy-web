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
	/** Invoked when a list item's 스킵 button is clicked. */
	onSkip: (liPos: number, liNode: PMNode) => void;
}

function buildDecorations(
	doc: PMNode,
	onSend: SendListItemOptions['onSend'],
	onSkip: SendListItemOptions['onSkip']
): DecorationSet {
	const decos: Decoration[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name !== 'listItem') return;
		decos.push(
			Decoration.widget(
				pos + 1,
				(view, getPos) => {
					// Resolve the live li node at click time — the captured `pos`
					// may have shifted as earlier rows mutate the doc.
					const resolveLi = (): { liPos: number; liNode: PMNode } | null => {
						const p = getPos();
						if (p == null) return null;
						const liPos = p - 1;
						const liNode = view.state.doc.nodeAt(liPos);
						if (!liNode || liNode.type.name !== 'listItem') return null;
						return { liPos, liNode };
					};

					const makeBtn = (
						label: string,
						className: string,
						handler: (liPos: number, liNode: PMNode) => void
					): HTMLButtonElement => {
						const btn = document.createElement('button');
						btn.type = 'button';
						btn.className = className;
						btn.textContent = label;
						btn.setAttribute('contenteditable', 'false');
						btn.setAttribute('data-no-drag', '');
						btn.addEventListener('mousedown', (e) => {
							e.preventDefault();
							e.stopPropagation();
						});
						btn.addEventListener('click', (e) => {
							e.preventDefault();
							e.stopPropagation();
							const r = resolveLi();
							if (!r) return;
							handler(r.liPos, r.liNode);
						});
						return btn;
					};

					const wrap = document.createElement('span');
					wrap.className = 'tomboy-send-li-actions';
					wrap.setAttribute('contenteditable', 'false');
					wrap.setAttribute('data-no-drag', '');
					// 스킵(왼쪽) → 보내기(오른쪽). 보내기를 맨 오른쪽에 유지해
					// 기존 위치 감각을 보존한다.
					wrap.appendChild(makeBtn('스킵', 'tomboy-skip-li-btn', onSkip));
					wrap.appendChild(makeBtn('보내기', 'tomboy-send-li-btn', onSend));
					return wrap;
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
				return buildDecorations(state.doc, options.onSend, options.onSkip);
			},
			attributes(state): Record<string, string> {
				const s = sendListItemPluginKey.getState(state);
				return s?.active ? { class: 'tomboy-send-active' } : {};
			}
		}
	});
}
