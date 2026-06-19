import { bridgeToHttpBase, getDefaultTerminalBridge, getTerminalBridgeToken } from '$lib/editor/terminal/bridgeSettings.js';
import { getHueBridgeIp, getHueAppKey } from '$lib/storage/hueSettings.js';

export interface ClipReq { ip: string; appkey: string; method: string; path: string; body?: unknown; }
export interface ClipResult { status: number; data: unknown; }

export class HueError extends Error {
  constructor(public kind: 'no_bridge' | 'unreachable' | 'http', public status = 0) { super(kind); this.name = 'HueError'; }
}

export async function hueClip(httpBase: string, token: string, req: ClipReq): Promise<ClipResult> {
  let resp: Response;
  try {
    resp = await fetch(`${httpBase}/hue/clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(req)
    });
  } catch { throw new HueError('unreachable'); }
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

export async function huePair(httpBase: string, token: string, ip: string): Promise<{ appkey: string; clientkey: string } | { error: 'link_button' | 'failed' }> {
  let resp: Response;
  try {
    resp = await fetch(`${httpBase}/hue/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ip }) });
  } catch { return { error: 'failed' }; }
  if (resp.status === 409) return { error: 'link_button' };
  if (!resp.ok) return { error: 'failed' };
  return (await resp.json()) as { appkey: string; clientkey: string };
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

// ── 설정 컨텍스트 바운드 편의층 ───────────────────────────────
export interface HueContext { httpBase: string; token: string; ip: string; appkey: string; }

/** 전역 브릿지(URL+토큰) + Hue 크레덴셜을 합쳐 컨텍스트 반환. 미설정이면 null. */
export async function getHueContext(): Promise<HueContext | null> {
  const bridge = await getDefaultTerminalBridge();
  const token = await getTerminalBridgeToken();
  const ip = await getHueBridgeIp();
  const appkey = await getHueAppKey();
  if (!bridge || !token || !ip || !appkey) return null;
  return { httpBase: bridgeToHttpBase(bridge), token, ip, appkey };
}

/** 컨텍스트 바운드 CLIP 호출. 컨텍스트 없으면 HueError('no_bridge'). */
export async function hueCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const ctx = await getHueContext();
  if (!ctx) throw new HueError('no_bridge');
  const { status, data } = await hueClip(ctx.httpBase, ctx.token, { ip: ctx.ip, appkey: ctx.appkey, method, path, body });
  if (status >= 400) throw new HueError('http', status);
  return data;
}
