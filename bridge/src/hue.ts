import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import { extractBearer, verifyToken } from './auth.js';

export interface HueRequestResult { status: number; body: string; }
export interface HueRequestOpts { ip: string; path: string; method: string; appkey?: string; body?: unknown; }
export type HueRequestFn = (opts: HueRequestOpts) => Promise<HueRequestResult>;

const ALLOWED_RESOURCES = new Set(['light', 'zone', 'room', 'grouped_light', 'scene', 'device']);
const ALLOWED_METHODS = new Set(['GET', 'PUT', 'POST', 'DELETE']);
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/** 실제 Hue 호출 — 자체서명 인증서 통과. 테스트는 이 함수를 주입 교체한다. */
export const realHueRequest: HueRequestFn = (opts) =>
  new Promise<HueRequestResult>((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.appkey) headers['hue-application-key'] = opts.appkey;
    if (payload) headers['Content-Length'] = String(Buffer.byteLength(payload));
    const r = https.request(
      { host: opts.ip, path: '/' + opts.path.replace(/^\//, ''), method: opts.method, headers, agent: insecureAgent, timeout: 10_000 },
      (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => resolve({ status: resp.statusCode ?? 502, body: b })); }
    );
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (payload) r.write(payload);
    r.end();
  });

function unauthorized(res: ServerResponse): void { res.writeHead(401, json()).end(JSON.stringify({ error: 'unauthorized' })); }
function json() { return { 'Content-Type': 'application/json' }; }

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const c of req) { const b = c as Buffer; total += b.length; if (total > 64 * 1024) throw new Error('too large'); chunks.push(b); }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/** GET /hue/discover → 클라우드 발견(보조). 실패해도 빈 목록 → 수동 IP 입력 경로 유지. */
export async function handleHueDiscover(req: IncomingMessage, res: ServerResponse, secret: string): Promise<void> {
  if (!verifyToken(secret, extractBearer(req.headers.authorization))) return unauthorized(res);
  try {
    const r = await fetch('https://discovery.meethue.com/', { signal: AbortSignal.timeout(5000) });
    const arr = (await r.json()) as Array<{ internalipaddress?: string; id?: string }>;
    const bridges = arr.filter((b) => b.internalipaddress).map((b) => ({ ip: b.internalipaddress!, id: b.id ?? '' }));
    res.writeHead(200, json()).end(JSON.stringify({ bridges }));
  } catch {
    res.writeHead(200, json()).end(JSON.stringify({ bridges: [] }));
  }
}

/** POST /hue/pair {ip} → 링크버튼 키 발급. */
export async function handleHuePair(req: IncomingMessage, res: ServerResponse, secret: string, hueRequest: HueRequestFn = realHueRequest): Promise<void> {
  if (!verifyToken(secret, extractBearer(req.headers.authorization))) return unauthorized(res);
  let body: Record<string, unknown>;
  try { body = await readJson(req); } catch { res.writeHead(400, json()).end(JSON.stringify({ error: 'bad_json' })); return; }
  const ip = typeof body.ip === 'string' ? body.ip.trim() : '';
  if (!ip) { res.writeHead(400, json()).end(JSON.stringify({ error: 'missing_ip' })); return; }
  let result: HueRequestResult;
  try {
    result = await hueRequest({ ip, path: 'api', method: 'POST', body: { devicetype: 'tomboy-web#app', generateclientkey: true } });
  } catch { res.writeHead(503, json()).end(JSON.stringify({ error: 'bridge_unreachable' })); return; }
  let parsed: any;
  try { parsed = JSON.parse(result.body); } catch { res.writeHead(502, json()).end(JSON.stringify({ error: 'bad_upstream' })); return; }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first?.error?.type === 101) { res.writeHead(409, json()).end(JSON.stringify({ error: 'link_button' })); return; }
  if (first?.success?.username) { res.writeHead(200, json()).end(JSON.stringify({ appkey: first.success.username, clientkey: first.success.clientkey ?? '' })); return; }
  res.writeHead(502, json()).end(JSON.stringify({ error: 'pair_failed' }));
}

/** POST /hue/clip {ip, appkey, method, path, body} → CLIP v2 릴레이. */
export async function handleHueClip(req: IncomingMessage, res: ServerResponse, secret: string, hueRequest: HueRequestFn = realHueRequest): Promise<void> {
  if (!verifyToken(secret, extractBearer(req.headers.authorization))) return unauthorized(res);
  let body: Record<string, unknown>;
  try { body = await readJson(req); } catch { res.writeHead(400, json()).end(JSON.stringify({ error: 'bad_json' })); return; }
  const ip = typeof body.ip === 'string' ? body.ip.trim() : '';
  const appkey = typeof body.appkey === 'string' ? body.appkey : '';
  const method = typeof body.method === 'string' ? body.method.toUpperCase() : 'GET';
  const path = typeof body.path === 'string' ? body.path.replace(/^\/+/, '') : '';
  if (!ip || !appkey || !path) { res.writeHead(400, json()).end(JSON.stringify({ error: 'bad_request' })); return; }
  if (!ALLOWED_METHODS.has(method)) { res.writeHead(400, json()).end(JSON.stringify({ error: 'bad_method' })); return; }
  const segments = path.split('/');
  if (!ALLOWED_RESOURCES.has(segments[0]) || segments.some((s) => s === '.' || s === '..' || s === '')) {
    res.writeHead(400, json()).end(JSON.stringify({ error: 'forbidden_path' })); return;
  }
  let result: HueRequestResult;
  try {
    result = await hueRequest({ ip, appkey, method, path: `clip/v2/resource/${path}`, body: 'body' in body ? body.body : undefined });
  } catch { res.writeHead(503, json()).end(JSON.stringify({ error: 'bridge_unreachable' })); return; }
  res.writeHead(result.status, json()).end(result.body);
}
