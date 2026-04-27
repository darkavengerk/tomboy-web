/**
 * ProseMirror plugin that renders CSV/TSV "table blocks" inside the editor.
 *
 * Source-of-truth model: a table block is just a stretch of consecutive
 * top-level paragraphs in the doc — see `findTableRegions.ts` for the
 * line-level grammar (` ```csv ` / ` ```tsv ` … ` ``` `). The plugin never
 * mutates the doc on its own; it only adds DECORATIONS:
 *
 *  - When a region is "checked" (the default): node + inline decorations
 *    collapse the source paragraphs to zero size, and a single widget
 *    decoration at the opening-fence position renders the table on top.
 *    A toggle checkbox sits absolutely top-right of that widget; CSS
 *    keeps it `opacity:0` until `:hover`.
 *  - When a region is "unchecked": no hide decorations, so the raw
 *    paragraphs are visible and editable. The widget for this state is
 *    a SHORT inline-block placed INSIDE the open-fence paragraph (at
 *    `openFromPos + 1`); CSS floats it to the right edge of that line
 *    and `:hover` reveals it. The user can re-check from there.
 *
 * Per-region toggle state is stored as a `Set<number>` of opening-fence
 * positions. Edits remap positions through `tr.mapping`, and a region
 * whose mapped position no longer matches an opening fence is dropped —
 * so deleting and re-creating a fence produces a fresh, default-checked
 * region.
 */

import {
	Plugin,
	PluginKey,
	type EditorState,
	type Transaction
} from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Editor, JSONContent } from '@tiptap/core';
import { findTableRegions, type TableRegion } from './findTableRegions.js';
import { renderInlinesToDom } from './renderInlines.js';

interface PluginState {
	regions: TableRegion[];
	uncheckedOpens: Set<number>;
	decorations: DecorationSet;
}

interface Meta {
	/** Toggle the region whose opening-fence position matches `openFromPos`. */
	toggleAt?: number;
}

export const tableBlockPluginKey = new PluginKey<PluginState>('tomboyTableBlock');

/**
 * Recompute `regions` for the current doc and reconcile `uncheckedOpens`.
 * `prevUnchecked` carries the Set already mapped through the current
 * transaction's mapping; we drop entries that don't line up with a real
 * opening fence anymore.
 */
function rebuildState(doc: PMNode, prevUnchecked: Set<number>): PluginState {
	const regions = findTableRegions(doc);
	const validOpens = new Set(regions.map((r) => r.openFromPos));
	const uncheckedOpens = new Set<number>();
	for (const p of prevUnchecked) {
		if (validOpens.has(p)) uncheckedOpens.add(p);
	}
	const decorations = buildDecorations(doc, regions, uncheckedOpens);
	return { regions, uncheckedOpens, decorations };
}

function buildDecorations(
	doc: PMNode,
	regions: TableRegion[],
	uncheckedOpens: Set<number>
): DecorationSet {
	if (regions.length === 0) return DecorationSet.empty;
	const decos: Decoration[] = [];
	for (const r of regions) {
		const checked = !uncheckedOpens.has(r.openFromPos);
		if (checked) {
			// Hide source paragraphs: inline span hides text content, node
			// deco collapses the surrounding <p>s to zero height so the
			// region doesn't leave visible blank lines.
			decos.push(
				Decoration.inline(
					r.openFromPos,
					r.closeToPos,
					{ class: 'tomboy-table-block-hidden' },
					{ inclusiveStart: false, inclusiveEnd: false }
				)
			);
			decos.push(
				Decoration.node(
					r.openFromPos,
					r.closeToPos,
					{ class: 'tomboy-table-block-hidden-block' },
					{ inclusiveStart: false, inclusiveEnd: false }
				)
			);
			// Block-level table widget overlaying the hidden source.
			decos.push(
				Decoration.widget(r.openFromPos, () => renderTableWidget(r), {
					side: -1,
					key: `tableBlock:${r.openFromPos}:on`
				})
			);
		} else {
			// Source visible. Inline-place a small floating-checkbox widget
			// INSIDE the opening fence paragraph so it can ride at the right
			// edge of the visible "```csv" line. `openFromPos + 1` is the
			// first position after the paragraph's open boundary; side:-1
			// keeps it before any text content there.
			decos.push(
				Decoration.widget(
					r.openFromPos + 1,
					() => renderFloatingToggle(r),
					{
						side: -1,
						key: `tableBlock:${r.openFromPos}:off`
					}
				)
			);
		}
	}
	return DecorationSet.create(doc, decos);
}

/**
 * Block-level widget for the CHECKED state — contains the rendered table
 * plus a hover-revealed toggle checkbox absolutely positioned top-right
 * of the widget. Clicks on the checkbox bubble up to the plugin's
 * `handleDOMEvents.click` which reads `data-table-block-open` and
 * dispatches the toggle meta.
 */
function renderTableWidget(region: TableRegion): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'tomboy-table-block-widget';
	wrap.setAttribute('contenteditable', 'false');
	wrap.setAttribute('data-table-block-open', String(region.openFromPos));

	// Don't let mousedown on the widget chrome move the editor selection.
	// Allow it on form controls and on links so they remain interactive.
	wrap.addEventListener('mousedown', (e) => {
		const target = e.target as HTMLElement;
		if (
			target.tagName === 'INPUT' ||
			target.tagName === 'BUTTON' ||
			target.closest('a')
		) {
			return;
		}
		e.preventDefault();
	});

	const label = document.createElement('label');
	label.className = 'tomboy-table-block-toggle';
	const cb = document.createElement('input');
	cb.type = 'checkbox';
	cb.checked = true;
	cb.setAttribute('data-table-block-toggle', '');
	label.appendChild(cb);
	wrap.appendChild(label);

	wrap.appendChild(renderTable(region));
	return wrap;
}

/**
 * Inline floating widget for the UNCHECKED state — sits inside the open
 * paragraph, CSS floats it to the right of the line, hover-revealed.
 * Carries `data-table-block-open` so the same click handler fires.
 */
function renderFloatingToggle(region: TableRegion): HTMLElement {
	const wrap = document.createElement('span');
	wrap.className = 'tomboy-table-block-floating';
	wrap.setAttribute('contenteditable', 'false');
	wrap.setAttribute('data-table-block-open', String(region.openFromPos));
	wrap.addEventListener('mousedown', (e) => {
		const target = e.target as HTMLElement;
		if (target.tagName === 'INPUT') return;
		e.preventDefault();
	});

	const label = document.createElement('label');
	const cb = document.createElement('input');
	cb.type = 'checkbox';
	cb.checked = false;
	cb.setAttribute('data-table-block-toggle', '');
	label.appendChild(cb);
	wrap.appendChild(label);
	return wrap;
}

function renderTable(region: TableRegion): HTMLTableElement {
	const table = document.createElement('table');
	table.className = 'tomboy-table-block-table';
	if (region.cells.length === 0) {
		const tr = table.insertRow();
		const td = tr.insertCell();
		td.textContent = '(빈 표)';
		td.className = 'tomboy-table-block-empty';
		return table;
	}
	const colCount = region.cells.reduce((m, r) => Math.max(m, r.length), 0);
	const thead = document.createElement('thead');
	const headTr = document.createElement('tr');
	const headRow = region.cells[0];
	for (let c = 0; c < colCount; c++) {
		const th = document.createElement('th');
		appendCellInlines(th, headRow[c]);
		headTr.appendChild(th);
	}
	thead.appendChild(headTr);
	table.appendChild(thead);

	if (region.cells.length > 1) {
		const tbody = document.createElement('tbody');
		for (let i = 1; i < region.cells.length; i++) {
			const row = region.cells[i];
			const tr = document.createElement('tr');
			for (let c = 0; c < colCount; c++) {
				const td = document.createElement('td');
				appendCellInlines(td, row[c]);
				tr.appendChild(td);
			}
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
	}
	return table;
}

function appendCellInlines(
	cell: HTMLElement,
	inlines: JSONContent[] | undefined
): void {
	if (!inlines || inlines.length === 0) return;
	cell.appendChild(renderInlinesToDom(inlines));
}

/**
 * Toggle the checkbox state of the region whose opening fence is at
 * `openFromPos` (the doc-position you got from `state.regions[i].openFromPos`).
 *
 * Exported so callers (e.g. the click handler attached by the widget, or
 * direct test code) can flip a region without going through the DOM.
 */
export function toggleTableBlock(editor: Editor, openFromPos: number): void {
	editor.view.dispatch(
		editor.state.tr.setMeta(tableBlockPluginKey, { toggleAt: openFromPos } as Meta)
	);
}

export function createTableBlockPlugin(): Plugin<PluginState> {
	return new Plugin<PluginState>({
		key: tableBlockPluginKey,
		state: {
			init(_, state): PluginState {
				return rebuildState(state.doc, new Set());
			},
			apply(tr, prev, _oldState, newState): PluginState {
				const meta = tr.getMeta(tableBlockPluginKey) as Meta | undefined;
				let unchecked = prev.uncheckedOpens;
				let regionsDirty = tr.docChanged || meta !== undefined;

				if (tr.docChanged) {
					// Map every tracked unchecked-open through the doc edits so
					// our identities follow the content.
					const mapped = new Set<number>();
					for (const p of unchecked) {
						const m = tr.mapping.map(p, -1);
						mapped.add(m);
					}
					unchecked = mapped;
				}

				if (meta?.toggleAt !== undefined) {
					unchecked = new Set(unchecked);
					if (unchecked.has(meta.toggleAt)) unchecked.delete(meta.toggleAt);
					else unchecked.add(meta.toggleAt);
				}

				if (!regionsDirty) {
					return prev;
				}

				return rebuildState(newState.doc, unchecked);
			}
		},
		props: {
			decorations(state: EditorState) {
				return tableBlockPluginKey.getState(state)?.decorations;
			},
			handleDOMEvents: {
				// Wire the checkbox click → toggle dispatch. We do this here
				// (rather than in renderTableWidget) so each widget render
				// doesn't bind a fresh closure that captures the editor view.
				click(view, event) {
					const target = event.target as HTMLElement;
					const cb = target.closest(
						'input[data-table-block-toggle]'
					) as HTMLInputElement | null;
					if (!cb) return false;
					const wrap = cb.closest('[data-table-block-open]') as HTMLElement | null;
					if (!wrap) return false;
					const open = Number(wrap.getAttribute('data-table-block-open'));
					if (!Number.isFinite(open)) return false;
					event.preventDefault();
					event.stopPropagation();
					const tr: Transaction = view.state.tr.setMeta(tableBlockPluginKey, {
						toggleAt: open
					} as Meta);
					view.dispatch(tr);
					return true;
				}
			}
		}
	});
}
