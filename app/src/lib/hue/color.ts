// app/src/lib/hue/color.ts
/** CIE xy 색 좌표. */
export interface XY { x: number; y: number; }
/** light 리소스의 color.gamut(3꼭짓점). 미지원/미상이면 null → 클램프 없이 통과. */
export type Gamut = { red: XY; green: XY; blue: XY } | null;

const MIREK_MIN = 153; // ~6500K
const MIREK_MAX = 500; // ~2000K

function gammaToLinear(c: number): number {
  return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
}
function linearToGamma(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** sRGB(0..255) → Philips Wide-RGB D65 → xy. */
export function rgbToXy(r: number, g: number, b: number): XY {
  const R = gammaToLinear(r / 255), G = gammaToLinear(g / 255), B = gammaToLinear(b / 255);
  const X = R * 0.664511 + G * 0.154324 + B * 0.162028;
  const Y = R * 0.283881 + G * 0.668433 + B * 0.047685;
  const Z = R * 0.000088 + G * 0.07231 + B * 0.986039;
  const sum = X + Y + Z;
  if (sum === 0) return { x: 0, y: 0 };
  return { x: X / sum, y: Y / sum };
}

/** xy + brightness(0..100) → sRGB 0..255 정수 3채널(스왓치 표시용 근사). */
export function xyToRgb(xy: XY, brightness: number): [number, number, number] {
  const Y = Math.max(0, Math.min(1, brightness / 100));
  const x = xy.x, y = xy.y <= 0 ? 1e-6 : xy.y;
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  const max = Math.max(r, g, b);
  if (max > 1) { r /= max; g /= max; b /= max; }
  const ch = (c: number) => Math.round(Math.max(0, Math.min(1, linearToGamma(Math.max(0, c)))) * 255);
  return [ch(r), ch(g), ch(b)];
}

/** gamut 삼각형 밖 xy 를 가장 가까운 삼각형 위 점으로 당김. null gamut 이면 그대로. */
export function clampToGamut(xy: XY, gamut: Gamut): XY {
  if (!gamut) return xy;
  const { red: A, green: B, blue: C } = gamut;
  if (inTriangle(xy, A, B, C)) return xy;
  const pAB = closestOnSegment(xy, A, B);
  const pAC = closestOnSegment(xy, A, C);
  const pBC = closestOnSegment(xy, B, C);
  const dAB = dist2(xy, pAB), dAC = dist2(xy, pAC), dBC = dist2(xy, pBC);
  let best = pAB, bd = dAB;
  if (dAC < bd) { best = pAC; bd = dAC; }
  if (dBC < bd) { best = pBC; bd = dBC; }
  return best;
}

function inTriangle(p: XY, a: XY, b: XY, c: XY): boolean {
  const s = (u: XY, v: XY, w: XY) => (u.x - w.x) * (v.y - w.y) - (v.x - w.x) * (u.y - w.y);
  const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
function closestOnSegment(p: XY, a: XY, b: XY): XY {
  const apx = p.x - a.x, apy = p.y - a.y, abx = b.x - a.x, aby = b.y - a.y;
  const ab2 = abx * abx + aby * aby || 1e-12;
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + abx * t, y: a.y + aby * t };
}
function dist2(a: XY, b: XY): number { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

/** mirek(153..500) → 켈빈 정수. */
export function mirekToKelvin(mirek: number): number {
  const m = Math.max(MIREK_MIN, Math.min(MIREK_MAX, mirek));
  return Math.round(1_000_000 / m);
}
/** 켈빈 → mirek 정수, 153..500 클램프. */
export function kelvinToMirek(kelvin: number): number {
  const m = Math.round(1_000_000 / Math.max(1, kelvin));
  return Math.max(MIREK_MIN, Math.min(MIREK_MAX, m));
}
