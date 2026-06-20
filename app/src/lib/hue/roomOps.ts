import type { HueRoom, HueResourceRef, HueLight, HueScene } from './hueTypes.js';

/** 룸 device children 에 owner 가 든 light 만(순서 보존). */
export function lightsInRoom(room: HueRoom, allLights: HueLight[]): HueLight[] {
  const devRids = new Set(room.children.filter((c) => c.rtype === 'device').map((c) => c.rid));
  return allLights.filter((l) => l.owner && devRids.has(l.owner.rid));
}

/** services 에서 grouped_light rid. */
export function groupedLightIdOf(group: { services: HueResourceRef[] }): string | null {
  return group.services.find((s) => s.rtype === 'grouped_light')?.rid ?? null;
}

export interface SceneAction { target: { rid: string; rtype: 'light' }; action: Record<string, unknown>; }
/** 멤버 light 현재 상태 → scene actions[]. color 와 color_temperature 는 상호배타 — mirek 있으면 CT. */
export function buildSceneActions(lights: HueLight[]): SceneAction[] {
  return lights.map((l) => {
    const action: Record<string, unknown> = { on: { on: l.on.on } };
    if (l.dimming) action.dimming = { brightness: l.dimming.brightness };
    if (l.color_temperature && l.color_temperature.mirek != null) action.color_temperature = { mirek: l.color_temperature.mirek };
    else if (l.color) action.color = { xy: l.color.xy };
    return { target: { rid: l.id, rtype: 'light' }, action };
  });
}

/** scene.status.active 가 inactive 가 아니면 활성. */
export function isSceneActive(scene: HueScene): boolean {
  return !!scene.status && scene.status.active !== 'inactive';
}
