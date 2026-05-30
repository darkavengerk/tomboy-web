import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import {
	findProcessBlocks,
	findProcessItems,
	findProcessItemAt
} from '$lib/editor/processRegion/regions.js';
import {
	moveProcessItem,
	insertProcessBlock
} from '$lib/editor/processRegion/commands.js';

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(doc: JSONContent): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem
		],
		content: doc
	});
	currentEditor = editor;
	return editor;
}

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});
const LI = (text: string): JSONContent => ({
	type: 'listItem',
	content: [P(text)]
});
const UL = (...items: string[]): JSONContent => ({
	type: 'bulletList',
	content: items.map(LI)
});
const OL = (...items: string[]): JSONContent => ({
	type: 'orderedList',
	content: items.map(LI)
});
const LI_NESTED = (text: string, nested: JSONContent): JSONContent => ({
	type: 'listItem',
	content: [P(text), nested]
});

/** Position of the first listItem whose first paragraph matches `text` (trimmed). */
function liPosByText(editor: Editor, text: string): number {
	let found = -1;
	editor.state.doc.descendants((node, pos) => {
		if (found >= 0) return false;
		if (
			node.type.name === 'listItem' &&
			node.firstChild?.textContent.trim() === text
		) {
			found = pos;
			return false;
		}
		return true;
	});
	return found;
}

/** Position of the first listItem in the top-level child at index `topIdx`. */
function firstLiPosInList(editor: Editor, topIdx: number): number {
	let pos = -1;
	let runningOffset = 0;
	let idx = 0;
	editor.state.doc.forEach((child) => {
		if (idx === topIdx) pos = runningOffset + 1;
		runningOffset += child.nodeSize;
		idx++;
	});
	return pos;
}

// -------------------------------------------------------------------------
// findProcessBlocks
// -------------------------------------------------------------------------

describe('findProcessBlocks', () => {
	it('returns empty when there is no Process header', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Hello')]
		});
		expect(findProcessBlocks(e.state.doc)).toHaveLength(0);
	});

	it('finds a Process…Complete block with intermediate stages', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('Process: 작업'),
				UL('a', 'b'),
				P('디자인'),
				UL('c'),
				P('Complete:'),
				UL('d')
			]
		});
		const blocks = findProcessBlocks(e.state.doc);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].stages).toHaveLength(3);
		expect(blocks[0].stages.map((s) => s.lists.length)).toEqual([1, 1, 1]);
	});

	it('requires a Complete terminal — a Process with no Complete is not a block', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Process: 작업'), UL('a'), P('디자인'), UL('b')]
		});
		expect(findProcessBlocks(e.state.doc)).toHaveLength(0);
	});

	it('accepts an intermediate stage with no list (empty column)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('Process: 작업'),
				UL('a'),
				P('리뷰'),
				P('Complete:'),
				UL('d')
			]
		});
		const blocks = findProcessBlocks(e.state.doc);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].stages).toHaveLength(3);
		// middle stage 리뷰 has no list
		expect(blocks[0].stages[1].lists).toHaveLength(0);
	});

	it('accepts an empty Complete stage (no following list)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Process: 작업'), UL('a'), P('Complete:')]
		});
		const blocks = findProcessBlocks(e.state.doc);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].stages).toHaveLength(2);
		expect(blocks[0].stages[1].lists).toHaveLength(0);
	});

	it('sets isFirst / isLast on the boundary stages', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('Process: 작업'),
				UL('a'),
				P('Mid'),
				UL('b'),
				P('Complete:'),
				UL('c')
			]
		});
		const stages = findProcessBlocks(e.state.doc)[0].stages;
		expect(stages.map((s) => s.isFirst)).toEqual([true, false, false]);
		expect(stages.map((s) => s.isLast)).toEqual([false, false, true]);
		expect(stages.map((s) => s.index)).toEqual([0, 1, 2]);
	});

	it('rejects Processing / Completed (no word boundary)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Processing notes'), UL('a'), P('Completed'), UL('b')]
		});
		expect(findProcessBlocks(e.state.doc)).toHaveLength(0);
	});

	it('never treats the title paragraph as the Process header', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Process: 작업'), UL('a'), P('Complete:')]
		});
		expect(findProcessBlocks(e.state.doc)).toHaveLength(0);
	});

	it('finds two independent Process blocks', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('Process: A'),
				UL('a'),
				P('Complete:'),
				P('Process: B'),
				UL('b'),
				P('Complete:')
			]
		});
		const blocks = findProcessBlocks(e.state.doc);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].stages).toHaveLength(2);
		expect(blocks[1].stages).toHaveLength(2);
	});
});

// -------------------------------------------------------------------------
// findProcessItems / findProcessItemAt
// -------------------------------------------------------------------------

describe('findProcessItems', () => {
	it('enumerates depth-1 items across every stage', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('Process: 작업'),
				UL('a', 'b'),
				P('Mid'),
				UL('c'),
				P('Complete:'),
				UL('d')
			]
		});
		const items = findProcessItems(findProcessBlocks(e.state.doc));
		expect(items.map((it) => it.liNode.textContent)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('does NOT descend into nested lists (depth-1 only)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('Process: 작업'),
				{
					type: 'bulletList',
					content: [LI_NESTED('parent', UL('child1', 'child2'))]
				},
				P('Complete:')
			]
		});
		const items = findProcessItems(findProcessBlocks(e.state.doc));
		// Only the depth-1 'parent' item; nested child1/child2 are ignored.
		expect(items).toHaveLength(1);
		expect(items[0].liNode.firstChild!.textContent).toBe('parent');
	});

	it('tags each item with its owning stage', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('Process: 작업'),
				UL('a'),
				P('Complete:'),
				UL('d')
			]
		});
		const items = findProcessItems(findProcessBlocks(e.state.doc));
		const a = items.find((it) => it.liNode.textContent === 'a')!;
		const d = items.find((it) => it.liNode.textContent === 'd')!;
		expect(a.stage.index).toBe(0);
		expect(a.stage.isFirst).toBe(true);
		expect(d.stage.index).toBe(1);
		expect(d.stage.isLast).toBe(true);
	});

	it('findProcessItemAt resolves the item at a liPos', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Process: 작업'), UL('a', 'b'), P('Complete:')]
		});
		const items = findProcessItems(findProcessBlocks(e.state.doc));
		const pos = liPosByText(e, 'b');
		expect(findProcessItemAt(items, pos)?.liNode.textContent).toBe('b');
		expect(findProcessItemAt(items, 0)).toBeNull();
	});
});

// -------------------------------------------------------------------------
// moveProcessItem
// -------------------------------------------------------------------------

describe('moveProcessItem', () => {
	it('moves an item to the next stage (append at end)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('Process: 작업'),
				UL('a', 'b'),
				P('Mid'),
				UL('c'),
				P('Complete:'),
				UL('d')
			]
		});
		const liPos = firstLiPosInList(e, 2); // 'a'
		expect(moveProcessItem(e, liPos, 'next')).toBe(true);
		// 'a' leaves Process list, lands at end of Mid's list.
		expect(e.state.doc.child(2).childCount).toBe(1);
		expect(e.state.doc.child(2).firstChild!.textContent).toBe('b');
		const midList = e.state.doc.child(4);
		expect(midList.childCount).toBe(2);
		expect(midList.lastChild!.textContent).toBe('a');
	});

	it('moves an item to the previous stage', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('Process: 작업'),
				UL('a'),
				P('Complete:'),
				UL('x', 'y')
			]
		});
		const liPos = firstLiPosInList(e, 4); // 'x' in Complete
		expect(moveProcessItem(e, liPos, 'prev')).toBe(true);
		const processList = e.state.doc.child(2);
		expect(processList.childCount).toBe(2);
		expect(processList.lastChild!.textContent).toBe('x');
		const completeList = e.state.doc.child(4);
		expect(completeList.childCount).toBe(1);
		expect(completeList.firstChild!.textContent).toBe('y');
	});

	it('emptying a stage removes its list but KEEPS the stage header', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Process: 작업'), UL('only'), P('Complete:')]
		});
		const liPos = firstLiPosInList(e, 2);
		expect(moveProcessItem(e, liPos, 'next')).toBe(true);
		// Process header survives; its emptied list is gone; Complete gains a list.
		expect(e.state.doc.child(1).textContent).toBe('Process: 작업');
		expect(e.state.doc.child(2).textContent).toBe('Complete:');
		expect(e.state.doc.child(3).type.name).toBe('bulletList');
		expect(e.state.doc.child(3).firstChild!.textContent).toBe('only');
		expect(e.state.doc.childCount).toBe(4);
	});

	it('creates a list in a listless target stage', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Process: 작업'), UL('a', 'b'), P('Complete:')]
		});
		const liPos = firstLiPosInList(e, 2); // 'a'
		expect(moveProcessItem(e, liPos, 'next')).toBe(true);
		// Process keeps [b]; Complete gets a fresh list with [a].
		expect(e.state.doc.child(2).childCount).toBe(1);
		expect(e.state.doc.child(2).firstChild!.textContent).toBe('b');
		expect(e.state.doc.child(3).textContent).toBe('Complete:');
		const completeList = e.state.doc.child(4);
		expect(completeList.type.name).toBe('bulletList');
		expect(completeList.firstChild!.textContent).toBe('a');
	});

	it('a created target list mirrors the source list type (orderedList)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Process: 작업'), OL('one'), P('Complete:')]
		});
		const liPos = firstLiPosInList(e, 2);
		expect(moveProcessItem(e, liPos, 'next')).toBe(true);
		expect(e.state.doc.child(3).type.name).toBe('orderedList');
	});

	it('no-op when moving next from the last stage', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Process: 작업'), UL('a'), P('Complete:'), UL('d')]
		});
		const liPos = firstLiPosInList(e, 4); // 'd' in Complete (last stage)
		expect(moveProcessItem(e, liPos, 'next')).toBe(false);
	});

	it('no-op when moving prev from the first stage', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Process: 작업'), UL('a'), P('Complete:'), UL('d')]
		});
		const liPos = firstLiPosInList(e, 2); // 'a' in Process (first stage)
		expect(moveProcessItem(e, liPos, 'prev')).toBe(false);
	});

	it('moves a middle-stage item both directions', () => {
		const mk = () =>
			makeEditor({
				type: 'doc',
				content: [
					P('Title'),
					P('Process: 작업'),
					UL('a'),
					P('Mid'),
					UL('b'),
					P('Complete:'),
					UL('c')
				]
			});

		// next: Mid → Complete. Mid's only item leaves, so Mid's emptied list
		// is removed and Complete's list shifts from index 6 to 5.
		let e = mk();
		let liPos = firstLiPosInList(e, 4);
		expect(moveProcessItem(e, liPos, 'next')).toBe(true);
		expect(e.state.doc.child(3).textContent).toBe('Mid'); // header survives
		expect(e.state.doc.child(5).lastChild!.textContent).toBe('b');

		// prev: Mid → Process
		e = mk();
		liPos = firstLiPosInList(e, 4);
		expect(moveProcessItem(e, liPos, 'prev')).toBe(true);
		expect(e.state.doc.child(2).lastChild!.textContent).toBe('b');
	});

	it('leaves siblings intact when moving one of several items', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Process: 작업'), UL('a', 'b', 'c'), P('Complete:')]
		});
		const liPos = liPosByText(e, 'b');
		expect(moveProcessItem(e, liPos, 'next')).toBe(true);
		const processList = e.state.doc.child(2);
		expect(processList.childCount).toBe(2);
		expect(processList.firstChild!.textContent).toBe('a');
		expect(processList.lastChild!.textContent).toBe('c');
	});
});

// -------------------------------------------------------------------------
// insertProcessBlock
// -------------------------------------------------------------------------

describe('insertProcessBlock', () => {
	it('inserts Process: + a starter list + Complete: after the caret block', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Body text')]
		});
		const bodyStart = e.state.doc.child(0).nodeSize + 1;
		e.commands.setTextSelection(bodyStart + 1);
		insertProcessBlock(e);
		expect(e.state.doc.childCount).toBe(5);
		expect(e.state.doc.child(2).textContent).toBe('Process: 작업 이름');
		expect(e.state.doc.child(3).type.name).toBe('bulletList');
		expect(e.state.doc.child(3).firstChild!.textContent).toBe('');
		expect(e.state.doc.child(4).textContent).toBe('Complete:');
	});

	it('produces a doc that parses back into one Process block', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('')]
		});
		e.commands.setTextSelection(e.state.doc.child(0).nodeSize + 1);
		insertProcessBlock(e);
		const blocks = findProcessBlocks(e.state.doc);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].stages).toHaveLength(2);
		expect(blocks[0].stages[0].isFirst).toBe(true);
		expect(blocks[0].stages[1].isLast).toBe(true);
	});

	it('replaces an empty non-title paragraph in place', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P(''), P('tail')]
		});
		const targetStart = e.state.doc.child(0).nodeSize + 1;
		e.commands.setTextSelection(targetStart);
		insertProcessBlock(e);
		// empty paragraph at index 1 replaced by [Process, UL, Complete]
		expect(e.state.doc.child(1).textContent).toBe('Process: 작업 이름');
		expect(e.state.doc.child(2).type.name).toBe('bulletList');
		expect(e.state.doc.child(3).textContent).toBe('Complete:');
		expect(e.state.doc.child(4).textContent).toBe('tail');
	});

	it('never replaces the title (index 0)', () => {
		const e = makeEditor({ type: 'doc', content: [P('')] });
		e.commands.setTextSelection(1);
		insertProcessBlock(e);
		expect(e.state.doc.child(0).textContent).toBe('');
		expect(e.state.doc.child(1).textContent).toBe('Process: 작업 이름');
	});

	it('selects the "작업 이름" placeholder so first keystroke replaces it', () => {
		const e = makeEditor({ type: 'doc', content: [P('Title'), P('')] });
		e.commands.setTextSelection(e.state.doc.child(0).nodeSize + 1);
		insertProcessBlock(e);
		const sel = e.state.selection;
		expect(sel.empty).toBe(false);
		const selected = e.state.doc.textBetween(sel.from, sel.to);
		expect(selected).toBe('작업 이름');
	});
});
