// app/tests/unit/hue/color.test.ts
import { describe, it, expect } from 'vitest';
import { rgbToXy, xyToRgb, clampToGamut, mirekToKelvin, kelvinToMirek, type Gamut } from '$lib/hue/color.js';

const GAMUT_C: Gamut = { red: { x: 0.6915, y: 0.3083 }, green: { x: 0.17, y: 0.7 }, blue: { x: 0.1532, y: 0.0475 } };

describe('color', () => {
  it('rgbToXy red lands in red region', () => {
    const { x, y } = rgbToXy(255, 0, 0);
    expect(x).toBeGreaterThan(0.6);
    expect(y).toBeGreaterThan(0.29);
    expect(y).toBeLessThan(0.36);
  });

  it('clampToGamut keeps inside points unchanged-ish and pulls outside points in', () => {
    const inside = clampToGamut({ x: 0.33, y: 0.33 }, GAMUT_C);
    expect(pointInTriangle(inside, GAMUT_C)).toBe(true);
    const outside = clampToGamut({ x: 0.9, y: 0.05 }, GAMUT_C);
    expect(pointInTriangle(outside, GAMUT_C)).toBe(true);
  });

  it('null gamut returns xy unchanged', () => {
    expect(clampToGamut({ x: 0.9, y: 0.05 }, null)).toEqual({ x: 0.9, y: 0.05 });
  });

  it('mirek <-> kelvin round trips within range', () => {
    expect(mirekToKelvin(153)).toBeGreaterThan(6000);
    expect(kelvinToMirek(2700)).toBeGreaterThanOrEqual(153);
    expect(kelvinToMirek(2700)).toBeLessThanOrEqual(500);
    expect(kelvinToMirek(100000)).toBe(153);
    expect(kelvinToMirek(100)).toBe(500);
  });

  it('xyToRgb returns 3 integer channels in range', () => {
    const rgb = xyToRgb({ x: 0.3, y: 0.3 }, 80);
    expect(rgb.length).toBe(3);
    for (const c of rgb) { expect(Number.isInteger(c)).toBe(true); expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(255); }
  });
});

function pointInTriangle(p: { x: number; y: number }, g: NonNullable<Gamut>): boolean {
  const sign = (a: any, b: any, c: any) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);
  const d1 = sign(p, g.red, g.green), d2 = sign(p, g.green, g.blue), d3 = sign(p, g.blue, g.red);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
