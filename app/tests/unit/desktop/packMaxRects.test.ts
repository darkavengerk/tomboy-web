import { describe, it, expect } from 'vitest';
import { packMaxRects, type Box, type PlacedBox } from '$lib/desktop/spreadView/packMaxRects.js';

const box = (guid: string, w: number, h: number): Box => ({ guid, w, h });

function overlaps(a: PlacedBox, b: PlacedBox): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('packMaxRects', () => {
	it('returns empty layout for no boxes', () => {
		expect(packMaxRects([], 1000, 16)).toEqual({ placed: [], totalHeight: 0 });
	});

	it('places every box exactly once, preserving guid → size', () => {
		const boxes = [box('a', 300, 200), box('b', 300, 150), box('c', 300, 600)];
		const r = packMaxRects(boxes, 1000, 16);
		expect(r.placed.map((p) => p.guid).sort()).toEqual(['a', 'b', 'c']);
		for (const src of boxes) {
			const p = r.placed.find((q) => q.guid === src.guid)!;
			expect({ w: p.w, h: p.h }).toEqual({ w: src.w, h: src.h });
		}
	});

	it('never overlaps two boxes', () => {
		const boxes = [
			box('a', 300, 200),
			box('b', 300, 150),
			box('c', 300, 600),
			box('d', 300, 80),
			box('e', 450, 300),
			box('f', 200, 90),
			box('g', 500, 120)
		];
		const { placed } = packMaxRects(boxes, 1000, 16);
		for (let i = 0; i < placed.length; i++) {
			for (let j = i + 1; j < placed.length; j++) {
				expect(overlaps(placed[i], placed[j]), `${placed[i].guid}↔${placed[j].guid}`).toBe(false);
			}
		}
	});

	it('keeps every box inside the container width', () => {
		const { placed } = packMaxRects(
			[box('a', 300, 200), box('b', 450, 150), box('c', 700, 600)],
			1000,
			16
		);
		for (const p of placed) {
			expect(p.x).toBeGreaterThanOrEqual(0);
			expect(p.x + p.w).toBeLessThanOrEqual(1000);
		}
	});

	it('reports totalHeight as the tightest bottom edge', () => {
		const { placed, totalHeight } = packMaxRects(
			[box('a', 300, 200), box('b', 300, 600), box('c', 300, 80)],
			1000,
			16
		);
		const computed = Math.max(...placed.map((p) => p.y + p.h));
		expect(totalHeight).toBe(computed);
	});

	it('clamps a box wider than the container to container width', () => {
		const { placed } = packMaxRects([box('wide', 1400, 300)], 1000, 16);
		expect(placed).toHaveLength(1);
		expect(placed[0].w).toBe(1000);
		expect(placed[0].x).toBe(0);
	});

	it('packs denser than a shelf layout — fills under short notes', () => {
		// Two 300×600 columns plus a short 300×100: a shelf packer would put the
		// short note on a new row below 600px. MaxRects tucks it beside/under,
		// so the strip stays well under the shelf height of 600 + gap + 100.
		const { totalHeight } = packMaxRects(
			[box('tall1', 300, 600), box('tall2', 300, 600), box('short', 300, 100)],
			1000,
			16
		);
		expect(totalHeight).toBe(600); // all three fit within the 600px tall row
	});
});
