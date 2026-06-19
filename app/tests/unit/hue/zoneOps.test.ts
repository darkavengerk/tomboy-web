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
