import { bridgeToHttpBase, getDefaultTerminalBridge, getTerminalBridgeToken } from '$lib/editor/terminal/bridgeSettings.js';
import { getHueBridgeIp, getHueAppKey } from '$lib/storage/hueSettings.js';

export interface ClipReq { method: string; path: string; ip?: string; appkey?: string; body?: unknown; }
export interface ClipResult { status: number; data: unknown; }

export class HueError extends Error {
  constructor(public kind: 'no_bridge' | 'unreachable' | 'http', public status = 0) { super(kind); this.name = 'HueError'; }
}

export async function hueClip(httpBase: string, token: string, req: ClipReq): Promise<ClipResult> {
  const payload: Record<string, unknown> = { method: req.method, path: req.path };
  if (req.ip) payload.ip = req.ip;
  if (req.appkey) payload.appkey = req.appkey;
  if (req.body !== undefined) payload.body = req.body;
  let resp: Response;
  try {
    resp = await fetch(`${httpBase}/hue/clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
  } catch { throw new HueError('unreachable'); }
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

export async function huePair(
  httpBase: string, token: string, ip: string
): Promise<{ appkey: string; clientkey: string; persisted: boolean; persistError?: string } | { error: 'link_button' | 'failed' }> {
  let resp: Response;
  try {
    resp = await fetch(`${httpBase}/hue/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ip }) });
  } catch { return { error: 'failed' }; }
  if (resp.status === 409) return { error: 'link_button' };
  if (!resp.ok) return { error: 'failed' };
  const j = (await resp.json()) as { appkey?: string; clientkey?: string; persisted?: boolean; persistError?: string };
  return { appkey: j.appkey ?? '', clientkey: j.clientkey ?? '', persisted: !!j.persisted, persistError: j.persistError };
}

export async function hueDiscover(httpBase: string, token: string): Promise<Array<{ ip: string; id: string }>> {
  let resp: Response;
  try {
    resp = await fetch(`${httpBase}/hue/discover`, { headers: { Authorization: `Bearer ${token}` } });
  } catch { return []; }
  if (!resp.ok) return [];
  const body = (await resp.json().catch(() => ({}))) as { bridges?: Array<{ ip: string; id: string }> };
  return body.bridges ?? [];
}

// ── health 캐시 + 컨텍스트 ───────────────────────────────────
export interface HueHealth { configured: boolean; ip?: string; }

let healthCache: { at: number; key: string; val: HueHealth | null } | null = null;
const HEALTH_TTL_MS = 15_000;

/** 페어링/해제 직후 호출해 다음 hueHealth 가 신선한 값을 읽게 한다. */
export function invalidateHueHealthCache(): void { healthCache = null; }

/** 브릿지 보관 creds 구성 여부. 브릿지/토큰 없거나 불통 → null. 15초 TTL 캐시. */
export async function hueHealth(): Promise<HueHealth | null> {
  const bridge = await getDefaultTerminalBridge();
  const token = await getTerminalBridgeToken();
  if (!bridge || !token) return null;
  const key = `${bridge} ${token}`;
  const now = Date.now();
  if (healthCache && healthCache.key === key && now - healthCache.at < HEALTH_TTL_MS) return healthCache.val;
  let val: HueHealth | null = null;
  try {
    const r = await fetch(`${bridgeToHttpBase(bridge)}/hue/health`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) {
      const d = (await r.json().catch(() => null)) as { configured?: boolean; ip?: string } | null;
      if (d && typeof d.configured === 'boolean') val = { configured: d.configured, ip: d.ip };
    }
  } catch { val = null; }
  healthCache = { at: now, key, val };
  return val;
}

export type HueSource = 'bridge' | 'local' | 'none';

/** UI 표시용 구성 상태 + 소스. */
export async function hueConfigured(): Promise<{ ok: boolean; source: HueSource; ip?: string }> {
  const ip = await getHueBridgeIp();
  const appkey = await getHueAppKey();
  if (ip && appkey) return { ok: true, source: 'local', ip };
  const h = await hueHealth();
  if (h?.configured) return { ok: true, source: 'bridge', ip: h.ip };
  return { ok: false, source: 'none' };
}

export interface HueContext { httpBase: string; token: string; ip?: string; appkey?: string; }

/** CLIP 호출용 컨텍스트. 로컬 creds 우선 동봉, 없으면 브릿지 구성 확인 후 creds 생략. 사용 불가면 null. */
export async function getHueContext(): Promise<HueContext | null> {
  const bridge = await getDefaultTerminalBridge();
  const token = await getTerminalBridgeToken();
  if (!bridge || !token) return null;
  const httpBase = bridgeToHttpBase(bridge);
  const ip = await getHueBridgeIp();
  const appkey = await getHueAppKey();
  if (ip && appkey) return { httpBase, token, ip, appkey };
  const h = await hueHealth();
  if (h?.configured) return { httpBase, token };
  return null;
}

/** 컨텍스트 바운드 CLIP 호출. 컨텍스트 없으면 HueError('no_bridge'). */
export async function hueCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const ctx = await getHueContext();
  if (!ctx) throw new HueError('no_bridge');
  const { status, data } = await hueClip(ctx.httpBase, ctx.token, { ip: ctx.ip, appkey: ctx.appkey, method, path, body });
  if (status >= 400) throw new HueError('http', status);
  return data;
}

/** 브릿지 보관 creds 삭제(모든 기기 영향). */
export async function hueClearBridgeCreds(): Promise<boolean> {
  const bridge = await getDefaultTerminalBridge();
  const token = await getTerminalBridgeToken();
  if (!bridge || !token) return false;
  try {
    const r = await fetch(`${bridgeToHttpBase(bridge)}/hue/creds`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    invalidateHueHealthCache();
    return r.ok;
  } catch { return false; }
}
