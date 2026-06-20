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
