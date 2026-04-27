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
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Editor, JSONContent } from '@tiptap/core';
import { findTableRegions, type TableRegion } from './findTableRegions.js';
import { renderInlinesToDom } from './renderInlines.js';
import { commitCellEdit, findCellEditRange } from './cellEdit.js';
import {
	appendColOp,
	appendRowOp,
	deleteColOp,
	deleteRowOp
} from './tableOps.js';

export interface CellEditTarget {
	openFromPos: number;
	rowIdx: number;
	colIdx: number;
}

interface PluginState {
	regions: TableRegion[];
	uncheckedOpens: Set<number>;
	editing: CellEditTarget | null;
	/** True while Ctrl is held — gates the structural-edit chrome (X
	 *  buttons on cells, + buttons on the table edges). */
	ctrlHeld: boolean;
	decorations: DecorationSet;
}

interface Meta {
	/** Toggle the region whose opening-fence position matches `openFromPos`. */
	toggleAt?: number;
	/** Enter cell-edit mode for `(openFromPos, rowIdx, colIdx)`. */
	startEdit?: CellEditTarget;
	/** Exit cell-edit mode (commit done by the caller's preceding tr). */
	stopEdit?: true;
	/** Set the ctrl-held flag. */
	setCtrl?: boolean;
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
	prevEditing: CellEditTarget | null,
	ctrlHeld: boolean
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
	const decorations = buildDecorations(doc, regions, uncheckedOpens, editing, ctrlHeld);
	return { regions, uncheckedOpens, editing, ctrlHeld, decorations };
}

function buildDecorations(
	doc: PMNode,
	regions: TableRegion[],
	uncheckedOpens: Set<number>,
	editing: CellEditTarget | null,
	ctrlHeld: boolean
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
			// Ctrl-mode chrome only renders when Ctrl is held AND no cell
			// edit is in progress (so the user isn't bombarded with action
			// buttons over the cell they're typing into).
			const showCtrlChrome = ctrlHeld && !editingHere;
			decos.push(
				Decoration.widget(
					r.openFromPos,
					(view) =>
						renderTableWidget(
							view,
							r,
							editingHere,
							editingText ?? '',
							showCtrlChrome
						),
					{
						side: -1,
						key: `tableBlock:${r.openFromPos}:on:${
							editingHere
								? `${editingHere.rowIdx}:${editingHere.colIdx}`
								: 'none'
						}:${showCtrlChrome ? 'ctrl' : 'plain'}`
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
	view: EditorView,
	region: TableRegion,
	editingHere: CellEditTarget | null,
	editingText: string,
	showCtrlChrome: boolean
): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'tomboy-table-block-widget';
	if (editingHere) wrap.classList.add('tomboy-table-block-editing');
	if (showCtrlChrome) wrap.classList.add('tomboy-table-block-ctrl');
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

	wrap.appendChild(
		renderTable(view, region, editingHere, editingText, showCtrlChrome)
	);

	if (showCtrlChrome) {
		// Append-row + button: positioned below the table, aligned with
		// the first column. Append-col + button: at the top-right outside
		// the table on the header row's line. Both are absolute-positioned
		// against the widget wrapper (CSS).
		wrap.appendChild(
			makeActionButton(view, region, 'add-row', '+', '행 추가')
		);
		wrap.appendChild(
			makeActionButton(view, region, 'add-col', '+', '열 추가')
		);
	}

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
	view: EditorView,
	region: TableRegion,
	editingHere: CellEditTarget | null,
	editingText: string,
	showCtrlChrome: boolean
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
	const lastColIdx = colCount - 1;
	const thead = document.createElement('thead');
	const headTr = document.createElement('tr');
	const headRow = region.cells[0];
	for (let c = 0; c < colCount; c++) {
		const th = document.createElement('th');
		fillCell(
			view,
			th,
			headRow[c],
			0,
			c,
			lastColIdx,
			editingHere,
			editingText,
			showCtrlChrome,
			region
		);
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
				fillCell(
					view,
					td,
					row[c],
					i,
					c,
					lastColIdx,
					editingHere,
					editingText,
					showCtrlChrome,
					region
				);
				tr.appendChild(td);
			}
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
	}
	return table;
}

function fillCell(
	view: EditorView,
	host: HTMLElement,
	inlines: JSONContent[] | undefined,
	rowIdx: number,
	colIdx: number,
	lastColIdx: number,
	editingHere: CellEditTarget | null,
	editingText: string,
	showCtrlChrome: boolean,
	region: TableRegion
): void {
	host.setAttribute('data-table-block-row', String(rowIdx));
	host.setAttribute('data-table-block-col', String(colIdx));
	const isEditing =
		!!editingHere &&
		editingHere.rowIdx === rowIdx &&
		editingHere.colIdx === colIdx;
	if (isEditing) {
		host.appendChild(buildEditingCell(view, editingText));
		return;
	}
	if (inlines && inlines.length > 0) {
		host.appendChild(renderInlinesToDom(inlines));
	}
	if (!showCtrlChrome) return;
	// Header row: column-delete X on every cell.
	if (rowIdx === 0) {
		host.appendChild(
			makeCellActionButton(view, region, 'del-col', colIdx, '×', '열 삭제')
		);
	}
	// Last cell of every row: row-delete X.
	if (colIdx === lastColIdx) {
		host.appendChild(
			makeCellActionButton(view, region, 'del-row', rowIdx, '×', '행 삭제')
		);
	}
}

/**
 * Build a small per-cell action button (column-delete X, row-delete X).
 * `index` identifies the row or column the action targets. The action
 * runs immediately on click — there's no separate confirmation since
 * the user can undo via Ctrl+Z.
 */
function makeCellActionButton(
	view: EditorView,
	region: TableRegion,
	action: 'del-row' | 'del-col',
	index: number,
	glyph: string,
	title: string
): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = `tomboy-table-block-action tomboy-table-block-${action}`;
	btn.setAttribute('data-table-block-action', action);
	btn.setAttribute('data-table-block-index', String(index));
	btn.setAttribute('contenteditable', 'false');
	btn.title = title;
	btn.textContent = glyph;
	btn.addEventListener('mousedown', (e) => {
		// Keep PM's selection where it was — don't move it onto the
		// button's anchor.
		e.preventDefault();
	});
	btn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		const tr =
			action === 'del-row'
				? deleteRowOp(view.state, currentRegionFor(view, region), index)
				: deleteColOp(view.state, currentRegionFor(view, region), index);
		if (tr) view.dispatch(tr);
	});
	return btn;
}

/**
 * Build a table-edge action button (append-row +, append-col +).
 */
function makeActionButton(
	view: EditorView,
	region: TableRegion,
	action: 'add-row' | 'add-col',
	glyph: string,
	title: string
): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = `tomboy-table-block-action tomboy-table-block-${action}`;
	btn.setAttribute('data-table-block-action', action);
	btn.setAttribute('contenteditable', 'false');
	btn.title = title;
	btn.textContent = glyph;
	btn.addEventListener('mousedown', (e) => {
		e.preventDefault();
	});
	btn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		const cur = currentRegionFor(view, region);
		const tr =
			action === 'add-row' ? appendRowOp(view.state, cur) : appendColOp(view.state, cur);
		view.dispatch(tr);
	});
	return btn;
}

/**
 * The widget closure captures a snapshot of the region from when it was
 * rendered, but by the time a button is clicked the region's positions
 * may have shifted. Resolve the current region (matched by its open
 * fence position) from the live plugin state. Falls back to the
 * captured snapshot if the live lookup fails — keeps tests that don't
 * round-trip through the plugin's state working.
 */
function currentRegionFor(view: EditorView, fallback: TableRegion): TableRegion {
	const st = tableBlockPluginKey.getState(view.state);
	const live = st?.regions.find((r) => r.openFromPos === fallback.openFromPos);
	return live ?? fallback;
}

/**
 * Build the contenteditable span for an active cell edit, with all its
 * keyboard / blur handlers attached directly. Going through a direct
 * listener (rather than the plugin's `handleDOMEvents`) lets us call
 * `stopPropagation` BEFORE the event bubbles past the editor — needed so
 * outer Escape consumers (e.g. the desktop note-window's close-on-Esc)
 * don't fire while the user is just cancelling a cell edit.
 *
 * Behaviour:
 *  - Enter (no shift): commit the typed text. Stop propagation.
 *  - Escape: cancel the edit (revert to pre-edit text). Stop propagation.
 *  - blur: cancel the edit (per UX: focus leaving = abandon).
 *  - Other keys: bubble normally so PM's input handling applies inside
 *    the contenteditable span (typing chars, arrow keys, etc.).
 */
function buildEditingCell(view: EditorView, initialText: string): HTMLElement {
	const span = document.createElement('span');
	span.className = 'tomboy-table-block-cell-editor';
	span.setAttribute('contenteditable', 'true');
	span.setAttribute('data-table-block-editing', 'true');
	span.textContent = initialText;

	span.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			commitFromDom(view, span.textContent ?? '');
			return;
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			cancelFromDom(view);
			return;
		}
		// All other keys: prevent leakage to outer handlers (note-window
		// shortcuts) but let the browser handle text input natively
		// inside this contenteditable span.
		e.stopPropagation();
	});

	// Browser blur fires when focus leaves. Cancel-on-blur matches the
	// "abandon on click-away" UX the user asked for.
	span.addEventListener('blur', () => {
		const st = tableBlockPluginKey.getState(view.state);
		if (!st?.editing) return;
		cancelFromDom(view);
	});

	return span;
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

/**
 * Push the latest ctrl-held state into the plugin. The TomboyEditor
 * Svelte component drives this from the global `modKeys.ctrl` rune so
 * the plugin's chrome reacts to physical Ctrl + the mobile Ctrl-lock.
 */
export function setCtrlHeld(editor: Editor, value: boolean): void {
	const st = tableBlockPluginKey.getState(editor.state);
	if (!st || st.ctrlHeld === value) return;
	editor.view.dispatch(
		editor.state.tr.setMeta(tableBlockPluginKey, { setCtrl: value } as Meta)
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
				return rebuildState(state.doc, new Set(), null, false);
			},
			apply(tr, prev, _oldState, newState): PluginState {
				const meta = tr.getMeta(tableBlockPluginKey) as Meta | undefined;
				let unchecked = prev.uncheckedOpens;
				let editing: CellEditTarget | null = prev.editing;
				let ctrlHeld = prev.ctrlHeld;
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

				if (typeof meta?.setCtrl === 'boolean') {
					ctrlHeld = meta.setCtrl;
				}

				if (!regionsDirty) {
					return prev;
				}

				return rebuildState(newState.doc, unchecked, editing, ctrlHeld);
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
				// `<th>` / `<td>`. The Enter / Escape / blur handlers are
				// attached directly on the editing cell DOM (see
				// `buildEditingCell`) so they can stop propagation BEFORE
				// outer Esc consumers (e.g. the desktop note-window) fire.
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
				}
			}
		}
	});
}

/**
 * Read the active editing cell's textContent and dispatch a combined
 * commit transaction (replace + stopEdit). Used by the Enter handler.
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

/** Drop the in-progress cell edit without modifying the doc. */
function cancelFromDom(view: {
	state: EditorState;
	dispatch: (tr: Transaction) => void;
}): void {
	view.dispatch(
		view.state.tr.setMeta(tableBlockPluginKey, { stopEdit: true } as Meta)
	);
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
