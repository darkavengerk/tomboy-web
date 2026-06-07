import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { handleRemarkableUpload, expandHome } from './remarkableUpload.js';
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

// epoch 1780740000000 = 2026-06-06T10:00:00.000Z
const DUMP = [
  '===uuid-A.metadata===',
  JSON.stringify({ type: 'CollectionType', visibleName: 'Diary', parent: '' }),
  '===uuid-B.metadata===',
  JSON.stringify({
    type: 'DocumentType',
    visibleName: 'p1',
    parent: 'uuid-A',
    lastModified: '1780740000000'
  })
].join('\n');

test('401 without Bearer', async () => {
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({}, { notebook: 'Diary' }),
    res,
    {
      secret: SECRET,
      ssh: { host: 'h', user: 'u', keyPath: 'k' },
      inboxDir: '/tmp/inbox',
      defaultNotebook: 'Diary',
      automationServiceUrl: 'http://auto.test',
      fetchDump: async () => DUMP,
      rsync: async () => {}
    }
  );
  assert.equal(get().status, 401);
});

test('SSE 200 + status/done events on happy path', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'inbox-'));
  let automationCalled = false;
  globalThis.fetch = (async () => {
    automationCalled = true;
    return new Response(JSON.stringify({ results: {}, errors: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  const { res, get } = mockRes();
  const rsyncCalls: string[] = [];
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { notebook: 'Diary' }),
    res,
    {
      secret: SECRET,
      ssh: { host: 'h', user: 'u', keyPath: 'k' },
      inboxDir,
      defaultNotebook: 'Diary',
      automationServiceUrl: 'http://auto.test',
      fetchDump: async () => DUMP,
      rsync: async (uuid) => {
        rsyncCalls.push(uuid);
      }
    }
  );
  const { status, headers, body } = get();
  assert.equal(status, 200);
  const ct = headers['Content-Type'] ?? headers['content-type'];
  assert.match(ct, /text\/event-stream/);
  assert.match(body, /event: status\ndata: \{"step":"ssh_connect"\}/);
  assert.match(body, /event: status\ndata: \{"step":"list_pages"/);
  assert.match(body, /event: done\ndata: \{"notebook":"Diary"/);
  assert.match(body, /"uuid":"uuid-B"/);
  assert.match(body, /"date":"2026-06-06"/);
  assert.deepEqual(rsyncCalls, ['uuid-B']);
  assert.equal(automationCalled, true);
});

test('error event on notebook_not_found', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'inbox-'));
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { notebook: 'Missing' }),
    res,
    {
      secret: SECRET,
      ssh: { host: 'h', user: 'u', keyPath: 'k' },
      inboxDir,
      defaultNotebook: 'Diary',
      automationServiceUrl: 'http://auto.test',
      fetchDump: async () => DUMP,
      rsync: async () => {}
    }
  );
  assert.match(get().body, /event: error\ndata: \{"kind":"notebook_not_found"/);
});

test('uses defaultNotebook when body omits notebook', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'inbox-'));
  globalThis.fetch = (async () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, {}),
    res,
    {
      secret: SECRET,
      ssh: { host: 'h', user: 'u', keyPath: 'k' },
      inboxDir,
      defaultNotebook: 'Diary',
      automationServiceUrl: 'http://auto.test',
      fetchDump: async () => DUMP,
      rsync: async () => {}
    }
  );
  assert.match(get().body, /"notebook":"Diary"/);
});

test('automation failure emits automation_unreachable but keeps inbox', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'inbox-'));
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { notebook: 'Diary' }),
    res,
    {
      secret: SECRET,
      ssh: { host: 'h', user: 'u', keyPath: 'k' },
      inboxDir,
      defaultNotebook: 'Diary',
      automationServiceUrl: 'http://auto.test',
      fetchDump: async () => DUMP,
      rsync: async () => {}
    }
  );
  const { body } = get();
  assert.match(body, /event: error\ndata: \{"kind":"automation_unreachable"/);
  // inbox index should still have the new uuid
  const idx = JSON.parse(
    readFileSync(`${inboxDir}/state/index.json`, 'utf8')
  );
  assert.ok(idx['uuid-B']);
});

test('flushHeaders is called after writeHead 200', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'inbox-'));
  globalThis.fetch = (async () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { notebook: 'Diary' }),
    res,
    {
      secret: SECRET,
      ssh: { host: 'h', user: 'u', keyPath: 'k' },
      inboxDir,
      defaultNotebook: 'Diary',
      automationServiceUrl: 'http://auto.test',
      fetchDump: async () => DUMP,
      rsync: async () => {}
    }
  );
  assert.equal(get().flushed, true);
});

test('expandHome expands ~ in inboxDir', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'inbox-'));
  globalThis.fetch = (async () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const { res } = mockRes();
  const stateFiles: string[] = [];
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { notebook: 'Diary' }),
    res,
    {
      secret: SECRET,
      ssh: { host: 'h', user: 'u', keyPath: 'k' },
      // use an absolute path that we can verify via expandHome directly
      inboxDir,
      defaultNotebook: 'Diary',
      automationServiceUrl: 'http://auto.test',
      fetchDump: async () => DUMP,
      rsync: async (uuid) => { stateFiles.push(uuid); }
    }
  );
  // Verify expandHome itself works correctly for tilde paths
  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('~/foo/bar'), join(homedir(), 'foo/bar'));
  // Verify state was written under the real inboxDir (not a literal ~/... path)
  const idx = JSON.parse(readFileSync(`${inboxDir}/state/index.json`, 'utf8'));
  assert.ok(idx['uuid-B']);
});
