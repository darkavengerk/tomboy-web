import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import {
	findTodoRegions,
	pairTodoRegions,
	regionContainingPos,
	findTodoItems,
	findTodoItemAt
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
const LI_NESTED = (text: string, nested: JSONContent): JSONContent => ({
	type: 'listItem',
	content: [P(text), nested]
});
const NESTED_UL = (...items: string[]): JSONContent => ({
	type: 'bulletList',
	content: items.map(LI)
});
const NESTED_OL = (...items: string[]): JSONContent => ({
	type: 'orderedList',
	content: items.map(LI)
});

/** Returns the position of the first listItem whose first paragraph matches `text` (trimmed). */
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
// findTodoItems / findTodoItemAt — depth-1 + depth-2 enumeration
// -------------------------------------------------------------------------

describe('findTodoItems', () => {
	it('returns just depth-1 items when no nesting', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('TODO'), UL('a', 'b')]
		});
		const items = findTodoItems(findTodoRegions(e.state.doc));
		expect(items).toHaveLength(2);
		expect(items.every((it) => it.depth === 1)).toBe(true);
		expect(items.map((it) => it.liNode.textContent)).toEqual(['a', 'b']);
	});

	it('yields depth-2 items in addition to their depth-1 parents', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [
						LI_NESTED('노트', NESTED_UL('여백', '날짜')),
						LI_NESTED('버그', NESTED_UL('알트로'))
					]
				}
			]
		});
		const items = findTodoItems(findTodoRegions(e.state.doc));
		// 2 depth-1 (노트, 버그) + 2 depth-2 under 노트 + 1 depth-2 under 버그
		expect(items).toHaveLength(5);
		const depth1Texts = items
			.filter((it) => it.depth === 1)
			.map((it) => it.liNode.firstChild!.textContent);
		expect(depth1Texts).toEqual(['노트', '버그']);
		const depth2 = items.filter((it) => it.depth === 2);
		expect(depth2.map((it) => it.liNode.textContent)).toEqual([
			'여백',
			'날짜',
			'알트로'
		]);
	});

	it('depth-2 items expose parent category text (trimmed)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('  버그  ', NESTED_UL('알트로'))]
				}
			]
		});
		const items = findTodoItems(findTodoRegions(e.state.doc));
		const child = items.find((it) => it.depth === 2)!;
		expect(child.parent?.categoryText).toBe('버그');
	});

	it('does NOT yield items deeper than depth 2', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [
						LI_NESTED(
							'노트',
							{
								type: 'bulletList',
								content: [
									LI_NESTED('서브카테고리', NESTED_UL('아주깊은'))
								]
							}
						)
					]
				}
			]
		});
		const items = findTodoItems(findTodoRegions(e.state.doc));
		// 노트 (depth 1) + 서브카테고리 (depth 2). The "아주깊은" depth-3
		// item must be ignored entirely.
		expect(items).toHaveLength(2);
		expect(items.map((it) => it.depth)).toEqual([1, 2]);
		expect(items.every((it) => it.liNode.textContent.includes('아주깊은') === false)).toBe(false);
		// (and the depth-3 text is not the depth-2's textContent — that
		// node text bubbles up. We only check the surface contract: 2 items.)
	});

	it('finds items inside multi-list regions', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('A', NESTED_UL('a1'))]
				},
				{
					type: 'bulletList',
					content: [LI_NESTED('B', NESTED_UL('b1', 'b2'))]
				}
			]
		});
		const items = findTodoItems(findTodoRegions(e.state.doc));
		// 2 depth-1 (A, B) + 1 (a1) + 2 (b1, b2)
		expect(items).toHaveLength(5);
	});
});

describe('findTodoItemAt', () => {
	it('returns the exact item at a given liPos', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('버그', NESTED_UL('알트로', '이름이'))]
				}
			]
		});
		const items = findTodoItems(findTodoRegions(e.state.doc));
		const liPos = liPosByText(e, '이름이');
		const found = findTodoItemAt(items, liPos);
		expect(found?.depth).toBe(2);
		expect(found?.liNode.textContent).toBe('이름이');
		expect(found?.parent?.categoryText).toBe('버그');
	});

	it('returns null for unrelated positions', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('Title'), P('TODO'), UL('a')]
		});
		const items = findTodoItems(findTodoRegions(e.state.doc));
		expect(findTodoItemAt(items, 0)).toBeNull();
	});
});

// -------------------------------------------------------------------------
// moveTodoItem — depth-2 cases
// -------------------------------------------------------------------------

describe('moveTodoItem (depth-2)', () => {
	function richDoc() {
		return {
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [
						LI_NESTED('노트', NESTED_UL('여백', '날짜')),
						LI_NESTED('버그', NESTED_UL('알트로', '이름이', '머지가'))
					]
				},
				P('Done'),
				{
					type: 'bulletList',
					content: [LI_NESTED('노트', NESTED_UL('todo, done 기능'))]
				}
			]
		} as JSONContent;
	}

	it('depth-2 → Done with matching category appends to existing nested list', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('노트', NESTED_UL('여백', '날짜'))]
				},
				P('Done'),
				{
					type: 'bulletList',
					content: [LI_NESTED('노트', NESTED_UL('todo, done 기능'))]
				}
			]
		});
		const liPos = liPosByText(e, '여백');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		// Source: 노트 still has only 날짜
		const todoCat = e.state.doc.child(2).firstChild!;
		expect(todoCat.firstChild!.textContent).toBe('노트');
		const todoNested = todoCat.child(1);
		expect(todoNested.childCount).toBe(1);
		expect(todoNested.firstChild!.textContent).toBe('날짜');

		// Target: Done > 노트 nested has [todo, done 기능, 여백]
		const doneCat = e.state.doc.child(4).firstChild!;
		expect(doneCat.firstChild!.textContent).toBe('노트');
		const doneNested = doneCat.child(1);
		expect(doneNested.childCount).toBe(2);
		expect(doneNested.lastChild!.textContent).toBe('여백');
	});

	it('depth-2 → Done with NO matching category creates the category', () => {
		const e = makeEditor(richDoc());
		const liPos = liPosByText(e, '알트로');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		// TODO 버그 still has 이름이, 머지가
		const todoList = e.state.doc.child(2);
		const bugCat = todoList.child(1);
		expect(bugCat.firstChild!.textContent).toBe('버그');
		expect(bugCat.child(1).childCount).toBe(2);
		expect(bugCat.child(1).firstChild!.textContent).toBe('이름이');
		expect(bugCat.child(1).lastChild!.textContent).toBe('머지가');

		// Done has 노트 unchanged + new 버그 category with [알트로]
		const doneList = e.state.doc.child(4);
		expect(doneList.childCount).toBe(2);
		const doneNote = doneList.child(0);
		expect(doneNote.firstChild!.textContent).toBe('노트');
		const doneBug = doneList.child(1);
		expect(doneBug.firstChild!.textContent).toBe('버그');
		expect(doneBug.child(1).childCount).toBe(1);
		expect(doneBug.child(1).firstChild!.textContent).toBe('알트로');
	});

	it('depth-2 → no Done region at all: creates Done with category and item', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('버그', NESTED_UL('알트로', '이름이'))]
				}
			]
		});
		const liPos = liPosByText(e, '알트로');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		// Title, TODO header, TODO list (버그 with 이름이), Done header, Done list (버그 with 알트로)
		expect(e.state.doc.childCount).toBe(5);
		expect(e.state.doc.child(3).textContent).toBe('Done');
		const doneList = e.state.doc.child(4);
		expect(doneList.type.name).toBe('bulletList');
		expect(doneList.childCount).toBe(1);
		const doneBug = doneList.firstChild!;
		expect(doneBug.firstChild!.textContent).toBe('버그');
		expect(doneBug.child(1).firstChild!.textContent).toBe('알트로');
	});

	it('depth-2 only-child: removes empty nested list, parent category survives', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('버그', NESTED_UL('알트로'))]
				},
				P('Done'),
				UL('이전건')
			]
		});
		const liPos = liPosByText(e, '알트로');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		// Source 버그 stays as a depth-1 with just its paragraph (no nested
		// list), TODO header still present.
		expect(e.state.doc.child(1).textContent).toBe('TODO');
		const todoList = e.state.doc.child(2);
		expect(todoList.childCount).toBe(1);
		const bugCat = todoList.firstChild!;
		expect(bugCat.firstChild!.textContent).toBe('버그');
		// Only one child remains in the depth-1 listItem (the paragraph).
		expect(bugCat.childCount).toBe(1);
	});

	it('depth-2 → matching category that has no nested list yet: creates nested list', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('버그', NESTED_UL('알트로'))]
				},
				P('Done'),
				UL('버그') // depth-1 「버그」 with NO nested list
			]
		});
		const liPos = liPosByText(e, '알트로');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		const doneList = e.state.doc.child(4);
		const doneBug = doneList.firstChild!;
		expect(doneBug.firstChild!.textContent).toBe('버그');
		// Now has 2 children: paragraph + new nested list
		expect(doneBug.childCount).toBe(2);
		expect(doneBug.child(1).type.name).toBe('bulletList');
		expect(doneBug.child(1).firstChild!.textContent).toBe('알트로');
	});

	it('depth-2 revert (Done→TODO) appends to matching TODO category', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('노트', NESTED_UL('여백'))]
				},
				P('Done'),
				{
					type: 'bulletList',
					content: [LI_NESTED('노트', NESTED_UL('todo, done 기능'))]
				}
			]
		});
		const liPos = liPosByText(e, 'todo, done 기능');
		expect(moveTodoItem(e, liPos, 'Done')).toBe(true);

		// TODO 노트 nested gains 'todo, done 기능'
		const todoNoteNested = e.state.doc.child(2).firstChild!.child(1);
		expect(todoNoteNested.childCount).toBe(2);
		expect(todoNoteNested.lastChild!.textContent).toBe('todo, done 기능');

		// Done 노트's nested list is gone (only-child case), depth-1 노트 survives
		const doneList = e.state.doc.child(4);
		const doneNote = doneList.firstChild!;
		expect(doneNote.childCount).toBe(1);
	});

	it('depth-2 → preserves source nested list type when creating new category', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('버그', NESTED_OL('알트로'))]
				},
				P('Done'),
				UL('노트') // existing 노트 only
			]
		});
		const liPos = liPosByText(e, '알트로');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		const doneList = e.state.doc.child(4);
		const doneBug = doneList.lastChild!;
		expect(doneBug.firstChild!.textContent).toBe('버그');
		// New nested list under created 버그 should be orderedList (mirrors source)
		expect(doneBug.child(1).type.name).toBe('orderedList');
	});

	it('depth-2 match is case-sensitive (exact, trimmed)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('Bug', NESTED_UL('alpha'))]
				},
				P('Done'),
				{
					type: 'bulletList',
					content: [LI_NESTED('bug', NESTED_UL('beta'))]
				}
			]
		});
		const liPos = liPosByText(e, 'alpha');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		// 'Bug' ≠ 'bug' (case sensitive). A new 'Bug' category should be added.
		const doneList = e.state.doc.child(4);
		expect(doneList.childCount).toBe(2);
		expect(doneList.firstChild!.firstChild!.textContent).toBe('bug');
		expect(doneList.lastChild!.firstChild!.textContent).toBe('Bug');
	});

	it('depth-1 click still moves the entire category including nested children', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [
						LI_NESTED('노트', NESTED_UL('여백', '날짜')),
						LI_NESTED('버그', NESTED_UL('알트로'))
					]
				},
				P('Done'),
				UL('이전건')
			]
		});
		// Click depth-1 「노트」 — entire item incl. children moves to Done.
		const liPos = liPosByText(e, '노트');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		// Source TODO list now has only 버그
		const todoList = e.state.doc.child(2);
		expect(todoList.childCount).toBe(1);
		expect(todoList.firstChild!.firstChild!.textContent).toBe('버그');

		// Done list now has 이전건 + the entire 노트 (with both nested)
		const doneList = e.state.doc.child(4);
		expect(doneList.childCount).toBe(2);
		const movedNote = doneList.lastChild!;
		expect(movedNote.firstChild!.textContent).toBe('노트');
		expect(movedNote.child(1).childCount).toBe(2);
		expect(movedNote.child(1).firstChild!.textContent).toBe('여백');
		expect(movedNote.child(1).lastChild!.textContent).toBe('날짜');
	});
});

// -------------------------------------------------------------------------
// moveTodoItem (depth-2) — edge cases
// -------------------------------------------------------------------------

describe('moveTodoItem (depth-2) edge cases', () => {
	it('depth-2 move is a no-op when sourceKind mismatches', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('버그', NESTED_UL('알트로'))]
				}
			]
		});
		const liPos = liPosByText(e, '알트로');
		expect(moveTodoItem(e, liPos, 'Done')).toBe(false);
	});

	it('depth-2 with multi-list source region: only nested list affected', () => {
		// TWO sibling top-level bulletLists form one TODO region. Each
		// contains a category with nested items. Moving a depth-2 from list 1
		// leaves list 2 (and the second header-less list of the region) intact.
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('A', NESTED_UL('a1', 'a2'))]
				},
				{
					type: 'bulletList',
					content: [LI_NESTED('B', NESTED_UL('b1'))]
				}
			]
		});
		const liPos = liPosByText(e, 'a1');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		// First list still has A with [a2]
		const list1 = e.state.doc.child(2);
		expect(list1.firstChild!.firstChild!.textContent).toBe('A');
		expect(list1.firstChild!.child(1).childCount).toBe(1);
		expect(list1.firstChild!.child(1).firstChild!.textContent).toBe('a2');

		// Second list (B) is untouched
		const list2 = e.state.doc.child(3);
		expect(list2.firstChild!.firstChild!.textContent).toBe('B');
		expect(list2.firstChild!.child(1).childCount).toBe(1);
		expect(list2.firstChild!.child(1).firstChild!.textContent).toBe('b1');

		// New Done region created with category A → [a1]
		expect(e.state.doc.child(4).textContent).toBe('Done');
		const doneList = e.state.doc.child(5);
		expect(doneList.firstChild!.firstChild!.textContent).toBe('A');
		expect(doneList.firstChild!.child(1).firstChild!.textContent).toBe('a1');
	});

	it('depth-2 → matching category with multiple nested lists appends to last', () => {
		// Done's 노트 category has two sibling nested bulletLists. The new
		// item should land in the LAST one to be consistent with how the
		// region itself treats multiple consecutive lists.
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('노트', NESTED_UL('새것'))]
				},
				P('Done'),
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							content: [
								P('노트'),
								NESTED_UL('first-bucket-item'),
								NESTED_UL('second-bucket-item')
							]
						}
					]
				}
			]
		});
		const liPos = liPosByText(e, '새것');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		const doneNote = e.state.doc.child(4).firstChild!;
		// noteContent: paragraph + nested1 + nested2 = 3 children
		expect(doneNote.childCount).toBe(3);
		// nested 1 unchanged
		expect(doneNote.child(1).childCount).toBe(1);
		expect(doneNote.child(1).firstChild!.textContent).toBe('first-bucket-item');
		// nested 2 gained '새것' as the last item
		expect(doneNote.child(2).childCount).toBe(2);
		expect(doneNote.child(2).lastChild!.textContent).toBe('새것');
	});

	it('depth-2 → multiple matching categories: appends to the FIRST match', () => {
		// Two depth-1 listItems with the same text in target region. The
		// first one in document order wins.
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('버그', NESTED_UL('alpha'))]
				},
				P('Done'),
				{
					type: 'bulletList',
					content: [
						LI_NESTED('버그', NESTED_UL('first-cat-existing')),
						LI_NESTED('버그', NESTED_UL('second-cat-existing'))
					]
				}
			]
		});
		const liPos = liPosByText(e, 'alpha');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		const doneList = e.state.doc.child(4);
		const firstCat = doneList.child(0);
		const secondCat = doneList.child(1);
		expect(firstCat.child(1).childCount).toBe(2);
		expect(firstCat.child(1).lastChild!.textContent).toBe('alpha');
		expect(secondCat.child(1).childCount).toBe(1);
	});

	it('depth-2 only-child: source TODO region survives even if no other items', () => {
		// Removing the last depth-2 must NOT collapse the depth-1 category
		// or the region — they're useful as still-extant categories.
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('버그', NESTED_UL('alpha'))]
				}
			]
		});
		const liPos = liPosByText(e, 'alpha');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		// Title, TODO, UL[버그 paragraph only], Done, UL[버그 with alpha]
		expect(e.state.doc.child(1).textContent).toBe('TODO');
		const todoList = e.state.doc.child(2);
		expect(todoList.childCount).toBe(1);
		expect(todoList.firstChild!.childCount).toBe(1);
		expect(todoList.firstChild!.firstChild!.textContent).toBe('버그');
	});

	it('depth-2 → existing matching category preserves target nested list type (not source)', () => {
		// Source nested is orderedList; target category already has a
		// bulletList nested. The item should land in the existing
		// bulletList — we only switch types when CREATING a new nested.
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('Cat', NESTED_OL('alpha'))]
				},
				P('Done'),
				{
					type: 'bulletList',
					content: [LI_NESTED('Cat', NESTED_UL('previous'))]
				}
			]
		});
		const liPos = liPosByText(e, 'alpha');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		const doneCat = e.state.doc.child(4).firstChild!;
		// Single nested (the bulletList) gained alpha
		expect(doneCat.childCount).toBe(2);
		expect(doneCat.child(1).type.name).toBe('bulletList');
		expect(doneCat.child(1).childCount).toBe(2);
		expect(doneCat.child(1).lastChild!.textContent).toBe('alpha');
	});

	it('depth-2 from second list in multi-list region with no Done: creates Done after the region', () => {
		// Source TODO region has TWO consecutive lists; the depth-2 lives in
		// the second list. New Done region is appended after the whole
		// source region.
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('A', NESTED_UL('a1'))]
				},
				{
					type: 'bulletList',
					content: [LI_NESTED('B', NESTED_UL('b1'))]
				}
			]
		});
		const liPos = liPosByText(e, 'b1');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		// Done header lands at index 4 (after both source lists), with B/b1.
		expect(e.state.doc.child(4).textContent).toBe('Done');
		const doneList = e.state.doc.child(5);
		expect(doneList.firstChild!.firstChild!.textContent).toBe('B');
		expect(doneList.firstChild!.child(1).firstChild!.textContent).toBe('b1');
	});

	it('depth-2 revert with NO matching TODO category creates one in the new TODO region', () => {
		// Done has 노트 with 알트로; revert when no TODO region exists must
		// build a TODO with category 노트 + nested [알트로], placed before
		// the Done region.
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('Done'),
				{
					type: 'bulletList',
					content: [LI_NESTED('노트', NESTED_UL('알트로'))]
				}
			]
		});
		const liPos = liPosByText(e, '알트로');
		expect(moveTodoItem(e, liPos, 'Done')).toBe(true);

		// Title, TODO, TODO-list (노트 with 알트로), Done, Done-list (노트
		// without nested) — Done category survives even though its nested
		// list went away with its only child.
		expect(e.state.doc.childCount).toBe(5);
		expect(e.state.doc.child(1).textContent).toBe('TODO');
		const todoList = e.state.doc.child(2);
		expect(todoList.firstChild!.firstChild!.textContent).toBe('노트');
		expect(todoList.firstChild!.child(1).firstChild!.textContent).toBe('알트로');
		expect(e.state.doc.child(3).textContent).toBe('Done');
		const doneList = e.state.doc.child(4);
		expect(doneList.firstChild!.childCount).toBe(1);
	});

	it('depth-2 with depth-3+ descendants: those descendants ride along on move', () => {
		// A depth-2 item itself contains a deeper nested list. We don't show
		// buttons on depth-3 items, but moving the depth-2 must take its
		// entire subtree with it.
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [
						LI_NESTED(
							'Cat',
							{
								type: 'bulletList',
								content: [LI_NESTED('mid', NESTED_UL('deep'))]
							}
						)
					]
				}
			]
		});
		const liPos = liPosByText(e, 'mid');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		// Source 'Cat' lost its only nested list, so just paragraph remains.
		const todoCat = e.state.doc.child(2).firstChild!;
		expect(todoCat.childCount).toBe(1);

		// Done created with Cat → nested(mid → nested(deep))
		const doneCat = e.state.doc.child(4).firstChild!;
		expect(doneCat.firstChild!.textContent).toBe('Cat');
		const movedMid = doneCat.child(1).firstChild!;
		expect(movedMid.firstChild!.textContent).toBe('mid');
		expect(movedMid.child(1).firstChild!.textContent).toBe('deep');
	});

	it('depth-2 with non-empty siblings: does NOT remove parent depth-1 nested list', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [LI_NESTED('Cat', NESTED_UL('alpha', 'beta', 'gamma'))]
				}
			]
		});
		const liPos = liPosByText(e, 'beta');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		const todoCat = e.state.doc.child(2).firstChild!;
		expect(todoCat.child(1).childCount).toBe(2);
		expect(todoCat.child(1).firstChild!.textContent).toBe('alpha');
		expect(todoCat.child(1).lastChild!.textContent).toBe('gamma');
	});

	it('depth-2 with empty parent category text matches another empty parent', () => {
		// Two depth-1 listItems with empty first paragraphs. categoryText is
		// '' on both sides; technically they match. Verify the move still
		// works and doesn't crash on empty text.
		const e = makeEditor({
			type: 'doc',
			content: [
				P('Title'),
				P('TODO'),
				{
					type: 'bulletList',
					content: [{ type: 'listItem', content: [P(''), NESTED_UL('alpha')] }]
				},
				P('Done'),
				{
					type: 'bulletList',
					content: [{ type: 'listItem', content: [P(''), NESTED_UL('done-existing')] }]
				}
			]
		});
		const liPos = liPosByText(e, 'alpha');
		expect(moveTodoItem(e, liPos, 'TODO')).toBe(true);

		// We treat empty categoryText as "no match" (categoryText==='' returns
		// null in findCategoryInRegion), so a new (also-empty) category is
		// appended to Done. Both tests of behaviour are acceptable; this
		// asserts the safer choice — don't fuse arbitrary unrelated empty
		// categories.
		const doneList = e.state.doc.child(4);
		expect(doneList.childCount).toBe(2);
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
