/**
 * Commands: move a list item between TODO/Done regions, and insert a fresh
 * TODO block at the caret (Ctrl+O).
 */
import type { Editor } from '@tiptap/core';
import type { Node as PMNode, NodeType, Schema } from '@tiptap/pm/model';
import { TextSelection } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';

import { SKIP_TRAILING_NODE } from '../listItemDepth.js';
import {
	findTodoItemAt,
	findTodoItems,
	findTodoRegions,
	pairTodoRegions,
	type TodoItemRef,
	type TodoRegion,
	type TodoRegionKind
} from './regions.js';

/**
 * Move the list item at `liPos` from its source region to the paired region.
 *
 * `sourceKind` guards against stale callbacks — if the li's current region
 * no longer matches (e.g. the user reshuffled the doc between button render
 * and click), the command is a no-op.
 *
 * Removal on source:
 *   - many items in list → delete the li.
 *   - last item in list, but the region has OTHER lists → delete the empty
 *     list; header + remaining lists stay.
 *   - last item in region's only list → delete the whole region (header +
 *     list). An emptied region has nothing left to display so we clear it
 *     out rather than leaving a dangling header or a stray empty bullet.
 *
 * Insertion on target:
 *   - TODO → Done: paired Done's last list end. If no Done paired, create
 *     a Done region where the TODO region's last list ended (falls into
 *     the spot vacated if the TODO just disappeared).
 *   - Done → TODO: paired TODO's last list end. If no TODO paired (e.g. it
 *     was collapsed earlier when its last item was moved), create one
 *     right before the Done region's header — again, falling into the
 *     vacated slot if the Done region is also about to collapse.
 */
export function moveTodoItem(
	editor: Editor,
	liPos: number,
	sourceKind: TodoRegionKind
): boolean {
	const { state } = editor;
	const schema = state.schema;

	const liNode = state.doc.nodeAt(liPos);
	if (!liNode || liNode.type.name !== 'listItem') return false;

	const regions = findTodoRegions(state.doc);
	const items = findTodoItems(regions);
	const item = findTodoItemAt(items, liPos);
	if (!item || item.region.kind !== sourceKind) return false;

	const tr = state.tr;
	const ok =
		item.depth === 1
			? buildDepth1Move(tr, schema, item, regions, sourceKind)
			: buildDepth2Move(tr, schema, item, regions, items, sourceKind);
	if (!ok) return false;

	tr.setMeta(SKIP_TRAILING_NODE, true);
	editor.view.dispatch(tr);
	return true;
}

function buildDepth1Move(
	tr: Transaction,
	schema: Schema,
	item: TodoItemRef,
	regions: TodoRegion[],
	sourceKind: TodoRegionKind
): boolean {
	const source = item.region;
	const liNode = item.liNode;
	const liPos = item.liPos;
	const liEnd = liPos + liNode.nodeSize;

	const sourceList = source.lists.find(
		(l) => liPos >= l.pos && liPos < l.pos + l.node.nodeSize
	);
	if (!sourceList) return false;
	const parentList = sourceList.node;
	const isOnlyChildInList = parentList.childCount === 1;
	const isOnlyListInRegion = source.lists.length === 1;

	const pairs = pairTodoRegions(regions);
	const targetRegion = pairs.get(source);

	let insertBeforeMap: number;
	let createRegionKind: TodoRegionKind | null = null;
	const newListType = parentList.type;

	if (targetRegion) {
		const lastList = targetRegion.lists[targetRegion.lists.length - 1];
		insertBeforeMap = lastList.pos + lastList.node.nodeSize - 1;
	} else if (sourceKind === 'TODO') {
		createRegionKind = 'Done';
		const lastList = source.lists[source.lists.length - 1];
		insertBeforeMap = lastList.pos + lastList.node.nodeSize;
	} else {
		createRegionKind = 'TODO';
		insertBeforeMap = source.headerPos;
	}

	if (isOnlyChildInList && isOnlyListInRegion) {
		const regionStart = source.headerPos;
		const regionEnd = sourceList.pos + sourceList.node.nodeSize;
		tr.delete(regionStart, regionEnd);
	} else if (isOnlyChildInList) {
		tr.delete(sourceList.pos, sourceList.pos + sourceList.node.nodeSize);
	} else {
		tr.delete(liPos, liEnd);
	}

	const mappedInsert = tr.mapping.map(insertBeforeMap);
	if (createRegionKind) {
		const header = schema.nodes.paragraph.create(
			null,
			schema.text(createRegionKind)
		);
		const newList = newListType.create(null, liNode);
		tr.insert(mappedInsert, [header, newList]);
	} else {
		tr.insert(mappedInsert, liNode);
	}
	return true;
}

/**
 * Depth-2 move: a sub-item under a depth-1 "category" listItem. The category
 * label (its first paragraph's trimmed text) is preserved across the move:
 * the item lands inside a depth-1 listItem with the same label in the target
 * region, creating that category if it doesn't already exist.
 *
 * Source removal is local — only the depth-2 li (and its now-empty enclosing
 * nested list, if it was the only child) is removed. The depth-1 parent
 * always survives a depth-2 move; if its nested list disappears the
 * paragraph stays as a bare category header.
 */
function buildDepth2Move(
	tr: Transaction,
	schema: Schema,
	item: TodoItemRef,
	regions: TodoRegion[],
	items: TodoItemRef[],
	sourceKind: TodoRegionKind
): boolean {
	const parent = item.parent;
	if (!parent) return false;

	const source = item.region;
	const liNode = item.liNode;
	const liPos = item.liPos;
	const liEnd = liPos + liNode.nodeSize;

	const nestedListNode = parent.nestedListNode;
	const nestedListPos = parent.nestedListPos;
	const isOnlyInNested = nestedListNode.childCount === 1;
	const sourceNestedListType: NodeType = nestedListNode.type;

	const pairs = pairTodoRegions(regions);
	const targetRegion = pairs.get(source);

	// Find a matching depth-1 category in the target region.
	const matchingCategory = targetRegion
		? findCategoryInRegion(items, targetRegion, parent.categoryText)
		: null;

	// Compute insertion plan based on (target region exists?, matching category exists?).
	type Plan =
		| { kind: 'into-existing-nested'; pos: number }
		| { kind: 'create-nested-in-category'; categoryLi: TodoItemRef }
		| { kind: 'append-new-category'; pos: number }
		| { kind: 'create-region' };

	let plan: Plan;
	if (targetRegion && matchingCategory) {
		const last = lastNestedListIn(matchingCategory);
		if (last) {
			plan = {
				kind: 'into-existing-nested',
				pos: last.listPos + last.listNode.nodeSize - 1
			};
		} else {
			plan = { kind: 'create-nested-in-category', categoryLi: matchingCategory };
		}
	} else if (targetRegion) {
		const lastList = targetRegion.lists[targetRegion.lists.length - 1];
		plan = {
			kind: 'append-new-category',
			pos: lastList.pos + lastList.node.nodeSize - 1
		};
	} else {
		plan = { kind: 'create-region' };
	}

	// --- Source deletion ---
	if (isOnlyInNested) {
		tr.delete(nestedListPos, nestedListPos + nestedListNode.nodeSize);
	} else {
		tr.delete(liPos, liEnd);
	}

	// --- Insertion ---
	const newCategoryLi = (): PMNode =>
		schema.nodes.listItem.create(null, [
			schema.nodes.paragraph.create(
				null,
				parent.categoryText ? schema.text(parent.categoryText) : null
			),
			sourceNestedListType.create(null, liNode)
		]);

	if (plan.kind === 'into-existing-nested') {
		const mapped = tr.mapping.map(plan.pos);
		tr.insert(mapped, liNode);
	} else if (plan.kind === 'create-nested-in-category') {
		// Append a new nested list (with the moved item) at the end of the
		// matching depth-1 listItem.
		const cat = plan.categoryLi;
		const insertPos = cat.liPos + cat.liNode.nodeSize - 1;
		const mapped = tr.mapping.map(insertPos);
		const newNested = sourceNestedListType.create(null, liNode);
		tr.insert(mapped, newNested);
	} else if (plan.kind === 'append-new-category') {
		const mapped = tr.mapping.map(plan.pos);
		tr.insert(mapped, newCategoryLi());
	} else {
		// create-region
		const createRegionKind: TodoRegionKind =
			sourceKind === 'TODO' ? 'Done' : 'TODO';
		// Same anchor logic as depth-1's no-target branches.
		const anchor =
			createRegionKind === 'Done'
				? source.lists[source.lists.length - 1].pos +
					source.lists[source.lists.length - 1].node.nodeSize
				: source.headerPos;
		const mapped = tr.mapping.map(anchor);
		const header = schema.nodes.paragraph.create(
			null,
			schema.text(createRegionKind)
		);
		// Outer list type defaults to bulletList for a freshly-created region —
		// matches insertTodoBlock's choice and the most common case.
		const outerListType = schema.nodes.bulletList;
		const newList = outerListType.create(null, newCategoryLi());
		tr.insert(mapped, [header, newList]);
	}

	return true;
}

function findCategoryInRegion(
	items: TodoItemRef[],
	region: TodoRegion,
	categoryText: string
): TodoItemRef | null {
	if (!categoryText) return null;
	for (const it of items) {
		if (it.region !== region) continue;
		if (it.depth !== 1) continue;
		const first = it.liNode.firstChild;
		if (!first || first.type.name !== 'paragraph') continue;
		if (first.textContent.trim() === categoryText) return it;
	}
	return null;
}

function lastNestedListIn(
	categoryLi: TodoItemRef
): { listNode: PMNode; listPos: number } | null {
	const li = categoryLi.liNode;
	let lastNode: PMNode | null = null;
	let lastPos = -1;
	let offset = categoryLi.liPos + 1;
	li.forEach((sub) => {
		if (sub.type.name === 'bulletList' || sub.type.name === 'orderedList') {
			lastNode = sub;
			lastPos = offset;
		}
		offset += sub.nodeSize;
	});
	return lastNode ? { listNode: lastNode, listPos: lastPos } : null;
}

/**
 * Ctrl/Cmd+O handler. Inserts a `TODO` paragraph + empty bulletList after
 * the caret's top-level block and drops the cursor inside the new empty
 * bullet. If the caret's block is an empty non-title paragraph, that
 * paragraph is replaced instead of appending below it — matches the natural
 * "turn my empty line into a TODO" gesture.
 */
export function insertTodoBlock(editor: Editor): void {
	const { state } = editor;
	const schema = state.schema;
	const { $from } = state.selection;
	if ($from.depth < 1) return;

	const topIdx = $from.index(0);
	const topNode = state.doc.child(topIdx);
	const topStart = $from.before(1);
	const topEnd = $from.after(1);

	const todoPara = schema.nodes.paragraph.create(null, schema.text('TODO'));
	const emptyLi = schema.nodes.listItem.create(
		null,
		schema.nodes.paragraph.create()
	);
	const newList = schema.nodes.bulletList.create(null, emptyLi);

	const tr = state.tr;
	const currentIsEmptyPara =
		topNode.type.name === 'paragraph' &&
		topNode.content.size === 0 &&
		topIdx > 0;

	let insertedAt: number;
	if (currentIsEmptyPara) {
		tr.replaceWith(topStart, topEnd, [todoPara, newList]);
		insertedAt = topStart;
	} else {
		tr.insert(topEnd, [todoPara, newList]);
		insertedAt = topEnd;
	}

	// Caret inside the empty bullet's paragraph:
	//   insertedAt                 -> before todoPara
	//   + todoPara.nodeSize        -> before newList (bulletList open)
	//   + 1                        -> inside bulletList, before li open
	//   + 1                        -> inside li, before paragraph open
	//   + 1                        -> inside paragraph (caret)
	const caret = insertedAt + todoPara.nodeSize + 3;
	const clamped = Math.max(1, Math.min(caret, tr.doc.content.size - 1));
	try {
		tr.setSelection(TextSelection.near(tr.doc.resolve(clamped)));
	} catch {
		// leave selection as-is on failure
	}
	tr.setMeta(SKIP_TRAILING_NODE, true);
	editor.view.dispatch(tr);
	editor.view.focus();
}
