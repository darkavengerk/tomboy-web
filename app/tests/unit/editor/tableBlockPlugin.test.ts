import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { DecorationSet } from '@tiptap/pm/view';
import {
	createTableBlockPlugin,
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
