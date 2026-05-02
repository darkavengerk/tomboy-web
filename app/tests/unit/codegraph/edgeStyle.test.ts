import { describe, it, expect } from 'vitest';
import { edgeStyle } from '$lib/codegraph/edgeStyle.js';

const BASE_TABLE: Record<string, [number, number, number, number]> = {
	contains: [120, 120, 120, 0.35],
	calls: [220, 220, 220, 0.65],
	references: [120, 200, 200, 0.55],
	cites: [220, 190, 130, 0.55],
	semantically_similar_to: [220, 150, 220, 0.45],
	conceptually_related_to: [180, 180, 180, 0.40],
	shares_data_with: [180, 180, 180, 0.40],
	rationale_for: [180, 180, 180, 0.40],
	implements: [180, 180, 180, 0.40]
};

describe('edgeStyle', () => {
	it('each base relation produces documented base RGBA at EXTRACTED', () => {
		for (const [relation, [r, g, b, a]] of Object.entries(BASE_TABLE)) {
			const style = edgeStyle(relation, 'EXTRACTED');
			expect(style.r).toBe(r);
			expect(style.g).toBe(g);
			expect(style.b).toBe(b);
			expect(style.a).toBeCloseTo(a, 9);
		}
	});

	it('INFERRED multiplies alpha by 0.55 (contains: 0.35 * 0.55 = 0.1925)', () => {
		const style = edgeStyle('contains', 'INFERRED');
		expect(style.r).toBe(120);
		expect(style.g).toBe(120);
		expect(style.b).toBe(120);
		expect(style.a).toBeCloseTo(0.35 * 0.55, 9);
	});

	it('AMBIGUOUS multiplies alpha by 0.30 and shifts R+=20, G-=10, B-=10', () => {
		const style = edgeStyle('contains', 'AMBIGUOUS');
		expect(style.r).toBe(140);
		expect(style.g).toBe(110);
		expect(style.b).toBe(110);
		expect(style.a).toBeCloseTo(0.35 * 0.30, 9);
	});

	it('AMBIGUOUS warm shift stays in [0, 255] for all defined relations', () => {
		for (const relation of Object.keys(BASE_TABLE)) {
			const style = edgeStyle(relation, 'AMBIGUOUS');
			expect(style.r).toBeGreaterThanOrEqual(0);
			expect(style.r).toBeLessThanOrEqual(255);
			expect(style.g).toBeGreaterThanOrEqual(0);
			expect(style.g).toBeLessThanOrEqual(255);
			expect(style.b).toBeGreaterThanOrEqual(0);
			expect(style.b).toBeLessThanOrEqual(255);
			expect(style.a).toBeGreaterThanOrEqual(0);
			expect(style.a).toBeLessThanOrEqual(1);
		}
	});

	it('unknown relation falls back to gray (120, 120, 120, 0.30) at EXTRACTED', () => {
		const style = edgeStyle('not_a_real_relation', 'EXTRACTED');
		expect(style.r).toBe(120);
		expect(style.g).toBe(120);
		expect(style.b).toBe(120);
		expect(style.a).toBeCloseTo(0.30, 9);
	});

	it('AMBIGUOUS alpha is less than EXTRACTED alpha for the same relation', () => {
		for (const relation of Object.keys(BASE_TABLE)) {
			const ext = edgeStyle(relation, 'EXTRACTED');
			const amb = edgeStyle(relation, 'AMBIGUOUS');
			expect(amb.a).toBeLessThan(ext.a);
		}
	});

	it('INFERRED alpha is between AMBIGUOUS and EXTRACTED for the same relation', () => {
		for (const relation of Object.keys(BASE_TABLE)) {
			const ext = edgeStyle(relation, 'EXTRACTED');
			const inf = edgeStyle(relation, 'INFERRED');
			const amb = edgeStyle(relation, 'AMBIGUOUS');
			expect(inf.a).toBeLessThan(ext.a);
			expect(inf.a).toBeGreaterThan(amb.a);
		}
	});
});
