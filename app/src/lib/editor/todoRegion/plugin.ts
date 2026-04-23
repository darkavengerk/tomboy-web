/**
 * ProseMirror plugin: renders the per-listItem "완료" / "되돌리기" buttons
 * inside TODO and Done regions. The buttons are widget decorations; the
 * Ctrl/Cmd-hold visibility gate lives in CSS via a class toggled on the
 * editor root element by TomboyEditor.svelte.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

import { findTodoRegions, type TodoRegionKind } from './regions.js';

export interface TodoRegionPluginOptions {
	/** Invoked when a region-item button is clicked. */
	onMove: (liPos: number, fromKind: TodoRegionKind) => void;
}

export const todoRegionPluginKey = new PluginKey<DecorationSet>('tomboyTodoRegion');

function buildButton(
	view: EditorView,
	getPos: () => number | undefined,
	kind: TodoRegionKind,
	onMove: TodoRegionPluginOptions['onMove']
): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className =
		kind === 'TODO' ? 'tomboy-todo-complete-btn' : 'tomboy-todo-revert-btn';
	btn.textContent = kind === 'TODO' ? '완료' : '되돌리기';
	btn.setAttribute('contenteditable', 'false');
	btn.setAttribute('data-no-drag', '');
	btn.addEventListener('mousedown', (e) => {
		// Prevent PM from stealing focus / moving the selection to the widget.
		e.preventDefault();
		e.stopPropagation();
	});
	btn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		const p = getPos();
		if (p == null) return;
		// Widget is placed at liPos+1 (content start); li opens 1 pos earlier.
		const liPos = p - 1;
		const node = view.state.doc.nodeAt(liPos);
		if (!node || node.type.name !== 'listItem') return;
		onMove(liPos, kind);
	});
	return btn;
}

function buildDecorations(
	doc: PMNode,
	onMove: TodoRegionPluginOptions['onMove']
): DecorationSet {
	const decos: Decoration[] = [];
	const regions = findTodoRegions(doc);
	for (const region of regions) {
		for (const list of region.lists) {
			// List content starts just after its opening token.
			let offset = list.pos + 1;
			list.node.forEach((li) => {
				const liPos = offset;
				const liEnd = liPos + li.nodeSize;
				decos.push(
					Decoration.node(liPos, liEnd, { class: 'tomboy-todo-item' })
				);
				decos.push(
					Decoration.widget(
						liPos + 1,
						(view, getPos) => buildButton(view, getPos, region.kind, onMove),
						{
							side: -1,
							ignoreSelection: true,
							key: `tomboy-todo-btn-${region.kind}`
						}
					)
				);
				offset += li.nodeSize;
			});
		}
	}
	return DecorationSet.create(doc, decos);
}

export function createTodoRegionPlugin(
	options: TodoRegionPluginOptions
): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: todoRegionPluginKey,
		state: {
			init(_, state) {
				return buildDecorations(state.doc, options.onMove);
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				return buildDecorations(newState.doc, options.onMove);
			}
		},
		props: {
			decorations(state) {
				return todoRegionPluginKey.getState(state) ?? null;
			}
		}
	});
}
