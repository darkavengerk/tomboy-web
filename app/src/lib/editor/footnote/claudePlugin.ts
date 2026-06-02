import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { ThinkingStep } from '$lib/chatNote/backends/claude.js';

import { definitionsMatchingTrigger, locateDefinition } from './claudeFill.js';
import { runFootnoteClaude } from './claudeFill.js';

export interface FootnoteClaudeState {
	active: string[];
	step: ThinkingStep | null;
	stepLabel: string | null;
}

export interface FootnoteClaudeOptions {
	/** 트리거 감지 시 호출. 기본값은 실제 오케스트레이터. */
	fill: (view: EditorView, label: string, instruction: string) => void;
}

export const footnoteClaudeKey = new PluginKey<FootnoteClaudeState>('footnoteClaude');

type Meta =
	| { type: 'active'; label: string }
	| { type: 'idle'; label: string }
	| { type: 'step'; label: string; step: ThinkingStep | null };

export function markActive(view: EditorView, label: string): void {
	view.dispatch(view.state.tr.setMeta(footnoteClaudeKey, { type: 'active', label }));
}
export function markIdle(view: EditorView, label: string): void {
	view.dispatch(view.state.tr.setMeta(footnoteClaudeKey, { type: 'idle', label }));
}
export function setFootnoteStep(
	view: EditorView,
	label: string,
	step: ThinkingStep | null
): void {
	view.dispatch(view.state.tr.setMeta(footnoteClaudeKey, { type: 'step', label, step }));
}

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

function reduce(state: FootnoteClaudeState, meta: Meta): FootnoteClaudeState {
	switch (meta.type) {
		case 'active':
			return state.active.includes(meta.label)
				? state
				: { ...state, active: [...state.active, meta.label] };
		case 'idle': {
			const clearStep = state.stepLabel === meta.label;
			return {
				active: state.active.filter((l) => l !== meta.label),
				step: clearStep ? null : state.step,
				stepLabel: clearStep ? null : state.stepLabel
			};
		}
		case 'step':
			return { ...state, step: meta.step, stepLabel: meta.step ? meta.label : null };
	}
}

export function createFootnoteClaudePlugin(
	opts?: Partial<FootnoteClaudeOptions>
): Plugin<FootnoteClaudeState> {
	const fill = opts?.fill ?? runFootnoteClaude;
	return new Plugin<FootnoteClaudeState>({
		key: footnoteClaudeKey,
		state: {
			init(): FootnoteClaudeState {
				return { active: [], step: null, stepLabel: null };
			},
			apply(tr, value): FootnoteClaudeState {
				const meta = tr.getMeta(footnoteClaudeKey) as Meta | undefined;
				return meta ? reduce(value, meta) : value;
			}
		},
		view() {
			return {
				update(view: EditorView, prev: EditorState) {
					const cur = view.state;
					if (cur.doc.eq(prev.doc)) return;
					const before = definitionsMatchingTrigger(prev.doc);
					const after = definitionsMatchingTrigger(cur.doc);
					const active = footnoteClaudeKey.getState(cur)?.active ?? [];
					for (const [label, instruction] of after) {
						if (before.has(label)) continue;
						if (active.includes(label)) continue;
						fill(view, label, instruction);
					}
				}
			};
		},
		props: {
			decorations(state): DecorationSet {
				const st = footnoteClaudeKey.getState(state);
				if (!st?.step || !st.stepLabel) return DecorationSet.empty;
				const loc = locateDefinition(state.doc, st.stepLabel);
				if (!loc) return DecorationSet.empty;
				const widget = Decoration.widget(loc.textTo, () => buildWidgetDom(st.step!), {
					side: 1,
					ignoreSelection: true
				});
				return DecorationSet.create(state.doc, [widget]);
			}
		}
	});
}
