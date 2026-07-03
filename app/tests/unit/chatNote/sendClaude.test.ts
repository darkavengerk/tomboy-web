import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendClaude, ClaudeChatError } from '$lib/chatNote/backends/claude.js';

// Helper: build a Response with a streaming SSE body.
function sseResponse(lines: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('sendClaude', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('accumulates text deltas via onToken and resolves with done', async () => {
    fetchSpy.mockResolvedValue(
      sseResponse([
        'data: {"delta":"hello"}',
        'data: {"delta":" world"}',
        'data: {"done":true,"reason":"success"}',
      ])
    );
    const tokens: string[] = [];
    const r = await sendClaude({
      url: 'https://bridge/claude/chat',
      token: 'tok',
      body: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      onToken: (d) => tokens.push(d),
    });
    expect(tokens.join('')).toBe('hello world');
    expect(r.reason).toBe('done');
  });

  it('throws ClaudeChatError(unauthorized) on 401', async () => {
    fetchSpy.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    await expect(
      sendClaude({ url: 'x', token: 'y', body: { messages: [] }, onToken: () => {} })
    ).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('throws ClaudeChatError(service_unavailable) on 503', async () => {
    fetchSpy.mockResolvedValue(new Response('{"error":"claude_service_not_configured"}', { status: 503 }));
    await expect(
      sendClaude({ url: 'x', token: 'y', body: { messages: [] }, onToken: () => {} })
    ).rejects.toMatchObject({ kind: 'service_unavailable' });
  });

  it('throws ClaudeChatError(rate_limited) on 429', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(
      sendClaude({ url: 'x', token: 'y', body: { messages: [] }, onToken: () => {} })
    ).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('throws ClaudeChatError(payload_too_large) on 413', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 413 }));
    await expect(
      sendClaude({ url: 'x', token: 'y', body: { messages: [] }, onToken: () => {} })
    ).rejects.toMatchObject({ kind: 'payload_too_large' });
  });

  it('throws ClaudeChatError(stream_error) when stream ends without done', async () => {
    fetchSpy.mockResolvedValue(
      sseResponse([
        'data: {"delta":"partial"}',
      ])
    );
    await expect(
      sendClaude({ url: 'x', token: 'y', body: { messages: [] }, onToken: () => {} })
    ).rejects.toMatchObject({ kind: 'stream_error' });
  });

  it('throws ClaudeChatError(cli_failed) on error event with detail', async () => {
    fetchSpy.mockResolvedValue(
      sseResponse([
        'data: {"delta":"some output"}',
        'data: {"error":"claude exit 1: command not found"}',
      ])
    );
    const err = await sendClaude({
      url: 'x', token: 'y', body: { messages: [] }, onToken: () => {}
    }).catch(e => e);
    expect(err).toBeInstanceOf(ClaudeChatError);
    expect(err.kind).toBe('cli_failed');
    expect(err.detail).toContain('command not found');
  });

  it('propagates AbortSignal to fetch and resolves with abort reason', async () => {
    const ctrl = new AbortController();
    fetchSpy.mockImplementation((_url: RequestInfo, init?: RequestInit) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    setTimeout(() => ctrl.abort(), 10);
    const r = await sendClaude({
      url: 'x', token: 'y', body: { messages: [] }, onToken: () => {}, signal: ctrl.signal,
    });
    expect(r.reason).toBe('abort');
  });

  it('sends Bearer header and JSON body', async () => {
    fetchSpy.mockResolvedValue(sseResponse(['data: {"done":true,"reason":"success"}']));
    await sendClaude({
      url: 'https://example/claude/chat',
      token: 'mytoken',
      body: {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        model: 'opus',
        effort: 'normal',
      },
      onToken: () => {},
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe('https://example/claude/chat');
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string,string>).Authorization).toBe('Bearer mytoken');
    expect(JSON.parse(init.body as string)).toMatchObject({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      model: 'opus',
      effort: 'normal',
    });
  });
});

describe('sendClaude — image_fetch_failed 분류', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it('502 body error=image_fetch_failed → kind image_fetch_failed + detail 보존', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'image_fetch_failed',
          detail: 'image fetch failed (https://x.public.blob.vercel-storage.com/temp-images/a.png): image too large: 21165980 bytes > 8388608',
        }),
        { status: 502 }
      )
    );
    const err = await sendClaude({
      url: 'x', token: 'y', body: { messages: [] }, onToken: () => {},
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeChatError);
    expect(err.kind).toBe('image_fetch_failed');
    expect(err.detail).toContain('too large: 21165980');
  });

  it('502 body가 image_fetch_failed 아니면 여전히 upstream_error', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'something_else' }), { status: 502 })
    );
    await expect(
      sendClaude({ url: 'x', token: 'y', body: { messages: [] }, onToken: () => {} })
    ).rejects.toMatchObject({ kind: 'upstream_error' });
  });

  it('502 body가 JSON 아니어도 upstream_error로 폴백', async () => {
    fetchSpy.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(
      sendClaude({ url: 'x', token: 'y', body: { messages: [] }, onToken: () => {} })
    ).rejects.toMatchObject({ kind: 'upstream_error' });
  });
});

describe('sendClaude — step events', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it('forwards {step} frames to onStep', async () => {
    fetchSpy.mockResolvedValue(
      sseResponse([
        'data: {"step":{"kind":"thinking","label":"생각 중","body":""}}',
        'data: {"step":{"kind":"thinking","label":"생각 중","body":"먼저"}}',
        'data: {"delta":"answer"}',
        'data: {"done":true,"reason":"success"}',
      ])
    );
    const steps: any[] = [];
    const tokens: string[] = [];
    const r = await sendClaude({
      url: 'https://bridge/claude/chat',
      token: 'tok',
      body: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      onToken: (d) => tokens.push(d),
      onStep: (s) => steps.push(s),
    });
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ kind: 'thinking', label: '생각 중', body: '' });
    expect(steps[1]).toEqual({ kind: 'thinking', label: '생각 중', body: '먼저' });
    expect(tokens.join('')).toBe('answer');
    expect(r.reason).toBe('done');
  });

  it('silently ignores {step} when onStep is undefined', async () => {
    fetchSpy.mockResolvedValue(
      sseResponse([
        'data: {"step":{"kind":"thinking","label":"x","body":"y"}}',
        'data: {"delta":"answer"}',
        'data: {"done":true,"reason":"success"}',
      ])
    );
    const tokens: string[] = [];
    const r = await sendClaude({
      url: 'x', token: 'y',
      body: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      onToken: (d) => tokens.push(d),
      // no onStep
    });
    expect(tokens.join('')).toBe('answer');
    expect(r.reason).toBe('done');
  });
});
