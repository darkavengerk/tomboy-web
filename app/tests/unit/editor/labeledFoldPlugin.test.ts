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

function buttons(editor: Editor): DecoWithType[] {
	return foldDecos(editor).filter(d => typeof d.type.toDOM === 'function');
}

function hiddenDecos(editor: Editor): DecoWithType[] {
	return foldDecos(editor).filter(d =>
		(d.type.attrs?.class ?? '').includes('tomboy-labeled-fold-hidden')
	);
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
	it('default: buttons only on ≥2-member groups, nothing hidden', () => {
		const ed = makeEditor();
		expect(buttons(ed)).toHaveLength(2);
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
