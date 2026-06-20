import { describe, it, expect } from 'vitest';
import { planLightImports, planRoomImports } from '$lib/hue/hueImport.js';
import type { HueLight, HueRoom } from '$lib/hue/hueTypes.js';

const light = (id: string, name: string): HueLight => ({ id, type: 'light', metadata: { name }, on: { on: true } });

const room = (id: string, name?: string): HueRoom =>
  ({ id, type: 'room', metadata: name ? { name } : undefined, children: [], services: [] });

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

describe('planRoomImports', () => {
  it('기존 룸 skip, 새 룸만', () => {
    const plan = planRoomImports([room('r1', '거실'), room('r2', '침실')], new Set(['r1']));
    expect(plan).toEqual([{ title: '조명::침실', bodyFirstLine: 'room:r2' }]);
  });
  it('이름 폴백', () => {
    expect(planRoomImports([room('r9')], new Set())[0].title).toBe('조명::방 r9');
  });
  it('멱등 — 전부 기존이면 빈 배열', () => {
    expect(planRoomImports([room('r1', '거실')], new Set(['r1']))).toEqual([]);
  });
});
