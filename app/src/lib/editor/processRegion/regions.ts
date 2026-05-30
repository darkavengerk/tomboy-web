/**
 * Process (multi-stage kanban) region detection.
 *
 * A Process block is a bounded span of top-level blocks that starts at a
 * paragraph whose trimmed text matches `Process` (English, case-sensitive,
 * `\b`-style boundary so `Processing` doesn't match but `Process: x` does)
 * and ENDS at a paragraph matching `Complete`. Every top-level paragraph in
 * between is a stage (a kanban column), in document order; the list block(s)
 * immediately following a stage paragraph are that stage's items. Empty
 * stages (a stage paragraph with no following list) are allowed.
 *
 * The terminal `Complete:` is REQUIRED — a `Process:` with no matching
 * `Complete:` is not a block. This keeps a stray `Process:` line in prose
 * from turning every following paragraph into a phantom stage.
 *
 * Distinct from the two-stage TODO feature (`TODO`/`Done` headers) — the
 * keywords never overlap, so the two coexist without coordination. Only
 * depth-1 list items are tracked; nested lists are left untouched.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

export type ProcessMoveDirection = 'next' | 'prev';

export interface ProcessStageList {
	/** Absolute position of the list node (its opening token). */
	pos: number;
	node: PMNode;
	/** Index of this list in the doc's top-level children. */
	childIndex: number;
}

export interface ProcessStage {
	/** 0-based position of this stage within its block's ordered stage list. */
	index: number;
	isFirst: boolean;
	isLast: boolean;
	/** Absolute position of the stage's header paragraph node. */
	headerPos: number;
	/** Top-level child index of the header paragraph. */
	headerChildIndex: number;
	/** Contiguous list blocks following the header (may be empty). */
	lists: ProcessStageList[];
}

export interface ProcessBlock {
	/** Ordered stages: [0] starts with `Process:`, [last] starts with `Complete:`. */
	stages: ProcessStage[];
}

export interface ProcessItemRef {
	liPos: number;
	liNode: PMNode;
	stage: ProcessStage;
	block: ProcessBlock;
	/** Position of the list directly containing this li. */
	containingListPos: number;
	containingListNode: PMNode;
}

const PROCESS_RE = /^Process(?![A-Za-z0-9_])/;
const COMPLETE_RE = /^Complete(?![A-Za-z0-9_])/;

function isList(node: PMNode): boolean {
	const n = node.type.name;
	return n === 'bulletList' || n === 'orderedList';
}

export function findProcessBlocks(doc: PMNode): ProcessBlock[] {
	const blocks: ProcessBlock[] = [];
	const childCount = doc.childCount;
	if (childCount === 0) return blocks;

	const positions: number[] = [];
	let offset = 0;
	doc.forEach((child) => {
		positions.push(offset);
		offset += child.nodeSize;
	});

	let i = 1; // skip title
	while (i < childCount) {
		const child = doc.child(i);
		if (child.type.name !== 'paragraph' || !PROCESS_RE.test(child.textContent.trim())) {
			i++;
			continue;
		}

		// Tentatively collect stages from here until a Complete terminal.
		const collected: Array<{ headerPos: number; headerChildIndex: number; lists: ProcessStageList[] }> = [];
		let j = i;
		let foundComplete = false;
		while (j < childCount) {
			const p = doc.child(j);
			if (p.type.name !== 'paragraph') break;
			const text = p.textContent.trim();
			// A new Process start (after the first stage) belongs to the next block.
			if (collected.length > 0 && PROCESS_RE.test(text)) break;

			const lists: ProcessStageList[] = [];
			let k = j + 1;
			while (k < childCount && isList(doc.child(k))) {
				lists.push({ pos: positions[k], node: doc.child(k), childIndex: k });
				k++;
			}
			collected.push({ headerPos: positions[j], headerChildIndex: j, lists });
			j = k;

			if (COMPLETE_RE.test(text)) {
				foundComplete = true;
				break;
			}
		}

		if (foundComplete && collected.length > 0) {
			const last = collected.length - 1;
			const stages: ProcessStage[] = collected.map((c, idx) => ({
				index: idx,
				isFirst: idx === 0,
				isLast: idx === last,
				headerPos: c.headerPos,
				headerChildIndex: c.headerChildIndex,
				lists: c.lists
			}));
			blocks.push({ stages });
			i = j;
		} else {
			// Not a well-formed block (no Complete terminal) — skip this header
			// and keep scanning; a later Process: may be complete.
			i++;
		}
	}

	return blocks;
}

export function findProcessItems(blocks: ProcessBlock[]): ProcessItemRef[] {
	const items: ProcessItemRef[] = [];
	for (const block of blocks) {
		for (const stage of block.stages) {
			for (const list of stage.lists) {
				let liOffset = list.pos + 1; // step inside the list's opening token
				list.node.forEach((li) => {
					items.push({
						liPos: liOffset,
						liNode: li,
						stage,
						block,
						containingListPos: list.pos,
						containingListNode: list.node
					});
					liOffset += li.nodeSize;
				});
			}
		}
	}
	return items;
}

export function findProcessItemAt(items: ProcessItemRef[], liPos: number): ProcessItemRef | null {
	for (const it of items) {
		if (it.liPos === liPos) return it;
	}
	return null;
}
