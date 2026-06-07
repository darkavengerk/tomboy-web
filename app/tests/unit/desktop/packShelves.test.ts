import { describe, it, expect } from 'vitest';
import { packShelves, type Box } from '$lib/desktop/spreadView/packShelves.js';

const box = (guid: string, w: number, h: number): Box => ({ guid, w, h });

describe('packShelves', () => {
	it('returns empty layout for no boxes', () => {
		expect(packShelves([], 1000, 16)).toEqual({ placed: [], totalHeight: 0 });
	});

	it('places boxes left-to-right on one shelf when they fit', () => {
		const r = packShelves([box('a', 300, 200), box('b', 300, 150)], 1000, 16);
		expect(r.placed).toEqual([
			{ guid: 'a', x: 0, y: 0, w: 300, h: 200 },
			{ guid: 'b', x: 316, y: 0, w: 300, h: 150 }
		]);
		expect(r.totalHeight).toBe(200);
	});

	it('wraps to a new shelf below the tallest box of the previous shelf', () => {
		const r = packShelves(
			[box('a', 600, 200), box('b', 600, 150), box('c', 300, 100)],
			1000,
			16
		);
		expect(r.placed[0]).toEqual({ guid: 'a', x: 0, y: 0, w: 600, h: 200 });
		expect(r.placed[1]).toEqual({ guid: 'b', x: 0, y: 216, w: 600, h: 150 });
		expect(r.placed[2]).toEqual({ guid: 'c', x: 616, y: 216, w: 300, h: 100 });
		expect(r.totalHeight).toBe(366);
	});

	it('preserves input order (no height sorting)', () => {
		const r = packShelves([box('tall', 300, 900), box('short', 300, 50)], 1000, 16);
		expect(r.placed.map((p) => p.guid)).toEqual(['tall', 'short']);
	});

	it('clamps a box wider than the container to container width', () => {
		const r = packShelves([box('wide', 1400, 300)], 1000, 16);
		expect(r.placed[0]).toEqual({ guid: 'wide', x: 0, y: 0, w: 1000, h: 300 });
		expect(r.totalHeight).toBe(300);
	});

	it('keeps a full-width box on its own shelf', () => {
		const r = packShelves([box('a', 1000, 100), box('b', 200, 80)], 1000, 16);
		expect(r.placed[0]).toEqual({ guid: 'a', x: 0, y: 0, w: 1000, h: 100 });
		expect(r.placed[1]).toEqual({ guid: 'b', x: 0, y: 116, w: 200, h: 80 });
		expect(r.totalHeight).toBe(196);
	});
});
