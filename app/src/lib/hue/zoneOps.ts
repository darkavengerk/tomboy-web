import type { HueZone, HueResourceRef, HueLight } from './hueTypes.js';

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

export interface ResolvedTitles { titles: string[]; missing: string[]; }
/** zone.children(light rids) → 각 uuid 의 노트 타이틀. 못 찾은 uuid 는 missing(rid). */
export function resolveChildTitles(childRids: string[], uuidToTitle: Map<string, string>): ResolvedTitles {
  const titles: string[] = []; const missing: string[] = [];
  for (const rid of childRids) {
    const t = uuidToTitle.get(rid);
    if (t) titles.push(t); else missing.push(rid);
  }
  return { titles, missing };
}

export interface SceneAction { target: { rid: string; rtype: 'light' }; action: Record<string, unknown>; }
/** 멤버 light 현재 상태 → scene actions[]. color 와 color_temperature 는 상호배타 — mirek 있으면 CT, 아니면 color. */
export function buildSceneActions(lights: HueLight[]): SceneAction[] {
  return lights.map((l) => {
    const action: Record<string, unknown> = { on: { on: l.on.on } };
    if (l.dimming) action.dimming = { brightness: l.dimming.brightness };
    if (l.color_temperature && l.color_temperature.mirek != null) action.color_temperature = { mirek: l.color_temperature.mirek };
    else if (l.color) action.color = { xy: l.color.xy };
    return { target: { rid: l.id, rtype: 'light' }, action };
  });
}
