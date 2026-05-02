export interface EdgeColor {
	r: number;
	g: number;
	b: number;
	a: number;
}

interface BaseRGBA {
	r: number;
	g: number;
	b: number;
	a: number;
}

const BASE: Record<string, BaseRGBA> = {
	contains: { r: 120, g: 120, b: 120, a: 0.35 },
	calls: { r: 220, g: 220, b: 220, a: 0.65 },
	references: { r: 120, g: 200, b: 200, a: 0.55 },
	cites: { r: 220, g: 190, b: 130, a: 0.55 },
	semantically_similar_to: { r: 220, g: 150, b: 220, a: 0.45 },
	conceptually_related_to: { r: 180, g: 180, b: 180, a: 0.40 },
	shares_data_with: { r: 180, g: 180, b: 180, a: 0.40 },
	rationale_for: { r: 180, g: 180, b: 180, a: 0.40 },
	implements: { r: 180, g: 180, b: 180, a: 0.40 }
};

const FALLBACK: BaseRGBA = { r: 120, g: 120, b: 120, a: 0.30 };

const ALPHA_MULT: Record<'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS', number> = {
	EXTRACTED: 1.0,
	INFERRED: 0.55,
	AMBIGUOUS: 0.30
};

function clampChannel(v: number): number {
	if (v < 0) return 0;
	if (v > 255) return 255;
	return v;
}

function clampAlpha(v: number): number {
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

export function edgeStyle(
	relation: string,
	confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'
): EdgeColor {
	const base = BASE[relation] ?? FALLBACK;
	let r = base.r;
	let g = base.g;
	let b = base.b;
	let a = base.a * ALPHA_MULT[confidence];
	if (confidence === 'AMBIGUOUS') {
		r += 20;
		g -= 10;
		b -= 10;
	}
	return {
		r: clampChannel(r),
		g: clampChannel(g),
		b: clampChannel(b),
		a: clampAlpha(a)
	};
}
