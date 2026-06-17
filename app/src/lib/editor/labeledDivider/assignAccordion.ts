/**
 * Pure accordion-assignment logic for the labeled-divider list fold.
 *
 * Model — labeled dividers (`텍스트 ---`) are grouped by plain `---` HR
 * markers: each `---` ends a group and starts the next. Within a group, a
 * labeled divider whose IMMEDIATELY following top-level block(s) form a
 * list owns that list run and is a foldable "member". The plugin shows at
 * most one member's list per group; this module only computes the static
 * structure.
 *
 * Ordinals number ALL labeled dividers post-header in document order, so
 * attaching/removing a list under a divider doesn't renumber the others.
 */

export type AccordionBlockKind = 'hr' | 'divider' | 'list' | 'other';

export interface AccordionMember {
	/** Index into the top-level children array (the divider paragraph). */
	index: number;
	/** Ordinal among all labeled dividers post-header, doc order, 0-based. */
	ord: number;
	/** Group index, 0-based; bumped by each plain `---` HR. */
	group: number;
	/** Top-level indices of the consecutive list run right after the
	 *  divider. Empty when the next block is not a list. */
	listIndices: number[];
	/** listIndices.length > 0. Only list-bearing members get fold UI and
	 *  participate in the accordion. */
	isListBearing: boolean;
}

export interface AccordionInput {
	kinds: AccordionBlockKind[];
	/** Leading children excluded (title + subtitle). Defaults to 0. */
	headerCount?: number;
}

export interface AccordionOutput {
	/** Every labeled divider post-header, doc order. */
	members: AccordionMember[];
	/** group → count of list-bearing members in it. */
	memberCountByGroup: Map<number, number>;
}

export function assignAccordion({
	kinds,
	headerCount: rawHeaderCount = 0
}: AccordionInput): AccordionOutput {
	const headerCount = Math.max(0, Math.min(rawHeaderCount, kinds.length));
	const members: AccordionMember[] = [];
	let group = 0;
	let ord = -1;

	for (let i = headerCount; i < kinds.length; i++) {
		const k = kinds[i];
		if (k === 'hr') {
			group++;
			continue;
		}
		if (k !== 'divider') continue;
		ord++;
		const listIndices: number[] = [];
		let j = i + 1;
		while (j < kinds.length && kinds[j] === 'list') {
			listIndices.push(j);
			j++;
		}
		members.push({
			index: i,
			ord,
			group,
			listIndices,
			isListBearing: listIndices.length > 0
		});
	}

	const memberCountByGroup = new Map<number, number>();
	for (const m of members) {
		if (!m.isListBearing) continue;
		memberCountByGroup.set(m.group, (memberCountByGroup.get(m.group) ?? 0) + 1);
	}

	return { members, memberCountByGroup };
}
