/**
 * Commands: move a list item between adjacent Process stages, and insert a
 * fresh Process block at the caret (Alt+P).
 */
import type { Editor } from '@tiptap/core';
import type { Node as PMNode, NodeType, Schema } from '@tiptap/pm/model';
import { TextSelection } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';

import { SKIP_TRAILING_NODE } from '../listItemDepth.js';
import {
	findProcessBlocks,
	findProcessItemAt,
	findProcessItems,
	type ProcessItemRef,
	type ProcessMoveDirection,
	type ProcessStage
} from './regions.js';

/**
 * Move the depth-1 list item at `liPos` one stage in `direction`.
 *
 * Unlike TODO (which collapses an emptied region), Process stages are
 * permanent columns: when an item leaves a stage its (now-empty) list is
 * removed but the stage's header paragraph stays. The target stage receives
 * the item at the end of its last list, or in a freshly-created list right
 * after its header when the stage had none.
 *
 * No-op (returns false) when there is no neighbor stage in `direction` (i.e.
 * `next` on the last stage or `prev` on the first) or the position is stale.
 */
export function moveProcessItem(
	editor: Editor,
	liPos: number,
	direction: ProcessMoveDirection
): boolean {
	const { state } = editor;

	const liNode = state.doc.nodeAt(liPos);
	if (!liNode || liNode.type.name !== 'listItem') return false;

	const blocks = findProcessBlocks(state.doc);
	const items = findProcessItems(blocks);
	const item = findProcessItemAt(items, liPos);
	if (!item) return false;
	// Depth-3 checkbox items are not movable — they travel with their parent.
	if (item.depth === 3) return false;

	const stages = item.block.stages;
	const targetIndex = direction === 'next' ? item.stage.index + 1 : item.stage.index - 1;
	if (targetIndex < 0 || targetIndex >= stages.length) return false;
	const target = stages[targetIndex];

	const tr = state.tr;
	const ok =
		item.depth === 1
			? buildDepth1Move(tr, item, target)
			: buildDepth2Move(tr, editor.state.schema, item, items, target);
	if (!ok) return false;

	tr.setMeta(SKIP_TRAILING_NODE, true);
	editor.view.dispatch(tr);
	return true;
}

function buildDepth1Move(
	tr: Transaction,
	item: ProcessItemRef,
	target: ProcessStage
): boolean {
	const liNode = item.liNode;
	const liPos = item.liPos;
	const liEnd = liPos + liNode.nodeSize;

	const sourceList = item.stage.lists.find(
		(l) => liPos >= l.pos && liPos < l.pos + l.node.nodeSize
	);
	if (!sourceList) return false;
	const isOnlyChildInList = sourceList.node.childCount === 1;
	const newListType = sourceList.node.type;

	// Where to insert in the target stage — computed against the pre-deletion
	// doc, then remapped after the source removal.
	let insertAtMap: number;
	let createList = false;
	if (target.lists.length > 0) {
		const lastList = target.lists[target.lists.length - 1];
		insertAtMap = lastList.pos + lastList.node.nodeSize - 1;
	} else {
		// No list in the target stage: drop a new list right after its header.
		createList = true;
		const headerNode = tr.doc.nodeAt(target.headerPos);
		const headerSize = headerNode ? headerNode.nodeSize : 0;
		insertAtMap = target.headerPos + headerSize;
	}

	// --- Source removal (stage header always survives) ---
	if (isOnlyChildInList) {
		tr.delete(sourceList.pos, sourceList.pos + sourceList.node.nodeSize);
	} else {
		tr.delete(liPos, liEnd);
	}

	// --- Insertion ---
	const mappedInsert = tr.mapping.map(insertAtMap);
	if (createList) {
		tr.insert(mappedInsert, newListType.create(null, liNode));
	} else {
		tr.insert(mappedInsert, liNode);
	}
	return true;
}

/**
 * Move a depth-2 sub-item to the neighbor stage, preserving its category.
 *
 * The sub-item's parent category label (its owning depth-1 listItem's first
 * paragraph) is matched against the target stage: it lands inside a depth-1
 * category with the same label, creating that category — and a stage list, if
 * the stage had none — when no match exists. The source category header always
 * survives; only the sub-item (and its now-empty nested list, if it was the
 * sole child) is removed.
 */
function buildDepth2Move(
	tr: Transaction,
	schema: Schema,
	item: ProcessItemRef,
	items: ProcessItemRef[],
	target: ProcessStage
): boolean {
	const parent = item.parent;
	if (!parent) return false;

	const liNode = item.liNode;
	const liPos = item.liPos;
	const liEnd = liPos + liNode.nodeSize;

	const nestedListNode = parent.nestedListNode;
	const nestedListPos = parent.nestedListPos;
	const isOnlyInNested = nestedListNode.childCount === 1;
	const sourceNestedListType: NodeType = nestedListNode.type;

	const matchingCategory = findCategoryInStage(items, target, parent.categoryText);

	type Plan =
		| { kind: 'into-existing-nested'; pos: number }
		| { kind: 'create-nested-in-category'; categoryLi: ProcessItemRef }
		| { kind: 'append-new-category'; pos: number }
		| { kind: 'create-list-with-category'; pos: number };

	let plan: Plan;
	if (matchingCategory) {
		const last = lastNestedListIn(matchingCategory);
		plan = last
			? { kind: 'into-existing-nested', pos: last.listPos + last.listNode.nodeSize - 1 }
			: { kind: 'create-nested-in-category', categoryLi: matchingCategory };
	} else if (target.lists.length > 0) {
		const lastList = target.lists[target.lists.length - 1];
		plan = { kind: 'append-new-category', pos: lastList.pos + lastList.node.nodeSize - 1 };
	} else {
		// Listless target stage: drop a fresh list right after its header.
		const headerNode = tr.doc.nodeAt(target.headerPos);
		const headerSize = headerNode ? headerNode.nodeSize : 0;
		plan = { kind: 'create-list-with-category', pos: target.headerPos + headerSize };
	}

	// --- Source removal (category header always survives) ---
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
		tr.insert(tr.mapping.map(plan.pos), liNode);
	} else if (plan.kind === 'create-nested-in-category') {
		const cat = plan.categoryLi;
		const insertPos = tr.mapping.map(cat.liPos + cat.liNode.nodeSize - 1);
		tr.insert(insertPos, sourceNestedListType.create(null, liNode));
	} else if (plan.kind === 'append-new-category') {
		tr.insert(tr.mapping.map(plan.pos), newCategoryLi());
	} else {
		// create-list-with-category
		const newList = sourceNestedListType.create(null, newCategoryLi());
		tr.insert(tr.mapping.map(plan.pos), newList);
	}
	return true;
}

function findCategoryInStage(
	items: ProcessItemRef[],
	stage: ProcessStage,
	categoryText: string
): ProcessItemRef | null {
	if (!categoryText) return null;
	for (const it of items) {
		if (it.stage !== stage) continue;
		if (it.depth !== 1) continue;
		const first = it.liNode.firstChild;
		if (!first || first.type.name !== 'paragraph') continue;
		if (first.textContent.trim() === categoryText) return it;
	}
	return null;
}

function lastNestedListIn(
	categoryLi: ProcessItemRef
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

const PROCESS_PLACEHOLDER = '작업 이름';
const PROCESS_HEADER = `Process: ${PROCESS_PLACEHOLDER}`;

/**
 * Alt+P handler. Inserts a `Process: 작업 이름` paragraph + an (empty)
 * `Complete:` paragraph after the caret's top-level block, then selects the
 * `작업 이름` placeholder so the first keystroke renames the process. Stage
 * headers and item lists are typed by the user — no starter list is inserted.
 * If the caret's block is an empty non-title paragraph, that paragraph is
 * replaced in place instead.
 */
export function insertProcessBlock(editor: Editor): void {
	const { state } = editor;
	const schema = state.schema;
	const { $from } = state.selection;
	if ($from.depth < 1) return;

	const topIdx = $from.index(0);
	const topNode = state.doc.child(topIdx);
	const topStart = $from.before(1);
	const topEnd = $from.after(1);

	const processPara = schema.nodes.paragraph.create(null, schema.text(PROCESS_HEADER));
	const completePara = schema.nodes.paragraph.create(null, schema.text('Complete:'));
	const block = [processPara, completePara];

	const tr = state.tr;
	const currentIsEmptyPara =
		topNode.type.name === 'paragraph' && topNode.content.size === 0 && topIdx > 0;

	let insertedAt: number;
	if (currentIsEmptyPara) {
		tr.replaceWith(topStart, topEnd, block);
		insertedAt = topStart;
	} else {
		tr.insert(topEnd, block);
		insertedAt = topEnd;
	}

	// Select the placeholder text inside the Process header:
	//   insertedAt + 1            -> inside processPara (text start)
	//   + "Process: ".length      -> start of the placeholder
	const selFrom = insertedAt + 1 + (PROCESS_HEADER.length - PROCESS_PLACEHOLDER.length);
	const selTo = selFrom + PROCESS_PLACEHOLDER.length;
	try {
		tr.setSelection(TextSelection.create(tr.doc, selFrom, selTo));
	} catch {
		// leave selection as-is on failure
	}
	tr.setMeta(SKIP_TRAILING_NODE, true);
	editor.view.dispatch(tr);
	editor.view.focus();
}
