import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import type { EditorState } from '@tiptap/pm/state';
import type { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
	createHrFoldPlugin,
	hrFoldPluginKey,
	getFoldedOrdinals
} from '$lib/editor/hrSplit/hrFoldPlugin.js';
import {
	createHrSplitPlugin,
	hrSplitPluginKey
} from '$lib/editor/hrSplit/hrSplitPlugin.js';

let currentEditor: Editor | null = null;

/** Doc layout (top-level index → content):
 *  0 제목 (header) · 1 날짜 (header) · 2 intro · 3 --- (HR ord 0) ·
 *  4 sec0-first · 5 sec0-rest · 6 --- (HR ord 1) · 7 sec1-first */
const DOC =
	'<p>제목</p><p>2026-06-02</p><p>intro</p><p>---</p>' +
	'<p>sec0 first</p><p>sec0 rest</p><p>---</p><p>sec1 first</p>';

function makeEditor(content: string = DOC): Editor {
	const editor = new Editor({
		extensions: [
			Document,
			Paragraph,
			Text,
			Extension.create({
				name: 'tomboyHrSplit',
				addProseMirrorPlugins() {
					return [createHrSplitPlugin()];
				}
			}),
			Extension.create({
				name: 'tomboyHrFold',
				addProseMirrorPlugins() {
					return [createHrFoldPlugin()];
				}
			})
		],
		content
	});
	currentEditor = editor;
	return editor;
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

type DecoWithType = Decoration & {
	type: { attrs?: { class?: string }; toDOM?: unknown };
};

function foldDecorations(editor: Editor): DecoWithType[] {
	const plugin = hrFoldPluginKey.get(editor.state);
	if (!plugin) return [];
	const fn = plugin.spec.props?.decorations as (
		this: unknown,
		state: EditorState
	) => DecorationSet | null;
	const set = fn.call(plugin, editor.state);
	return set ? (set.find() as DecoWithType[]) : [];
}

function widgetDecos(editor: Editor): DecoWithType[] {
	return foldDecorations(editor).filter(d => typeof d.type.toDOM === 'function');
}

function classDecos(editor: Editor, cls: string): DecoWithType[] {
	return foldDecorations(editor).filter(d =>
		(d.type.attrs?.class ?? '').includes(cls)
	);
}

function toggleFold(editor: Editor, ord: number): void {
	editor.view.dispatch(
		editor.state.tr.setMeta(hrFoldPluginKey, { toggle: ord })
	);
}

/** Doc position of the top-level child at `index` (start of node). */
function topLevelPos(editor: Editor, index: number): number {
	let pos = -1;
	editor.state.doc.forEach((_node, offset, idx) => {
		if (idx === index) pos = offset;
	});
	return pos;
}

describe('hrFoldPlugin — fold buttons', () => {
	it('emits one widget button per non-empty section HR', () => {
		const ed = makeEditor();
		// Both HRs (ordinals 0, 1) own content → 2 buttons.
		expect(widgetDecos(ed)).toHaveLength(2);
	});

	it('emits no button for an HR with an empty section', () => {
		// Trailing HR owns nothing.
		const ed = makeEditor(
			'<p>제목</p><p>날짜</p><p>intro</p><p>---</p><p>content</p><p>---</p>'
		);
		expect(widgetDecos(ed)).toHaveLength(1);
	});

	it('button DOM is a small button with +/− glyph', () => {
		const ed = makeEditor();
		const w = widgetDecos(ed)[0];
		const dom = (
			w.type as unknown as { toDOM: (view: unknown) => HTMLElement }
		).toDOM(ed.view);
		expect(dom.tagName).toBe('BUTTON');
		expect(dom.className).toContain('tomboy-hr-fold-btn');
		expect(dom.textContent).toBe('−');
	});
});

describe('hrFoldPlugin — folding a section', () => {
	it('toggle folds: first block clamped, rest hidden', () => {
		const ed = makeEditor();
		toggleFold(ed, 0);
		expect(Array.from(getFoldedOrdinals(ed.state))).toEqual([0]);
		// Section 0 = indices 4 (first), 5 (rest).
		expect(classDecos(ed, 'tomboy-hr-fold-clamped')).toHaveLength(1);
		expect(classDecos(ed, 'tomboy-hr-fold-hidden')).toHaveLength(1);
		// Section 1 untouched.
		const clamped = classDecos(ed, 'tomboy-hr-fold-clamped')[0];
		expect(clamped.from).toBe(topLevelPos(ed, 4));
	});

	it('toggle twice unfolds', () => {
		const ed = makeEditor();
		toggleFold(ed, 0);
		toggleFold(ed, 0);
		expect(getFoldedOrdinals(ed.state).size).toBe(0);
		expect(classDecos(ed, 'tomboy-hr-fold-clamped')).toHaveLength(0);
		expect(classDecos(ed, 'tomboy-hr-fold-hidden')).toHaveLength(0);
	});

	it('folding section 1 (last section, no trailing HR)', () => {
		const ed = makeEditor();
		toggleFold(ed, 1);
		// Section 1 has only one block (index 7) → clamped, nothing hidden.
		expect(classDecos(ed, 'tomboy-hr-fold-clamped')).toHaveLength(1);
		expect(classDecos(ed, 'tomboy-hr-fold-hidden')).toHaveLength(0);
		const clamped = classDecos(ed, 'tomboy-hr-fold-clamped')[0];
		expect(clamped.from).toBe(topLevelPos(ed, 7));
	});

	it('folded button shows + and unfolded shows −', () => {
		const ed = makeEditor();
		toggleFold(ed, 0);
		const doms = widgetDecos(ed).map(w =>
			(
				w.type as unknown as { toDOM: (view: unknown) => HTMLElement }
			).toDOM(ed.view)
		);
		const texts = doms.map(d => d.textContent).sort();
		expect(texts).toEqual(['+', '−']);
	});

	it('replace meta seeds folded set (note load)', () => {
		const ed = makeEditor();
		ed.view.dispatch(
			ed.state.tr.setMeta(hrFoldPluginKey, { replace: [1] })
		);
		expect(Array.from(getFoldedOrdinals(ed.state))).toEqual([1]);
	});

	it('doc change pruning drops out-of-range ordinals', () => {
		const ed = makeEditor();
		toggleFold(ed, 1);
		// Delete the second HR (index 6) and everything after it.
		const from = topLevelPos(ed, 6);
		ed.view.dispatch(ed.state.tr.delete(from, ed.state.doc.content.size));
		expect(getFoldedOrdinals(ed.state).size).toBe(0);
	});
});

describe('hrFoldPlugin — mutual exclusion with hrSplit', () => {
	it('split active → no fold decorations at all', () => {
		const ed = makeEditor();
		toggleFold(ed, 0);
		expect(foldDecorations(ed).length).toBeGreaterThan(0);
		// Activate split on HR ordinal 1.
		ed.view.dispatch(
			ed.state.tr.setMeta(hrSplitPluginKey, { toggle: 1 })
		);
		expect(foldDecorations(ed)).toHaveLength(0);
		// Fold state preserved (inert).
		expect(Array.from(getFoldedOrdinals(ed.state))).toEqual([0]);
	});

	it('split deactivated → fold decorations come back', () => {
		const ed = makeEditor();
		toggleFold(ed, 0);
		ed.view.dispatch(ed.state.tr.setMeta(hrSplitPluginKey, { toggle: 1 }));
		ed.view.dispatch(ed.state.tr.setMeta(hrSplitPluginKey, { toggle: 1 }));
		expect(classDecos(ed, 'tomboy-hr-fold-clamped')).toHaveLength(1);
	});

	it('folded section → split Ctrl+click toggle is ignored', () => {
		const ed = makeEditor();
		toggleFold(ed, 0);
		const splitPlugin = hrSplitPluginKey.get(ed.state);
		const handleClick = splitPlugin?.spec.props?.handleClick as (
			this: unknown,
			view: unknown,
			pos: number,
			event: MouseEvent
		) => boolean;
		// Ctrl+click on HR ordinal 1 (top-level index 6).
		const hrPos = topLevelPos(ed, 6) + 1;
		const event = new MouseEvent('click', { ctrlKey: true });
		const handled = handleClick.call(splitPlugin, ed.view, hrPos, event);
		expect(handled).toBe(false);
		expect(
			hrSplitPluginKey.getState(ed.state)?.activeOrdinals.size
		).toBe(0);
	});

	it('no folded sections → split Ctrl+click toggle works', () => {
		const ed = makeEditor();
		const splitPlugin = hrSplitPluginKey.get(ed.state);
		const handleClick = splitPlugin?.spec.props?.handleClick as (
			this: unknown,
			view: unknown,
			pos: number,
			event: MouseEvent
		) => boolean;
		const hrPos = topLevelPos(ed, 6) + 1;
		const event = new MouseEvent('click', { ctrlKey: true });
		const handled = handleClick.call(splitPlugin, ed.view, hrPos, event);
		expect(handled).toBe(true);
		expect(
			hrSplitPluginKey.getState(ed.state)?.activeOrdinals.has(1)
		).toBe(true);
	});
});

describe('hrFoldPlugin — onChange persistence callback', () => {
	it('fires onChange on toggle, not on replace', async () => {
		const calls: Array<{ folded: number[]; prev: number[] }> = [];
		const editor = new Editor({
			extensions: [
				Document,
				Paragraph,
				Text,
				Extension.create({
					name: 'tomboyHrSplit',
					addProseMirrorPlugins() {
						return [createHrSplitPlugin()];
					}
				}),
				Extension.create({
					name: 'tomboyHrFold',
					addProseMirrorPlugins() {
						return [
							createHrFoldPlugin({
								onChange: (folded, prev) => {
									calls.push({
										folded: Array.from(folded),
										prev: Array.from(prev)
									});
								}
							})
						];
					}
				})
			],
			content: DOC
		});
		currentEditor = editor;

		editor.view.dispatch(
			editor.state.tr.setMeta(hrFoldPluginKey, { replace: [0] })
		);
		editor.view.dispatch(
			editor.state.tr.setMeta(hrFoldPluginKey, { toggle: 1 })
		);
		// onChange is queued via microtask.
		await Promise.resolve();
		expect(calls).toHaveLength(1);
		expect(calls[0].folded.sort()).toEqual([0, 1]);
		expect(calls[0].prev).toEqual([0]);
	});
});
