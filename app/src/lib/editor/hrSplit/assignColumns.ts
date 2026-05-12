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

export interface LayoutHints {
	/** Inline style per top-level child for headers (`grid-column: 1 / -1`)
	 *  and v-dividers (`grid-column: <track>`). null for every other role —
	 *  content blocks and h-lines are wrapped by the plugin's view() hook
	 *  into per-column flex containers, so their grid placement is governed
	 *  by the wrapper, not by the block itself. */
	styleFor: (string | null)[];
	/** Value for `grid-template-columns` on the editor root. N content
	 *  tracks (`1fr`) interleaved with N-1 divider tracks (`auto`). Null
	 *  when totalColumns <= 1 (no split active). */
	template: string | null;
}

/**
 * Per-block CSS hints for headers + dividers. Drops the explicit
 * `grid-row` positioning that the previous Grid-shared-row design relied
 * on — independent column flow is delegated to the per-column wrapper
 * elements created by the plugin's view() hook.
 *
 * Track layout for N content columns: N content tracks (`1fr`) interleaved
 * with N-1 divider tracks (`auto`). Content column `c` lands at grid
 * track `2c - 1`; divider `k` at grid track `2k + 2`.
 */
export function computeLayoutHints(
	placements: ReadonlyArray<Placement>,
	totalColumns: number
): LayoutHints {
	if (totalColumns <= 1) {
		return {
			styleFor: placements.map(() => null),
			template: null
		};
	}

	const styleFor: (string | null)[] = placements.map(p => {
		if (p.role === 'header') return 'grid-column:1 / -1;';
		if (p.role === 'v-divider') return `grid-column:${2 * p.dividerIdx + 2};`;
		return null;
	});

	const parts: string[] = [];
	for (let c = 1; c <= totalColumns; c++) {
		if (c > 1) parts.push('auto');
		parts.push('1fr');
	}

	return { styleFor, template: parts.join(' ') };
}

export interface ColumnGroup {
	/** Content column number (1-based). */
	col: number;
	/** Start index (inclusive) in the placement array. */
	startIdx: number;
	/** End index (exclusive). */
	endIdx: number;
}

/**
 * Group consecutive `block`/`h-line` placements that share the same
 * column number. Headers and v-dividers are skipped (they remain
 * top-level grid items). Each content column yields at most one
 * contiguous group — within a single column, blocks and h-lines are
 * always adjacent because a v-divider would advance the column number.
 */
export function computeColumnGroups(
	placements: ReadonlyArray<Placement>
): ColumnGroup[] {
	const groups: ColumnGroup[] = [];
	let i = 0;
	while (i < placements.length) {
		const p = placements[i];
		if (p.role !== 'block' && p.role !== 'h-line') {
			i++;
			continue;
		}
		const col = p.col;
		const startIdx = i;
		while (i < placements.length) {
			const q = placements[i];
			if ((q.role === 'block' || q.role === 'h-line') && q.col === col) {
				i++;
			} else {
				break;
			}
		}
		groups.push({ col, startIdx, endIdx: i });
	}
	return groups;
}
