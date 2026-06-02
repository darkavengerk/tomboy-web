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
 * keywords never overlap, so the two coexist without coordination.
 *
 * Blank paragraphs and `---` (3+ dashes, the hrSplit virtual HR) paragraphs
 * are IGNORABLE: they never become stages, never break a block, and lists
 * separated from their stage header by ignorables still belong to that stage.
 * This keeps visual spacers from turning into phantom kanban columns.
 *
 * Each stage behaves like a TODO region internally: a depth-1 list item with
 * a nested list acts as a CATEGORY, and the nested depth-2 list items are its
 * sub-items. Both depths are enumerated as movable items — a depth-1 card
 * moves whole, a depth-2 sub-item moves by matching its parent's category
 * label in the target stage. Depth-3 list items (nested under a depth-2
 * sub-item) are CHECKBOX items — not movable, toggled whole like checklist
 * region items and serialized with `[[ ]]` / `[[X]]` markers. Anything deeper
 * than depth-3 is left untouched.
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
	/**
	 * `1` = a card directly under a stage's top-level list. `2` = a sub-item
	 * under a depth-1 category listItem. `3` = a checkbox item under a depth-2
	 * sub-item (not movable, whole-li check toggle). Deeper nesting is ignored.
	 */
	depth: 1 | 2 | 3;
	stage: ProcessStage;
	block: ProcessBlock;
	/** Position of the list directly containing this li. */
	containingListPos: number;
	containingListNode: PMNode;
	/** Present only on depth-2 items: the owning category. */
	parent?: {
		liPos: number;
		liNode: PMNode;
		/** Trimmed text of the category's first paragraph (the match key). */
		categoryText: string;
		nestedListPos: number;
		nestedListNode: PMNode;
	};
}

const PROCESS_RE = /^Process(?![A-Za-z0-9_])/;
const COMPLETE_RE = /^Complete(?![A-Za-z0-9_])/;

// 아래 세 text 판정 함수는 noteContentArchiver.ts (JSON 직렬화/역직렬화)도
// 같은 규칙으로 프로세스 블록을 인식해야 해서 export 한다 — single source.

/** `Process` 헤더 문단 텍스트인지 (trim 후 검사). */
export function isProcessHeaderText(text: string): boolean {
	return PROCESS_RE.test(text.trim());
}

/** `Complete` 터미널 문단 텍스트인지 (trim 후 검사). */
export function isCompleteHeaderText(text: string): boolean {
	return COMPLETE_RE.test(text.trim());
}

/**
 * 스테이지 구조에서 투명하게 무시되는 문단: 빈 문단 또는 `---`(대시 3개
 * 이상, hrSplit 의 가상 HR 과 동일 규칙). 스테이지가 되지도, 블록을 끊지도
 * 않는다.
 */
export function isIgnorableProcessText(text: string): boolean {
	const t = text.trim();
	return t.length === 0 || /^-{3,}$/.test(t);
}

function isList(node: PMNode): boolean {
	const n = node.type.name;
	return n === 'bulletList' || n === 'orderedList';
}

/** 문단이면서 isIgnorableProcessText 에 해당하는 노드. */
function isIgnorablePara(node: PMNode): boolean {
	return node.type.name === 'paragraph' && isIgnorableProcessText(node.textContent);
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
		if (child.type.name !== 'paragraph' || !isProcessHeaderText(child.textContent)) {
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
			// 공백 / `---` 문단은 스테이지가 아니다 — 건너뛰고 계속 스캔.
			if (isIgnorablePara(p)) {
				j++;
				continue;
			}
			const text = p.textContent.trim();
			// A new Process start (after the first stage) belongs to the next block.
			if (collected.length > 0 && PROCESS_RE.test(text)) break;

			// Collect this stage's lists; ignorable paragraphs BETWEEN lists are
			// skipped so spacers don't detach a list from its stage header.
			const lists: ProcessStageList[] = [];
			let k = j + 1;
			while (k < childCount) {
				const c = doc.child(k);
				if (isList(c)) {
					lists.push({ pos: positions[k], node: c, childIndex: k });
					k++;
				} else if (isIgnorablePara(c)) {
					k++;
				} else {
					break;
				}
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

function categoryTextOf(li: PMNode): string {
	const first = li.firstChild;
	if (!first || first.type.name !== 'paragraph') return '';
	return first.textContent.trim();
}

export function findProcessItems(blocks: ProcessBlock[]): ProcessItemRef[] {
	const items: ProcessItemRef[] = [];
	for (const block of blocks) {
		for (const stage of block.stages) {
			for (const list of stage.lists) {
				let liOffset = list.pos + 1; // step inside the list's opening token
				list.node.forEach((li) => {
					const liPos = liOffset;
					items.push({
						liPos,
						liNode: li,
						depth: 1,
						stage,
						block,
						containingListPos: list.pos,
						containingListNode: list.node
					});

					// Enumerate this card's depth-2 sub-items (one nested list level).
					const categoryText = categoryTextOf(li);
					let inLiOffset = liPos + 1;
					li.forEach((sub) => {
						if (isList(sub)) {
							const nestedListPos = inLiOffset;
							let subLiOffset = nestedListPos + 1;
							sub.forEach((subLi) => {
								items.push({
									liPos: subLiOffset,
									liNode: subLi,
									depth: 2,
									stage,
									block,
									containingListPos: nestedListPos,
									containingListNode: sub,
									parent: {
										liPos,
										liNode: li,
										categoryText,
										nestedListPos,
										nestedListNode: sub
									}
								});

								// Depth-3: checkbox items nested under this sub-item.
								let inSubLiOffset = subLiOffset + 1;
								subLi.forEach((subSub) => {
									if (isList(subSub)) {
										const d3ListPos = inSubLiOffset;
										let d3Offset = d3ListPos + 1;
										subSub.forEach((d3Li) => {
											items.push({
												liPos: d3Offset,
												liNode: d3Li,
												depth: 3,
												stage,
												block,
												containingListPos: d3ListPos,
												containingListNode: subSub
											});
											d3Offset += d3Li.nodeSize;
										});
									}
									inSubLiOffset += subSub.nodeSize;
								});

								subLiOffset += subLi.nodeSize;
							});
						}
						inLiOffset += sub.nodeSize;
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
