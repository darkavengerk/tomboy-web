import { describe, it, expect } from 'vitest';
import { nodeColor } from '$lib/codegraph/nodeColor.js';

function extractHue(css: string): number {
	const m = css.match(/^hsl\(([-\d.]+),\s*60%,\s*55%\)$/);
	if (!m) throw new Error(`unexpected color string: ${css}`);
	return parseFloat(m[1]);
}

describe('nodeColor', () => {
	it('is deterministic for the same input', () => {
		expect(nodeColor(7)).toBe(nodeColor(7));
		expect(nodeColor(42)).toBe(nodeColor(42));
		expect(nodeColor(0)).toBe(nodeColor(0));
	});

	it('returns hsl(0, 60%, 55%) for community 0', () => {
		expect(nodeColor(0)).toBe('hsl(0, 60%, 55%)');
	});

	it('returns hsl(137.5, 60%, 55%) for community 1', () => {
		expect(nodeColor(1)).toBe('hsl(137.5, 60%, 55%)');
	});

	it('hue diff between communities 0 and 1 is >= 30°', () => {
		const h0 = extractHue(nodeColor(0));
		const h1 = extractHue(nodeColor(1));
		const direct = Math.abs(h1 - h0);
		const wrap = Math.min(direct, 360 - direct);
		expect(wrap).toBeGreaterThanOrEqual(30);
	});

	it('negative input produces a valid hsl with hue in [0, 360)', () => {
		const css = nodeColor(-3);
		expect(css).toMatch(/^hsl\([-\d.]+,\s*60%,\s*55%\)$/);
		const h = extractHue(css);
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThan(360);
	});

	it('non-integer input is rounded (2.7 → 3)', () => {
		expect(nodeColor(2.7)).toBe(nodeColor(3));
	});

	it('non-integer input rounded down for x.4 (2.4 → 2)', () => {
		expect(nodeColor(2.4)).toBe(nodeColor(2));
	});
});
