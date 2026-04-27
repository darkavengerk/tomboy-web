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
import { commitCellEdit, findCellEditRange } from './cellEdit.js';

export interface CellEditTarget {
	openFromPos: number;
	rowIdx: number;
	colIdx: number;
}

interface PluginState {
	regions: TableRegion[];
	uncheckedOpens: Set<number>;
	editing: CellEditTarget | null;
	decorations: DecorationSet;
}

interface Meta {
	/** Toggle the region whose opening-fence position matches `openFromPos`. */
	toggleAt?: number;
	/** Enter cell-edit mode for `(openFromPos, rowIdx, colIdx)`. */
	startEdit?: CellEditTarget;
	/** Exit cell-edit mode (commit done by the caller's preceding tr). */
	stopEdit?: true;
}

export const tableBlockPluginKey = new PluginKey<PluginState>('tomboyTableBlock');

/**
 * Recompute `regions` for the current doc and reconcile `uncheckedOpens`
 * + `editing`. `prevUnchecked` and `prevEditing` arrive already mapped
 * through the current transaction's mapping; we drop entries that don't
 * line up with an opening fence anymore. The editing target is also
 * dropped if its row index drifted past the current row count.
 */
function rebuildState(
	doc: PMNode,
	prevUnchecked: Set<number>,
	prevEditing: CellEditTarget | null
): PluginState {
	const regions = findTableRegions(doc);
	const validOpens = new Set(regions.map((r) => r.openFromPos));
	const uncheckedOpens = new Set<number>();
	for (const p of prevUnchecked) {
		if (validOpens.has(p)) uncheckedOpens.add(p);
	}
	let editing: CellEditTarget | null = null;
	if (prevEditing) {
		const r = regions.find((r) => r.openFromPos === prevEditing.openFromPos);
		if (
			r &&
			!uncheckedOpens.has(r.openFromPos) &&
			prevEditing.rowIdx < r.cells.length &&
			prevEditing.colIdx <
				r.cells[prevEditing.rowIdx].length
		) {
			editing = prevEditing;
		}
	}
	const decorations = buildDecorations(doc, regions, uncheckedOpens, editing);
	return { regions, uncheckedOpens, editing, decorations };
}

function buildDecorations(
	doc: PMNode,
	regions: TableRegion[],
	uncheckedOpens: Set<number>,
	editing: CellEditTarget | null
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
			const editingHere =
				editing && editing.openFromPos === r.openFromPos ? editing : null;
			const editingText = editingHere
				? cellTextForEdit(doc, r, editingHere.rowIdx, editingHere.colIdx)
				: null;
			decos.push(
				Decoration.widget(
					r.openFromPos,
					() => renderTableWidget(r, editingHere, editingText ?? ''),
					{
						side: -1,
						key: `tableBlock:${r.openFromPos}:on:${
							editingHere
								? `${editingHere.rowIdx}:${editingHere.colIdx}`
								: 'none'
						}`
					}
				)
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
 *
 * If `editingHere` is non-null the matching cell is rendered as a
 * `contenteditable="true"` span (pre-filled with `editingText`), and
 * the hover-only toggle chrome is suppressed via a marker class so
 * the user can focus on the cell.
 */
function renderTableWidget(
	region: TableRegion,
	editingHere: CellEditTarget | null,
	editingText: string
): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'tomboy-table-block-widget';
	if (editingHere) wrap.classList.add('tomboy-table-block-editing');
	wrap.setAttribute('contenteditable', 'false');
	wrap.setAttribute('data-table-block-open', String(region.openFromPos));

	// Don't let mousedown on the widget chrome move the editor selection.
	// Allow it on form controls, links, and the editing cell.
	wrap.addEventListener('mousedown', (e) => {
		const target = e.target as HTMLElement;
		if (
			target.tagName === 'INPUT' ||
			target.tagName === 'BUTTON' ||
			target.closest('a') ||
			target.closest('[contenteditable="true"]')
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

	wrap.appendChild(renderTable(region, editingHere, editingText));
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

function renderTable(
	region: TableRegion,
	editingHere: CellEditTarget | null,
	editingText: string
): HTMLTableElement {
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
		fillCell(th, headRow[c], 0, c, editingHere, editingText);
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
				fillCell(td, row[c], i, c, editingHere, editingText);
				tr.appendChild(td);
			}
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
	}
	return table;
}

function fillCell(
	host: HTMLElement,
	inlines: JSONContent[] | undefined,
	rowIdx: number,
	colIdx: number,
	editingHere: CellEditTarget | null,
	editingText: string
): void {
	host.setAttribute('data-table-block-row', String(rowIdx));
	host.setAttribute('data-table-block-col', String(colIdx));
	const isEditing =
		!!editingHere &&
		editingHere.rowIdx === rowIdx &&
		editingHere.colIdx === colIdx;
	if (isEditing) {
		const editor = document.createElement('span');
		editor.className = 'tomboy-table-block-cell-editor';
		editor.setAttribute('contenteditable', 'true');
		editor.setAttribute('data-table-block-editing', 'true');
		editor.textContent = editingText;
		host.appendChild(editor);
		return;
	}
	if (!inlines || inlines.length === 0) return;
	host.appendChild(renderInlinesToDom(inlines));
}

/**
 * Read the plain text that represents the editable slice of a cell —
 * i.e. the text that `commitCellEdit` would replace. Used to pre-fill
 * the contenteditable span when entering edit mode.
 */
function cellTextForEdit(
	doc: PMNode,
	region: TableRegion,
	rowIdx: number,
	colIdx: number
): string | null {
	const range = findCellEditRange(doc, region, rowIdx, colIdx);
	if (!range) return null;
	if (range.from === range.to) return '';
	return doc.textBetween(range.from, range.to, '');
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

/**
 * Begin editing a single cell of a table region. Called by the
 * dblclick handler in `handleDOMEvents`; exposed for tests and any
 * future programmatic entry points.
 */
export function enterCellEdit(editor: Editor, target: CellEditTarget): void {
	editor.view.dispatch(
		editor.state.tr.setMeta(tableBlockPluginKey, { startEdit: target } as Meta)
	);
}

/** Cancel the current cell edit without modifying the doc. */
export function cancelCellEdit(editor: Editor): void {
	const st = tableBlockPluginKey.getState(editor.state);
	if (!st?.editing) return;
	editor.view.dispatch(
		editor.state.tr.setMeta(tableBlockPluginKey, { stopEdit: true } as Meta)
	);
}

/**
 * Commit the current cell edit by replacing the active cell's range
 * with `newText`. Bundles the doc replacement and the `stopEdit` meta
 * into a single transaction so the rebuild sees both at once.
 *
 * Returns `false` if there is no active edit (caller decides whether
 * that's a no-op or an error). Returns `true` after a successful
 * dispatch.
 */
export function commitCellEditCommand(editor: Editor, newText: string): boolean {
	const st = tableBlockPluginKey.getState(editor.state);
	const editing = st?.editing;
	if (!editing) return false;
	const region = st!.regions.find((r) => r.openFromPos === editing.openFromPos);
	if (!region) {
		// Region went away under us — just clear the edit state.
		cancelCellEdit(editor);
		return false;
	}
	const tr = commitCellEdit(
		editor.state,
		region,
		editing.rowIdx,
		editing.colIdx,
		newText
	);
	if (!tr) {
		cancelCellEdit(editor);
		return false;
	}
	tr.setMeta(tableBlockPluginKey, { stopEdit: true } as Meta);
	editor.view.dispatch(tr);
	return true;
}

export function createTableBlockPlugin(): Plugin<PluginState> {
	return new Plugin<PluginState>({
		key: tableBlockPluginKey,
		state: {
			init(_, state): PluginState {
				return rebuildState(state.doc, new Set(), null);
			},
			apply(tr, prev, _oldState, newState): PluginState {
				const meta = tr.getMeta(tableBlockPluginKey) as Meta | undefined;
				let unchecked = prev.uncheckedOpens;
				let editing: CellEditTarget | null = prev.editing;
				const regionsDirty = tr.docChanged || meta !== undefined;

				if (tr.docChanged) {
					// Map every tracked unchecked-open through the doc edits so
					// our identities follow the content.
					const mapped = new Set<number>();
					for (const p of unchecked) {
						const m = tr.mapping.map(p, -1);
						mapped.add(m);
					}
					unchecked = mapped;
					if (editing) {
						editing = {
							...editing,
							openFromPos: tr.mapping.map(editing.openFromPos, -1)
						};
					}
				}

				if (meta?.toggleAt !== undefined) {
					unchecked = new Set(unchecked);
					if (unchecked.has(meta.toggleAt)) unchecked.delete(meta.toggleAt);
					else unchecked.add(meta.toggleAt);
					// A toggle cancels any in-progress edit.
					editing = null;
				}

				if (meta?.startEdit) {
					// Replace any current edit with the new target. The
					// rebuilder validates that (rowIdx, colIdx) is in range.
					editing = { ...meta.startEdit };
				}

				if (meta?.stopEdit) {
					editing = null;
				}

				if (!regionsDirty) {
					return prev;
				}

				return rebuildState(newState.doc, unchecked, editing);
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
				},
				// Double-click on a body cell enters cell-edit mode for that
				// cell. We resolve the target (region open + row/col) from
				// the data attributes the renderer sprinkled on each
				// `<th>` / `<td>`.
				dblclick(view, event) {
					const target = event.target as HTMLElement;
					const cell = target.closest(
						'th[data-table-block-row], td[data-table-block-row]'
					) as HTMLElement | null;
					if (!cell) return false;
					const wrap = cell.closest('[data-table-block-open]') as HTMLElement | null;
					if (!wrap) return false;
					const open = Number(wrap.getAttribute('data-table-block-open'));
					const rowIdx = Number(cell.getAttribute('data-table-block-row'));
					const colIdx = Number(cell.getAttribute('data-table-block-col'));
					if (!Number.isFinite(open) || !Number.isFinite(rowIdx) || !Number.isFinite(colIdx)) {
						return false;
					}
					event.preventDefault();
					event.stopPropagation();
					view.dispatch(
						view.state.tr.setMeta(tableBlockPluginKey, {
							startEdit: { openFromPos: open, rowIdx, colIdx }
						} as Meta)
					);
					// Defer focus to the next tick so PM has had a chance to
					// re-render the widget with the contenteditable cell.
					queueMicrotask(() => focusEditingCell(view.dom));
					return true;
				},
				// Keys handled while inside the editing cell:
				//  - Enter (without shift): commit
				//  - Escape: cancel
				//  - Tab handling could be added later for cell-to-cell jumps.
				keydown(view, event) {
					const target = event.target as HTMLElement | null;
					if (!target?.closest('[data-table-block-editing="true"]')) return false;
					if (event.key === 'Enter' && !event.shiftKey) {
						event.preventDefault();
						event.stopPropagation();
						const text = target.closest('[data-table-block-editing="true"]')
							?.textContent ?? '';
						commitFromDom(view, text);
						return true;
					}
					if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						view.dispatch(
							view.state.tr.setMeta(tableBlockPluginKey, {
								stopEdit: true
							} as Meta)
						);
						return true;
					}
					return false;
				},
				focusout(view, event) {
					const target = event.target as HTMLElement | null;
					const cell = target?.closest(
						'[data-table-block-editing="true"]'
					) as HTMLElement | null;
					if (!cell) return false;
					// `relatedTarget` is the new focus owner; if it's still
					// inside the editor's DOM, ignore — the user might just
					// have dragged a selection and we don't want to commit
					// prematurely. Otherwise commit on blur.
					const next = (event as FocusEvent).relatedTarget as Node | null;
					if (next && view.dom.contains(next)) return false;
					commitFromDom(view, cell.textContent ?? '');
					return false;
				}
			}
		}
	});
}

/**
 * Read the active editing cell's textContent and dispatch a combined
 * commit transaction (replace + stopEdit). Used by Enter/blur paths.
 */
function commitFromDom(
	view: { state: EditorState; dispatch: (tr: Transaction) => void },
	newText: string
): void {
	const st = tableBlockPluginKey.getState(view.state);
	const editing = st?.editing;
	if (!editing) return;
	const region = st!.regions.find((r) => r.openFromPos === editing.openFromPos);
	if (!region) {
		view.dispatch(
			view.state.tr.setMeta(tableBlockPluginKey, { stopEdit: true } as Meta)
		);
		return;
	}
	const tr = commitCellEdit(
		view.state,
		region,
		editing.rowIdx,
		editing.colIdx,
		newText
	);
	if (!tr) {
		view.dispatch(
			view.state.tr.setMeta(tableBlockPluginKey, { stopEdit: true } as Meta)
		);
		return;
	}
	tr.setMeta(tableBlockPluginKey, { stopEdit: true } as Meta);
	view.dispatch(tr);
}

/**
 * After a startEdit dispatch, place focus inside the freshly rendered
 * `[data-table-block-editing="true"]` span and select all of its text
 * so the user can immediately overwrite or extend.
 */
function focusEditingCell(root: HTMLElement): void {
	const cell = root.querySelector(
		'[data-table-block-editing="true"]'
	) as HTMLElement | null;
	if (!cell) return;
	cell.focus();
	const sel = window.getSelection();
	if (!sel) return;
	const range = document.createRange();
	range.selectNodeContents(cell);
	sel.removeAllRanges();
	sel.addRange(range);
}
