import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
  getDefaultTerminalBridge: vi.fn(),
  getTerminalBridgeToken: vi.fn(),
  bridgeToHttpBase: (b: string) => `https://${b.replace(/^wss?:\/\//, '')}`
}));

import {
  uploadRemarkable,
  RemarkableUploadError
} from '$lib/remarkable/uploadRemarkable.js';
import {
  getDefaultTerminalBridge,
  getTerminalBridgeToken
} from '$lib/editor/terminal/bridgeSettings.js';

const realFetch = globalThis.fetch;
beforeEach(() => {
  (getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue('wss://host/ws');
  (getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue('tok');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

/** SSE body를 ReadableStream으로 감싸는 헬퍼. */
function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    }
  });
}

it('throws not_configured when bridge or token missing', async () => {
  (getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  await expect(uploadRemarkable({ notebook: 'Diary' })).rejects.toMatchObject({
    kind: 'not_configured'
  });
});

it('throws not_configured when bridge is missing', async () => {
  (getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  await expect(uploadRemarkable({ notebook: 'Diary' })).rejects.toMatchObject({
    kind: 'not_configured'
  });
});

it('parses trigger_pipeline status + done payload', async () => {
  const frames = [
    'event: status\ndata: {"step":"trigger_pipeline"}\n\n',
    'event: done\ndata: {"notebook":"Diary"}\n\n'
  ];
  globalThis.fetch = (async () =>
    new Response(sseBody(frames), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;
  const statuses: unknown[] = [];
  const out = await uploadRemarkable({
    notebook: 'Diary',
    onStatus: (s) => statuses.push(s)
  });
  expect(statuses).toEqual([{ step: 'trigger_pipeline' }]);
  expect(out).toEqual({ notebook: 'Diary' });
});

it('maps 401 to unauthorized', async () => {
  globalThis.fetch = (async () =>
    new Response('{"error":"unauthorized"}', {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch;
  await expect(uploadRemarkable({ notebook: 'Diary' })).rejects.toMatchObject({
    kind: 'unauthorized'
  });
});

it('throws on automation_unreachable error event', async () => {
  const frames = [
    'event: error\ndata: {"kind":"automation_unreachable","message":"ECONNREFUSED"}\n\n'
  ];
  globalThis.fetch = (async () =>
    new Response(sseBody(frames), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;
  await expect(uploadRemarkable({ notebook: 'Diary' })).rejects.toMatchObject({
    kind: 'automation_unreachable',
    detail: 'ECONNREFUSED'
  });
});

it('maps 5xx to upstream_error', async () => {
  globalThis.fetch = (async () =>
    new Response('{"error":"x"}', {
      status: 502,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch;
  await expect(uploadRemarkable({ notebook: 'Diary' })).rejects.toMatchObject({
    kind: 'upstream_error'
  });
});

it('maps network error to network kind', async () => {
  globalThis.fetch = (async () => {
    throw new Error('Failed to connect');
  }) as typeof fetch;
  await expect(uploadRemarkable({ notebook: 'Diary' })).rejects.toMatchObject({
    kind: 'network'
  });
});

it('passes AbortSignal to fetch', async () => {
  const ac = new AbortController();
  let received: AbortSignal | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    received = init?.signal ?? undefined;
    return new Response(sseBody([]), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  }) as typeof fetch;
  await uploadRemarkable({ notebook: 'Diary', signal: ac.signal }).catch(() => {});
  expect(received).toBe(ac.signal);
});

it('omits notebook from body when undefined', async () => {
  let bodyText = '';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodyText = typeof init?.body === 'string' ? init.body : '';
    return new Response(
      sseBody(['event: done\ndata: {"notebook":""}\n\n']),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
  }) as typeof fetch;
  await uploadRemarkable({ notebook: undefined });
  expect(JSON.parse(bodyText)).toEqual({});
});

it('parses status events when frames are CRLF-separated', async () => {
  // Simulate a server that uses \r\n line endings (Node http module default).
  const enc = new TextEncoder();
  const crlfBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode('event: status\r\ndata: {"step":"trigger_pipeline"}\r\n\r\n'));
      controller.enqueue(enc.encode('event: done\r\ndata: {"notebook":"Diary"}\r\n\r\n'));
      controller.close();
    }
  });
  globalThis.fetch = (async () =>
    new Response(crlfBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;
  const statuses: unknown[] = [];
  const out = await uploadRemarkable({ notebook: 'Diary', onStatus: (s) => statuses.push(s) });
  expect(statuses).toEqual([{ step: 'trigger_pipeline' }]);
  expect(out.notebook).toBe('Diary');
});

it('cancels reader and throws on error event without waiting for stream close', async () => {
  const enc = new TextEncoder();
  // After the error frame, pull() never resolves — simulates a server that
  // keeps the connection open after emitting an error event.
  const hangingBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        enc.encode('event: error\ndata: {"kind":"automation_unreachable","message":"timeout"}\n\n')
      );
      // Do NOT close — pull hangs indefinitely.
    }
  });
  globalThis.fetch = (async () =>
    new Response(hangingBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timed out waiting for error throw')), 500)
  );
  await expect(
    Promise.race([uploadRemarkable({ notebook: 'Diary' }), timeout])
  ).rejects.toMatchObject({ kind: 'automation_unreachable', detail: 'timeout' });
});

it('aborts mid-stream and throws network/aborted', async () => {
  const ac = new AbortController();
  const enc = new TextEncoder();
  const pausedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode('event: status\ndata: {"step":"trigger_pipeline"}\n\n'));
      // Further data never arrives — we abort from outside instead.
    }
  });
  globalThis.fetch = (async () =>
    new Response(pausedBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;

  const promise = uploadRemarkable({ notebook: 'Diary', signal: ac.signal });
  // Abort after a tick so the SSE loop has started reading.
  await Promise.resolve();
  ac.abort();
  await expect(promise).rejects.toMatchObject({ kind: 'network', detail: 'aborted' });
});
