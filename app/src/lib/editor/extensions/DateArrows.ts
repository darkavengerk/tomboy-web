/**
 * Date-title prev/next arrows.
 *
 * When the first block's trimmed text matches `yyyy-mm-dd`, render a pair
 * of prev/next arrow buttons on their own line directly below the title.
 * Arrow targets (titles) are fed via extension storage from the parent
 * Svelte component, which computes them by filtering the shared title
 * index for date-format titles.
 *
 * Decoration strategy: a single block-level widget placed at the position
 * between block 0 and block 1 (i.e. `firstBlock.nodeSize`) so it renders
 * on its own line, similar to the slip-note arrows but without a carrier
 * paragraph — the date arrows are pure UI, not part of the persisted doc.
 *
 * The decoration is keyed on the prev/next titles so that storage
 * updates (via a no-op transaction dispatched by the parent) force a
 * widget rebuild with fresh disabled states and click handlers.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface DateArrowsStorage {
	enabled: boolean;
	/** Title of the nearest earlier date-titled note, or null when none. */
	prevTitle: string | null;
	/** Title of the nearest later date-titled note, or null when none. */
	nextTitle: string | null;
	onNavigate: (target: string, direction: 'prev' | 'next') => void;
}

const pluginKey = new PluginKey('dateArrows');
const DATE_TITLE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const DateArrows = Extension.create<
	Record<string, never>,
	DateArrowsStorage
>({
	name: 'dateArrows',

	addStorage() {
		return {
			enabled: false,
			prevTitle: null,
			nextTitle: null,
			onNavigate: () => {}
		};
	},

	addProseMirrorPlugins() {
		const storage = this.storage;
		return [
			new Plugin({
				key: pluginKey,
				props: {
					decorations: (state) => {
						if (!storage.enabled) return DecorationSet.empty;
						return buildDecorations(state.doc, storage);
					}
				}
			})
		];
	}
});

function buildDecorations(doc: PMNode, storage: DateArrowsStorage): DecorationSet {
	const first = doc.firstChild;
	if (!first) return DecorationSet.empty;
	const titleText = first.textContent.trim();
	if (!DATE_TITLE_REGEX.test(titleText)) return DecorationSet.empty;

	const pos = first.nodeSize;
	const decoration = Decoration.widget(
		pos,
		makeArrowRowFactory(storage),
		{
			side: -1,
			ignoreSelection: true,
			key: `date-arrows-${storage.prevTitle ?? 'n'}-${storage.nextTitle ?? 'n'}`
		}
	);
	return DecorationSet.create(doc, [decoration]);
}

function makeArrowRowFactory(storage: DateArrowsStorage): () => HTMLElement {
	return () => {
		const row = document.createElement('div');
		row.className = 'datelink-arrow-row';
		row.contentEditable = 'false';
		row.appendChild(makeArrow('prev', storage));
		row.appendChild(makeArrow('next', storage));
		return row;
	};
}

function makeArrow(
	direction: 'prev' | 'next',
	storage: DateArrowsStorage
): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = `datelink-arrow datelink-arrow-${direction}`;
	btn.contentEditable = 'false';
	btn.setAttribute(
		'aria-label',
		direction === 'prev' ? '이전 날짜 노트' : '다음 날짜 노트'
	);
	const target = direction === 'prev' ? storage.prevTitle : storage.nextTitle;
	if (target) btn.title = target;
	btn.disabled = !target;
	btn.innerHTML =
		direction === 'prev'
			? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>'
			: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
	btn.addEventListener('mousedown', (e) => {
		e.preventDefault();
	});
	btn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (!target) return;
		storage.onNavigate(target, direction);
	});
	return btn;
}
