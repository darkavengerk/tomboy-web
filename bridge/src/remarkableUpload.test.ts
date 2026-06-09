import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleRemarkableUpload } from './remarkableUpload.js';
import { mintToken } from './auth.js';

const SECRET = 'test-secret';

function mockReq(headers: Record<string, string>, body: object | string): IncomingMessage {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const r = Readable.from([Buffer.from(raw, 'utf8')]) as unknown as IncomingMessage;
  (r as unknown as { headers: Record<string, string> }).headers = headers;
  (r as unknown as { method: string }).method = 'POST';
  return r;
}

function mockRes() {
  const writes: string[] = [];
  let status = 0;
  let flushed = false;
  const headers: Record<string, string> = {};
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s;
      Object.assign(headers, h ?? {});
      return res;
    },
    flushHeaders: () => { flushed = true; },
    write: (b: string) => writes.push(b),
    end: (b?: string) => {
      if (b) writes.push(b);
    }
  } as unknown as ServerResponse;
  return { res, get: () => ({ status, headers, body: writes.join(''), flushed }) };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('401 without Bearer', async () => {
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({}, { notebook: 'Diary' }),
    res,
    { secret: SECRET, automationServiceUrl: 'http://auto.test' }
  );
  assert.equal(get().status, 401);
});

test('503 when automation-service URL is missing', async () => {
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { notebook: 'Diary' }),
    res,
    { secret: SECRET, automationServiceUrl: '' }
  );
  assert.equal(get().status, 503);
});

test('SSE 200 + trigger_pipeline + done on happy path', async () => {
  let automationCalled = false;
  let upstreamBody: string | null = null;
  globalThis.fetch = (async (_url, init) => {
    automationCalled = true;
    upstreamBody = (init as RequestInit | undefined)?.body as string;
    return new Response(JSON.stringify({ results: {}, errors: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { notebook: 'Diary' }),
    res,
    { secret: SECRET, automationServiceUrl: 'http://auto.test' }
  );
  const { status, headers, body, flushed } = get();
  assert.equal(status, 200);
  const ct = headers['Content-Type'] ?? headers['content-type'];
  assert.match(ct, /text\/event-stream/);
  assert.equal(flushed, true);
  assert.match(body, /event: status\ndata: \{"step":"trigger_pipeline"\}/);
  assert.match(body, /event: done\ndata: \{"notebook":"Diary"\}/);
  assert.equal(automationCalled, true);
  // Verifies the bridge issues `pipeline-run` to automation-service.
  assert.ok(upstreamBody);
  assert.match(upstreamBody!, /"command":"pipeline-run"/);
});

test('uses empty notebook when body omits notebook', async () => {
  globalThis.fetch = (async () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, {}),
    res,
    { secret: SECRET, automationServiceUrl: 'http://auto.test' }
  );
  assert.match(get().body, /event: done\ndata: \{"notebook":""\}/);
});

test('automation upstream non-2xx emits automation_unreachable', async () => {
  globalThis.fetch = (async () =>
    new Response('boom', { status: 502 })) as typeof fetch;
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { notebook: 'Diary' }),
    res,
    { secret: SECRET, automationServiceUrl: 'http://auto.test' }
  );
  assert.match(get().body, /event: error\ndata: \{"kind":"automation_unreachable","message":"status 502"\}/);
});

test('automation fetch throw emits automation_unreachable', async () => {
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { notebook: 'Diary' }),
    res,
    { secret: SECRET, automationServiceUrl: 'http://auto.test' }
  );
  assert.match(get().body, /event: error\ndata: \{"kind":"automation_unreachable","message":"ECONNREFUSED"\}/);
});

test('bad JSON body returns 400', async () => {
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, '{not json'),
    res,
    { secret: SECRET, automationServiceUrl: 'http://auto.test' }
  );
  assert.equal(get().status, 400);
});
