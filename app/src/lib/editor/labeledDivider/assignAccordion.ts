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

/**
 * The "accordion box" — a 1×N table frame drawn around a group's
 * member+list run. The box exists only for a group whose accordion is
 * active (≥2 list-bearing members — the exact threshold that shows the
 * fold buttons), and spans from the first list-bearing member's divider
 * (top edge) to the last list-bearing member's last list block. Each
 * labeled divider inside is a row separator; any non-member content that
 * happens to sit between two members is inside the box, while content
 * before the first member / after the last member's list stays outside.
 *
 * The box is a *visual* frame, but its `bottom` edge is focus-dependent: a
 * folded member's list is hidden (`display:none`), so the bottom border
 * must land on the last *visible* block (dividers always stay visible).
 * This mirrors labeledFoldPlugin's own visibility logic so the two agree.
 */
export interface AccordionBox {
	/** Group index. */
	group: number;
	/** First list-bearing member's divider index — the box top edge. */
	top: number;
	/** Last list block index of the last list-bearing member — the logical
	 *  box end (may be hidden when that member's list is folded away). */
	end: number;
	/** Last *visible* index in `[top, end]` for the given focus — carries
	 *  the bottom border. */
	bottom: number;
}

export function computeAccordionBoxes(
	members: AccordionMember[],
	memberCountByGroup: Map<number, number>,
	focused: ReadonlySet<number> = new Set()
): AccordionBox[] {
	// list-bearing members per group, in doc order (members[] is doc order).
	const byGroup = new Map<number, AccordionMember[]>();
	for (const m of members) {
		if (!m.isListBearing) continue;
		const arr = byGroup.get(m.group);
		if (arr) arr.push(m);
		else byGroup.set(m.group, [m]);
	}

	const boxes: AccordionBox[] = [];
	for (const [group, gms] of byGroup) {
		// Only ≥2-member groups have an active accordion (and a box).
		if ((memberCountByGroup.get(group) ?? 0) < 2) continue;

		const top = gms[0].index;
		let end = top;
		for (const m of gms) {
			for (const li of m.listIndices) if (li > end) end = li;
		}

		// At most one focused member per group; default (no focus) = all open.
		let focusedOrd: number | null = null;
		for (const m of gms) {
			if (focused.has(m.ord)) {
				focusedOrd = m.ord;
				break;
			}
		}
		// Hidden = the list runs of every non-open member (only when a focus
		// is set). Dividers and other blocks are never hidden.
		const hidden = new Set<number>();
		if (focusedOrd !== null) {
			for (const m of gms) {
				if (m.ord === focusedOrd) continue;
				for (const li of m.listIndices) hidden.add(li);
			}
		}

		let bottom = top;
		for (let i = end; i >= top; i--) {
			if (!hidden.has(i)) {
				bottom = i;
				break;
			}
		}

		boxes.push({ group, top, end, bottom });
	}
	return boxes;
}
