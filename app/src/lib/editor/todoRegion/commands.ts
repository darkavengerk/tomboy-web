/**
 * Commands: move a list item between TODO/Done regions, and insert a fresh
 * TODO block at the caret (Ctrl+O).
 */
import type { Editor } from '@tiptap/core';
import { TextSelection } from 'prosemirror-state';

import { SKIP_TRAILING_NODE } from '../listItemDepth.js';
import {
	findTodoRegions,
	pairTodoRegions,
	regionContainingPos,
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
	const liEnd = liPos + liNode.nodeSize;

	const regions = findTodoRegions(state.doc);
	const source = regionContainingPos(regions, liPos);
	if (!source || source.kind !== sourceKind) return false;

	// Locate which of the region's lists actually contains this li.
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
		// End of list content — just before the list's closing token.
		insertBeforeMap = lastList.pos + lastList.node.nodeSize - 1;
	} else if (sourceKind === 'TODO') {
		createRegionKind = 'Done';
		const lastList = source.lists[source.lists.length - 1];
		// Top-level position immediately after the TODO region's last list.
		insertBeforeMap = lastList.pos + lastList.node.nodeSize;
	} else {
		// Done with no paired TODO — recreate one just before the Done
		// region. The header position is invariant under all three source
		// deletion modes (li-only, list-only, whole-region) so the mapping
		// resolves to the correct insertion point whether or not Done
		// survives.
		createRegionKind = 'TODO';
		insertBeforeMap = source.headerPos;
	}

	const tr = state.tr;

	if (isOnlyChildInList && isOnlyListInRegion) {
		// The whole region collapses. Delete from the header through the end
		// of the (single) list.
		const regionStart = source.headerPos;
		const regionEnd = sourceList.pos + sourceList.node.nodeSize;
		tr.delete(regionStart, regionEnd);
	} else if (isOnlyChildInList) {
		// Drop just this empty list; sibling lists in the region survive.
		const listStart = sourceList.pos;
		const listEnd = sourceList.pos + sourceList.node.nodeSize;
		tr.delete(listStart, listEnd);
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

	tr.setMeta(SKIP_TRAILING_NODE, true);
	editor.view.dispatch(tr);
	return true;
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
