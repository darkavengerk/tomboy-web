/**
 * Pure First-Fit "shelf" packing for the desktop 펼쳐보기 (spread view).
 *
 * Boxes keep their real width/height; we lay them left-to-right into rows
 * ("shelves") of fixed `containerWidth`. When the next box doesn't fit on the
 * current shelf, a new shelf starts below the tallest box of the previous one.
 * Input order is preserved (no height sorting) so visual order matches the
 * caller's order (row-major by original window position). A box wider than the
 * container is clamped to the container width (full-width row).
 *
 * Hand-rolled (no library) to match this repo's no-lib convention — see
 * `dragResize.ts`. Trade-off: real-size packing leaves a ragged right edge,
 * which is the accepted cost of preserving each note's true size.
 */
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

export function packShelves(boxes: Box[], containerWidth: number, gap: number): PackResult {
	const placed: PlacedBox[] = [];
	let shelfX = 0;
	let shelfY = 0;
	let shelfH = 0;
	for (const box of boxes) {
		const w = Math.min(box.w, containerWidth);
		const h = box.h;
		// Start a new shelf when the box can't fit on the current one. The
		// `shelfX > 0` guard keeps the first box on shelf 0 even when it is
		// exactly `containerWidth` wide.
		if (shelfX > 0 && shelfX + w > containerWidth) {
			shelfY += shelfH + gap;
			shelfX = 0;
			shelfH = 0;
		}
		placed.push({ guid: box.guid, x: shelfX, y: shelfY, w, h });
		shelfX += w + gap;
		shelfH = Math.max(shelfH, h);
	}
	return { placed, totalHeight: boxes.length ? shelfY + shelfH : 0 };
}
