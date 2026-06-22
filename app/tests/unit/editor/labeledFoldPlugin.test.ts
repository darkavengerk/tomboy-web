import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { EditorState } from '@tiptap/pm/state';
import type { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
	createLabeledFoldPlugin,
	labeledFoldPluginKey,
	getFocusedOrdinals
} from '$lib/editor/labeledDivider/labeledFoldPlugin.js';
import {
	createHrSplitPlugin,
	hrSplitPluginKey
} from '$lib/editor/hrSplit/hrSplitPlugin.js';

let currentEditor: Editor | null = null;

/** Doc (top-level index → content):
 *  0 제목(h) 1 날짜(h) 2 intro
 *  3 섹션1---(div ord0,grp0) 4 ul(a)
 *  5 섹션2---(div ord1,grp0) 6 ul(b)
 *  7 ---(hr → grp1)
 *  8 섹션3---(div ord2,grp1) 9 ul(c) */
const DOC =
	'<p>제목</p><p>2026-06-17</p><p>intro</p>' +
	'<p>섹션1 ---</p><ul><li><p>a</p></li></ul>' +
	'<p>섹션2 ---</p><ul><li><p>b</p></li></ul>' +
	'<p>---</p>' +
	'<p>섹션3 ---</p><ul><li><p>c</p></li></ul>';

function makeEditor(content: string = DOC): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit,
			Extension.create({
				name: 'tomboyHrSplit',
				addProseMirrorPlugins() {
					return [createHrSplitPlugin()];
				}
			}),
			Extension.create({
				name: 'tomboyLabeledFold',
				addProseMirrorPlugins() {
					return [createLabeledFoldPlugin()];
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

function foldDecos(editor: Editor): DecoWithType[] {
	const plugin = labeledFoldPluginKey.get(editor.state);
	if (!plugin) return [];
	const fn = plugin.spec.props?.decorations as (
		this: unknown,
		state: EditorState
	) => DecorationSet | null;
	const set = fn.call(plugin, editor.state);
	return set ? (set.find() as DecoWithType[]) : [];
}

/** Widget decorations (there should be none — toggle is the label click). */
function widgets(editor: Editor): DecoWithType[] {
	return foldDecos(editor).filter(d => typeof d.type.toDOM === 'function');
}

function foldableDecos(editor: Editor): DecoWithType[] {
	return foldDecos(editor).filter(d =>
		(d.type.attrs?.class ?? '').includes('tomboy-labeled-foldable')
	);
}

function hiddenDecos(editor: Editor): DecoWithType[] {
	return foldDecos(editor).filter(d =>
		(d.type.attrs?.class ?? '').includes('tomboy-labeled-fold-hidden')
	);
}

function classDecos(editor: Editor, cls: string): DecoWithType[] {
	return foldDecos(editor).filter(d =>
		(d.type.attrs?.class ?? '').includes(cls)
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

function toggle(editor: Editor, ord: number): void {
	editor.view.dispatch(
		editor.state.tr.setMeta(labeledFoldPluginKey, { toggle: ord })
	);
}

function focusedArr(editor: Editor): number[] {
	return Array.from(getFocusedOrdinals(editor.state)).sort((a, b) => a - b);
}

describe('labeledFoldPlugin', () => {
	it('default: foldable affordance on ≥2-member group dividers, no buttons', () => {
		const ed = makeEditor();
		// No widget buttons — the divider label is the toggle.
		expect(widgets(ed)).toHaveLength(0);
		// Two list-bearing members in grp0 → 2 foldable dividers.
		expect(foldableDecos(ed)).toHaveLength(2);
		expect(hiddenDecos(ed)).toHaveLength(0);
	});

	it('focusing ord0 hides its group siblings, not other groups', () => {
		const ed = makeEditor();
		toggle(ed, 0);
		expect(focusedArr(ed)).toEqual([0]);
		expect(hiddenDecos(ed)).toHaveLength(1);
	});

	it('closing the open member cycles to the next (wraps)', () => {
		const ed = makeEditor();
		toggle(ed, 0); // focus 0
		toggle(ed, 0); // close open → advance to 1
		expect(focusedArr(ed)).toEqual([1]);
		toggle(ed, 1); // close open → advance wraps to 0
		expect(focusedArr(ed)).toEqual([0]);
	});

	it('clicking a closed member jumps to it', () => {
		const ed = makeEditor();
		toggle(ed, 0);
		toggle(ed, 1);
		expect(focusedArr(ed)).toEqual([1]);
	});

	it('a <2-member group ignores toggles', () => {
		const ed = makeEditor();
		toggle(ed, 2);
		expect(focusedArr(ed)).toEqual([]);
	});

	it('group focus is independent across --- boundaries', () => {
		const ed = makeEditor();
		toggle(ed, 0);
		expect(focusedArr(ed)).toEqual([0]);
	});

	it('inert while hrSplit is active', () => {
		const ed = makeEditor();
		toggle(ed, 0);
		ed.view.dispatch(ed.state.tr.setMeta(hrSplitPluginKey, { toggle: 0 }));
		expect(foldDecos(ed)).toHaveLength(0);
	});

	it('reconcile prunes invalid ordinals on doc change', () => {
		const ed = makeEditor();
		ed.view.dispatch(
			ed.state.tr.setMeta(labeledFoldPluginKey, { replace: [99] })
		);
		expect(focusedArr(ed)).toEqual([99]);
		ed.view.dispatch(ed.state.tr.insertText('x', 1));
		expect(focusedArr(ed)).toEqual([]);
	});

	it('skips reconcile for editor-appended (normalization) transactions', () => {
		// A `replace` reseed can be immediately followed by an editor-appended
		// normalization transaction (e.g. StarterKit's trailing-node insert),
		// which is docChanged. Reconciling on it would prematurely prune the
		// just-seeded focus before the matching member is even parsed. The
		// plugin guards on PM's genuine `appendedTransaction` meta. A real
		// user edit (no such meta) still reconciles — covered above.
		const ed = makeEditor();
		ed.view.dispatch(
			ed.state.tr.setMeta(labeledFoldPluginKey, { replace: [99] })
		);
		const appended = ed.state.tr.insertText('x', 1);
		appended.setMeta('appendedTransaction', ed.state.tr);
		ed.view.dispatch(appended);
		// Still [99] — the appended transaction must NOT prune it.
		expect(focusedArr(ed)).toEqual([99]);
	});
});

describe('labeledFoldPlugin — accordion box frame', () => {
	// DOC: grp0 = idx 3(섹션1 div)·4(ul)·5(섹션2 div)·6(ul) — 2 members → boxed.
	//      grp1 = idx 8(섹션3 div)·9(ul) — 1 member → no box.
	it('boxes only the ≥2-member group: idx 3..6 → 4 blocks', () => {
		const ed = makeEditor();
		expect(classDecos(ed, 'tomboy-labeled-box')).toHaveLength(4);
	});

	it('top edge on the first member divider, bottom on the last list', () => {
		const ed = makeEditor();
		const tops = classDecos(ed, 'tomboy-labeled-box-top');
		const bottoms = classDecos(ed, 'tomboy-labeled-box-bottom');
		expect(tops).toHaveLength(1);
		expect(tops[0].from).toBe(topLevelPos(ed, 3));
		expect(bottoms).toHaveLength(1);
		expect(bottoms[0].from).toBe(topLevelPos(ed, 6));
	});

	it('the single-member group (grp1) and intro are not boxed', () => {
		const ed = makeEditor();
		const froms = classDecos(ed, 'tomboy-labeled-box').map(d => d.from);
		expect(froms).not.toContain(topLevelPos(ed, 2)); // intro
		expect(froms).not.toContain(topLevelPos(ed, 8)); // 섹션3 divider
		expect(froms).not.toContain(topLevelPos(ed, 9)); // its list
	});

	it('the top divider node carries both box and box-top classes', () => {
		const ed = makeEditor();
		const topDeco = foldDecos(ed).find(
			d => d.from === topLevelPos(ed, 3) && typeof d.type.toDOM !== 'function'
		);
		const cls = topDeco?.type.attrs?.class ?? '';
		expect(cls).toContain('tomboy-labeled-box');
		expect(cls).toContain('tomboy-labeled-box-top');
	});

	it('focusing the first member moves the bottom edge up to the next divider', () => {
		const ed = makeEditor();
		toggle(ed, 0); // ord1 list (idx 6) hidden
		const bottoms = classDecos(ed, 'tomboy-labeled-box-bottom');
		expect(bottoms).toHaveLength(1);
		expect(bottoms[0].from).toBe(topLevelPos(ed, 5)); // 섹션2 divider
		// The box still covers all 4 blocks (idx 6 is box + hidden).
		expect(classDecos(ed, 'tomboy-labeled-box')).toHaveLength(4);
	});

	it('focusing the last member keeps the bottom on its list', () => {
		const ed = makeEditor();
		toggle(ed, 1); // ord0 list (idx 4) hidden; idx 6 visible
		expect(classDecos(ed, 'tomboy-labeled-box-bottom')[0].from).toBe(
			topLevelPos(ed, 6)
		);
	});

	it('inert while hrSplit is active → no box decorations', () => {
		const ed = makeEditor();
		expect(classDecos(ed, 'tomboy-labeled-box').length).toBeGreaterThan(0);
		ed.view.dispatch(ed.state.tr.setMeta(hrSplitPluginKey, { toggle: 0 }));
		expect(classDecos(ed, 'tomboy-labeled-box')).toHaveLength(0);
	});
});

describe('labeledFoldPlugin — click the divider label to toggle', () => {
	type ClickHandler = (
		this: unknown,
		view: unknown,
		pos: number,
		event: MouseEvent
	) => boolean;

	function clicker(ed: Editor): { plugin: unknown; handleClick: ClickHandler } {
		const plugin = labeledFoldPluginKey.get(ed.state);
		return {
			plugin,
			handleClick: plugin?.spec.props?.handleClick as ClickHandler
		};
	}

	function clickDivider(ed: Editor, topIndex: number, opts?: MouseEventInit) {
		const { plugin, handleClick } = clicker(ed);
		const pos = topLevelPos(ed, topIndex) + 1;
		return handleClick.call(plugin, ed.view, pos, new MouseEvent('click', opts));
	}

	it('clicking a member divider focuses it (jumps)', () => {
		const ed = makeEditor();
		// idx 5 = 섹션2 divider (ord1), currently all-open → jump focus to it.
		const handled = clickDivider(ed, 5);
		expect(handled).toBe(true);
		expect(focusedArr(ed)).toEqual([1]);
	});

	it('clicking the open member cycles to the next (wrap)', () => {
		const ed = makeEditor();
		clickDivider(ed, 3); // focus ord0
		expect(focusedArr(ed)).toEqual([0]);
		clickDivider(ed, 3); // open member clicked again → advance to ord1
		expect(focusedArr(ed)).toEqual([1]);
	});

	it('Ctrl/Cmd+click is not claimed (reserved for split)', () => {
		const ed = makeEditor();
		expect(clickDivider(ed, 3, { ctrlKey: true })).toBe(false);
		expect(clickDivider(ed, 3, { metaKey: true })).toBe(false);
		expect(focusedArr(ed)).toEqual([]);
	});

	it('clicking a non-divider block does nothing', () => {
		const ed = makeEditor();
		expect(clickDivider(ed, 2)).toBe(false); // intro paragraph
		expect(focusedArr(ed)).toEqual([]);
	});

	it('clicking a single-member group divider does nothing', () => {
		const ed = makeEditor();
		// idx 8 = 섹션3 divider, grp1 has only 1 member.
		expect(clickDivider(ed, 8)).toBe(false);
		expect(focusedArr(ed)).toEqual([]);
	});

	it('inert while hrSplit is active', () => {
		const ed = makeEditor();
		ed.view.dispatch(ed.state.tr.setMeta(hrSplitPluginKey, { toggle: 0 }));
		expect(clickDivider(ed, 3)).toBe(false);
		expect(focusedArr(ed)).toEqual([]);
	});
});
