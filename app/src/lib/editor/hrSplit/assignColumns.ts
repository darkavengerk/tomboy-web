/**
 * Pure column-assignment logic for the HR split-layout feature.
 *
 * Model — every top-level child is either a regular block, a header, or
 * an HR marker. Each HR marker has a binary state: active (split-active
 * = vertical divider) or inactive (horizontal line within its column).
 *
 * Header blocks (typically the first N children: title + subtitle line)
 * are reserved for note metadata and never participate in column
 * splitting. They span the full grid width above the split area.
 *
 * Rule: N active dividers split the *content* area (everything after the
 * header) into N+1 columns. The walking algorithm starts at column 1 and
 * advances past every active divider. Inactive HRs become h-lines in
 * the current column.
 */

export type BlockKind = 'hr' | 'block';

export type Placement =
	| { role: 'header' }
	| { role: 'block'; col: number }
	| { role: 'h-line'; col: number }
	| { role: 'v-divider'; dividerIdx: number };

export interface AssignInput {
	kinds: BlockKind[];
	activeOrdinals: ReadonlySet<number>;
	/** Number of leading top-level children to treat as header (full-width,
	 *  excluded from split layout). Capped at `kinds.length`. Defaults to 0
	 *  so the pure algorithm has no implicit header assumption. */
	headerCount?: number;
}

export interface AssignOutput {
	placements: Placement[];
	/** Number of content columns. Always >= 1; equals 1 + (active HR count). */
	totalColumns: number;
	/** Effective header count (clamped to kinds.length). */
	headerCount: number;
}

export function assignColumns({
	kinds,
	activeOrdinals,
	headerCount: rawHeaderCount = 0
}: AssignInput): AssignOutput {
	const headerCount = Math.max(0, Math.min(rawHeaderCount, kinds.length));
	const placements: Placement[] = [];
	let col = 1;
	let hrOrd = 0;
	let activeCount = 0;

	for (let i = 0; i < kinds.length; i++) {
		if (i < headerCount) {
			placements.push({ role: 'header' });
			continue;
		}
		const kind = kinds[i];
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

	return { placements, totalColumns: col, headerCount };
}

export interface GridStyleOutput {
	/** Inline-style per top-level child. Each style sets explicit grid-row
	 *  + grid-column. Null when no grid layout is needed (totalColumns === 1
	 *  AND headerCount === 0). */
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
 * with N-1 divider tracks (`auto`). Content column `c` lands at grid
 * track `2c - 1`; divider `k` at grid track `2k + 2`.
 *
 * Row layout:
 *   - Headers occupy rows 1..headerCount, spanning all columns.
 *   - Content blocks occupy rows starting at headerCount + 1, counting
 *     up independently within each column.
 *   - Dividers span the full content area: rows headerCount+1 .. headerCount+maxContentRows.
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

	const headerCount = placements.findIndex(p => p.role !== 'header');
	const effHeader = headerCount < 0 ? placements.length : headerCount;

	const rowCounts: number[] = new Array(totalColumns + 1).fill(0);
	const rowOf: number[] = new Array(placements.length).fill(0);
	const contentStartRow = effHeader + 1;

	for (let i = 0; i < placements.length; i++) {
		const p = placements[i];
		if (p.role === 'header') {
			rowOf[i] = i + 1;
		} else if (p.role !== 'v-divider') {
			rowCounts[p.col] += 1;
			rowOf[i] = contentStartRow + rowCounts[p.col] - 1;
		}
	}

	let maxContentRows = 0;
	for (let c = 1; c <= totalColumns; c++) {
		if (rowCounts[c] > maxContentRows) maxContentRows = rowCounts[c];
	}
	if (maxContentRows < 1) maxContentRows = 1;

	const styleFor: (string | null)[] = new Array(placements.length).fill(null);
	for (let i = 0; i < placements.length; i++) {
		const p = placements[i];
		if (p.role === 'header') {
			styleFor[i] = `grid-column:1 / -1;grid-row:${rowOf[i]};`;
		} else if (p.role === 'v-divider') {
			const track = 2 * p.dividerIdx + 2;
			styleFor[i] = `grid-column:${track};grid-row:${contentStartRow} / span ${maxContentRows};`;
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
	const template = parts.join(' ');

	return { styleFor, template, totalColumns };
}
