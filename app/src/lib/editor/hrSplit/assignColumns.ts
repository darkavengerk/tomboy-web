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
 * Translate `Placement[]` into CSS Grid coordinates for a **masonry**
 * layout (`grid-template-rows: masonry` on the editor root).
 *
 * Masonry packs each grid column independently along the masonry axis,
 * so items in different columns do NOT share a row height — a tall image
 * in column 1 no longer forces column 2's adjacent block to grow. The
 * spec disallows spanning the masonry axis, so we emit `grid-column`
 * only (no `grid-row`).
 *
 * Track layout for N content columns: N content tracks (`1fr`) interleaved
 * with N-1 divider tracks (`auto`). Content column `c` lands at grid
 * track `2c - 1`; divider `k` at grid track `2k + 2`. Headers span all
 * tracks via `grid-column: 1 / -1`; per the masonry spec, full-axis
 * spanners act as breakpoints — content above them packs per-column up
 * to that point, then the spanner sits across, then content below
 * starts fresh per-column.
 *
 * Divider elements end up small at the top of their column track
 * (intrinsic size only — `align-self: stretch` is undefined along the
 * masonry axis). The hrSplit plugin's `view()` hook is responsible for
 * sizing the divider visual to match the tallest content column at
 * runtime (Firefox-only — masonry isn't shipped in Chromium/WebKit as
 * of 2026-Q1).
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

	const styleFor: (string | null)[] = placements.map(p => {
		if (p.role === 'header') return 'grid-column:1 / -1;';
		if (p.role === 'v-divider') return `grid-column:${2 * p.dividerIdx + 2};`;
		if (p.role === 'h-line') return `grid-column:${2 * p.col - 1};`;
		return `grid-column:${2 * p.col - 1};`;
	});

	const parts: string[] = [];
	for (let c = 1; c <= totalColumns; c++) {
		if (c > 1) parts.push('auto');
		parts.push('1fr');
	}
	const template = parts.join(' ');

	return { styleFor, template, totalColumns };
}
