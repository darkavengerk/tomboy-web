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
  children: HueResourceRef[];
  services: HueResourceRef[];
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
