import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { ThinkingStep } from '$lib/chatNote/backends/claude.js';

interface PluginState {
	step: ThinkingStep | null;
}

export const thinkingDisplayKey = new PluginKey<PluginState>('thinkingDisplay');

function buildWidgetDom(step: ThinkingStep): HTMLElement {
	const aside = document.createElement('aside');
	aside.className = 'thinking-display';
	aside.setAttribute('data-kind', step.kind);

	const header = document.createElement('header');
	header.className = 'thinking-display-label';
	header.textContent = step.label;
	aside.appendChild(header);

	if (step.body) {
		const bq = document.createElement('blockquote');
		bq.className = 'thinking-display-body';
		bq.textContent = step.body;
		aside.appendChild(bq);
	}

	return aside;
}

function lastParagraphStart(state: EditorState): number | null {
	const doc = state.doc;
	if (doc.childCount === 0) return null;
	let pos = 0;
	for (let i = 0; i < doc.childCount - 1; i++) {
		pos += doc.child(i).nodeSize;
	}
	return pos;
}

export function createThinkingDisplayPlugin(): Plugin<PluginState> {
	return new Plugin<PluginState>({
		key: thinkingDisplayKey,
		state: {
			init(): PluginState {
				return { step: null };
			},
			apply(tr, value): PluginState {
				const meta = tr.getMeta(thinkingDisplayKey) as
					| { step: ThinkingStep | null }
					| undefined;
				if (meta !== undefined) return { step: meta.step };
				return value;
			}
		},
		props: {
			decorations(state): DecorationSet {
				const pluginState = thinkingDisplayKey.getState(state);
				const step = pluginState?.step ?? null;
				if (!step) return DecorationSet.empty;
				const pos = lastParagraphStart(state);
				if (pos === null) return DecorationSet.empty;
				const widget = Decoration.widget(pos, () => buildWidgetDom(step), {
					side: -1,
					ignoreSelection: true
				});
				return DecorationSet.create(state.doc, [widget]);
			}
		}
	});
}

export function setStep(view: EditorView, step: ThinkingStep | null): void {
	view.dispatch(view.state.tr.setMeta(thinkingDisplayKey, { step }));
}

export function clearStep(view: EditorView): void {
	setStep(view, null);
}
