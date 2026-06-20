export type HueNoteKind = 'bulb' | 'room' | 'master';
export interface HueNoteInfo { kind: HueNoteKind; lightId?: string; roomId?: string; }

export const HUE_PREFIX = '조명::';
export const HUE_MASTER_NAME = '전체';
const LIGHT_RE = /^light:([0-9a-fA-F-]{36})$/;
const ROOM_RE = /^room:([0-9a-fA-F-]{36})$/;

/** 타이틀+본문 첫 줄로 조명 노트 종류 판별. 조명 노트가 아니면 null. */
export function parseHueNote(title: string, bodyFirstLine: string): HueNoteInfo | null {
  if (!title.startsWith(HUE_PREFIX)) return null;
  const name = title.slice(HUE_PREFIX.length).trim();
  if (name === HUE_MASTER_NAME) return { kind: 'master' };
  const sig = bodyFirstLine.trim();
  const lm = LIGHT_RE.exec(sig);
  if (lm) return { kind: 'bulb', lightId: lm[1] };
  const rm = ROOM_RE.exec(sig);
  if (rm) return { kind: 'room', roomId: rm[1] };
  return null;
}
