import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import {
	findTodoRegions,
	pairTodoRegions,
	regionContainingPos
} from '$lib/editor/todoRegion/regions.js';
import {
	moveTodoItem,
	insertTodoBlock
} from '$lib/editor/todoRegion/commands.js';

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

function firstLiPosInList(editor: Editor, topIdx: number): number {
	let pos = -1;
	let runningOffset = 0;
	let idx = 0;
	editor.state.doc.forEach((child) => {
		if (idx === topIdx) {
			// Inside the list: +1 past list's opening token.
			pos = runningOffset + 1;
		}
		runningOffset += child.nodeSize;
		idx++;
	});
	return pos;
}

// -------------------------------------------------------------------------
// findTodoRegions
// -------------------------------------------------------------------------

describe('findTodoRegions', () => {
	it('returns empty when there is no header', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Hello')]
		});
		expect(findTodoRegions(e.state.doc)).toHaveLength(0);
	});

	it('finds a plain TODO header followed by a list', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('TODO'), UL('a', 'b')]
		});
		const regions = findTodoRegions(e.state.doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].kind).toBe('TODO');
		expect(regions[0].lists).toHaveLength(1);
	});

	it('accepts `TODO: description` and `Done — note` as headers', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO: urgent stuff'),
				UL('a'),
				P('Done — 2026'),
				UL('x')
			]
		});
		const regions = findTodoRegions(e.state.doc);
		expect(regions.map((r) => r.kind)).toEqual(['TODO', 'Done']);
	});

	it('merges consecutive lists into a single region', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('TODO'), UL('a'), UL('b'), OL('c')]
		});
		const regions = findTodoRegions(e.state.doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].lists).toHaveLength(3);
	});

	it('rejects TODOLIST (no word boundary)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('TODOLIST'), UL('a')]
		});
		expect(findTodoRegions(e.state.doc)).toHaveLength(0);
	});

	it('rejects a header with no following list', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('TODO'), P('just prose')]
		});
		expect(findTodoRegions(e.state.doc)).toHaveLength(0);
	});

	it('never treats the title paragraph as a header', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('TODO'), UL('a')]
		});
		expect(findTodoRegions(e.state.doc)).toHaveLength(0);
	});

	it('rejects lowercase `todo` / `done`', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('todo'), UL('a'), P('done'), UL('b')]
		});
		expect(findTodoRegions(e.state.doc)).toHaveLength(0);
	});
});

// -------------------------------------------------------------------------
// pairTodoRegions
// -------------------------------------------------------------------------

describe('pairTodoRegions', () => {
	it('pairs each TODO with the next Done', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('TODO'), UL('a'), P('Done'), UL('b')]
		});
		const regions = findTodoRegions(e.state.doc);
		const pairs = pairTodoRegions(regions);
		expect(pairs.get(regions[0])).toBe(regions[1]);
		expect(pairs.get(regions[1])).toBe(regions[0]);
	});

	it('leaves a lone Done unpaired', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Done'), UL('a')]
		});
		const regions = findTodoRegions(e.state.doc);
		const pairs = pairTodoRegions(regions);
		expect(pairs.size).toBe(0);
	});

	it('multi-pair: TODO1↔Done1, TODO2↔Done2', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				UL('a'),
				P('Done'),
				UL('b'),
				P('TODO'),
				UL('c'),
				P('Done'),
				UL('d')
			]
		});
		const regions = findTodoRegions(e.state.doc);
		const pairs = pairTodoRegions(regions);
		expect(pairs.get(regions[0])).toBe(regions[1]);
		expect(pairs.get(regions[2])).toBe(regions[3]);
	});
});

// -------------------------------------------------------------------------
// moveTodoItem
// -------------------------------------------------------------------------

describe('moveTodoItem', () => {
	it('moves first item from TODO to existing Done (append at end)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				UL('a', 'b'),
				P('Done'),
				UL('x')
			]
		});
		const liPos = firstLiPosInList(e, 2);
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);
		const todoList = e.state.doc.child(2);
		const doneList = e.state.doc.child(4);
		expect(todoList.childCount).toBe(1);
		expect(todoList.firstChild!.textContent).toBe('b');
		expect(doneList.childCount).toBe(2);
		expect(doneList.lastChild!.textContent).toBe('a');
	});

	it('moving the only item to a missing Done collapses the TODO region', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('TODO'), UL('only')]
		});
		const liPos = firstLiPosInList(e, 2);
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);
		// TODO header + list are gone; Done takes their slot.
		expect(e.state.doc.childCount).toBe(3);
		expect(e.state.doc.child(0).textContent).toBe('Title');
		expect(e.state.doc.child(1).textContent).toBe('Done');
		expect(e.state.doc.child(2).firstChild!.textContent).toBe('only');
	});

	it('created Done list matches source list type (orderedList)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('TODO'), OL('one')]
		});
		const liPos = firstLiPosInList(e, 2);
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);
		expect(e.state.doc.child(2).type.name).toBe('orderedList');
	});

	it('last TODO item → existing Done: TODO region disappears entirely', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				UL('only'),
				P('Done'),
				UL('x')
			]
		});
		const liPos = firstLiPosInList(e, 2);
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);
		// Title, Done, UL[x, only]. No TODO header or empty list remains.
		expect(e.state.doc.childCount).toBe(3);
		expect(e.state.doc.child(1).textContent).toBe('Done');
		const doneList = e.state.doc.child(2);
		expect(doneList.childCount).toBe(2);
		expect(doneList.lastChild!.textContent).toBe('only');
	});

	it('last Done item → TODO: Done region disappears entirely', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				UL('a'),
				P('Done'),
				UL('only')
			]
		});
		const liPos = firstLiPosInList(e, 4);
		expect(moveTodoItem(e, liPos, 'Done')).toBe(true);
		expect(e.state.doc.childCount).toBe(3);
		expect(e.state.doc.child(1).textContent).toBe('TODO');
		const todoList = e.state.doc.child(2);
		expect(todoList.childCount).toBe(2);
		expect(todoList.lastChild!.textContent).toBe('only');
	});

	it('multi-list region: empties only one list, keeps header + siblings', () => {
		// Two consecutive bulletLists form a single region. Moving the only
		// item in the first list should drop that list but leave the header
		// and the second list alone.
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				UL('solo'), // will become empty → deleted
				UL('b'),
				P('Done'),
				UL('x')
			]
		});
		const liPos = firstLiPosInList(e, 2);
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);
		// Title, TODO, UL[b], Done, UL[x, solo]
		expect(e.state.doc.childCount).toBe(5);
		expect(e.state.doc.child(1).textContent).toBe('TODO');
		expect(e.state.doc.child(2).type.name).toBe('bulletList');
		expect(e.state.doc.child(2).firstChild!.textContent).toBe('b');
		expect(e.state.doc.child(3).textContent).toBe('Done');
		expect(e.state.doc.child(4).lastChild!.textContent).toBe('solo');
	});

	it('moves an item back from Done to paired TODO', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				UL('a'),
				P('Done'),
				UL('x', 'y')
			]
		});
		const liPos = firstLiPosInList(e, 4);
		expect(moveTodoItem(e, liPos, 'Done')).toBe(true);
		const todoList = e.state.doc.child(2);
		const doneList = e.state.doc.child(4);
		expect(todoList.childCount).toBe(2);
		expect(todoList.lastChild!.textContent).toBe('x');
		expect(doneList.childCount).toBe(1);
		expect(doneList.firstChild!.textContent).toBe('y');
	});

	it('no-op when sourceKind mismatches', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('TODO'), UL('a')]
		});
		const liPos = firstLiPosInList(e, 2);
		expect(moveTodoItem(e, liPos, 'Done')).toBe(false);
	});

	it('Done → TODO recreates a missing TODO before Done', () => {
		// One-item Done with no TODO. Reverting the item should collapse
		// the Done region AND create a TODO at the same spot.
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Done'), UL('only')]
		});
		const liPos = firstLiPosInList(e, 2);
		expect(moveTodoItem(e, liPos, 'Done')).toBe(true);
		expect(e.state.doc.childCount).toBe(3);
		expect(e.state.doc.child(1).textContent).toBe('TODO');
		expect(e.state.doc.child(2).firstChild!.textContent).toBe('only');
	});

	it('Done → TODO recreates TODO in front of surviving Done', () => {
		// Done has multiple items; reverting one should leave Done intact
		// and create a new TODO just before it.
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Done'), UL('x', 'y')]
		});
		const liPos = firstLiPosInList(e, 2);
		expect(moveTodoItem(e, liPos, 'Done')).toBe(true);
		// Title, TODO, UL[x], Done, UL[y]
		expect(e.state.doc.childCount).toBe(5);
		expect(e.state.doc.child(1).textContent).toBe('TODO');
		expect(e.state.doc.child(2).firstChild!.textContent).toBe('x');
		expect(e.state.doc.child(3).textContent).toBe('Done');
		expect(e.state.doc.child(4).firstChild!.textContent).toBe('y');
	});
});

// -------------------------------------------------------------------------
// regionContainingPos
// -------------------------------------------------------------------------

describe('regionContainingPos', () => {
	it('identifies which region a position belongs to', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				UL('a'),
				P('Done'),
				UL('x')
			]
		});
		const regions = findTodoRegions(e.state.doc);
		const todoLiPos = firstLiPosInList(e, 2);
		const doneLiPos = firstLiPosInList(e, 4);
		expect(regionContainingPos(regions, todoLiPos)?.kind).toBe('TODO');
		expect(regionContainingPos(regions, doneLiPos)?.kind).toBe('Done');
	});
});

// -------------------------------------------------------------------------
// insertTodoBlock
// -------------------------------------------------------------------------

describe('insertTodoBlock', () => {
	it('inserts TODO + empty bullet after the caret block', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('Body text')]
		});
		// Caret inside the Body paragraph.
		const bodyStart = e.state.doc.child(0).nodeSize + 1;
		e.commands.setTextSelection(bodyStart + 1);
		insertTodoBlock(e);
		expect(e.state.doc.childCount).toBe(4);
		expect(e.state.doc.child(2).textContent).toBe('TODO');
		expect(e.state.doc.child(3).type.name).toBe('bulletList');
		expect(e.state.doc.child(3).firstChild!.textContent).toBe('');
	});

	it('replaces an empty non-title paragraph in place', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P(''), P('')]
		});
		// Caret in the first empty paragraph (index 1).
		const targetStart = e.state.doc.child(0).nodeSize + 1;
		e.commands.setTextSelection(targetStart);
		insertTodoBlock(e);
		// The empty paragraph at index 1 was replaced by [TODO paragraph, UL].
		expect(e.state.doc.childCount).toBe(4);
		expect(e.state.doc.child(1).textContent).toBe('TODO');
		expect(e.state.doc.child(2).type.name).toBe('bulletList');
	});

	it('never replaces the title (index 0)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('')]
		});
		// Caret in the only (empty, title) paragraph.
		e.commands.setTextSelection(1);
		insertTodoBlock(e);
		// Title stayed; TODO/UL appended after.
		expect(e.state.doc.childCount).toBe(3);
		expect(e.state.doc.child(0).textContent).toBe('');
		expect(e.state.doc.child(1).textContent).toBe('TODO');
		expect(e.state.doc.child(2).type.name).toBe('bulletList');
	});
});
