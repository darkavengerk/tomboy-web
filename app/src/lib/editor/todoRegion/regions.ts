/**
 * TODO / Done region detection.
 *
 * A "region" is a top-level paragraph whose trimmed text starts with `TODO`
 * or `Done` (English, case-sensitive; `\b`-style boundary so `TODOLIST` and
 * `Donesia` don't match, but `TODO: ...` / `Done — Q2` do), followed by one
 * or more CONSECUTIVE list blocks (bulletList or orderedList).
 *
 * Multiple lists placed back-to-back after the header are logically one
 * region — note authors sometimes split a bullet run across two ul's and we
 * want them to behave as a single TODO area. The first top-level child
 * (note title) is never treated as a header.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

export type TodoRegionKind = 'TODO' | 'Done';

export interface TodoRegionList {
	/** Absolute position of the list node (its opening token). */
	pos: number;
	node: PMNode;
	/** Index of this list in the doc's top-level children. */
	childIndex: number;
}

export interface TodoRegion {
	kind: TodoRegionKind;
	/** Absolute position of the header paragraph node. */
	headerPos: number;
	/** Top-level child index of the header paragraph. */
	headerChildIndex: number;
	/** Contiguous list blocks making up this region (always >= 1). */
	lists: TodoRegionList[];
}

const TODO_RE = /^TODO(?![A-Za-z0-9_])/;
const DONE_RE = /^Done(?![A-Za-z0-9_])/;

function matchHeaderKind(text: string): TodoRegionKind | null {
	if (TODO_RE.test(text)) return 'TODO';
	if (DONE_RE.test(text)) return 'Done';
	return null;
}

export function findTodoRegions(doc: PMNode): TodoRegion[] {
	const regions: TodoRegion[] = [];
	const childCount = doc.childCount;
	if (childCount === 0) return regions;

	const positions: number[] = [];
	let offset = 0;
	doc.forEach((child) => {
		positions.push(offset);
		offset += child.nodeSize;
	});

	let i = 1; // skip title
	while (i < childCount) {
		const child = doc.child(i);
		if (child.type.name !== 'paragraph') {
			i++;
			continue;
		}
		const kind = matchHeaderKind(child.textContent.trim());
		if (kind === null) {
			i++;
			continue;
		}

		const lists: TodoRegionList[] = [];
		let j = i + 1;
		while (j < childCount) {
			const c = doc.child(j);
			const name = c.type.name;
			if (name === 'bulletList' || name === 'orderedList') {
				lists.push({ pos: positions[j], node: c, childIndex: j });
				j++;
			} else {
				break;
			}
		}

		if (lists.length > 0) {
			regions.push({
				kind,
				headerPos: positions[i],
				headerChildIndex: i,
				lists
			});
			i = j;
		} else {
			i++;
		}
	}

	return regions;
}

export function regionContainingPos(
	regions: TodoRegion[],
	pos: number
): TodoRegion | null {
	for (const r of regions) {
		for (const l of r.lists) {
			if (pos >= l.pos && pos < l.pos + l.node.nodeSize) return r;
		}
	}
	return null;
}

/**
 * Pair each TODO region with the next Done region after it (doc order). A
 * Done can only pair with the nearest earlier unpaired TODO; a TODO that has
 * no Done following it is left unmapped so the move command can create one.
 */
export function pairTodoRegions(
	regions: TodoRegion[]
): Map<TodoRegion, TodoRegion> {
	const pairs = new Map<TodoRegion, TodoRegion>();
	let pendingTodo: TodoRegion | null = null;
	for (const r of regions) {
		if (r.kind === 'TODO') {
			pendingTodo = r;
		} else if (pendingTodo) {
			pairs.set(pendingTodo, r);
			pairs.set(r, pendingTodo);
			pendingTodo = null;
		}
	}
	return pairs;
}
