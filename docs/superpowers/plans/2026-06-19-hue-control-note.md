# Hue 조명 제어 노트 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 브릿지와 같은 LAN의 Philips Hue 허브를 Tomboy 노트(`조명::` 접두어)로 제어 — 전구 노트, 존 노트, 마스터 대시보드.

**Architecture:** Pi 브릿지에 `/hue/{discover,pair,clip}` 3 라우트를 추가해 같은 LAN의 Hue CLIP v2 API를 자체서명 인증서로 직접 릴레이(`wol`/`music` 패턴). 앱은 기존 전역 터미널-브릿지 URL+토큰을 재사용해 브릿지를 호출하고, `automationNote` 패턴의 에디터 플러그인이 `조명::` 노트에 제어 위젯을 주입한다(풀-노트 takeover 아님). 바인딩은 light/zone UUID, 상태 읽기는 마운트 1회 + ⟳, 쓰기는 즉시.

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap/ProseMirror 플러그인, IndexedDB(appSettings), Node `node:https`(브릿지), vitest(app) + node:test(bridge).

**스펙:** `docs/superpowers/specs/2026-06-19-hue-control-note-design.md`

**스펙 대비 정제 1건:** 발견(discover)은 v1에서 **클라우드 `discovery.meethue.com` + 수동 IP 입력**만. mDNS는 새 브릿지 의존성(`multicast-dns`)을 피하려고 v1 제외(YAGNI, 나중).

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `app/src/lib/hue/color.ts` | RGB↔xy + gamut 클램프 + mirek↔kelvin (순수) |
| `app/src/lib/hue/hueTypes.ts` | CLIP v2 타입 + 노트 종류 타입 |
| `app/src/lib/hue/hueNoteParse.ts` | `조명::` 노트 파싱(kind/uuid) + PMNode 멤버십 링크 추출 |
| `app/src/lib/hue/hueClient.ts` | 앱→브릿지 `/hue/*` 호출 + 설정 컨텍스트 |
| `app/src/lib/hue/hueImport.ts` | 발견→노트 멱등 생성 |
| `app/src/lib/storage/hueSettings.ts` | appSettings: ip/appkey/clientkey |
| `app/src/lib/editor/hueNote/hueNotePlugin.ts` | `조명::` 게이트 + 위젯 데코레이션 + Svelte 마운트 |
| `app/src/lib/editor/hueNote/BulbControl.svelte` | 전구 제어 패널 |
| `app/src/lib/editor/hueNote/ZoneControl.svelte` | grouped_light 바 + 멤버십 + 씬 |
| `app/src/lib/editor/hueNote/MasterDashboard.svelte` | 가져오기 + 개요 + 전체 on/off |
| `bridge/src/hue.ts` | `/hue/{discover,pair,clip}` 핸들러 |
| `app/src/lib/noteTypes/registry.ts` | `조명::` 등재 (수정) |
| `app/src/routes/settings/+page.svelte` | Hue 페어링 하위탭 + 가이드 카드 (수정) |
| `app/src/lib/editor/TomboyEditor.svelte` | 플러그인 등록 (수정) |
| `CLAUDE.md` | 스킬 인덱스 행 (수정) |

---

## Task 0: color.ts — 색 변환 (TDD, 최우선 위험)

**Goal:** RGB↔CIE xy, per-light gamut 삼각형 클램프, mirek↔kelvin 순수 변환 함수.

**Files:**
- Create: `app/src/lib/hue/color.ts`
- Test: `app/tests/unit/hue/color.test.ts`

**Acceptance Criteria:**
- [ ] `rgbToXy(255,0,0)` 가 빨강 영역 xy(x≈0.64, y≈0.33, ±0.03) 반환.
- [ ] `clampToGamut` 가 gamut 삼각형 밖 점을 삼각형 위/안으로 당김(반환점이 삼각형 내부).
- [ ] `mirekToKelvin(153)`≈6535, `kelvinToMirek(2700)`≈370; mirek 153..500 클램프.
- [ ] `xyToRgb` 가 brightness 반영해 0..255 정수 3채널 반환.

**Verify:** `cd app && npx vitest run tests/unit/hue/color.test.ts` → 모두 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성**

```ts
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
    expect(kelvinToMirek(100000)).toBe(153); // clamp low mirek
    expect(kelvinToMirek(100)).toBe(500);    // clamp high mirek
  });

  it('xyToRgb returns 3 integer channels in range', () => {
    const rgb = xyToRgb({ x: 0.3, y: 0.3 }, 80);
    expect(rgb.length).toBe(3);
    for (const c of rgb) { expect(Number.isInteger(c)).toBe(true); expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(255); }
  });
});

// local helper for the test only
function pointInTriangle(p: { x: number; y: number }, g: NonNullable<Gamut>): boolean {
  const sign = (a: any, b: any, c: any) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);
  const d1 = sign(p, g.red, g.green), d2 = sign(p, g.green, g.blue), d3 = sign(p, g.blue, g.red);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
```

- [ ] **Step 2: 실패 확인**

Run: `cd app && npx vitest run tests/unit/hue/color.test.ts`
Expected: FAIL — `Cannot find module '$lib/hue/color.js'`

- [ ] **Step 3: 구현**

```ts
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
```

- [ ] **Step 4: 통과 확인**

Run: `cd app && npx vitest run tests/unit/hue/color.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/hue/color.ts app/tests/unit/hue/color.test.ts
git commit -m "feat(hue): RGB↔xy + gamut 클램프 + mirek↔kelvin 색 변환"
```

---

## Task 1: hueTypes.ts + hueNoteParse.ts — 타입 + 노트 파서 (TDD)

**Goal:** CLIP v2 타입 정의 + `조명::` 노트 종류/UUID 파싱 + PMNode 멤버십 링크 추출(atom 안전).

**Files:**
- Create: `app/src/lib/hue/hueTypes.ts`, `app/src/lib/hue/hueNoteParse.ts`
- Test: `app/tests/unit/hue/hueNoteParse.test.ts`

**Acceptance Criteria:**
- [ ] `parseHueNote('조명::거실', 'light:<uuid>')` → `{kind:'bulb', lightId:'<uuid>'}`.
- [ ] `parseHueNote('조명::침실', 'zone:<uuid>')` → `{kind:'zone', zoneId:'<uuid>'}`; `'zone'` 만이면 `zoneId:null`.
- [ ] `parseHueNote('조명::전체', '')` → `{kind:'master'}`.
- [ ] 접두어 없으면 `null`; 접두어 있으나 시그니처 미상이면 `null`.
- [ ] `extractMembershipTitles(doc)` 가 `tomboyInternalLink` 마크의 `target` 들을 문서 순서대로(중복 제거) 반환 — 일반 텍스트 스캔 아님.

**Verify:** `cd app && npx vitest run tests/unit/hue/hueNoteParse.test.ts` → 모두 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성**

```ts
// app/tests/unit/hue/hueNoteParse.test.ts
import { describe, it, expect } from 'vitest';
import { parseHueNote, extractMembershipTitles } from '$lib/hue/hueNoteParse.js';
import { Schema } from '@tiptap/pm/model';

const UUID = '11111111-2222-3333-4444-555555555555';

describe('parseHueNote', () => {
  it('bulb', () => expect(parseHueNote('조명::거실 등', `light:${UUID}`)).toEqual({ kind: 'bulb', lightId: UUID }));
  it('zone with id', () => expect(parseHueNote('조명::침실', `zone:${UUID}`)).toEqual({ kind: 'zone', zoneId: UUID }));
  it('zone not yet created', () => expect(parseHueNote('조명::침실', 'zone')).toEqual({ kind: 'zone', zoneId: null }));
  it('master', () => expect(parseHueNote('조명::전체', '')).toEqual({ kind: 'master' }));
  it('no prefix', () => expect(parseHueNote('거실 등', `light:${UUID}`)).toBeNull());
  it('unknown signature', () => expect(parseHueNote('조명::뭐', 'hello')).toBeNull());
});

// minimal schema with a paragraph + text + tomboyInternalLink mark
const schema = new Schema({
  nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] }, text: { group: 'inline' } },
  marks: { tomboyInternalLink: { attrs: { target: {}, broken: { default: false } }, toDOM: () => ['a', 0] } }
});

describe('extractMembershipTitles', () => {
  it('collects link targets in order, deduped', () => {
    const link = (t: string) => schema.text(t, [schema.marks.tomboyInternalLink.create({ target: t })]);
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [link('거실 등'), schema.text(', '), link('주방 등')]),
      schema.node('paragraph', null, [link('거실 등')]) // dup
    ]);
    expect(extractMembershipTitles(doc)).toEqual(['거실 등', '주방 등']);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npx vitest run tests/unit/hue/hueNoteParse.test.ts` → FAIL (module not found)

- [ ] **Step 3: 구현**

```ts
// app/src/lib/hue/hueTypes.ts
import type { XY, Gamut } from './color.js';

export interface HueOn { on: boolean; }
export interface HueDimming { brightness: number; } // 0..100
export interface HueColor { xy: XY; gamut?: { red: XY; green: XY; blue: XY }; gamut_type?: string; }
export interface HueColorTemp { mirek: number | null; }

export interface HueLight {
  id: string;
  type: 'light';
  metadata?: { name?: string };
  on: HueOn;
  dimming?: HueDimming;
  color?: HueColor;
  color_temperature?: HueColorTemp;
}
export interface HueResourceRef { rid: string; rtype: string; }
export interface HueZone {
  id: string;
  type: 'zone';
  metadata?: { name?: string };
  children: HueResourceRef[];      // rtype 'light'
  services: HueResourceRef[];      // rtype 'grouped_light' 포함
}
export interface HueScene {
  id: string;
  type: 'scene';
  metadata: { name: string };
  group: HueResourceRef;
  actions: Array<{ target: HueResourceRef; action: Record<string, unknown> }>;
}

/** light 의 capability — 키 존재 여부로 판별. */
export function lightGamut(light: HueLight): Gamut {
  return light.color?.gamut ?? null;
}
export function supportsColor(light: HueLight): boolean { return !!light.color; }
export function supportsColorTemp(light: HueLight): boolean { return !!light.color_temperature; }
export function supportsDimming(light: HueLight): boolean { return !!light.dimming; }
```

```ts
// app/src/lib/hue/hueNoteParse.ts
import type { Node as PMNode } from '@tiptap/pm/model';

export type HueNoteKind = 'bulb' | 'zone' | 'master';
export interface HueNoteInfo { kind: HueNoteKind; lightId?: string; zoneId?: string | null; }

export const HUE_PREFIX = '조명::';
export const HUE_MASTER_NAME = '전체';
const LIGHT_RE = /^light:([0-9a-fA-F-]{36})$/;
const ZONE_RE = /^zone(?::([0-9a-fA-F-]{36}))?$/;

/** 타이틀+본문 첫 줄로 조명 노트 종류 판별. 조명 노트가 아니면 null. */
export function parseHueNote(title: string, bodyFirstLine: string): HueNoteInfo | null {
  if (!title.startsWith(HUE_PREFIX)) return null;
  const name = title.slice(HUE_PREFIX.length).trim();
  if (name === HUE_MASTER_NAME) return { kind: 'master' };
  const sig = bodyFirstLine.trim();
  const lm = LIGHT_RE.exec(sig);
  if (lm) return { kind: 'bulb', lightId: lm[1] };
  const zm = ZONE_RE.exec(sig);
  if (zm) return { kind: 'zone', zoneId: zm[1] ?? null };
  return null;
}

/** 본문 내부링크(tomboyInternalLink) 마크의 target 을 문서 순서대로(중복 제거) 반환.
 *  inlineCheckbox/atom 교훈: plain JSON text 스캔 금지 — 라이브 PMNode 마크를 읽는다. */
export function extractMembershipTitles(doc: PMNode): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  doc.descendants((node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name === 'tomboyInternalLink') {
        const t = String(mark.attrs.target ?? '').trim();
        if (t && !seen.has(t)) { seen.add(t); out.push(t); }
      }
    }
  });
  return out;
}
```

- [ ] **Step 4: 통과 확인** — Run: `cd app && npx vitest run tests/unit/hue/hueNoteParse.test.ts` → PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/hue/hueTypes.ts app/src/lib/hue/hueNoteParse.ts app/tests/unit/hue/hueNoteParse.test.ts
git commit -m "feat(hue): CLIP v2 타입 + 조명:: 노트 파서 + PMNode 멤버십 추출"
```

---

## Task 2: bridge `hue.ts` — discover/pair/clip 핸들러 (TDD, node:test)

**Goal:** 브릿지에 `/hue/discover`(클라우드), `/hue/pair`(키 발급), `/hue/clip`(CLIP v2 릴레이, path 화이트리스트) 핸들러. Hue HTTP는 주입 가능한 `hueRequest`로 추상화해 테스트 가능.

**Files:**
- Create: `bridge/src/hue.ts`, `bridge/src/hue.test.ts`
- Modify: `bridge/src/server.ts` (import + 3 라우트)

**Acceptance Criteria:**
- [ ] 토큰 없는 요청 → 401.
- [ ] `/hue/clip` path 첫 세그먼트가 화이트리스트(`light/zone/room/grouped_light/scene/device`) 아니면 400.
- [ ] `/hue/pair` 가 Hue 에러 101 응답을 받으면 409 `{error:'link_button'}`; 성공 응답이면 `{appkey, clientkey}`.
- [ ] `/hue/clip` 가 주입된 hueRequest 의 status+body 를 그대로 파이프.

**Verify:** `cd bridge && node --import tsx --test src/hue.test.ts` → 모두 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성**

```ts
// bridge/src/hue.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleHuePair, handleHueClip, type HueRequestFn } from './hue.js';
import { mintToken } from './auth.js';

const SECRET = 'test-secret';
const AUTH = `Bearer ${mintToken(SECRET)}`;

function mockReqRes(body: unknown, authorization = AUTH) {
  const req: any = { headers: { authorization }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); } };
  const res: any = { statusCode: 0, headers: {}, chunks: '', writeHead(s: number, h: any) { this.statusCode = s; Object.assign(this.headers, h); return this; }, end(c?: string) { if (c) this.chunks += c; } };
  return { req, res };
}

test('pair maps link-button error 101 to 409', async () => {
  const hueRequest: HueRequestFn = async () => ({ status: 200, body: JSON.stringify([{ error: { type: 101, description: 'link button not pressed' } }]) });
  const { req, res } = mockReqRes({ ip: '192.168.0.2' });
  await handleHuePair(req, res, SECRET, hueRequest);
  assert.equal(res.statusCode, 409);
  assert.match(res.chunks, /link_button/);
});

test('pair success returns appkey + clientkey', async () => {
  const hueRequest: HueRequestFn = async () => ({ status: 200, body: JSON.stringify([{ success: { username: 'APPKEY', clientkey: 'CK' } }]) });
  const { req, res } = mockReqRes({ ip: '192.168.0.2' });
  await handleHuePair(req, res, SECRET, hueRequest);
  assert.equal(res.statusCode, 200);
  const out = JSON.parse(res.chunks);
  assert.equal(out.appkey, 'APPKEY');
  assert.equal(out.clientkey, 'CK');
});

test('clip rejects non-whitelisted path', async () => {
  const hueRequest: HueRequestFn = async () => ({ status: 200, body: '{}' });
  const { req, res } = mockReqRes({ ip: '1.2.3.4', appkey: 'K', method: 'GET', path: 'config' });
  await handleHueClip(req, res, SECRET, hueRequest);
  assert.equal(res.statusCode, 400);
});

test('clip pipes status + body for whitelisted path', async () => {
  const hueRequest: HueRequestFn = async (opts) => { assert.match(opts.path, /clip\/v2\/resource\/light\//); return { status: 207, body: '{"data":[]}' }; };
  const { req, res } = mockReqRes({ ip: '1.2.3.4', appkey: 'K', method: 'GET', path: 'light/abc' });
  await handleHueClip(req, res, SECRET, hueRequest);
  assert.equal(res.statusCode, 207);
  assert.equal(res.chunks, '{"data":[]}');
});

test('unauthorized without token', async () => {
  const { req, res } = mockReqRes({ ip: '1.2.3.4', appkey: 'K', method: 'GET', path: 'light/abc' }, '');
  await handleHueClip(req, res, SECRET, async () => ({ status: 200, body: '{}' }));
  assert.equal(res.statusCode, 401);
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd bridge && node --import tsx --test src/hue.test.ts` → FAIL (module not found)

- [ ] **Step 3: 구현**

```ts
// bridge/src/hue.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import { extractBearer, verifyToken } from './auth.js';

export interface HueRequestResult { status: number; body: string; }
export interface HueRequestOpts { ip: string; path: string; method: string; appkey?: string; body?: unknown; }
export type HueRequestFn = (opts: HueRequestOpts) => Promise<HueRequestResult>;

const ALLOWED_RESOURCES = new Set(['light', 'zone', 'room', 'grouped_light', 'scene', 'device']);
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/** 실제 Hue 호출 — 자체서명 인증서 통과. 테스트는 이 함수를 주입 교체한다. */
export const realHueRequest: HueRequestFn = (opts) =>
  new Promise<HueRequestResult>((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.appkey) headers['hue-application-key'] = opts.appkey;
    if (payload) headers['Content-Length'] = String(Buffer.byteLength(payload));
    const r = https.request(
      { host: opts.ip, path: '/' + opts.path.replace(/^\//, ''), method: opts.method, headers, agent: insecureAgent, timeout: 10_000 },
      (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => resolve({ status: resp.statusCode ?? 502, body: b })); }
    );
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (payload) r.write(payload);
    r.end();
  });

function unauthorized(res: ServerResponse): void { res.writeHead(401, json()).end(JSON.stringify({ error: 'unauthorized' })); }
function json() { return { 'Content-Type': 'application/json' }; }

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const c of req) { const b = c as Buffer; total += b.length; if (total > 64 * 1024) throw new Error('too large'); chunks.push(b); }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/** GET /hue/discover → 클라우드 발견(보조). LAN-only 환경이면 빈 목록 → 사용자가 수동 IP 입력. */
export async function handleHueDiscover(req: IncomingMessage, res: ServerResponse, secret: string): Promise<void> {
  if (!verifyToken(secret, extractBearer(req.headers.authorization))) return unauthorized(res);
  try {
    const r = await fetch('https://discovery.meethue.com/', { signal: AbortSignal.timeout(5000) });
    const arr = (await r.json()) as Array<{ internalipaddress?: string; id?: string }>;
    const bridges = arr.filter((b) => b.internalipaddress).map((b) => ({ ip: b.internalipaddress!, id: b.id ?? '' }));
    res.writeHead(200, json()).end(JSON.stringify({ bridges }));
  } catch {
    res.writeHead(200, json()).end(JSON.stringify({ bridges: [] })); // 실패해도 수동 입력 경로 유지
  }
}

/** POST /hue/pair {ip} → 링크버튼 키 발급. */
export async function handleHuePair(req: IncomingMessage, res: ServerResponse, secret: string, hueRequest: HueRequestFn = realHueRequest): Promise<void> {
  if (!verifyToken(secret, extractBearer(req.headers.authorization))) return unauthorized(res);
  let body: Record<string, unknown>;
  try { body = await readJson(req); } catch { res.writeHead(400, json()).end(JSON.stringify({ error: 'bad_json' })); return; }
  const ip = typeof body.ip === 'string' ? body.ip.trim() : '';
  if (!ip) { res.writeHead(400, json()).end(JSON.stringify({ error: 'missing_ip' })); return; }
  let result: HueRequestResult;
  try {
    result = await hueRequest({ ip, path: 'api', method: 'POST', body: { devicetype: 'tomboy-web#app', generateclientkey: true } });
  } catch { res.writeHead(503, json()).end(JSON.stringify({ error: 'bridge_unreachable' })); return; }
  let parsed: any;
  try { parsed = JSON.parse(result.body); } catch { res.writeHead(502, json()).end(JSON.stringify({ error: 'bad_upstream' })); return; }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first?.error?.type === 101) { res.writeHead(409, json()).end(JSON.stringify({ error: 'link_button' })); return; }
  if (first?.success?.username) { res.writeHead(200, json()).end(JSON.stringify({ appkey: first.success.username, clientkey: first.success.clientkey ?? '' })); return; }
  res.writeHead(502, json()).end(JSON.stringify({ error: 'pair_failed' }));
}

/** POST /hue/clip {ip, appkey, method, path, body} → CLIP v2 릴레이. */
export async function handleHueClip(req: IncomingMessage, res: ServerResponse, secret: string, hueRequest: HueRequestFn = realHueRequest): Promise<void> {
  if (!verifyToken(secret, extractBearer(req.headers.authorization))) return unauthorized(res);
  let body: Record<string, unknown>;
  try { body = await readJson(req); } catch { res.writeHead(400, json()).end(JSON.stringify({ error: 'bad_json' })); return; }
  const ip = typeof body.ip === 'string' ? body.ip.trim() : '';
  const appkey = typeof body.appkey === 'string' ? body.appkey : '';
  const method = typeof body.method === 'string' ? body.method.toUpperCase() : 'GET';
  const path = typeof body.path === 'string' ? body.path.replace(/^\/+/, '') : '';
  if (!ip || !appkey || !path) { res.writeHead(400, json()).end(JSON.stringify({ error: 'bad_request' })); return; }
  if (!ALLOWED_RESOURCES.has(path.split('/')[0])) { res.writeHead(400, json()).end(JSON.stringify({ error: 'forbidden_path' })); return; }
  let result: HueRequestResult;
  try {
    result = await hueRequest({ ip, appkey, method, path: `clip/v2/resource/${path}`, body: 'body' in body ? body.body : undefined });
  } catch { res.writeHead(503, json()).end(JSON.stringify({ error: 'bridge_unreachable' })); return; }
  res.writeHead(result.status, json()).end(result.body);
}
```

- [ ] **Step 4: server.ts 라우트 등록**

`bridge/src/server.ts` import 블록(다른 handler import 옆, line ~17 부근)에 추가:

```ts
import { handleHueDiscover, handleHuePair, handleHueClip } from './hue.js';
```

`/files` 라우트들 앞(line ~217 부근, `if (url === '/files' && req.method === 'POST')` 위)에 추가:

```ts
	if (url === '/hue/discover' && req.method === 'GET') {
		await handleHueDiscover(req, res, SECRET);
		return;
	}

	if (url === '/hue/pair' && req.method === 'POST') {
		await handleHuePair(req, res, SECRET);
		return;
	}

	if (url === '/hue/clip' && req.method === 'POST') {
		await handleHueClip(req, res, SECRET);
		return;
	}
```

- [ ] **Step 5: 통과 확인**

Run: `cd bridge && node --import tsx --test src/hue.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: 커밋**

```bash
git add bridge/src/hue.ts bridge/src/hue.test.ts bridge/src/server.ts
git commit -m "feat(bridge): /hue/{discover,pair,clip} — CLIP v2 릴레이 + path 화이트리스트"
```

---

## Task 3: hueSettings.ts + hueClient.ts — 앱 설정 + 브릿지 클라이언트 (TDD)

**Goal:** appSettings 에 ip/appkey/clientkey 저장 + 앱→브릿지 `/hue/*` 호출 래퍼(전역 터미널 브릿지 URL+토큰 재사용) + 설정 컨텍스트 조회.

**Files:**
- Create: `app/src/lib/storage/hueSettings.ts`, `app/src/lib/hue/hueClient.ts`
- Test: `app/tests/unit/hue/hueClient.test.ts`

**Acceptance Criteria:**
- [ ] `hueClip` 가 `<httpBase>/hue/clip` 로 POST, Bearer 토큰 첨부, `{ip,appkey,method,path,body}` 전송, 응답 `{status, data}` 반환.
- [ ] `huePair` 409 응답을 `{error:'link_button'}` 로 매핑.
- [ ] `getHueContext()` 가 ip/appkey 미설정 시 `null`.

**Verify:** `cd app && npx vitest run tests/unit/hue/hueClient.test.ts` → 모두 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성**

```ts
// app/tests/unit/hue/hueClient.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hueClip, huePair, hueDiscover } from '$lib/hue/hueClient.js';

const BASE = 'https://bridge.example';
const TOKEN = 'tok';

beforeEach(() => { vi.restoreAllMocks(); });

describe('hueClient', () => {
  it('hueClip posts to /hue/clip with bearer + body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await hueClip(BASE, TOKEN, { ip: '1.2.3.4', appkey: 'K', method: 'GET', path: 'light/abc' });
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/hue/clip`, expect.objectContaining({ method: 'POST' }));
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toMatchObject({ ip: '1.2.3.4', appkey: 'K', method: 'GET', path: 'light/abc' });
    expect(out.status).toBe(200);
    expect(out.data).toEqual({ data: [{ id: 'x' }] });
  });

  it('huePair maps 409 to link_button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'link_button' }), { status: 409 })));
    expect(await huePair(BASE, TOKEN, '1.2.3.4')).toEqual({ error: 'link_button' });
  });

  it('hueDiscover returns bridges', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ bridges: [{ ip: '1.2.3.4', id: 'b' }] }), { status: 200 })));
    expect(await hueDiscover(BASE, TOKEN)).toEqual([{ ip: '1.2.3.4', id: 'b' }]);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npx vitest run tests/unit/hue/hueClient.test.ts` → FAIL

- [ ] **Step 3: 구현 — hueSettings.ts**

```ts
// app/src/lib/storage/hueSettings.ts
import { getSetting, setSetting } from './appSettings.js';

const IP_KEY = 'hueBridgeIp';
const APPKEY_KEY = 'hueAppKey';
const CLIENTKEY_KEY = 'hueClientKey';

export async function getHueBridgeIp(): Promise<string> { return (await getSetting<string>(IP_KEY)) ?? ''; }
export async function getHueAppKey(): Promise<string> { return (await getSetting<string>(APPKEY_KEY)) ?? ''; }
export async function getHueClientKey(): Promise<string> { return (await getSetting<string>(CLIENTKEY_KEY)) ?? ''; }

export async function setHueCredentials(ip: string, appkey: string, clientkey: string): Promise<void> {
  await setSetting(IP_KEY, ip);
  await setSetting(APPKEY_KEY, appkey);
  await setSetting(CLIENTKEY_KEY, clientkey);
}
export async function clearHueCredentials(): Promise<void> {
  await setSetting(IP_KEY, ''); await setSetting(APPKEY_KEY, ''); await setSetting(CLIENTKEY_KEY, '');
}
```

- [ ] **Step 4: 구현 — hueClient.ts**

```ts
// app/src/lib/hue/hueClient.ts
import { bridgeToHttpBase, getDefaultTerminalBridge, getTerminalBridgeToken } from '$lib/editor/terminal/bridgeSettings.js';
import { getHueBridgeIp, getHueAppKey } from '$lib/storage/hueSettings.js';

export interface ClipReq { ip: string; appkey: string; method: string; path: string; body?: unknown; }
export interface ClipResult { status: number; data: unknown; }

export class HueError extends Error {
  constructor(public kind: 'no_bridge' | 'unreachable' | 'http', public status = 0) { super(kind); this.name = 'HueError'; }
}

export async function hueClip(httpBase: string, token: string, req: ClipReq): Promise<ClipResult> {
  let resp: Response;
  try {
    resp = await fetch(`${httpBase}/hue/clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(req)
    });
  } catch { throw new HueError('unreachable'); }
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

export async function huePair(httpBase: string, token: string, ip: string): Promise<{ appkey: string; clientkey: string } | { error: 'link_button' | 'failed' }> {
  let resp: Response;
  try {
    resp = await fetch(`${httpBase}/hue/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ip }) });
  } catch { return { error: 'failed' }; }
  if (resp.status === 409) return { error: 'link_button' };
  if (!resp.ok) return { error: 'failed' };
  return (await resp.json()) as { appkey: string; clientkey: string };
}

export async function hueDiscover(httpBase: string, token: string): Promise<Array<{ ip: string; id: string }>> {
  const resp = await fetch(`${httpBase}/hue/discover`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return [];
  const body = (await resp.json()) as { bridges?: Array<{ ip: string; id: string }> };
  return body.bridges ?? [];
}

// ── 설정 컨텍스트 바운드 편의층 ───────────────────────────────
export interface HueContext { httpBase: string; token: string; ip: string; appkey: string; }

/** 전역 브릿지(URL+토큰) + Hue 크레덴셜을 합쳐 컨텍스트 반환. 미설정이면 null. */
export async function getHueContext(): Promise<HueContext | null> {
  const bridge = await getDefaultTerminalBridge();
  const token = await getTerminalBridgeToken();
  const ip = await getHueBridgeIp();
  const appkey = await getHueAppKey();
  if (!bridge || !token || !ip || !appkey) return null;
  return { httpBase: bridgeToHttpBase(bridge), token, ip, appkey };
}

/** 컨텍스트 바운드 CLIP 호출. 컨텍스트 없으면 HueError('no_bridge'). */
export async function hueCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const ctx = await getHueContext();
  if (!ctx) throw new HueError('no_bridge');
  const { status, data } = await hueClip(ctx.httpBase, ctx.token, { ip: ctx.ip, appkey: ctx.appkey, method, path, body });
  if (status >= 400) throw new HueError('http', status);
  return data;
}
```

- [ ] **Step 5: 통과 확인** — Run: `cd app && npx vitest run tests/unit/hue/hueClient.test.ts` → PASS (3 tests)

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/storage/hueSettings.ts app/src/lib/hue/hueClient.ts app/tests/unit/hue/hueClient.test.ts
git commit -m "feat(hue): appSettings 크레덴셜 + 브릿지 클라이언트(discover/pair/clip) + 컨텍스트"
```

---

## Task 4: noteTypes 등재 + hueImport.ts — 발견→노트 멱등 생성 (TDD)

**Goal:** `조명::` 을 노트종류 레지스트리에 등재 + Hue light/zone 목록을 받아 기존 uuid 를 건너뛰고 누락분만 노트로 생성.

**Files:**
- Modify: `app/src/lib/noteTypes/registry.ts`
- Create: `app/src/lib/hue/hueImport.ts`
- Test: `app/tests/unit/hue/hueImport.test.ts`

**Acceptance Criteria:**
- [ ] registry 에 `{id:'hue-master', titlePrefix:'조명::', ...}` 등재 — `composeTitle('hue-master','전체')` === `'조명::전체'`.
- [ ] `importLights(lights, existingSigs)` 가 기존에 `light:<uuid>` 시그니처가 이미 있는 light 는 skip, 없는 것만 `{title:'조명::<name>', bodyFirstLine:'light:<uuid>'}` createNote 인자로 반환.
- [ ] 같은 입력 재실행 시 새 노트 0개(멱등).

**Verify:** `cd app && npx vitest run tests/unit/hue/hueImport.test.ts && npx vitest run tests/unit/noteTypes` → 모두 PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성**

```ts
// app/tests/unit/hue/hueImport.test.ts
import { describe, it, expect } from 'vitest';
import { planLightImports } from '$lib/hue/hueImport.js';
import type { HueLight } from '$lib/hue/hueTypes.js';

const light = (id: string, name: string): HueLight => ({ id, type: 'light', metadata: { name }, on: { on: true } });

describe('planLightImports', () => {
  it('skips lights whose uuid already has a note', () => {
    const lights = [light('aaa', '거실'), light('bbb', '주방')];
    const existing = new Set(['aaa']);
    const plan = planLightImports(lights, existing);
    expect(plan).toEqual([{ title: '조명::주방', bodyFirstLine: 'light:bbb' }]);
  });
  it('idempotent — re-run with all existing yields nothing', () => {
    const lights = [light('aaa', '거실')];
    expect(planLightImports(lights, new Set(['aaa']))).toEqual([]);
  });
  it('falls back to id-based name when metadata.name missing', () => {
    const plan = planLightImports([{ id: 'ccc', type: 'light', on: { on: true } }], new Set());
    expect(plan[0].title).toBe('조명::전구 ccc');
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npx vitest run tests/unit/hue/hueImport.test.ts` → FAIL

- [ ] **Step 3: registry.ts 수정**

`app/src/lib/noteTypes/registry.ts` 의 `NOTE_TYPES` 배열에 (slip 항목 앞 등 적당한 위치) 추가:

```ts
	{
		id: 'hue-master', label: '조명 (Hue)', trigger: 'title-prefix',
		titlePrefix: '조명::',
		help: '타이틀 조명::전체 = 마스터(전구 가져오기). 조명::<이름> = 전구/존 노트. 설정 → Hue 에서 허브 먼저 연결.'
	},
```

- [ ] **Step 4: hueImport.ts 구현**

```ts
// app/src/lib/hue/hueImport.ts
import type { HueLight } from './hueTypes.js';
import { HUE_PREFIX } from './hueNoteParse.js';

export interface ImportPlanItem { title: string; bodyFirstLine: string; }

/** 새로 노트를 만들어야 할 light 만 createNote 인자로 변환. existingLightIds 에 든 uuid 는 skip. */
export function planLightImports(lights: HueLight[], existingLightIds: Set<string>): ImportPlanItem[] {
  const out: ImportPlanItem[] = [];
  for (const l of lights) {
    if (existingLightIds.has(l.id)) continue;
    const name = l.metadata?.name?.trim() || `전구 ${l.id}`;
    out.push({ title: `${HUE_PREFIX}${name}`, bodyFirstLine: `light:${l.id}` });
  }
  return out;
}
```

> **참고(실행 시):** 호출부(`MasterDashboard.svelte`, Task 7)는 `listNotesShared()` 로 전체 노트를 읽어 각 노트의 본문 첫 줄에서 `light:<uuid>` 를 모아 `existingLightIds` 를 만들고, `planLightImports` 결과를 `createNote({ title, bodyFirstLine })`(`$lib/core/noteManager.js`)로 생성한다. createNote 는 타이틀 충돌 시 `ensureUniqueTitle` 로 ` (2)` 접미사를 붙이지 않으므로(명시 타이틀은 그대로) — 호출부에서 `ensureUniqueTitle(title)` 를 먼저 적용해 중복을 회피한다. uuid 바인딩이라 접미사가 붙어도 링크 안전.

- [ ] **Step 5: 통과 확인** — Run: `cd app && npx vitest run tests/unit/hue/hueImport.test.ts && npx vitest run tests/unit/noteTypes` → PASS

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/noteTypes/registry.ts app/src/lib/hue/hueImport.ts app/tests/unit/hue/hueImport.test.ts
git commit -m "feat(hue): 조명:: 노트종류 등재 + 발견→노트 멱등 생성 플래너"
```

---

## Task 5: hueNotePlugin + BulbControl.svelte — 전구 제어 위젯

**Goal:** `조명::` 노트에서 본문 첫 줄 시그니처로 종류를 판별해 제목 아래에 제어 위젯(전구=BulbControl)을 Svelte 마운트하는 에디터 플러그인. 전구: 마운트 1회 fetch + ⟳, on/off·밝기·(가능시)색온도·색 즉시 쓰기 + 옵티미스틱/롤백.

**Files:**
- Create: `app/src/lib/editor/hueNote/hueNotePlugin.ts`, `app/src/lib/editor/hueNote/BulbControl.svelte`
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (플러그인 등록)
- Test: `app/tests/unit/hue/hueNotePlugin.test.ts`

**Acceptance Criteria:**
- [ ] `조명::거실` + 본문 `light:<uuid>` 문서에서 플러그인이 제목 직후 1개 위젯 데코레이션 생성.
- [ ] `조명::` 아닌 노트에선 데코레이션 0개.
- [ ] 본문 변경으로 시그니처가 바뀌면 위젯 종류가 갱신(decoration key 변경).
- [ ] (수동) `npm run dev` 에서 전구 노트 열면 토글/슬라이더 동작 + ⟳ 재조회.

**Verify:** `cd app && npx vitest run tests/unit/hue/hueNotePlugin.test.ts && npm run check` → PASS / 타입 통과

**Steps:**

- [ ] **Step 1: 실패 테스트 작성 (데코레이션 빌드 순수 함수)**

```ts
// app/tests/unit/hue/hueNotePlugin.test.ts
import { describe, it, expect } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { buildHueDecorations } from '$lib/editor/hueNote/hueNotePlugin.js';

const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] }, text: { group: 'inline' } } });
const docOf = (lines: string[]) => schema.node('doc', null, lines.map((l) => schema.node('paragraph', null, l ? [schema.text(l)] : [])));
const UUID = '11111111-2222-3333-4444-555555555555';

describe('buildHueDecorations', () => {
  it('one widget for a bulb note', () => {
    const set = buildHueDecorations(docOf(['조명::거실', `light:${UUID}`]));
    expect(set.find().length).toBe(1);
  });
  it('no widget for a non-hue note', () => {
    expect(buildHueDecorations(docOf(['그냥 노트', 'hello'])).find().length).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npx vitest run tests/unit/hue/hueNotePlugin.test.ts` → FAIL

- [ ] **Step 3: hueNotePlugin.ts 구현**

```ts
// app/src/lib/editor/hueNote/hueNotePlugin.ts
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { mount, unmount } from 'svelte';
import { parseHueNote } from '$lib/hue/hueNoteParse.js';
import BulbControl from './BulbControl.svelte';
import ZoneControl from './ZoneControl.svelte';
import MasterDashboard from './MasterDashboard.svelte';

export const hueNotePluginKey = new PluginKey<DecorationSet>('tomboyHueNote');

interface HuePluginOpts { getGuid: () => string; oninternallink?: (title: string) => void; }

/** 제목(첫 노드) + 본문 첫 보이는 줄로 종류 판별, 종류별 위젯 1개를 제목 직후에. */
export function buildHueDecorations(doc: PMNode, opts?: HuePluginOpts): DecorationSet {
  const first = doc.firstChild;
  if (!first) return DecorationSet.empty;
  const title = first.textContent;
  // 본문 첫 보이는 줄 = 두 번째 top-level 노드의 textContent
  const second = doc.childCount > 1 ? doc.child(1) : null;
  const bodyFirstLine = second?.textContent ?? '';
  const info = parseHueNote(title, bodyFirstLine);
  if (!info) return DecorationSet.empty;
  const afterTitle = first.nodeSize;
  const key = `hue:${info.kind}:${info.lightId ?? info.zoneId ?? 'master'}`;
  const widget = Decoration.widget(afterTitle, (view) => renderWidget(view, info, opts), { side: 1, key });
  return DecorationSet.create(doc, [widget]);
}

function renderWidget(view: EditorView, info: ReturnType<typeof parseHueNote>, opts?: HuePluginOpts): HTMLElement {
  const host = document.createElement('div');
  host.className = 'hue-widget';
  host.contentEditable = 'false';
  const Comp = info!.kind === 'bulb' ? BulbControl : info!.kind === 'zone' ? ZoneControl : MasterDashboard;
  const props: Record<string, unknown> =
    info!.kind === 'bulb' ? { lightId: info!.lightId }
    : info!.kind === 'zone' ? { zoneId: info!.zoneId, view, getGuid: opts?.getGuid, oninternallink: opts?.oninternallink }
    : { oninternallink: opts?.oninternallink };
  const inst = mount(Comp as never, { target: host, props });
  // PM 위젯 destroy 에서 unmount — DecorationSet 재생성 시 호출됨
  (host as unknown as { _hueDestroy?: () => void })._hueDestroy = () => { void unmount(inst); };
  return host;
}

export function createHueNotePlugin(opts: HuePluginOpts): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: hueNotePluginKey,
    state: {
      init: (_, { doc }) => buildHueDecorations(doc, opts),
      apply: (tr, old) => (tr.docChanged ? buildHueDecorations(tr.doc, opts) : old.map(tr.mapping, tr.doc))
    },
    props: { decorations: (state) => hueNotePluginKey.getState(state) }
  });
}
```

> **destroy 처리 주의:** ProseMirror `Decoration.widget` 의 `destroy` 콜백을 쓰려면 3번째 인자 `{ side, key, destroy }` 에 `destroy(node)` 를 넘긴다. 위 코드의 `_hueDestroy` 대신 옵션의 `destroy: (node) => (node as any)._hueDestroy?.()` 형태로 연결할 것 — 구현 시 spec 의 widget 옵션에 `destroy` 추가:
> ```ts
> Decoration.widget(afterTitle, (view) => renderWidget(view, info, opts), { side: 1, key, destroy: (node) => (node as { _hueDestroy?: () => void })._hueDestroy?.() });
> ```

- [ ] **Step 4: BulbControl.svelte 구현**

```svelte
<!-- app/src/lib/editor/hueNote/BulbControl.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { hueCall, HueError } from '$lib/hue/hueClient.js';
  import { supportsColor, supportsColorTemp, supportsDimming, lightGamut, type HueLight } from '$lib/hue/hueTypes.js';
  import { rgbToXy, xyToRgb, clampToGamut, mirekToKelvin, kelvinToMirek } from '$lib/hue/color.js';
  import { pushToast } from '$lib/stores/toast.js';

  let { lightId }: { lightId: string } = $props();

  let light = $state<HueLight | null>(null);
  let loading = $state(true);
  let errorMsg = $state('');

  async function load() {
    loading = true; errorMsg = '';
    try {
      const data = (await hueCall('GET', `light/${lightId}`)) as { data?: HueLight[] };
      light = data.data?.[0] ?? null;
      if (!light) errorMsg = '오프라인/제거됨';
    } catch (e) {
      errorMsg = e instanceof HueError && e.kind === 'no_bridge' ? '설정에서 Hue를 먼저 연결' : '조명 브릿지에 연결 안 됨';
    } finally { loading = false; }
  }
  onMount(load);

  async function put(body: Record<string, unknown>, optimistic: () => void, rollback: () => void) {
    optimistic();
    try { await hueCall('PUT', `light/${lightId}`, body); }
    catch { rollback(); pushToast('전구 설정 실패'); }
  }

  function toggle() {
    if (!light) return;
    const prev = light.on.on; const next = !prev;
    put({ on: { on: next } }, () => { light!.on.on = next; }, () => { light!.on.on = prev; });
  }
  function setBrightness(v: number) {
    if (!light?.dimming) return;
    const prev = light.dimming.brightness;
    put({ dimming: { brightness: v } }, () => { light!.dimming!.brightness = v; }, () => { light!.dimming!.brightness = prev; });
  }
  function setKelvin(k: number) {
    if (!light?.color_temperature) return;
    const mirek = kelvinToMirek(k); const prev = light.color_temperature.mirek;
    put({ color_temperature: { mirek } }, () => { light!.color_temperature!.mirek = mirek; }, () => { light!.color_temperature!.mirek = prev; });
  }
  function setColorHex(hex: string) {
    if (!light?.color) return;
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const xy = clampToGamut(rgbToXy(r, g, b), lightGamut(light));
    const prev = light.color.xy;
    put({ color: { xy } }, () => { light!.color!.xy = xy; }, () => { light!.color!.xy = prev; });
  }

  const swatch = $derived(light?.color ? `rgb(${xyToRgb(light.color.xy, light.dimming?.brightness ?? 100).join(',')})` : '');
  const kelvin = $derived(light?.color_temperature?.mirek ? mirekToKelvin(light.color_temperature.mirek) : 4000);
</script>

<div class="bulb-control">
  {#if loading}
    <span class="hue-status">불러오는 중…</span>
  {:else if errorMsg}
    <span class="hue-status hue-error">{errorMsg}</span>
    <button type="button" onclick={load}>⟳</button>
  {:else if light}
    <div class="bulb-row">
      <button type="button" class="bulb-toggle" class:on={light.on.on} onclick={toggle}>{light.on.on ? '켜짐' : '꺼짐'}</button>
      <span class="bulb-name">{light.metadata?.name ?? ''}</span>
      {#if swatch}<span class="bulb-swatch" style:background={swatch}></span>{/if}
      <button type="button" class="hue-refresh" onclick={load} aria-label="새로고침">⟳</button>
    </div>
    {#if supportsDimming(light)}
      <label class="bulb-slider">밝기
        <input type="range" min="1" max="100" value={light.dimming?.brightness ?? 100} oninput={(e) => setBrightness(Number((e.target as HTMLInputElement).value))} />
      </label>
    {/if}
    {#if supportsColorTemp(light)}
      <label class="bulb-slider">색온도
        <input type="range" min="2000" max="6500" step="100" value={kelvin} oninput={(e) => setKelvin(Number((e.target as HTMLInputElement).value))} />
      </label>
    {/if}
    {#if supportsColor(light)}
      <label class="bulb-slider">색
        <input type="color" value={swatch ? rgbToHex(xyToRgb(light.color!.xy, light.dimming?.brightness ?? 100)) : '#ffffff'} oninput={(e) => setColorHex((e.target as HTMLInputElement).value)} />
      </label>
    {/if}
  {/if}
</div>

<script lang="ts" module>
  function rgbToHex(rgb: [number, number, number]): string {
    return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
  }
</script>

<style>
  .bulb-control { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.6rem; border: 1px solid var(--border, #ddd); border-radius: 8px; margin: 0.3rem 0; }
  .bulb-row { display: flex; align-items: center; gap: 0.5rem; }
  .bulb-toggle { padding: 0.3rem 0.8rem; border-radius: 999px; border: 1px solid var(--border, #ccc); cursor: pointer; }
  .bulb-toggle.on { background: #ffd766; }
  .bulb-swatch { width: 1.1rem; height: 1.1rem; border-radius: 50%; border: 1px solid #0002; }
  .bulb-slider { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
  .bulb-slider input[type='range'] { flex: 1; }
  .hue-refresh { margin-left: auto; }
  .hue-error { color: #c0392b; }
  .hue-status { font-size: 0.85rem; opacity: 0.8; }
</style>
```

- [ ] **Step 5: TomboyEditor.svelte 플러그인 등록**

`app/src/lib/editor/TomboyEditor.svelte` 의 `tomboyAutomationNote` Extension 블록(line ~611) **바로 뒤**에 추가:

```ts
				Extension.create({
					name: "tomboyHueNote",
					addProseMirrorPlugins() {
						return [createHueNotePlugin({ getGuid: () => currentGuid ?? "", oninternallink: (t) => oninternallink?.(t) })];
					},
				}),
```

그리고 파일 상단 import 영역(다른 plugin import 옆)에:

```ts
	import { createHueNotePlugin } from "./hueNote/hueNotePlugin";
```

- [ ] **Step 6: 통과 확인**

Run: `cd app && npx vitest run tests/unit/hue/hueNotePlugin.test.ts && npm run check`
Expected: 2 tests PASS, svelte-check 0 errors

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/editor/hueNote/hueNotePlugin.ts app/src/lib/editor/hueNote/BulbControl.svelte app/src/lib/editor/TomboyEditor.svelte app/tests/unit/hue/hueNotePlugin.test.ts
git commit -m "feat(hue): 조명 노트 에디터 플러그인 + 전구 제어 위젯(BulbControl)"
```

> ⚠️ Task 5 는 `ZoneControl.svelte`/`MasterDashboard.svelte` 를 import 한다. 빌드가 깨지지 않게 Task 6·7 전이라면 두 파일의 **빈 스텁**(`<script lang="ts"></script><div></div>`)을 먼저 만들고 Task 6·7 에서 채운다. 스텁 생성도 이 커밋에 포함.

---

## Task 6: ZoneControl.svelte — grouped_light 바 + 멤버십 + 씬

**Goal:** 존 노트 위젯 — grouped_light 일괄 제어(전체 on/off·밝기), 멤버십 양방향 버튼(노트→Hue / Hue→노트), 씬 recall + 현재상태 저장.

**Files:**
- Create/Replace: `app/src/lib/editor/hueNote/ZoneControl.svelte` (Task 5 스텁 대체)
- Create: `app/src/lib/hue/zoneOps.ts` (순수/IO 분리 로직)
- Test: `app/tests/unit/hue/zoneOps.test.ts`

**Acceptance Criteria:**
- [ ] `resolveMembershipIds(titles, titleToLightId)` 가 멤버십 타이틀을 light uuid 로 해석, 미해석 타이틀은 `unresolved` 로 분리.
- [ ] `groupedLightIdOf(zone)` 가 zone.services 에서 rtype `grouped_light` 의 rid 반환(없으면 null).
- [ ] (수동) `npm run dev`: 존 노트에서 전체 on/off 동작, `[Hue에 반영]` 으로 zone.children PUT, 씬 버튼 recall.

**Verify:** `cd app && npx vitest run tests/unit/hue/zoneOps.test.ts && npm run check` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 작성**

```ts
// app/tests/unit/hue/zoneOps.test.ts
import { describe, it, expect } from 'vitest';
import { resolveMembershipIds, groupedLightIdOf } from '$lib/hue/zoneOps.js';
import type { HueZone } from '$lib/hue/hueTypes.js';

describe('zoneOps', () => {
  it('resolves member titles to light ids, separating unresolved', () => {
    const map = new Map([['거실 등', 'aaa'], ['주방 등', 'bbb']]);
    const r = resolveMembershipIds(['거실 등', '없는 등', '주방 등'], map);
    expect(r.lightIds).toEqual(['aaa', 'bbb']);
    expect(r.unresolved).toEqual(['없는 등']);
  });
  it('finds grouped_light service id', () => {
    const zone: HueZone = { id: 'z', type: 'zone', children: [], services: [{ rid: 'gl1', rtype: 'grouped_light' }, { rid: 'x', rtype: 'entertainment' }] };
    expect(groupedLightIdOf(zone)).toBe('gl1');
  });
  it('returns null when no grouped_light', () => {
    expect(groupedLightIdOf({ id: 'z', type: 'zone', children: [], services: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npx vitest run tests/unit/hue/zoneOps.test.ts` → FAIL

- [ ] **Step 3: zoneOps.ts 구현**

```ts
// app/src/lib/hue/zoneOps.ts
import type { HueZone, HueResourceRef } from './hueTypes.js';

export interface Resolved { lightIds: string[]; unresolved: string[]; }

/** 멤버십 타이틀 → light uuid. 못 찾은 타이틀은 unresolved 로. */
export function resolveMembershipIds(titles: string[], titleToLightId: Map<string, string>): Resolved {
  const lightIds: string[] = []; const unresolved: string[] = [];
  for (const t of titles) {
    const id = titleToLightId.get(t);
    if (id) lightIds.push(id); else unresolved.push(t);
  }
  return { lightIds, unresolved };
}

/** zone.services 에서 grouped_light rid. */
export function groupedLightIdOf(zone: HueZone): string | null {
  return zone.services.find((s) => s.rtype === 'grouped_light')?.rid ?? null;
}

/** light uuid 배열 → zone.children 페이로드. */
export function toChildrenRefs(lightIds: string[]): HueResourceRef[] {
  return lightIds.map((rid) => ({ rid, rtype: 'light' }));
}
```

- [ ] **Step 4: ZoneControl.svelte 구현**

```svelte
<!-- app/src/lib/editor/hueNote/ZoneControl.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { EditorView } from '@tiptap/pm/view';
  import { hueCall, HueError } from '$lib/hue/hueClient.js';
  import type { HueZone, HueScene, HueLight } from '$lib/hue/hueTypes.js';
  import { groupedLightIdOf, resolveMembershipIds, toChildrenRefs } from '$lib/hue/zoneOps.js';
  import { extractMembershipTitles } from '$lib/hue/hueNoteParse.js';
  import { listNotesShared } from '$lib/core/noteManager.js';
  import { pushToast } from '$lib/stores/toast.js';
  import { firstBodyLineOf } from '$lib/hue/noteBody.js';

  let { zoneId, view }: { zoneId: string | null; view: EditorView; getGuid?: () => string; oninternallink?: (t: string) => void } = $props();

  let zone = $state<HueZone | null>(null);
  let groupedOn = $state(false);
  let brightness = $state(100);
  let scenes = $state<HueScene[]>([]);
  let status = $state('');
  let glId = $state<string | null>(null);

  async function load() {
    if (!zoneId) { status = 'Hue에 아직 미생성 — [Hue에 반영]'; return; }
    status = '불러오는 중…';
    try {
      const zd = (await hueCall('GET', `zone/${zoneId}`)) as { data?: HueZone[] };
      zone = zd.data?.[0] ?? null;
      if (zone) {
        glId = groupedLightIdOf(zone);
        if (glId) {
          const gd = (await hueCall('GET', `grouped_light/${glId}`)) as { data?: Array<{ on: { on: boolean }; dimming?: { brightness: number } }> };
          const g = gd.data?.[0];
          groupedOn = g?.on.on ?? false; brightness = g?.dimming?.brightness ?? 100;
        }
        const sd = (await hueCall('GET', 'scene')) as { data?: HueScene[] };
        scenes = (sd.data ?? []).filter((s) => s.group?.rid === zoneId);
      }
      status = '';
    } catch (e) { status = e instanceof HueError && e.kind === 'no_bridge' ? '설정에서 Hue를 먼저 연결' : '조명 브릿지에 연결 안 됨'; }
  }
  onMount(load);

  async function setGroupOn(on: boolean) {
    if (!glId) return; const prev = groupedOn; groupedOn = on;
    try { await hueCall('PUT', `grouped_light/${glId}`, { on: { on } }); } catch { groupedOn = prev; pushToast('그룹 제어 실패'); }
  }
  async function setGroupBrightness(v: number) {
    if (!glId) return; const prev = brightness; brightness = v;
    try { await hueCall('PUT', `grouped_light/${glId}`, { dimming: { brightness: v } }); } catch { brightness = prev; pushToast('그룹 밝기 실패'); }
  }

  /** 타이틀→lightId 맵을 전체 노트 스캔으로 구축. */
  async function buildTitleMap(): Promise<Map<string, string>> {
    const notes = await listNotesShared();
    const map = new Map<string, string>();
    for (const n of notes) {
      const line = firstBodyLineOf(n.xmlContent);
      const m = /^light:([0-9a-fA-F-]{36})$/.exec(line.trim());
      if (m) map.set(n.title.replace(/^조명::/, ''), m[1]);
    }
    return map;
  }

  async function pushMembership() {
    const titles = extractMembershipTitles(view.state.doc).map((t) => t.replace(/^조명::/, ''));
    const map = await buildTitleMap();
    const { lightIds, unresolved } = resolveMembershipIds(titles, map);
    if (unresolved.length) pushToast(`해석 못한 항목 ${unresolved.length}개 건너뜀`);
    try {
      if (!zoneId) {
        const created = (await hueCall('POST', 'zone', { type: 'zone', metadata: { name: '새 존', archetype: 'other' }, children: toChildrenRefs(lightIds) })) as { data?: Array<{ rid: string }> };
        const newId = created.data?.[0]?.rid;
        if (newId) writeZoneSignature(newId);
      } else {
        await hueCall('PUT', `zone/${zoneId}`, { children: toChildrenRefs(lightIds) });
      }
      pushToast('Hue에 반영됨'); await load();
    } catch { pushToast('Hue 반영 실패'); }
  }

  /** 본문 첫 줄 시그니처를 zone:<id> 로 갱신 — 새 존 생성 후 write-back. */
  function writeZoneSignature(newId: string) {
    const doc = view.state.doc; const first = doc.firstChild; if (!first) return;
    const start = first.nodeSize; const second = doc.childCount > 1 ? doc.child(1) : null;
    if (!second) return;
    const from = start + 1; const to = from + second.content.size;
    view.dispatch(view.state.tr.insertText(`zone:${newId}`, from, to));
  }

  async function recallScene(id: string) {
    try { await hueCall('PUT', `scene/${id}`, { recall: { action: 'active' } }); pushToast('씬 적용'); }
    catch { pushToast('씬 적용 실패'); }
  }
</script>

<div class="zone-control">
  <div class="zone-row">
    <button type="button" class="bulb-toggle" class:on={groupedOn} onclick={() => setGroupOn(!groupedOn)}>{groupedOn ? '전체 켜짐' : '전체 꺼짐'}</button>
    <button type="button" class="hue-refresh" onclick={load} aria-label="새로고침">⟳</button>
  </div>
  {#if glId}
    <label class="bulb-slider">전체 밝기
      <input type="range" min="1" max="100" value={brightness} oninput={(e) => setGroupBrightness(Number((e.target as HTMLInputElement).value))} />
    </label>
  {/if}
  {#if status}<span class="hue-status">{status}</span>{/if}
  <div class="zone-membership">
    <button type="button" onclick={pushMembership}>Hue에 반영</button>
  </div>
  {#if scenes.length}
    <div class="zone-scenes">
      {#each scenes as s (s.id)}<button type="button" onclick={() => recallScene(s.id)}>{s.metadata.name}</button>{/each}
    </div>
  {/if}
</div>

<style>
  .zone-control { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.6rem; border: 1px solid var(--border, #ddd); border-radius: 8px; margin: 0.3rem 0; }
  .zone-row { display: flex; align-items: center; gap: 0.5rem; }
  .zone-scenes { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .zone-scenes button { padding: 0.2rem 0.6rem; border-radius: 999px; border: 1px solid var(--border, #ccc); }
  .bulb-toggle { padding: 0.3rem 0.8rem; border-radius: 999px; border: 1px solid var(--border, #ccc); }
  .bulb-toggle.on { background: #ffd766; }
  .bulb-slider { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
  .bulb-slider input[type='range'] { flex: 1; }
  .hue-refresh { margin-left: auto; }
  .hue-status { font-size: 0.85rem; opacity: 0.8; }
</style>
```

- [ ] **Step 5: noteBody.ts 헬퍼 (본문 첫 줄 추출, 공유)**

```ts
// app/src/lib/hue/noteBody.ts
/** note.xmlContent(<note-content>title\nsecond\n...) 에서 본문 첫 보이는 줄(2번째 줄) 추출. */
export function firstBodyLineOf(xmlContent: string): string {
  const m = /<note-content[^>]*>([\s\S]*?)<\/note-content>/.exec(xmlContent);
  const inner = m ? m[1] : xmlContent;
  const lines = inner.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').split('\n');
  return lines[1] ?? '';
}
```

> **참고:** `firstBodyLineOf` 는 단순 텍스트 시그니처(`light:`/`zone:`) 추출 전용 — XML 마크업이 섞이지 않는 첫 본문 줄 기준. 테스트 추가 권장(아래 Step 6 에 포함).

- [ ] **Step 6: noteBody 테스트 + 통과 확인**

```ts
// app/tests/unit/hue/noteBody.test.ts
import { describe, it, expect } from 'vitest';
import { firstBodyLineOf } from '$lib/hue/noteBody.js';
describe('firstBodyLineOf', () => {
  it('extracts second line', () => {
    expect(firstBodyLineOf('<note-content version="0.1">조명::거실\nlight:abc\n\n</note-content>')).toBe('light:abc');
  });
});
```

Run: `cd app && npx vitest run tests/unit/hue/zoneOps.test.ts tests/unit/hue/noteBody.test.ts && npm run check`
Expected: PASS, 타입 통과

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/editor/hueNote/ZoneControl.svelte app/src/lib/hue/zoneOps.ts app/src/lib/hue/noteBody.ts app/tests/unit/hue/zoneOps.test.ts app/tests/unit/hue/noteBody.test.ts
git commit -m "feat(hue): 존 제어 위젯 — grouped_light 바 + 양방향 멤버십 + 씬 recall"
```

---

## Task 7: MasterDashboard.svelte — 가져오기 + 개요 + 전체 on/off

**Goal:** 마스터 노트 위젯 — `[전구 가져오기]`(발견→멱등 생성), `[존 가져오기]`, 전 전구 전역 on/off.

**Files:**
- Create/Replace: `app/src/lib/editor/hueNote/MasterDashboard.svelte` (Task 5 스텁 대체)
- Test: (로직은 Task 4 의 `planLightImports` 로 커버됨 — 추가 유닛 불필요. 수동 검증.)

**Acceptance Criteria:**
- [ ] `[전구 가져오기]` → Hue light 목록 fetch → 기존 uuid 스캔 → 누락분만 createNote. 재클릭 시 새 노트 0개.
- [ ] `[전체 켜기]/[전체 끄기]` → 알려진 light 전체에 PUT on.
- [ ] 미페어링 시 "설정에서 Hue 연결" 안내 + 가져오기 버튼 비활성.

**Verify:** `cd app && npm run check` (타입) + 수동 `npm run dev`

**Steps:**

- [ ] **Step 1: MasterDashboard.svelte 구현**

```svelte
<!-- app/src/lib/editor/hueNote/MasterDashboard.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { hueCall, getHueContext, HueError } from '$lib/hue/hueClient.js';
  import type { HueLight } from '$lib/hue/hueTypes.js';
  import { planLightImports } from '$lib/hue/hueImport.js';
  import { firstBodyLineOf } from '$lib/hue/noteBody.js';
  import { createNote, ensureUniqueTitle, listNotesShared } from '$lib/core/noteManager.js';
  import { pushToast } from '$lib/stores/toast.js';

  let paired = $state(false);
  let busy = $state(false);
  let lights = $state<HueLight[]>([]);

  onMount(async () => { paired = (await getHueContext()) !== null; });

  async function existingLightIds(): Promise<Set<string>> {
    const notes = await listNotesShared();
    const ids = new Set<string>();
    for (const n of notes) { const m = /^light:([0-9a-fA-F-]{36})$/.exec(firstBodyLineOf(n.xmlContent).trim()); if (m) ids.add(m[1]); }
    return ids;
  }

  async function importLights() {
    busy = true;
    try {
      const data = (await hueCall('GET', 'light')) as { data?: HueLight[] };
      lights = data.data ?? [];
      const existing = await existingLightIds();
      const plan = planLightImports(lights, existing);
      for (const item of plan) {
        const title = await ensureUniqueTitle(item.title);
        await createNote({ title, bodyFirstLine: item.bodyFirstLine });
      }
      pushToast(plan.length ? `전구 ${plan.length}개 노트 생성` : '새 전구 없음');
    } catch (e) {
      pushToast(e instanceof HueError && e.kind === 'no_bridge' ? '설정에서 Hue를 먼저 연결' : '조명 브릿지에 연결 안 됨');
    } finally { busy = false; }
  }

  async function allOnOff(on: boolean) {
    busy = true;
    try {
      const data = (await hueCall('GET', 'light')) as { data?: HueLight[] };
      for (const l of data.data ?? []) { await hueCall('PUT', `light/${l.id}`, { on: { on } }); }
      pushToast(on ? '전체 켜짐' : '전체 꺼짐');
    } catch { pushToast('전체 제어 실패'); } finally { busy = false; }
  }
</script>

<div class="master-dashboard">
  {#if !paired}
    <span class="hue-status hue-error">설정 → Hue 에서 허브를 먼저 연결하세요.</span>
  {:else}
    <div class="master-row">
      <button type="button" disabled={busy} onclick={importLights}>전구 가져오기</button>
      <button type="button" disabled={busy} onclick={() => allOnOff(true)}>전체 켜기</button>
      <button type="button" disabled={busy} onclick={() => allOnOff(false)}>전체 끄기</button>
    </div>
  {/if}
</div>

<style>
  .master-dashboard { padding: 0.6rem; border: 1px solid var(--border, #ddd); border-radius: 8px; margin: 0.3rem 0; }
  .master-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .master-row button { padding: 0.3rem 0.8rem; border-radius: 8px; border: 1px solid var(--border, #ccc); }
  .hue-status { font-size: 0.85rem; } .hue-error { color: #c0392b; }
</style>
```

> **존 가져오기:** v1 에선 `[전구 가져오기]` 만 자동. 존 노트는 사용자가 `조명::<존이름>` 노트를 직접 만들고 본문에 전구 링크 리스트 + 첫 줄 `zone` 을 적은 뒤 `[Hue에 반영]` 으로 생성하는 흐름(Task 6). `[존 가져오기]`(Hue→노트)는 YAGNI 백로그.

- [ ] **Step 2: 타입/빌드 확인** — Run: `cd app && npm run check` → 0 errors

- [ ] **Step 3: 커밋**

```bash
git add app/src/lib/editor/hueNote/MasterDashboard.svelte
git commit -m "feat(hue): 마스터 대시보드 — 전구 가져오기(멱등) + 전체 on/off"
```

---

## Task 8: 설정 Hue 페어링 하위탭

**Goal:** 설정에 'Hue/조명' 하위탭 — 브릿지 찾기/수동 IP → 링크버튼 안내 → 연결(키 발급·저장) → 연결됨 표시/해제.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte`

**Acceptance Criteria:**
- [ ] 하위탭에서 `[브릿지 찾기]` → 후보 IP 목록 또는 수동 입력 칸.
- [ ] `[연결]` → `huePair` 성공 시 `setHueCredentials` 저장 + "연결됨" 표시. 409 → "허브 링크 버튼 누르고 다시".
- [ ] `[연결 해제]` → `clearHueCredentials`.

**Verify:** `cd app && npm run check` + 수동 `npm run dev` → 설정에서 페어링

**Steps:**

- [ ] **Step 1: 설정 페이지에 Hue 탭 추가**

`app/src/routes/settings/+page.svelte` 의 기존 탭 구조(터미널 브릿지 설정이 있는 곳)를 따라 Hue 섹션을 추가. 핵심 스크립트 로직:

```ts
  import { hueDiscover, huePair } from '$lib/hue/hueClient.js';
  import { bridgeToHttpBase, getDefaultTerminalBridge, getTerminalBridgeToken } from '$lib/editor/terminal/bridgeSettings.js';
  import { getHueBridgeIp, getHueAppKey, setHueCredentials, clearHueCredentials } from '$lib/storage/hueSettings.js';

  let hueIp = $state('');
  let hueCandidates = $state<Array<{ ip: string; id: string }>>([]);
  let hueConnected = $state(false);
  let hueMsg = $state('');

  async function loadHueState() {
    hueIp = await getHueBridgeIp();
    hueConnected = !!(await getHueAppKey());
  }
  // onMount 에서 loadHueState() 호출

  async function bridgeCtx(): Promise<{ base: string; token: string } | null> {
    const b = await getDefaultTerminalBridge(); const t = await getTerminalBridgeToken();
    if (!b || !t) return null; return { base: bridgeToHttpBase(b), token: t };
  }

  async function findHueBridges() {
    const ctx = await bridgeCtx(); if (!ctx) { hueMsg = '먼저 터미널 브릿지를 연결하세요.'; return; }
    hueCandidates = await hueDiscover(ctx.base, ctx.token);
    if (!hueCandidates.length) hueMsg = '자동 발견 실패 — IP를 직접 입력하세요.';
  }

  async function connectHue() {
    const ctx = await bridgeCtx(); if (!ctx) { hueMsg = '먼저 터미널 브릿지를 연결하세요.'; return; }
    if (!hueIp.trim()) { hueMsg = 'IP를 입력하세요.'; return; }
    hueMsg = '허브의 링크 버튼을 누른 뒤 잠시 기다리세요…';
    const r = await huePair(ctx.base, ctx.token, hueIp.trim());
    if ('error' in r) { hueMsg = r.error === 'link_button' ? '허브 링크 버튼을 누르고 다시 [연결]' : 'Hue 연결 실패'; return; }
    await setHueCredentials(hueIp.trim(), r.appkey, r.clientkey);
    hueConnected = true; hueMsg = '연결됨';
  }

  async function disconnectHue() { await clearHueCredentials(); hueConnected = false; hueMsg = '연결 해제됨'; }
```

마크업(설정 탭 패턴에 맞춰):

```svelte
<section class="settings-group">
  <h3>Hue 조명</h3>
  {#if hueConnected}
    <p class="info-text">연결됨 — {hueIp}</p>
    <button type="button" onclick={disconnectHue}>연결 해제</button>
  {:else}
    <button type="button" onclick={findHueBridges}>브릿지 찾기</button>
    {#each hueCandidates as c (c.ip)}
      <button type="button" onclick={() => (hueIp = c.ip)}>{c.ip}</button>
    {/each}
    <input type="text" placeholder="허브 IP (예: 192.168.0.50)" bind:value={hueIp} />
    <button type="button" onclick={connectHue}>연결</button>
  {/if}
  {#if hueMsg}<p class="info-text">{hueMsg}</p>{/if}
</section>
```

> **위치:** 기존 터미널 브릿지 설정 섹션 근처(같은 탭)에 둔다 — Hue 는 같은 브릿지 자격을 재사용하므로 사용자 멘탈모델이 맞다. 별도 하위탭 버튼을 만들면 기존 `guideSubTab` 류 탭 상태 패턴을 따른다.

- [ ] **Step 2: 타입 확인** — Run: `cd app && npm run check` → 0 errors

- [ ] **Step 3: 커밋**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "feat(hue): 설정 Hue 페어링 — 발견/수동 IP + 링크버튼 키 발급 + 연결 해제"
```

---

## Task 9: 가이드 카드 + CLAUDE.md 인덱스 + 스킬 스텁

**Goal:** 사용자 발견 표면(설정→가이드) 카드 + CLAUDE.md 스킬 테이블 행 + `tomboy-hue` 스킬 스텁.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (guide-card, `guideSubTab: notes`)
- Modify: `CLAUDE.md`
- Create: `.claude/skills/tomboy-hue/SKILL.md` (또는 리포의 스킬 경로 규약)

**Acceptance Criteria:**
- [ ] 설정 → 가이드 → notes 에 `조명::` 카드(`<details class="guide-card">`): 노트 3종 + 페어링 + ⟳ + 존 양방향 + 씬.
- [ ] CLAUDE.md 스킬 테이블에 `tomboy-hue` 행.
- [ ] `npm run check` 통과.

**Verify:** `cd app && npm run check` + 수동: 설정→가이드→notes 에 카드 노출

**Steps:**

- [ ] **Step 1: 가이드 카드 추가** (`+page.svelte` 의 `guideSubTab === 'notes'` 블록 안, 기존 카드 패턴 모방)

```svelte
<details class="guide-card">
  <summary>조명 노트 (Hue)</summary>
  <p class="info-text">같은 네트워크의 Philips Hue 허브를 노트로 제어합니다. 먼저 설정에서 허브를 연결하세요.</p>
  <pre class="snippet">조명::전체      ← 마스터(전구 가져오기·전체 on/off)
조명::거실 등   본문 첫 줄: light:&lt;uuid&gt;
조명::침실      본문 첫 줄: zone  + 전구 링크 리스트</pre>
  <ul class="guide-list">
    <li>마스터 노트의 <b>전구 가져오기</b>로 전구별 노트가 자동 생성됩니다.</li>
    <li>상태는 <b>⟳</b>로 새로고침 — 물리 스위치/Hue 앱 변경은 자동 반영되지 않습니다.</li>
    <li>존 노트: 본문에 전구 노트 링크를 적고 <b>[Hue에 반영]</b>으로 그룹을 만듭니다(양방향).</li>
    <li>씬: 존 노트에서 적용/현재 상태 저장.</li>
  </ul>
</details>
```

- [ ] **Step 2: CLAUDE.md 스킬 테이블 행 추가** (스킬 인덱스 표 마지막 부근)

```md
| `tomboy-hue` | `조명::` 노트 — Hue 허브 전구/존/씬 제어(브릿지 직통 CLIP v2) | `lib/hue/`, `lib/editor/hueNote/`, `bridge/src/hue.ts` |
```

- [ ] **Step 3: 스킬 스텁 작성** `.claude/skills/tomboy-hue/SKILL.md` (frontmatter + 요약; 상세 invariant 는 구현 후 보강)

```md
---
name: tomboy-hue
description: Use when working on the 조명:: Hue light-control note family — per-bulb / zone / master notes that drive a Philips Hue hub via the Pi bridge's /hue/{discover,pair,clip} CLIP v2 relay. Covers color.ts (RGB↔xy + gamut), hueNoteParse (kind/uuid + PMNode membership), hueClient (bridge calls + context), hueImport (idempotent note creation), the editor plugin + BulbControl/ZoneControl/MasterDashboard widgets, settings pairing, and the UUID-binding / manual-refresh / two-way-membership invariants.
---

# tomboy-hue

조명:: 노트로 Philips Hue 허브 제어. 설계: `docs/superpowers/specs/2026-06-19-hue-control-note-design.md`.

## 핵심 불변식
- 바인딩은 항상 light/zone **UUID**(이름/타이틀 아님).
- 상태 읽기 = 마운트 1회 + ⟳ 수동. 주기 폴링·SSE 없음. 쓰기 = 즉시 PUT + 옵티미스틱/롤백.
- 브릿지가 같은 LAN Hue 를 자체서명(`rejectUnauthorized:false`)으로 직접 호출. `/hue/clip` path 화이트리스트.
- 존 멤버십 양방향: 노트 링크 리스트 ⇄ zone.children. 충돌 시 "마지막 버튼 승".
- capability 판별 = light 리소스의 `color`/`color_temperature`/`dimming` 키 존재.

## 파일
- `app/src/lib/hue/` — color, hueTypes, hueNoteParse, hueClient, hueImport, zoneOps, noteBody
- `app/src/lib/editor/hueNote/` — hueNotePlugin + BulbControl/ZoneControl/MasterDashboard
- `bridge/src/hue.ts` — discover/pair/clip
- 설정: `lib/storage/hueSettings.ts`, 페어링 UI in `routes/settings/+page.svelte`
```

- [ ] **Step 4: 확인 + 커밋**

Run: `cd app && npm run check` → 0 errors

```bash
git add app/src/routes/settings/+page.svelte CLAUDE.md .claude/skills/tomboy-hue/SKILL.md
git commit -m "docs(hue): 가이드 카드 + CLAUDE.md 인덱스 + tomboy-hue 스킬 스텁"
```

---

## 최종 검증

- [ ] `cd app && npx vitest run tests/unit/hue` → 전체 PASS
- [ ] `cd bridge && node --import tsx --test src/hue.test.ts` → PASS
- [ ] `cd app && npm run check` → 0 errors
- [ ] 수동(`npm run dev` + 실 Hue 허브): 설정 페어링 → `조명::전체` 노트 → 전구 가져오기 → 전구 노트 토글/밝기/색 → `조명::침실` 존 노트 링크 리스트 + Hue에 반영 → 그룹 on/off → 씬 recall.
- [ ] 설정 → 가이드 → notes 에 조명 카드 노출.

## 빌드 순서 메모

Task 5 가 ZoneControl/MasterDashboard 를 import 하므로, 권장 구현 순서는 **0→1→2→3→4→5(스텁 포함)→6→7→8→9**. Task 5 에서 두 컴포넌트의 빈 스텁을 먼저 만들어 빌드를 통과시키고 6·7 에서 채운다.
