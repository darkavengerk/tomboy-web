import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
  getDefaultTerminalBridge: vi.fn(),
  getTerminalBridgeToken: vi.fn(),
  bridgeToHttpBase: (b: string) => `https://${b.replace(/^https?:\/\//, '')}`
}));
vi.mock('$lib/storage/hueSettings.js', () => ({
  getHueBridgeIp: vi.fn(),
  getHueAppKey: vi.fn()
}));

import { getDefaultTerminalBridge, getTerminalBridgeToken } from '$lib/editor/terminal/bridgeSettings.js';
import { getHueBridgeIp, getHueAppKey } from '$lib/storage/hueSettings.js';
import {
  hueHealth, hueConfigured, getHueContext, hueClip, hueClearBridgeCreds, invalidateHueHealthCache,
  huePair, hueDiscover
} from '$lib/hue/hueClient.js';

const mBridge = vi.mocked(getDefaultTerminalBridge);
const mToken = vi.mocked(getTerminalBridgeToken);
const mIp = vi.mocked(getHueBridgeIp);
const mAppkey = vi.mocked(getHueAppKey);

beforeEach(() => {
  invalidateHueHealthCache();
  vi.restoreAllMocks();
  mBridge.mockResolvedValue('bridge.example');
  mToken.mockResolvedValue('TOK');
  mIp.mockResolvedValue('');
  mAppkey.mockResolvedValue('');
});

function mockFetch(impl: (url: string, init?: any) => { ok: boolean; json?: () => any }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const r = impl(String(url), init);
    return { ok: r.ok, status: r.ok ? 200 : 500, json: async () => (r.json ? r.json() : {}) } as any;
  }));
}

describe('hueHealth', () => {
  it('브릿지/토큰 없으면 null', async () => {
    mToken.mockResolvedValue(undefined);
    expect(await hueHealth()).toBeNull();
  });
  it('configured 반환 + TTL 캐시(두 번째 호출은 fetch 안 함)', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ configured: true, ip: '1.2.3.4' }) }) as any);
    vi.stubGlobal('fetch', f);
    expect(await hueHealth()).toEqual({ configured: true, ip: '1.2.3.4' });
    expect(await hueHealth()).toEqual({ configured: true, ip: '1.2.3.4' });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('비-OK → null', async () => {
    mockFetch(() => ({ ok: false }));
    expect(await hueHealth()).toBeNull();
  });
});

describe('hueConfigured', () => {
  it('로컬 creds → source local (health 미조회)', async () => {
    mIp.mockResolvedValue('10.0.0.9'); mAppkey.mockResolvedValue('LK');
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await hueConfigured()).toEqual({ ok: true, source: 'local', ip: '10.0.0.9' });
    expect(f).not.toHaveBeenCalled();
  });
  it('로컬 없음 + 브릿지 구성 → source bridge', async () => {
    mockFetch(() => ({ ok: true, json: () => ({ configured: true, ip: '1.2.3.4' }) }));
    expect(await hueConfigured()).toEqual({ ok: true, source: 'bridge', ip: '1.2.3.4' });
  });
  it('아무 것도 없음 → none', async () => {
    mockFetch(() => ({ ok: true, json: () => ({ configured: false }) }));
    expect(await hueConfigured()).toEqual({ ok: false, source: 'none' });
  });
});

describe('getHueContext', () => {
  it('브릿지/토큰 없으면 null', async () => {
    mBridge.mockResolvedValue(undefined);
    expect(await getHueContext()).toBeNull();
  });
  it('로컬 creds → ip/appkey 동봉', async () => {
    mIp.mockResolvedValue('10.0.0.9'); mAppkey.mockResolvedValue('LK');
    const ctx = await getHueContext();
    expect(ctx).toMatchObject({ token: 'TOK', ip: '10.0.0.9', appkey: 'LK' });
  });
  it('로컬 없음 + 브릿지 구성 → creds 생략 컨텍스트', async () => {
    mockFetch(() => ({ ok: true, json: () => ({ configured: true, ip: '1.2.3.4' }) }));
    const ctx = await getHueContext();
    expect(ctx).toMatchObject({ token: 'TOK' });
    expect(ctx?.ip).toBeUndefined();
    expect(ctx?.appkey).toBeUndefined();
  });
  it('로컬 없음 + 브릿지 미구성 → null', async () => {
    mockFetch(() => ({ ok: true, json: () => ({ configured: false }) }));
    expect(await getHueContext()).toBeNull();
  });
});

describe('hueClip omits empty creds', () => {
  it('ip/appkey 없으면 요청 바디에서 생략', async () => {
    let sent: any;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { sent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({}) } as any; }));
    await hueClip('https://b', 'TOK', { method: 'GET', path: 'room' });
    expect(sent).toEqual({ method: 'GET', path: 'room' });
    expect('ip' in sent).toBe(false);
    expect('appkey' in sent).toBe(false);
  });
});

describe('hueClearBridgeCreds', () => {
  it('DELETE 호출 + ok', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ cleared: true }) }) as any);
    vi.stubGlobal('fetch', f);
    expect(await hueClearBridgeCreds()).toBe(true);
    expect(f).toHaveBeenCalledWith(expect.stringContaining('/hue/creds'), expect.objectContaining({ method: 'DELETE' }));
  });
});

describe('hueClient legacy coverage', () => {
  const BASE = 'https://bridge.example';
  const TOKEN = 'tok';

  it('hueClip posts to /hue/clip with bearer + body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await hueClip(BASE, TOKEN, { ip: '1.2.3.4', appkey: 'K', method: 'GET', path: 'light/abc' });
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/hue/clip`, expect.objectContaining({ method: 'POST' }));
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toMatchObject({ ip: '1.2.3.4', appkey: 'K', method: 'GET', path: 'light/abc' });
    expect(out.status).toBe(200);
    expect(out.data).toEqual({ data: [{ id: 'x' }] });
  });

  it('huePair maps 409 to link_button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'link_button' }), { status: 409 })));
    expect(await huePair(BASE, TOKEN, '1.2.3.4')).toEqual({ error: 'link_button' });
  });

  it('hueDiscover returns bridges', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ bridges: [{ ip: '1.2.3.4', id: 'b' }] }), { status: 200 })));
    expect(await hueDiscover(BASE, TOKEN)).toEqual([{ ip: '1.2.3.4', id: 'b' }]);
  });

  it('hueHealth 실패(null)는 캐시 안 함 — 다음 호출 재시도', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as any);
    vi.stubGlobal('fetch', f);
    expect(await hueHealth()).toBeNull();
    expect(await hueHealth()).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
  });
});
