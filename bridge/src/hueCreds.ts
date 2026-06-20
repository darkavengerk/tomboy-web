import { readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';

export interface HueCreds { ip: string; appkey: string; clientkey: string; }

/** BRIDGE_HUE_FILE 경로(빈값/미설정이면 undefined). 호출마다 재평가 — 캐시 없음. */
function credsPath(): string | undefined {
  const p = process.env.BRIDGE_HUE_FILE;
  return p && p.trim() ? p : undefined;
}

/** 파일/env 없음·파싱 실패·ip/appkey 누락 → null. clientkey 빈값은 허용(엔터테인먼트 미사용). */
export function readHueCreds(): HueCreds | null {
  const p = credsPath();
  if (!p) return null;
  let raw: string;
  try { raw = readFileSync(p, 'utf8'); }
  catch (err) {
    // ENOENT = 미구성(정상). 그 외(권한/디스크)는 조용히 삼키면 디버깅이 어려우므로 경고.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[term-bridge] hueCreds read failed ${p}:`, err);
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v.ip !== 'string' || typeof v.appkey !== 'string' || typeof v.clientkey !== 'string') return null;
  if (!v.ip || !v.appkey) return null;
  return { ip: v.ip, appkey: v.appkey, clientkey: v.clientkey };
}

/** 원자적 쓰기(같은 디렉터리 temp → rename), perms 0600. env 미설정/쓰기 실패 시 throw. */
export function writeHueCreds(c: HueCreds): void {
  const p = credsPath();
  if (!p) throw new Error('BRIDGE_HUE_FILE not configured');
  const tmp = `${p}.${process.pid}.tmp`;
  const data = JSON.stringify({ ip: c.ip, appkey: c.appkey, clientkey: c.clientkey });
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, p);
  try { chmodSync(p, 0o600); } catch { /* best effort */ }
}

/** 파일 삭제. env 미설정/파일 없음 → no-op. */
export function clearHueCreds(): void {
  const p = credsPath();
  if (!p) return;
  try { unlinkSync(p); } catch { /* ENOENT ok */ }
}

export interface HueCredsStore {
  read(): HueCreds | null;
  write(c: HueCreds): void; // throws on failure
  clear(): void;
}

/** 실제 파일 백엔드. 핸들러 기본 store; 테스트는 인메모리 fake 를 주입. */
export const fileHueCredsStore: HueCredsStore = {
  read: readHueCreds,
  write: writeHueCreds,
  clear: clearHueCreds
};
