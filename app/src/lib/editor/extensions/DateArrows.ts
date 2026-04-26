/**
 * Date-title prev/next arrows.
 *
 * When the first block's trimmed text parses as a date title (yyyy-mm-dd or
 * `yyyy년 m월 d일`), render a pair of prev/next arrow buttons on their own
 * line directly below the second top-level block (the subtitle slot). Arrow
 * targets (titles) are fed via extension storage from the parent Svelte
 * component, which computes them by filtering the shared title index for
 * date-format titles.
 *
 * Decoration strategy: a single block-level widget placed at the position
 * after block 1 (i.e. `block0.nodeSize + block1.nodeSize`) so the date note
 * still gets its normal subtitle line, with the arrows appearing on the
 * line below it. If the doc only has the title block, the arrows fall back
 * to placement directly below the title.
 *
 * The decoration is keyed on the prev/next titles so that storage updates
 * (via a no-op transaction dispatched by the parent) force a widget rebuild
 * with fresh disabled states and click handlers.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

import { parseDateTitle } from '../dateLink/findAdjacentDateNotes.js';

export interface DateArrowsStorage {
	enabled: boolean;
	/** Title of the nearest earlier date-titled note, or null when none. */
	prevTitle: string | null;
	/** Title of the nearest later date-titled note, or null when none. */
	nextTitle: string | null;
	onNavigate: (target: string, direction: 'prev' | 'next') => void;
}

const pluginKey = new PluginKey('dateArrows');

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
	if (!parseDateTitle(first.textContent)) return DecorationSet.empty;

	// Place the arrow row AFTER the subtitle block (block 1) so the
	// subtitle placeholder / user-typed second line still has its normal
	// slot. Falls back to "directly below the title" when the doc has no
	// second block yet.
	const second = doc.maybeChild(1);
	const pos = first.nodeSize + (second ? second.nodeSize : 0);
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
