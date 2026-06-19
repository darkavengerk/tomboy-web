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
