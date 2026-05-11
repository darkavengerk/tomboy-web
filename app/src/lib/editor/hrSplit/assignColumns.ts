/**
 * Pure column-assignment logic for the HR split-layout feature.
 *
 * Model — every top-level child is either a regular block or an HR marker
 * (a paragraph whose entire text is 3+ dashes). Each HR marker has a
 * binary state: active (split-active = vertical divider) or inactive
 * (renders as a horizontal line within its current column).
 *
 * Rule: N active dividers split the doc into N+1 columns. Walking
 * top-level children in order, the "current column" starts at 1 and
 * increments past every active divider. Blocks (and inactive HRs)
 * belong to the column that was current when they were visited. Active
 * HRs sit in the divider track between columns N and N+1.
 *
 * Within a column, the sequence of blocks and inactive HRs is unchanged
 * — each column reads top-to-bottom as if it were a normal note.
 */

export type BlockKind = 'hr' | 'block';

export type Placement =
	| { role: 'block'; col: number }            // ordinary block in column `col` (1-based)
	| { role: 'h-line'; col: number }           // inactive HR rendered as horizontal line in column `col`
	| { role: 'v-divider'; dividerIdx: number }; // active HR rendered as vertical divider, 0-indexed among actives

export interface AssignInput {
	kinds: BlockKind[];
	/** 0-based ordinals among HRs only that are split-active. Ordinals
	 *  not corresponding to an HR in `kinds` are silently ignored. */
	activeOrdinals: ReadonlySet<number>;
}

export interface AssignOutput {
	placements: Placement[];
	/** Number of content columns. Always >= 1; equals 1 + (count of active
	 *  HRs encountered in `kinds`). */
	totalColumns: number;
}

export function assignColumns({ kinds, activeOrdinals }: AssignInput): AssignOutput {
	const placements: Placement[] = [];
	let col = 1;
	let hrOrd = 0;
	let activeCount = 0;

	for (const kind of kinds) {
		if (kind === 'hr') {
			if (activeOrdinals.has(hrOrd)) {
				placements.push({ role: 'v-divider', dividerIdx: activeCount });
				activeCount++;
				col++;
			} else {
				placements.push({ role: 'h-line', col });
			}
			hrOrd++;
		} else {
			placements.push({ role: 'block', col });
		}
	}

	return { placements, totalColumns: col };
}

export interface GridStyleOutput {
	/** Inline-style string per top-level child, parallel to placements.
	 *  Each style sets explicit grid-row + grid-column. Null when no grid
	 *  layout is needed (`totalColumns === 1`). */
	styleFor: (string | null)[];
	/** Value for `grid-template-columns` on the editor root. Alternates
	 *  `1fr` content tracks with `auto` divider tracks. Null when no grid
	 *  layout is needed. */
	template: string | null;
	totalColumns: number;
}

/**
 * Translate `Placement[]` into CSS Grid coordinates.
 *
 * Track layout for N content columns: N content tracks (`1fr`) interleaved
 * with N-1 divider tracks (`auto`). Content column `c` (1-based) lives at
 * grid track `2c - 1`; divider `k` (0-based) at grid track `2k + 2`.
 *
 * Row layout: each column reads independently top-to-bottom — block `i`
 * in column `c` lands at grid-row equal to its sequence index within that
 * column. Dividers span `1 / span maxRowsAcrossColumns` so they always
 * draw the full height of the tallest column.
 */
export function computeGridStyles(
	placements: ReadonlyArray<Placement>,
	totalColumns: number
): GridStyleOutput {
	if (totalColumns <= 1) {
		return {
			styleFor: placements.map(() => null),
			template: null,
			totalColumns
		};
	}

	// rowCounts[c] = number of non-divider blocks placed in column `c` so far.
	const rowCounts: number[] = new Array(totalColumns + 1).fill(0); // 1-indexed
	const rowOf: number[] = new Array(placements.length).fill(0);

	for (let i = 0; i < placements.length; i++) {
		const p = placements[i];
		if (p.role !== 'v-divider') {
			rowCounts[p.col] += 1;
			rowOf[i] = rowCounts[p.col];
		}
	}

	let maxRows = 1;
	for (let c = 1; c <= totalColumns; c++) {
		if (rowCounts[c] > maxRows) maxRows = rowCounts[c];
	}

	const styleFor: (string | null)[] = new Array(placements.length).fill(null);
	for (let i = 0; i < placements.length; i++) {
		const p = placements[i];
		if (p.role === 'v-divider') {
			const track = 2 * p.dividerIdx + 2;
			styleFor[i] = `grid-column:${track};grid-row:1 / span ${maxRows};`;
		} else {
			const track = 2 * p.col - 1;
			styleFor[i] = `grid-column:${track};grid-row:${rowOf[i]};`;
		}
	}

	const parts: string[] = [];
	for (let c = 1; c <= totalColumns; c++) {
		if (c > 1) parts.push('auto');
		parts.push('1fr');
	}

	return { styleFor, template: parts.join(' '), totalColumns };
}
