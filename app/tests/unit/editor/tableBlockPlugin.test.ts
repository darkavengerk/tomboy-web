import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { DecorationSet } from '@tiptap/pm/view';
import {
	cancelCellEdit,
	commitCellEditCommand,
	createTableBlockPlugin,
	enterCellEdit,
	tableBlockPluginKey,
	toggleTableBlock
} from '$lib/editor/tableBlock/tableBlockPlugin.js';

let currentEditor: Editor | null = null;

function makeEditor(lines: string[]): Editor {
	const editor = new Editor({
		extensions: [
			Document,
			Paragraph,
			Text,
			Extension.create({
				name: 'tomboyTableBlock',
				addProseMirrorPlugins() {
					return [createTableBlockPlugin()];
				}
			})
		],
		content: {
			type: 'doc',
			content: lines.map((line) =>
				line.length === 0
					? { type: 'paragraph' }
					: { type: 'paragraph', content: [{ type: 'text', text: line }] }
			)
		}
	});
	currentEditor = editor;
	return editor;
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function getState(editor: Editor) {
	return tableBlockPluginKey.getState(editor.state);
}

describe('tableBlockPlugin — initial state', () => {
	it('exposes a DecorationSet from the get-go', () => {
		const ed = makeEditor(['hello']);
		expect(getState(ed)?.decorations).toBeInstanceOf(DecorationSet);
	});

	it('reports zero regions for plain text', () => {
		const ed = makeEditor(['plain text']);
		expect(getState(ed)?.regions).toEqual([]);
	});

	it('reports one region for a complete csv block', () => {
		const ed = makeEditor(['```csv', 'a, b', 'c, d', '```']);
		const regions = getState(ed)?.regions ?? [];
		expect(regions).toHaveLength(1);
		expect(regions[0].format).toBe('csv');
	});
});

describe('tableBlockPlugin — default-checked rendering', () => {
	it('emits a hide-decoration spanning the fenced range and a widget', () => {
		const ed = makeEditor(['```csv', 'a, b', '```']);
		const set = getState(ed)?.decorations as DecorationSet;
		const decos = set.find();
		// At least one widget (the table) and at least one inline-hide deco.
		const hide = decos.filter(
			(d) =>
				(d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class
					=== 'tomboy-table-block-hidden'
		);
		const widgets = decos.filter(
			(d) => (d as unknown as { type: { toDOM?: unknown } }).type.toDOM !== undefined
		);
		expect(hide.length).toBeGreaterThan(0);
		expect(widgets.length).toBeGreaterThan(0);
	});

	it('renders a table widget DOM element with rows from the source', () => {
		const ed = makeEditor(['```csv', '이름, 내용', '1, 표내용1', '```']);
		const set = getState(ed)?.decorations as DecorationSet;
		const widgetDeco = set
			.find()
			.find(
				(d) =>
					(d as unknown as { type: { toDOM?: unknown } }).type.toDOM !== undefined
			);
		expect(widgetDeco).toBeDefined();
		// @ts-expect-error — toDOM is the internal widget factory
		const dom = (widgetDeco!.type as { toDOM: (view: unknown) => HTMLElement }).toDOM({
			root: document
		});
		// Container should hold a <table> with the header and body cells.
		const table = dom.querySelector('table');
		expect(table).not.toBeNull();
		const cells = Array.from(table!.querySelectorAll('th, td')).map((el) =>
			el.textContent
		);
		expect(cells).toContain('이름');
		expect(cells).toContain('내용');
		expect(cells).toContain('표내용1');
	});

	it('renders a checkbox in the widget that is checked by default', () => {
		const ed = makeEditor(['```csv', 'a, b', '```']);
		const set = getState(ed)?.decorations as DecorationSet;
		const widgetDeco = set
			.find()
			.find(
				(d) =>
					(d as unknown as { type: { toDOM?: unknown } }).type.toDOM !== undefined
			);
		// @ts-expect-error — toDOM is the internal widget factory
		const dom = (widgetDeco!.type as { toDOM: (view: unknown) => HTMLElement }).toDOM({
			root: document
		});
		const cb = dom.querySelector(
			'input[type="checkbox"]'
		) as HTMLInputElement | null;
		expect(cb).not.toBeNull();
		expect(cb!.checked).toBe(true);
	});
});

describe('tableBlockPlugin — toggleTableBlock command', () => {
	it('marks a region unchecked → no hide decoration, raw paragraphs visible', () => {
		const ed = makeEditor(['```csv', 'a, b', '```']);
		const r0 = getState(ed)!.regions[0]!;
		toggleTableBlock(ed, r0.openFromPos);

		const set = getState(ed)!.decorations;
		const hide = set
			.find()
			.filter(
				(d) =>
					(d as unknown as { type: { attrs?: { class?: string } } }).type.attrs
						?.class === 'tomboy-table-block-hidden'
			);
		expect(hide).toHaveLength(0);
	});

	it('still emits a checkbox widget when unchecked, so the user can re-check', () => {
		const ed = makeEditor(['```csv', 'a, b', '```']);
		const r0 = getState(ed)!.regions[0]!;
		toggleTableBlock(ed, r0.openFromPos);

		const set = getState(ed)!.decorations;
		const widgets = set
			.find()
			.filter(
				(d) => (d as unknown as { type: { toDOM?: unknown } }).type.toDOM !== undefined
			);
		expect(widgets.length).toBeGreaterThan(0);

		// And the checkbox in that widget is unchecked now.
		const widgetDeco = widgets[0];
		// @ts-expect-error — toDOM is the internal widget factory
		const dom = (widgetDeco.type as { toDOM: (view: unknown) => HTMLElement }).toDOM({
			root: document
		});
		const cb = dom.querySelector(
			'input[type="checkbox"]'
		) as HTMLInputElement | null;
		expect(cb).not.toBeNull();
		expect(cb!.checked).toBe(false);
	});

	it('toggling twice returns to checked state', () => {
		const ed = makeEditor(['```csv', 'a, b', '```']);
		const r0 = getState(ed)!.regions[0]!;
		toggleTableBlock(ed, r0.openFromPos);
		toggleTableBlock(ed, r0.openFromPos);

		const hide = getState(ed)!
			.decorations.find()
			.filter(
				(d) =>
					(d as unknown as { type: { attrs?: { class?: string } } }).type.attrs
						?.class === 'tomboy-table-block-hidden'
			);
		expect(hide.length).toBeGreaterThan(0);
	});

	it('toggling one region does not affect another', () => {
		const ed = makeEditor([
			'```csv',
			'a, b',
			'```',
			'middle',
			'```tsv',
			'x\ty',
			'```'
		]);
		const [r0, r1] = getState(ed)!.regions;
		toggleTableBlock(ed, r0.openFromPos);

		const set = getState(ed)!.decorations;
		const hides = set
			.find()
			.filter(
				(d) =>
					(d as unknown as { type: { attrs?: { class?: string } } }).type.attrs
						?.class === 'tomboy-table-block-hidden'
			);
		// The second region still has its hide decoration.
		expect(hides.length).toBeGreaterThan(0);
		const r1Hidden = hides.some((h) => h.from <= r1.openFromPos && h.to >= r1.closeToPos);
		expect(r1Hidden).toBe(true);
	});
});

describe('tableBlockPlugin — hover-floating checkbox positioning', () => {
	function findWidget(editor: Editor) {
		const set = getState(editor)!.decorations;
		const all = set.find();
		return all.find(
			(d) => (d as unknown as { type: { toDOM?: unknown } }).type.toDOM !== undefined
		);
	}

	it('checked-mode widget sits at the region START so it overlays the hidden source', () => {
		// In checked mode the source paragraphs are hidden (display:none) and
		// the table widget renders in their place — the widget's natural flow
		// position must be the region's open-fence position so the table
		// appears where the user typed the fence.
		const ed = makeEditor(['intro', '```csv', 'a, b', '```']);
		const r0 = getState(ed)!.regions[0]!;
		const widget = findWidget(ed)!;
		expect(widget.from).toBe(r0.openFromPos);
	});

	it('unchecked-mode widget is INSIDE the open-fence paragraph (so it floats on its line)', () => {
		const ed = makeEditor(['intro', '```csv', 'a, b', '```']);
		const r0 = getState(ed)!.regions[0]!;
		toggleTableBlock(ed, r0.openFromPos);

		const widget = findWidget(ed)!;
		// In unchecked mode the source line is visible; the checkbox needs
		// to ride at the right edge of THAT line, so the widget is placed
		// INSIDE the open paragraph (one position past the paragraph's open
		// boundary) instead of ahead of it like in checked mode.
		expect(widget.from).toBeGreaterThan(r0.openFromPos);
		expect(widget.from).toBeLessThan(r0.openFromPos + (r0.openLine.length + 2));
	});

	it('the rendered widget DOM marks itself for hover-only visibility', () => {
		// Either via a `tomboy-table-block-toggle` (checked mode, absolute
		// inside the table widget) or `tomboy-table-block-floating` (unchecked
		// mode, floats on the source line). Both should be opacity:0 by
		// default; CSS unhides them on :hover. The DOM contract here is
		// just: the toggle wrapper element exists with one of those classes.
		const ed = makeEditor(['```csv', 'a, b', '```']);
		const widget = findWidget(ed)!;
		// @ts-expect-error — toDOM is the internal widget factory
		const dom = (widget.type as { toDOM: (view: unknown) => HTMLElement }).toDOM({
			root: document
		});
		const toggle = dom.querySelector(
			'.tomboy-table-block-toggle, .tomboy-table-block-floating'
		);
		expect(toggle).not.toBeNull();
	});
});

describe('tableBlockPlugin — cell content with marks', () => {
	function widgetDom(editor: Editor): HTMLElement {
		const widget = getState(editor)!
			.decorations.find()
			.find(
				(d) => (d as unknown as { type: { toDOM?: unknown } }).type.toDOM !== undefined
			)!;
		// @ts-expect-error — toDOM is the internal widget factory
		return (widget.type as { toDOM: (view: unknown) => HTMLElement }).toDOM({
			root: document
		});
	}

	// Editor extensions register the marks they need. We use TipTap's full
	// schema by including bold etc. via the Highlight + Bold marks below.
	// To avoid dragging in StarterKit, we declare the extensions ad-hoc.
	it('renders a bold cell as <strong> in the table', async () => {
		const { default: Bold } = await import('@tiptap/extension-bold');
		const editor = new Editor({
			extensions: [
				Document,
				Paragraph,
				Text,
				Bold,
				Extension.create({
					name: 'tomboyTableBlock',
					addProseMirrorPlugins() {
						return [createTableBlockPlugin()];
					}
				})
			],
			content: {
				type: 'doc',
				content: [
					{ type: 'paragraph', content: [{ type: 'text', text: '```csv' }] },
					{
						type: 'paragraph',
						content: [
							{ type: 'text', text: 'plain, ' },
							{ type: 'text', text: 'BOLD', marks: [{ type: 'bold' }] }
						]
					},
					{ type: 'paragraph', content: [{ type: 'text', text: '```' }] }
				]
			}
		});
		currentEditor = editor;
		const dom = widgetDom(editor);
		const strong = dom.querySelector('table strong');
		expect(strong?.textContent).toBe('BOLD');
	});

	it('renders an internal-link cell with data-link-target', async () => {
		const { TomboyInternalLink } = await import(
			'$lib/editor/extensions/TomboyInternalLink.js'
		);
		const editor = new Editor({
			extensions: [
				Document,
				Paragraph,
				Text,
				TomboyInternalLink.configure({
					getTitles: () => [{ title: 'Other Note', guid: 'g1' }]
				}),
				Extension.create({
					name: 'tomboyTableBlock',
					addProseMirrorPlugins() {
						return [createTableBlockPlugin()];
					}
				})
			],
			content: {
				type: 'doc',
				content: [
					{ type: 'paragraph', content: [{ type: 'text', text: '```csv' }] },
					{
						type: 'paragraph',
						content: [
							{ type: 'text', text: 'see, ' },
							{
								type: 'text',
								text: 'Other Note',
								marks: [
									{
										type: 'tomboyInternalLink',
										attrs: { target: 'Other Note' }
									}
								]
							}
						]
					},
					{ type: 'paragraph', content: [{ type: 'text', text: '```' }] }
				]
			}
		});
		currentEditor = editor;
		const dom = widgetDom(editor);
		const link = dom.querySelector(
			'table a[data-link-target="Other Note"]'
		) as HTMLAnchorElement | null;
		expect(link).not.toBeNull();
		expect(link!.textContent).toBe('Other Note');
	});

});

describe('tableBlockPlugin — cell-level edit mode', () => {
	function widgetDom(editor: Editor): HTMLElement {
		const w = getState(editor)!
			.decorations.find()
			.find(
				(d) => (d as unknown as { type: { toDOM?: unknown } }).type.toDOM !== undefined
			)!;
		// @ts-expect-error — toDOM is the internal widget factory
		return (w.type as { toDOM: (view: unknown) => HTMLElement }).toDOM({
			root: document
		});
	}

	it('starts with editing=null', () => {
		const ed = makeEditor(['```csv', 'a, b', '```']);
		expect(getState(ed)!.editing).toBeNull();
	});

	it('startEdit meta sets the editing state', () => {
		const ed = makeEditor(['```csv', 'alpha, beta', '```']);
		const r = getState(ed)!.regions[0]!;
		ed.view.dispatch(
			ed.state.tr.setMeta(tableBlockPluginKey, {
				startEdit: { openFromPos: r.openFromPos, rowIdx: 0, colIdx: 1 }
			})
		);
		const e = getState(ed)!.editing;
		expect(e).not.toBeNull();
		expect(e!.openFromPos).toBe(r.openFromPos);
		expect(e!.rowIdx).toBe(0);
		expect(e!.colIdx).toBe(1);
	});

	it('renders the editing cell as contenteditable=true and pre-fills its text', () => {
		const ed = makeEditor(['```csv', 'alpha, beta', '```']);
		const r = getState(ed)!.regions[0]!;
		ed.view.dispatch(
			ed.state.tr.setMeta(tableBlockPluginKey, {
				startEdit: { openFromPos: r.openFromPos, rowIdx: 0, colIdx: 1 }
			})
		);
		const dom = widgetDom(ed);
		const editing = dom.querySelector(
			'[data-table-block-editing="true"]'
		) as HTMLElement | null;
		expect(editing).not.toBeNull();
		expect(editing!.getAttribute('contenteditable')).toBe('true');
		expect(editing!.textContent).toBe('beta');
	});

	it('only the targeted cell is editable; the others remain plain', () => {
		const ed = makeEditor(['```csv', 'alpha, beta, gamma', '```']);
		const r = getState(ed)!.regions[0]!;
		ed.view.dispatch(
			ed.state.tr.setMeta(tableBlockPluginKey, {
				startEdit: { openFromPos: r.openFromPos, rowIdx: 0, colIdx: 1 }
			})
		);
		const dom = widgetDom(ed);
		const editingCells = dom.querySelectorAll('[contenteditable="true"]');
		expect(editingCells).toHaveLength(1);
	});

	it('stopEdit meta clears the editing state', () => {
		const ed = makeEditor(['```csv', 'alpha, beta', '```']);
		const r = getState(ed)!.regions[0]!;
		ed.view.dispatch(
			ed.state.tr.setMeta(tableBlockPluginKey, {
				startEdit: { openFromPos: r.openFromPos, rowIdx: 0, colIdx: 0 }
			})
		);
		ed.view.dispatch(
			ed.state.tr.setMeta(tableBlockPluginKey, { stopEdit: true })
		);
		expect(getState(ed)!.editing).toBeNull();
	});

	it('toggling the table off cancels any in-progress edit', () => {
		const ed = makeEditor(['```csv', 'alpha, beta', '```']);
		const r = getState(ed)!.regions[0]!;
		ed.view.dispatch(
			ed.state.tr.setMeta(tableBlockPluginKey, {
				startEdit: { openFromPos: r.openFromPos, rowIdx: 0, colIdx: 0 }
			})
		);
		toggleTableBlock(ed, r.openFromPos);
		expect(getState(ed)!.editing).toBeNull();
	});

	it('drops the edit state when the targeted region disappears', () => {
		const ed = makeEditor(['```csv', 'alpha, beta', '```']);
		const r = getState(ed)!.regions[0]!;
		ed.view.dispatch(
			ed.state.tr.setMeta(tableBlockPluginKey, {
				startEdit: { openFromPos: r.openFromPos, rowIdx: 0, colIdx: 0 }
			})
		);
		// Delete the closing fence so the region vanishes.
		ed.commands.deleteRange({
			from: r.closeToPos - 5,
			to: r.closeToPos
		});
		expect(getState(ed)!.regions).toEqual([]);
		expect(getState(ed)!.editing).toBeNull();
	});
});

describe('tableBlockPlugin — cell-edit commit / cancel helpers', () => {
	it('enterCellEdit puts the plugin into editing mode at the right slot', () => {
		const ed = makeEditor(['```csv', 'alpha, beta', '```']);
		const r = getState(ed)!.regions[0]!;
		enterCellEdit(ed, { openFromPos: r.openFromPos, rowIdx: 0, colIdx: 1 });
		expect(getState(ed)!.editing).toEqual({
			openFromPos: r.openFromPos,
			rowIdx: 0,
			colIdx: 1
		});
	});

	it('commitCellEditCommand replaces the cell text and exits edit mode', () => {
		const ed = makeEditor(['```csv', 'alpha, beta', '```']);
		const r = getState(ed)!.regions[0]!;
		enterCellEdit(ed, { openFromPos: r.openFromPos, rowIdx: 0, colIdx: 1 });
		const ok = commitCellEditCommand(ed, 'BETA');
		expect(ok).toBe(true);
		expect(getState(ed)!.editing).toBeNull();
		const after = getState(ed)!.regions[0];
		expect(after.rows).toEqual([['alpha', 'BETA']]);
	});

	it('commitCellEditCommand returns false when there is no active edit', () => {
		const ed = makeEditor(['```csv', 'alpha, beta', '```']);
		expect(commitCellEditCommand(ed, 'whatever')).toBe(false);
	});

	it('cancelCellEdit exits edit mode without modifying the doc', () => {
		const ed = makeEditor(['```csv', 'alpha, beta', '```']);
		const r = getState(ed)!.regions[0]!;
		enterCellEdit(ed, { openFromPos: r.openFromPos, rowIdx: 0, colIdx: 1 });
		const before = ed.state.doc.textContent;
		cancelCellEdit(ed);
		expect(getState(ed)!.editing).toBeNull();
		expect(ed.state.doc.textContent).toBe(before);
	});

	it('starting a new edit while one is active swaps to the new target without committing', () => {
		const ed = makeEditor(['```csv', 'alpha, beta', '```']);
		const r = getState(ed)!.regions[0]!;
		const before = ed.state.doc.textContent;
		enterCellEdit(ed, { openFromPos: r.openFromPos, rowIdx: 0, colIdx: 0 });
		enterCellEdit(ed, { openFromPos: r.openFromPos, rowIdx: 0, colIdx: 1 });
		expect(getState(ed)!.editing!.colIdx).toBe(1);
		// No commit happened — the doc text is unchanged.
		expect(ed.state.doc.textContent).toBe(before);
	});
});

describe('tableBlockPlugin — state across edits', () => {
	it('preserves unchecked status when content edits shift positions', () => {
		// Insert a leading paragraph BEFORE the fence so the table block's
		// open position shifts. Edits before a tracked position must move
		// the position with them via the transaction's mapping.
		const ed = makeEditor(['intro', '```csv', 'a, b', '```']);
		const r0 = getState(ed)!.regions[0]!;
		toggleTableBlock(ed, r0.openFromPos);

		// Insert a character into the "intro" paragraph, ahead of the fence.
		// This bumps every following position by 1.
		ed.commands.insertContentAt(1, 'X');

		const r0After = getState(ed)!.regions[0];
		expect(r0After).toBeDefined();
		const hides = getState(ed)!
			.decorations.find()
			.filter(
				(d) =>
					(d as unknown as { type: { attrs?: { class?: string } } }).type.attrs
						?.class === 'tomboy-table-block-hidden'
			);
		expect(hides).toHaveLength(0);
	});

	it('drops unchecked tracking once the region is destroyed (e.g. fence deleted)', () => {
		const ed = makeEditor(['```csv', 'a, b', '```']);
		const r0 = getState(ed)!.regions[0]!;
		toggleTableBlock(ed, r0.openFromPos);

		// Remove the closing fence paragraph — region disappears.
		ed.commands.deleteRange({ from: r0.closeToPos - 5, to: r0.closeToPos });
		expect(getState(ed)!.regions).toEqual([]);

		// Re-add a closing fence — the new region should default back to
		// CHECKED, because the previously-tracked unchecked position no
		// longer matches an opening fence.
		ed.commands.insertContentAt(ed.state.doc.content.size, '```');
		const after = getState(ed)!.regions;
		expect(after.length).toBeGreaterThan(0);
		const hides = getState(ed)!
			.decorations.find()
			.filter(
				(d) =>
					(d as unknown as { type: { attrs?: { class?: string } } }).type.attrs
						?.class === 'tomboy-table-block-hidden'
			);
		expect(hides.length).toBeGreaterThan(0);
	});
});
