import type { HueLight, HueRoom } from './hueTypes.js';
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

/** 새로 노트를 만들어야 할 room 만. existingRoomIds 의 id 는 skip. */
export function planRoomImports(rooms: HueRoom[], existingRoomIds: Set<string>): ImportPlanItem[] {
  const out: ImportPlanItem[] = [];
  for (const r of rooms) {
    if (existingRoomIds.has(r.id)) continue;
    const name = r.metadata?.name?.trim() || `방 ${r.id}`;
    out.push({ title: `${HUE_PREFIX}${name}`, bodyFirstLine: `room:${r.id}` });
  }
  return out;
}
