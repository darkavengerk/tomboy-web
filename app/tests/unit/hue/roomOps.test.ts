import { describe, it, expect } from 'vitest';
import { lightsInRoom, groupedLightIdOf, buildSceneActions, isSceneActive, lightsInZone } from '$lib/hue/roomOps.js';
import type { HueLight, HueRoom, HueScene, HueZone } from '$lib/hue/hueTypes.js';

const room: HueRoom = {
  id: 'r1', type: 'room', metadata: { name: '거실' },
  children: [{ rid: 'devA', rtype: 'device' }, { rid: 'devB', rtype: 'device' }],
  services: [{ rid: 'gl1', rtype: 'grouped_light' }, { rid: 'mot', rtype: 'motion' }]
};
const mk = (id: string, dev: string, extra: Partial<HueLight> = {}): HueLight =>
  ({ id, type: 'light', owner: { rid: dev, rtype: 'device' }, on: { on: false }, ...extra });

describe('lightsInRoom', () => {
  it('owner가 룸 device에 든 light만, 순서 보존', () => {
    const all = [mk('lA', 'devA'), mk('lX', 'devZ'), mk('lB', 'devB')];
    expect(lightsInRoom(room, all).map((l) => l.id)).toEqual(['lA', 'lB']);
  });
  it('owner 없는 light는 제외', () => {
    const all = [{ id: 'lN', type: 'light', on: { on: true } } as HueLight];
    expect(lightsInRoom(room, all)).toEqual([]);
  });
});

describe('groupedLightIdOf', () => {
  it('grouped_light rid 반환', () => expect(groupedLightIdOf(room)).toBe('gl1'));
  it('없으면 null', () => expect(groupedLightIdOf({ ...room, services: [] })).toBeNull());
});

describe('buildSceneActions', () => {
  it('mirek 있으면 color_temperature, 아니면 color', () => {
    const lights: HueLight[] = [
      mk('l1', 'devA', { on: { on: true }, dimming: { brightness: 80 }, color_temperature: { mirek: 300 }, color: { xy: { x: 0.4, y: 0.4 } } }),
      mk('l2', 'devB', { on: { on: true }, color: { xy: { x: 0.5, y: 0.3 } } })
    ];
    const acts = buildSceneActions(lights);
    expect(acts[0].action).toMatchObject({ on: { on: true }, dimming: { brightness: 80 }, color_temperature: { mirek: 300 } });
    expect(acts[0].action.color).toBeUndefined();
    expect(acts[1].action).toMatchObject({ color: { xy: { x: 0.5, y: 0.3 } } });
  });
  it('off 상태도 캡처', () => {
    expect(buildSceneActions([mk('l3', 'devA')])[0].action).toMatchObject({ on: { on: false } });
  });
  it('color_temperature 키는 있지만 mirek=null 이면 color 로 폴백', () => {
    const l = mk('l4', 'devA', { on: { on: true }, color_temperature: { mirek: null }, color: { xy: { x: 0.5, y: 0.3 } } });
    const act = buildSceneActions([l])[0].action;
    expect(act.color_temperature).toBeUndefined();
    expect(act).toMatchObject({ color: { xy: { x: 0.5, y: 0.3 } } });
  });
});

describe('isSceneActive', () => {
  const base: HueScene = { id: 's', type: 'scene', metadata: { name: 'n' }, group: { rid: 'r1', rtype: 'room' }, actions: [] };
  it('active != inactive → true', () => expect(isSceneActive({ ...base, status: { active: 'static' } })).toBe(true));
  it('inactive → false', () => expect(isSceneActive({ ...base, status: { active: 'inactive' } })).toBe(false));
  it('status 없으면 false', () => expect(isSceneActive(base)).toBe(false));
});

describe('lightsInZone', () => {
  const lights = [
    { id: 'L1', type: 'light', on: { on: true } },
    { id: 'L2', type: 'light', on: { on: false } },
    { id: 'L3', type: 'light', on: { on: true } }
  ] as any[];
  it('children 의 light rid 만, 순서 보존, device-hop 없음', () => {
    const zone = { id: 'Z', type: 'zone', children: [
      { rid: 'L3', rtype: 'light' }, { rid: 'L1', rtype: 'light' }
    ], services: [] } as HueZone;
    expect(lightsInZone(zone, lights).map((l) => l.id)).toEqual(['L1', 'L3']);
  });
  it('rtype 가 light 아닌 children 무시', () => {
    const zone = { id: 'Z', type: 'zone', children: [
      { rid: 'L1', rtype: 'light' }, { rid: 'DEV', rtype: 'device' }
    ], services: [] } as HueZone;
    expect(lightsInZone(zone, lights).map((l) => l.id)).toEqual(['L1']);
  });
  it('멤버 없으면 빈 배열', () => {
    const zone = { id: 'Z', type: 'zone', children: [], services: [] } as HueZone;
    expect(lightsInZone(zone, lights)).toEqual([]);
  });
});
