/**
 * Commands: move a list item between adjacent Process stages, and insert a
 * fresh Process block at the caret (Alt+P).
 */
import type { Editor } from '@tiptap/core';
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

	const stages = item.block.stages;
	const targetIndex = direction === 'next' ? item.stage.index + 1 : item.stage.index - 1;
	if (targetIndex < 0 || targetIndex >= stages.length) return false;
	const target = stages[targetIndex];

	const tr = state.tr;
	if (!buildMove(tr, item, target)) return false;

	tr.setMeta(SKIP_TRAILING_NODE, true);
	editor.view.dispatch(tr);
	return true;
}

function buildMove(
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

const PROCESS_PLACEHOLDER = '작업 이름';
const PROCESS_HEADER = `Process: ${PROCESS_PLACEHOLDER}`;

/**
 * Alt+P handler. Inserts a `Process: 작업 이름` paragraph + a starter
 * single-item bullet list + an (empty) `Complete:` paragraph after the
 * caret's top-level block, then selects the `작업 이름` placeholder so the
 * first keystroke renames the process. If the caret's block is an empty
 * non-title paragraph, that paragraph is replaced in place instead.
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
	const emptyLi = schema.nodes.listItem.create(null, schema.nodes.paragraph.create());
	const starterList = schema.nodes.bulletList.create(null, emptyLi);
	const completePara = schema.nodes.paragraph.create(null, schema.text('Complete:'));
	const block = [processPara, starterList, completePara];

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
