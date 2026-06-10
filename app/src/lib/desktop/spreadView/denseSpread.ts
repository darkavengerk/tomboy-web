/**
 * Overlap-allowed dense layout for the desktop 펼쳐보기 (spread view).
 *
 * The base packer (`packMaxRects`) tiles notes at their *real* size with no
 * overlap, which leaves jagged whitespace whenever note sizes don't tessellate.
 * This layer reclaims that whitespace by registering each note a few px *smaller*
 * (its "footprint") so the packer tucks them tighter — then rendering each card
 * at its *real* size. The real card therefore spills past its footprint on the
 * right + bottom and overlaps its neighbours by `shrink − gap` px. Because a note
 * anchors at its top-left (title + leading content), only the bottom-right fringe
 * gets covered; the overlay raises whichever card the mouse hovers, so any
 * covered card is one hover away from fully visible.
 *
 * ## Picking the shrink amount — "의미있는 축소"
 *
 * Shrinking only earns its overlap if it actually lowers the total scroll height.
 * We pack at several shrink levels and pick the largest one that is still pulling
 * its weight, by the *rendered* height `H(s) = max(y + realHeight)` (honest: it
 * includes the unavoidable bottom-row spill):
 *
 *   reclaim(s)  = (H(0) − H(s)) / H(0)        // fraction of scroll height saved
 *   marginal(s) = (H(prev) − H(s)) / H(0)     // extra saved by escalating one level
 *
 *   - Escalate 30 → 50 → 70 while each step's `marginal ≥ MIN_MARGINAL`
 *     (the curve is still dropping; stop the moment it flattens).
 *   - Among the escalated levels, adopt overlap only once `reclaim ≥ MIN_RECLAIM`
 *     — below that the notes already tile tight and overlap buys nothing, so we
 *     keep `shrink = 0` (no overlap at all).
 *
 * `n` is tiny (open windows) so packing at 4 levels every layout is free.
 */
import { packMaxRects, type Box, type PlacedBox } from './packMaxRects.js';

/** Shrink amounts (px) probed each layout. Index 0 (no shrink) is the baseline. */
export const SHRINK_LEVELS = [0, 30, 50, 70] as const;

/** Minimum total scroll-height fraction reclaimed to adopt overlap at all. */
export const MIN_RECLAIM = 0.1;
/** Minimum extra fraction one shrink step must reclaim to be worth escalating. */
export const MIN_MARGINAL = 0.03;
/** Cap per side: a box never shrinks below this fraction of that side. */
export const MAX_SIDE_FRACTION = 0.3;

export interface ShrinkMetric {
	shrink: number;
	height: number;
	reclaim: number;
}

export interface DenseLayout {
	/** Real-size cards at packed positions, sorted (y, x) so bottom-right paints last. */
	placed: PlacedBox[];
	/** Rendered scroll height = max(y + realHeight). */
	totalHeight: number;
	/** Chosen shrink amount (0 = no overlap). */
	shrink: number;
	/** Per-level diagnostics, baseline first. */
	metrics: ShrinkMetric[];
}

/** Footprint side after shrinking by `s`, clamped so it stays ≥ (1−frac) of the side. */
function footprintSide(side: number, s: number): number {
	return side - Math.min(s, Math.floor(MAX_SIDE_FRACTION * side));
}

/**
 * Pack `boxes` (real sizes) with each registered `shrink` px smaller, then map
 * the placements back to real size. Returns real-size cards plus the rendered
 * height (which includes the bottom row's real-size spill below its footprint).
 */
function packDense(
	boxes: Box[],
	containerWidth: number,
	gap: number,
	shrink: number
): { placed: PlacedBox[]; height: number } {
	const real = new Map(boxes.map((b) => [b.guid, b]));
	const footprints: Box[] = boxes.map((b) => ({
		guid: b.guid,
		w: footprintSide(b.w, shrink),
		h: footprintSide(b.h, shrink)
	}));
	const packed = packMaxRects(footprints, containerWidth, gap);
	let height = 0;
	const placed: PlacedBox[] = packed.placed.map((p) => {
		const src = real.get(p.guid)!;
		// Render at real size, clamped to the strip width like the base packer.
		const w = Math.min(src.w, containerWidth);
		const h = src.h;
		height = Math.max(height, p.y + h);
		return { guid: p.guid, x: p.x, y: p.y, w, h };
	});
	return { placed, height };
}

/**
 * Choose a shrink-level index from per-level rendered heights (baseline first).
 * Pure so the selection rule is unit-testable apart from the packer. See the
 * module header for the rule; returns an index into `SHRINK_LEVELS`.
 */
export function pickShrinkIndex(heights: number[]): number {
	const h0 = heights[0];
	if (!h0) return 0;
	let chosen = 0;
	let prev = h0;
	for (let i = 1; i < heights.length; i++) {
		const h = heights[i];
		const marginal = (prev - h) / h0;
		if (marginal < MIN_MARGINAL) break; // curve flattened — escalating costs overlap for nothing
		const reclaim = (h0 - h) / h0;
		if (reclaim >= MIN_RECLAIM) chosen = i; // crossed the floor — overlap now pays off
		prev = h;
	}
	return chosen;
}

export function selectDenseLayout(boxes: Box[], containerWidth: number, gap: number): DenseLayout {
	if (boxes.length === 0) return { placed: [], totalHeight: 0, shrink: 0, metrics: [] };

	const layouts = SHRINK_LEVELS.map((s) => packDense(boxes, containerWidth, gap, s));
	const heights = layouts.map((l) => l.height);
	const h0 = heights[0];
	const metrics: ShrinkMetric[] = SHRINK_LEVELS.map((s, i) => ({
		shrink: s,
		height: heights[i],
		reclaim: h0 ? (h0 - heights[i]) / h0 : 0
	}));

	const idx = pickShrinkIndex(heights);
	const chosen = layouts[idx];
	const placed = chosen.placed.slice().sort((a, b) => a.y - b.y || a.x - b.x);
	return { placed, totalHeight: chosen.height, shrink: SHRINK_LEVELS[idx], metrics };
}
