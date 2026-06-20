import { describe, it, expect } from 'vitest';
import { resolveMembershipIds, groupedLightIdOf, resolveChildTitles, buildSceneActions } from '$lib/hue/zoneOps.js';
import type { HueZone, HueLight } from '$lib/hue/hueTypes.js';

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

describe('resolveChildTitles', () => {
  it('maps child rids to titles, collecting missing', () => {
    const map = new Map([['aaa', '조명::거실'], ['bbb', '조명::주방']]);
    const r = resolveChildTitles(['aaa', 'zzz', 'bbb'], map);
    expect(r.titles).toEqual(['조명::거실', '조명::주방']);
    expect(r.missing).toEqual(['zzz']);
  });
});

describe('buildSceneActions', () => {
  it('builds on + dimming + chooses CT over color when mirek present', () => {
    const lights: HueLight[] = [
      { id: 'a', type: 'light', on: { on: true }, dimming: { brightness: 50 }, color_temperature: { mirek: 300 }, color: { xy: { x: 0.3, y: 0.3 } } }
    ];
    expect(buildSceneActions(lights)).toEqual([
      { target: { rid: 'a', rtype: 'light' }, action: { on: { on: true }, dimming: { brightness: 50 }, color_temperature: { mirek: 300 } } }
    ]);
  });
  it('uses color when no mirek', () => {
    const lights: HueLight[] = [{ id: 'b', type: 'light', on: { on: false }, color: { xy: { x: 0.1, y: 0.2 } } }];
    expect(buildSceneActions(lights)).toEqual([
      { target: { rid: 'b', rtype: 'light' }, action: { on: { on: false }, color: { xy: { x: 0.1, y: 0.2 } } } }
    ]);
  });
});
