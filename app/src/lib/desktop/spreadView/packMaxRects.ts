/**
 * Dense 2D rectangle packing for the desktop 펼쳐보기 (spread view), via the
 * MaxRects heuristic (`maxrects-packer`).
 *
 * Boxes keep their real width/height; they are packed bottom-left into a strip
 * of fixed `containerWidth` that grows downward (vertical scroll). Unlike the
 * earlier shelf packer this fills the gaps *under* short notes, so the gallery
 * looks densely tiled instead of leaving a black band beneath every short note.
 *
 * Why a library: the 2D strip-packing optimum is NP-hard, so everyone (this
 * code included) uses a heuristic. MaxRects is the densest of the common online
 * heuristics, but its free-rectangle subtraction/merge logic is the bug-prone
 * part — exactly where an audited library earns its place (contrast
 * `dragResize.ts`, whose geometry is simple enough to hand-roll). Trade-off:
 * input order is NOT preserved (the packer reorders to pack tightly); the
 * spread view accepts shuffled order in exchange for density.
 *
 * ## Why we search for the strip height instead of using one tall bin
 *
 * `maxrects-packer` packs into a fixed `width × height` bin. The obvious move —
 * one bin with a near-infinite height — backfires: with effectively unbounded
 * vertical room the heuristic always finds a "perfect" downward fit and stacks
 * equal-width notes into a single column, wasting the horizontal space (the
 * exact symptom we set out to fix). So we instead *minimise the strip height*
 * directly, which is the real packing objective: binary-search the smallest
 * height at which every box still fits in a single bin. Too small → a box
 * overflows into a second bin (infeasible); the smallest feasible height is the
 * tightest layout. `n` is tiny here (open windows), so the ~log₂ extra packs
 * are negligible.
 */
import { MaxRectsPacker } from 'maxrects-packer';

export interface Box {
	guid: string;
	w: number;
	h: number;
}

export interface PlacedBox extends Box {
	x: number;
	y: number;
}

export interface PackResult {
	placed: PlacedBox[];
	totalHeight: number;
}

const PACK_OPTS = {
	smart: false, // keep the bin at the full containerWidth; `smart` shrinks it
	pow2: false,
	square: false,
	allowRotation: false,
	border: 0 // edge boxes sit flush at 0,0 — the overlay supplies outer padding
};

/**
 * Pack `boxes` into a `height`-tall, `containerWidth`-wide bin. Returns the
 * placed rectangles and whether they all fit in a single bin (feasible) — an
 * overflow bin or an oversized rect means `height` is too small.
 */
function packAt(
	boxes: Box[],
	containerWidth: number,
	gap: number,
	height: number
): { placed: PlacedBox[]; totalHeight: number; feasible: boolean } {
	const packer = new MaxRectsPacker(containerWidth, height, gap, PACK_OPTS);
	for (const b of boxes) {
		packer.add(b.w, b.h, { guid: b.guid });
	}
	const placed: PlacedBox[] = [];
	let totalHeight = 0;
	let oversized = false;
	for (const bin of packer.bins) {
		for (const r of bin.rects) {
			if (r.oversized) oversized = true;
			placed.push({ guid: r.data.guid as string, x: r.x, y: r.y, w: r.width, h: r.height });
			totalHeight = Math.max(totalHeight, r.y + r.height);
		}
	}
	return { placed, totalHeight, feasible: packer.bins.length === 1 && !oversized };
}

export function packMaxRects(boxes: Box[], containerWidth: number, gap: number): PackResult {
	if (boxes.length === 0) return { placed: [], totalHeight: 0 };

	// Clamp any box wider than the strip; an over-wide box would otherwise be
	// kicked into an OversizedElementBin instead of placed in the strip.
	const clamped = boxes.map((b) => ({ guid: b.guid, w: Math.min(b.w, containerWidth), h: b.h }));

	// Lower bound: the strip can't be shorter than the tallest box, nor shorter
	// than total-area / width. Upper bound: a single stacked column always fits.
	const totalArea = clamped.reduce((s, b) => s + b.w * b.h, 0);
	const tallest = Math.max(...clamped.map((b) => b.h));
	let lo = Math.max(tallest, Math.ceil(totalArea / containerWidth));
	let hi = clamped.reduce((s, b) => s + b.h + gap, 0);

	// Smallest height at which everything fits in one bin. `best` always holds a
	// feasible layout: hi (single column) is feasible, so the loop sets it.
	let best = packAt(clamped, containerWidth, gap, hi);
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		const attempt = packAt(clamped, containerWidth, gap, mid);
		if (attempt.feasible) {
			best = attempt;
			hi = mid - 1;
		} else {
			lo = mid + 1;
		}
	}
	return { placed: best.placed, totalHeight: best.totalHeight };
}
