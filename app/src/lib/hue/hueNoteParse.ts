import type { Node as PMNode } from '@tiptap/pm/model';

export type HueNoteKind = 'bulb' | 'zone' | 'master';
export interface HueNoteInfo { kind: HueNoteKind; lightId?: string; zoneId?: string | null; }

export const HUE_PREFIX = '조명::';
export const HUE_MASTER_NAME = '전체';
const LIGHT_RE = /^light:([0-9a-fA-F-]{36})$/;
const ZONE_RE = /^zone(?::([0-9a-fA-F-]{36}))?$/;

/** 타이틀+본문 첫 줄로 조명 노트 종류 판별. 조명 노트가 아니면 null. */
export function parseHueNote(title: string, bodyFirstLine: string): HueNoteInfo | null {
  if (!title.startsWith(HUE_PREFIX)) return null;
  const name = title.slice(HUE_PREFIX.length).trim();
  if (name === HUE_MASTER_NAME) return { kind: 'master' };
  const sig = bodyFirstLine.trim();
  const lm = LIGHT_RE.exec(sig);
  if (lm) return { kind: 'bulb', lightId: lm[1] };
  const zm = ZONE_RE.exec(sig);
  if (zm) return { kind: 'zone', zoneId: zm[1] ?? null };
  return null;
}

/** 본문 내부링크(tomboyInternalLink) 마크의 target 을 문서 순서대로(중복 제거) 반환.
 *  atom 교훈: plain JSON text 스캔 금지 — 라이브 PMNode 마크를 읽는다. */
export function extractMembershipTitles(doc: PMNode): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  doc.descendants((node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name === 'tomboyInternalLink') {
        const t = String(mark.attrs.target ?? '').trim();
        if (t && !seen.has(t)) { seen.add(t); out.push(t); }
      }
    }
  });
  return out;
}
