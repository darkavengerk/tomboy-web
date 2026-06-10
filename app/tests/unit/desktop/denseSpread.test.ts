import { describe, it, expect } from 'vitest';
import {
	pickShrinkIndex,
	selectDenseLayout,
	SHRINK_LEVELS,
	MIN_RECLAIM,
	type DenseLayout
} from '$lib/desktop/spreadView/denseSpread.js';
import type { Box } from '$lib/desktop/spreadView/packMaxRects.js';

const box = (guid: string, w: number, h: number): Box => ({ guid, w, h });

describe('pickShrinkIndex — "의미있는 축소" rule', () => {
	it('stays at 0 when nothing reclaims the minimum (already tight)', () => {
		// every step saves < MIN_MARGINAL → never escalates, never crosses floor
		expect(pickShrinkIndex([1000, 998, 997, 996])).toBe(0);
	});

	it('escalates to the largest level while each step still pays its way', () => {
		// reclaim: .12, .18, .20 — marginals .12, .06, .02; last (<.03) breaks → idx 2 (=50)
		const heights = [1000, 880, 820, 800];
		expect(pickShrinkIndex(heights)).toBe(2);
		expect(SHRINK_LEVELS[pickShrinkIndex(heights)]).toBe(50);
	});

	it('goes all the way to 70 when every step keeps dropping meaningfully', () => {
		// marginals .10, .10, .10 — all ≥ .03, all cumulative ≥ floor → idx 3 (=70)
		expect(pickShrinkIndex([1000, 900, 800, 700])).toBe(3);
		expect(SHRINK_LEVELS[3]).toBe(70);
	});

	it('does not adopt overlap below the reclaim floor even if it keeps dropping', () => {
		// marginals are all ≥ .03 so it escalates, but cumulative never reaches
		// MIN_RECLAIM (.10) → chosen stays 0 (no overlap worth it)
		const heights = [1000, 965, 935, 910]; // reclaim max .09 < .10
		expect((1000 - heights[3]) / 1000).toBeLessThan(MIN_RECLAIM);
		expect(pickShrinkIndex(heights)).toBe(0);
	});

	it('reaches the floor on a later level after early sub-floor steps', () => {
		// 30: reclaim .06 (<floor, skip), 50: .12 (≥floor → chosen), 70: marginal .015 break
		expect(pickShrinkIndex([1000, 940, 880, 865])).toBe(2);
	});

	it('returns 0 for a degenerate zero-height baseline', () => {
		expect(pickShrinkIndex([0, 0, 0, 0])).toBe(0);
	});
});

describe('selectDenseLayout', () => {
	it('returns an empty layout for no boxes', () => {
		expect(selectDenseLayout([], 1000, 16)).toEqual({
			placed: [],
			totalHeight: 0,
			shrink: 0,
			metrics: []
		});
	});

	it('renders every card at its REAL size, not the shrunk footprint', () => {
		const boxes = [box('a', 300, 200), box('b', 280, 460), box('c', 320, 140)];
		const { placed } = selectDenseLayout(boxes, 1000, 16);
		for (const src of boxes) {
			const p = placed.find((q) => q.guid === src.guid)!;
			expect({ w: p.w, h: p.h }).toEqual({ w: src.w, h: src.h });
		}
	});

	it('places every box exactly once', () => {
		const boxes = [box('a', 300, 200), box('b', 300, 600), box('c', 300, 100)];
		const { placed } = selectDenseLayout(boxes, 1000, 16);
		expect(placed.map((p) => p.guid).sort()).toEqual(['a', 'b', 'c']);
	});

	it('orders cards top-to-bottom, left-to-right so bottom-right paints last', () => {
		const boxes = Array.from({ length: 8 }, (_, i) => box(`n${i}`, 240, 150 + (i % 3) * 90));
		const { placed } = selectDenseLayout(boxes, 800, 16);
		for (let i = 1; i < placed.length; i++) {
			const a = placed[i - 1];
			const b = placed[i];
			expect(a.y < b.y || (a.y === b.y && a.x <= b.x)).toBe(true);
		}
	});

	it('reports totalHeight as the real-size bottom edge of the chosen layout', () => {
		const boxes = [box('a', 300, 200), box('b', 300, 600), box('c', 300, 100)];
		const r: DenseLayout = selectDenseLayout(boxes, 1000, 16);
		expect(r.totalHeight).toBe(Math.max(...r.placed.map((p) => p.y + p.h)));
	});

	it('exposes baseline-first per-level metrics with a 0 baseline reclaim', () => {
		const boxes = [box('a', 300, 200), box('b', 280, 470), box('c', 300, 130)];
		const { metrics } = selectDenseLayout(boxes, 1000, 16);
		expect(metrics.map((m) => m.shrink)).toEqual([...SHRINK_LEVELS]);
		expect(metrics[0].reclaim).toBe(0);
	});

	it('keeps cards within the container width (real size clamped)', () => {
		const { placed } = selectDenseLayout([box('wide', 1400, 300)], 1000, 16);
		expect(placed[0].w).toBe(1000);
		expect(placed[0].x + placed[0].w).toBeLessThanOrEqual(1000);
	});
});
