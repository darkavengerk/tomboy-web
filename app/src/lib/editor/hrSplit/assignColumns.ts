/**
 * Pure column-assignment logic for the HR split-layout feature.
 *
 * Given a flat sequence of top-level block "kinds" (HR or non-HR) and the set
 * of HR ordinals (0-based among HRs only) that are split-active, produce a
 * per-block role assignment that the plugin turns into decoration classes.
 *
 * Algorithm — segments are the runs of non-HR blocks between HRs (or the doc
 * bounds). For each active HR at ordinal k, we pair the immediately
 * preceding segment (LEFT) with the immediately following segment (RIGHT)
 * and tag the HR itself as DIVIDER. Cursor advances past both segments so
 * the next decision starts fresh at the segment after RIGHT — meaning
 * adjacent active HRs are resolved first-wins (the second active HR in a
 * chain reverts to a plain HR visually, since its left-side segment is
 * already consumed as the right column of the first split).
 *
 * Returns one role per input block, in the same order.
 */

export type BlockKind = 'hr' | 'block';

export type ColumnRole =
	| 'full'        // ordinary block, full editor width
	| 'left'        // block placed in the left column of a split
	| 'right'       // block placed in the right column of a split
	| 'divider'     // active HR acting as the vertical divider
	| 'plain-hr';   // inactive HR (or active-but-overridden HR)

export interface AssignInput {
	kinds: BlockKind[];
	/** 0-based ordinals among HRs only that are split-active. */
	activeOrdinals: ReadonlySet<number>;
}

export function assignColumns({ kinds, activeOrdinals }: AssignInput): ColumnRole[] {
	const out: ColumnRole[] = kinds.map(k => (k === 'hr' ? 'plain-hr' : 'full'));

	// Decompose into segments + HR positions in the kinds array.
	// segmentRanges[i] = [startIdx, endIdxExclusive) of segment i in kinds.
	// hrIndexInKinds[i] = index in kinds where HR i sits.
	const segmentRanges: Array<[number, number]> = [];
	const hrIndexInKinds: number[] = [];
	{
		let segStart = 0;
		for (let i = 0; i < kinds.length; i++) {
			if (kinds[i] === 'hr') {
				segmentRanges.push([segStart, i]);
				hrIndexInKinds.push(i);
				segStart = i + 1;
			}
		}
		segmentRanges.push([segStart, kinds.length]);
	}

	const n = hrIndexInKinds.length;
	let segCursor = 0;
	while (segCursor < segmentRanges.length) {
		const isLastSeg = segCursor === segmentRanges.length - 1;
		if (!isLastSeg && activeOrdinals.has(segCursor)) {
			// Split: seg[segCursor] = LEFT, hr[segCursor] = DIVIDER, seg[segCursor+1] = RIGHT
			const [ls, le] = segmentRanges[segCursor];
			for (let i = ls; i < le; i++) out[i] = 'left';
			out[hrIndexInKinds[segCursor]] = 'divider';
			const [rs, re] = segmentRanges[segCursor + 1];
			for (let i = rs; i < re; i++) out[i] = 'right';
			segCursor += 2;
		} else {
			// Full-width segment; HR (if any) at end of this segment stays plain.
			// (Already initialised; nothing to do.)
			segCursor += 1;
		}
	}

	// Sanity: any HR ordinal we marked active but didn't consume stays plain-hr
	// (already the default). No further action.
	void n;
	void activeOrdinals;
	return out;
}
