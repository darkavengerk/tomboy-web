/**
 * ProseMirror plugin: renders the per-listItem "이전" / "다음" stage-move
 * buttons inside Process blocks. Buttons are widget decorations; the
 * Ctrl/Cmd-hold visibility gate reuses the `.tomboy-todo-ctrl-hold` class
 * toggled on the editor root by TomboyEditor.svelte (so the mobile "Ctrl
 * 고정" toggle reveals them too).
 *
 * First stage shows only "다음"; last stage shows only "이전"; middle stages
 * show both.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

import {
	findProcessBlocks,
	findProcessItems,
	type ProcessMoveDirection
} from './regions.js';

export interface ProcessRegionPluginOptions {
	/** Invoked when a stage-move button is clicked. */
	onMove: (liPos: number, direction: ProcessMoveDirection) => void;
}

export const processRegionPluginKey = new PluginKey<DecorationSet>('tomboyProcessRegion');

function makeButton(
	view: EditorView,
	getPos: () => number | undefined,
	direction: ProcessMoveDirection,
	onMove: ProcessRegionPluginOptions['onMove']
): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className =
		direction === 'next' ? 'tomboy-process-next-btn' : 'tomboy-process-prev-btn';
	btn.textContent = direction === 'next' ? '다음' : '이전';
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
		onMove(liPos, direction);
	});
	return btn;
}

/** One wrapper holding the available 이전 / 다음 buttons for an item. */
function buildButtonGroup(
	view: EditorView,
	getPos: () => number | undefined,
	showPrev: boolean,
	showNext: boolean,
	onMove: ProcessRegionPluginOptions['onMove']
): HTMLElement {
	const wrap = document.createElement('span');
	wrap.className = 'tomboy-process-btns';
	wrap.setAttribute('contenteditable', 'false');
	wrap.setAttribute('data-no-drag', '');
	if (showPrev) wrap.appendChild(makeButton(view, getPos, 'prev', onMove));
	if (showNext) wrap.appendChild(makeButton(view, getPos, 'next', onMove));
	return wrap;
}

function buildDecorations(
	doc: PMNode,
	onMove: ProcessRegionPluginOptions['onMove']
): DecorationSet {
	const decos: Decoration[] = [];
	const items = findProcessItems(findProcessBlocks(doc));
	for (const it of items) {
		const liPos = it.liPos;
		const liEnd = liPos + it.liNode.nodeSize;
		const showPrev = !it.stage.isFirst;
		const showNext = !it.stage.isLast;
		if (!showPrev && !showNext) continue; // single-stage block: nothing to move
		decos.push(Decoration.node(liPos, liEnd, { class: 'tomboy-process-item' }));
		decos.push(
			Decoration.widget(
				liPos + 1,
				(view, getPos) => buildButtonGroup(view, getPos, showPrev, showNext, onMove),
				{
					side: -1,
					ignoreSelection: true,
					key: `tomboy-process-btns-${showPrev ? 'p' : ''}${showNext ? 'n' : ''}`
				}
			)
		);
	}
	return DecorationSet.create(doc, decos);
}

export function createProcessRegionPlugin(
	options: ProcessRegionPluginOptions
): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: processRegionPluginKey,
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
				return processRegionPluginKey.getState(state) ?? null;
			}
		}
	});
}
