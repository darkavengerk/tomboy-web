/**
 * ProseMirror plugin that renders CSV/TSV "table blocks" inside the editor.
 *
 * Source-of-truth model: a table block is just a stretch of consecutive
 * top-level paragraphs in the doc — see `findTableRegions.ts` for the
 * line-level grammar (` ```csv ` / ` ```tsv ` … ` ``` `). The plugin never
 * mutates the doc on its own; it only adds DECORATIONS:
 *
 *  - When a region is "checked" (the default): an inline decoration spans
 *    every paragraph in the region with `display: none` styling, plus a
 *    widget decoration at the opening fence renders the table + checkbox.
 *  - When a region is "unchecked": the hide-decoration is omitted so the
 *    raw paragraphs are visible and editable. The widget decoration still
 *    appears, but reduced to just the checkbox so the user can re-check.
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
import type { Editor } from '@tiptap/core';
import { findTableRegions, type TableRegion } from './findTableRegions.js';

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
			// Hide the underlying source paragraphs by spanning them with an
			// inline decoration that flags every text node inside the region.
			// We expand to [openFromPos, closeToPos] so the fence lines and
			// every body row are all hidden together.
			decos.push(
				Decoration.inline(
					r.openFromPos,
					r.closeToPos,
					{ class: 'tomboy-table-block-hidden' },
					{ inclusiveStart: false, inclusiveEnd: false }
				)
			);
			// Also mark the surrounding paragraph nodes themselves so the
			// hidden region collapses fully (an inline-only decoration would
			// still leave each <p> as a block, producing visible empty lines).
			decos.push(
				Decoration.node(
					r.openFromPos,
					r.closeToPos,
					{ class: 'tomboy-table-block-hidden-block' },
					{ inclusiveStart: false, inclusiveEnd: false }
				)
			);
		}
		// Widget decoration at the opening-fence start. side:-1 keeps it on
		// the line BEFORE the fence's content so it renders cleanly above
		// the source paragraphs.
		decos.push(
			Decoration.widget(r.openFromPos, () => renderTableWidget(r, checked), {
				side: -1,
				key: `tableBlock:${r.openFromPos}:${checked ? 'on' : 'off'}`
			})
		);
	}
	return DecorationSet.create(doc, decos);
}

/**
 * Build the widget DOM for a region — a container holding the (rendered)
 * table plus a top-right checkbox that toggles the region's view mode.
 *
 * The click handler dispatches a plugin meta on the editor view it's
 * attached to. We discover the view via the `data-table-block-open` attr
 * we put on the wrapper: the plugin's keydown / mousedown hooks below
 * read the attr and know which region was clicked, but for the actual
 * checkbox click we attach the handler directly.
 */
function renderTableWidget(region: TableRegion, checked: boolean): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'tomboy-table-block-widget';
	wrap.setAttribute('contenteditable', 'false');
	wrap.setAttribute('data-table-block-open', String(region.openFromPos));

	// Don't let mousedown on the widget chrome move the editor selection.
	wrap.addEventListener('mousedown', (e) => {
		const target = e.target as HTMLElement;
		// Allow normal interaction inside <input> / <button>.
		if (target.tagName === 'INPUT' || target.tagName === 'BUTTON') return;
		e.preventDefault();
	});

	const header = document.createElement('div');
	header.className = 'tomboy-table-block-header';

	const label = document.createElement('label');
	label.className = 'tomboy-table-block-toggle';
	const cb = document.createElement('input');
	cb.type = 'checkbox';
	cb.checked = checked;
	cb.setAttribute('data-table-block-toggle', '');
	const span = document.createElement('span');
	span.textContent = '표';
	label.appendChild(cb);
	label.appendChild(span);
	header.appendChild(label);

	wrap.appendChild(header);

	if (checked) {
		const table = renderTable(region);
		wrap.appendChild(table);
	}

	return wrap;
}

function renderTable(region: TableRegion): HTMLTableElement {
	const table = document.createElement('table');
	table.className = 'tomboy-table-block-table';
	if (region.rows.length === 0) {
		// Show an empty placeholder so the toggle still has something to
		// hang on the page.
		const tr = table.insertRow();
		const td = tr.insertCell();
		td.textContent = '(빈 표)';
		td.className = 'tomboy-table-block-empty';
		return table;
	}
	const colCount = region.rows.reduce((m, r) => Math.max(m, r.length), 0);
	const thead = document.createElement('thead');
	const headTr = document.createElement('tr');
	const headRow = region.rows[0];
	for (let c = 0; c < colCount; c++) {
		const th = document.createElement('th');
		th.textContent = headRow[c] ?? '';
		headTr.appendChild(th);
	}
	thead.appendChild(headTr);
	table.appendChild(thead);

	if (region.rows.length > 1) {
		const tbody = document.createElement('tbody');
		for (let i = 1; i < region.rows.length; i++) {
			const row = region.rows[i];
			const tr = document.createElement('tr');
			for (let c = 0; c < colCount; c++) {
				const td = document.createElement('td');
				td.textContent = row[c] ?? '';
				tr.appendChild(td);
			}
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
	}
	return table;
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
