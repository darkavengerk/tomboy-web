import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hueClip, huePair, hueDiscover } from '$lib/hue/hueClient.js';

const BASE = 'https://bridge.example';
const TOKEN = 'tok';

beforeEach(() => { vi.restoreAllMocks(); });

describe('hueClient', () => {
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
});
