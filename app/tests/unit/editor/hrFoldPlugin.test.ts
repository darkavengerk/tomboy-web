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

	it('non-empty section HRs get the clickable-line class decoration', () => {
		const ed = makeEditor();
		// Both HRs own content → 2 line decorations.
		expect(classDecos(ed, 'tomboy-hr-fold-line')).toHaveLength(2);
	});

	it('empty-section HR gets no clickable-line class', () => {
		const ed = makeEditor(
			'<p>제목</p><p>날짜</p><p>intro</p><p>---</p><p>content</p><p>---</p>'
		);
		expect(classDecos(ed, 'tomboy-hr-fold-line')).toHaveLength(1);
	});
});

describe('hrFoldPlugin — plain click on the HR line toggles fold', () => {
	type ClickHandler = (
		this: unknown,
		view: unknown,
		pos: number,
		event: MouseEvent
	) => boolean;

	function foldHandleClick(ed: Editor): {
		plugin: unknown;
		handleClick: ClickHandler;
	} {
		const plugin = hrFoldPluginKey.get(ed.state);
		return {
			plugin,
			handleClick: plugin?.spec.props?.handleClick as ClickHandler
		};
	}

	it('plain click on an HR line folds its section', () => {
		const ed = makeEditor();
		const { plugin, handleClick } = foldHandleClick(ed);
		// HR ordinal 0 = top-level index 3.
		const hrPos = topLevelPos(ed, 3) + 1;
		const event = new MouseEvent('click');
		const handled = handleClick.call(plugin, ed.view, hrPos, event);
		expect(handled).toBe(true);
		expect(Array.from(getFoldedOrdinals(ed.state))).toEqual([0]);
	});

	it('plain click again unfolds', () => {
		const ed = makeEditor();
		const { plugin, handleClick } = foldHandleClick(ed);
		const hrPos = topLevelPos(ed, 3) + 1;
		handleClick.call(plugin, ed.view, hrPos, new MouseEvent('click'));
		handleClick.call(plugin, ed.view, hrPos, new MouseEvent('click'));
		expect(getFoldedOrdinals(ed.state).size).toBe(0);
	});

	it('Ctrl/Cmd+click is not claimed (reserved for split toggle)', () => {
		const ed = makeEditor();
		const { plugin, handleClick } = foldHandleClick(ed);
		const hrPos = topLevelPos(ed, 3) + 1;
		expect(
			handleClick.call(plugin, ed.view, hrPos, new MouseEvent('click', { ctrlKey: true }))
		).toBe(false);
		expect(
			handleClick.call(plugin, ed.view, hrPos, new MouseEvent('click', { metaKey: true }))
		).toBe(false);
		expect(getFoldedOrdinals(ed.state).size).toBe(0);
	});

	it('click on a regular block does nothing', () => {
		const ed = makeEditor();
		const { plugin, handleClick } = foldHandleClick(ed);
		// Index 4 = sec0 first (regular block).
		const blockPos = topLevelPos(ed, 4) + 1;
		const handled = handleClick.call(
			plugin,
			ed.view,
			blockPos,
			new MouseEvent('click')
		);
		expect(handled).toBe(false);
		expect(getFoldedOrdinals(ed.state).size).toBe(0);
	});

	it('click on an empty-section HR does nothing', () => {
		const ed = makeEditor(
			'<p>제목</p><p>날짜</p><p>intro</p><p>---</p><p>content</p><p>---</p>'
		);
		const { plugin, handleClick } = foldHandleClick(ed);
		// Trailing HR (index 5) owns nothing.
		const hrPos = topLevelPos(ed, 5) + 1;
		const handled = handleClick.call(
			plugin,
			ed.view,
			hrPos,
			new MouseEvent('click')
		);
		expect(handled).toBe(false);
		expect(getFoldedOrdinals(ed.state).size).toBe(0);
	});

	it('split active → line click is ignored (fold inert)', () => {
		const ed = makeEditor();
		ed.view.dispatch(ed.state.tr.setMeta(hrSplitPluginKey, { toggle: 0 }));
		const { plugin, handleClick } = foldHandleClick(ed);
		const hrPos = topLevelPos(ed, 6) + 1;
		const handled = handleClick.call(
			plugin,
			ed.view,
			hrPos,
			new MouseEvent('click')
		);
		expect(handled).toBe(false);
		expect(getFoldedOrdinals(ed.state).size).toBe(0);
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

describe('hrFoldPlugin — section box frame', () => {
	// DOC layout: 0 제목 · 1 날짜 · 2 intro(outside) · 3 ---(0) ·
	// 4 sec0-first · 5 sec0-rest · 6 ---(1) · 7 sec1-first.
	it('boxes every block from the first content --- to the last block', () => {
		const ed = makeEditor();
		// Indices 3..7 → 5 boxed blocks. (intro at index 2 is outside.)
		expect(classDecos(ed, 'tomboy-hr-box')).toHaveLength(5);
	});

	it('intro above the first --- is not boxed', () => {
		const ed = makeEditor();
		const introFrom = topLevelPos(ed, 2);
		expect(
			classDecos(ed, 'tomboy-hr-box').some(d => d.from === introFrom)
		).toBe(false);
	});

	it('top edge sits on the first content --- ', () => {
		const ed = makeEditor();
		const tops = classDecos(ed, 'tomboy-hr-box-top');
		expect(tops).toHaveLength(1);
		expect(tops[0].from).toBe(topLevelPos(ed, 3));
	});

	it('bottom edge sits on the last section block', () => {
		const ed = makeEditor();
		const bottoms = classDecos(ed, 'tomboy-hr-box-bottom');
		expect(bottoms).toHaveLength(1);
		expect(bottoms[0].from).toBe(topLevelPos(ed, 7));
	});

	it('box renders with nothing folded (independent of fold state)', () => {
		const ed = makeEditor();
		expect(getFoldedOrdinals(ed.state).size).toBe(0);
		expect(classDecos(ed, 'tomboy-hr-box').length).toBeGreaterThan(0);
	});

	it('the top --- carries both the fold-line and box classes', () => {
		const ed = makeEditor();
		const topDeco = foldDecorations(ed).find(
			d => d.from === topLevelPos(ed, 3) && typeof d.type.toDOM !== 'function'
		);
		const cls = topDeco?.type.attrs?.class ?? '';
		expect(cls).toContain('tomboy-hr-fold-line');
		expect(cls).toContain('tomboy-hr-box');
		expect(cls).toContain('tomboy-hr-box-top');
	});

	it('folding the last section moves the bottom edge to its clamped block', () => {
		// Last section has two blocks so the move is observable.
		const ed = makeEditor(
			'<p>제목</p><p>날짜</p><p>---</p><p>s0f</p><p>---</p><p>s1f</p><p>s1r</p>'
		);
		// Unfolded: bottom on the last block (index 6).
		expect(classDecos(ed, 'tomboy-hr-box-bottom')[0].from).toBe(
			topLevelPos(ed, 6)
		);
		toggleFold(ed, 1);
		// Index 6 hidden, index 5 (clamped first) is now the last visible block.
		const bottoms = classDecos(ed, 'tomboy-hr-box-bottom');
		expect(bottoms).toHaveLength(1);
		expect(bottoms[0].from).toBe(topLevelPos(ed, 5));
	});

	it('split active → no box decorations (whole fold set is inert)', () => {
		const ed = makeEditor();
		expect(classDecos(ed, 'tomboy-hr-box').length).toBeGreaterThan(0);
		ed.view.dispatch(ed.state.tr.setMeta(hrSplitPluginKey, { toggle: 0 }));
		expect(classDecos(ed, 'tomboy-hr-box')).toHaveLength(0);
	});

	it('a note with only a bare trailing --- gets no box', () => {
		const ed = makeEditor(
			'<p>제목</p><p>날짜</p><p>body</p><p>---</p>'
		);
		expect(classDecos(ed, 'tomboy-hr-box')).toHaveLength(0);
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
