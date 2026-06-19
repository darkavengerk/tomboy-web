import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleHuePair, handleHueClip, type HueRequestFn } from './hue.js';
import { mintToken } from './auth.js';

const SECRET = 'test-secret';
const AUTH = `Bearer ${mintToken(SECRET)}`;

function mockReqRes(body: unknown, authorization = AUTH) {
  const req: any = { headers: { authorization }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); } };
  const res: any = { statusCode: 0, headers: {}, chunks: '', writeHead(s: number, h: any) { this.statusCode = s; Object.assign(this.headers, h); return this; }, end(c?: string) { if (c) this.chunks += c; } };
  return { req, res };
}

test('pair maps link-button error 101 to 409', async () => {
  const hueRequest: HueRequestFn = async () => ({ status: 200, body: JSON.stringify([{ error: { type: 101, description: 'link button not pressed' } }]) });
  const { req, res } = mockReqRes({ ip: '192.168.0.2' });
  await handleHuePair(req, res, SECRET, hueRequest);
  assert.equal(res.statusCode, 409);
  assert.match(res.chunks, /link_button/);
});

test('pair success returns appkey + clientkey', async () => {
  const hueRequest: HueRequestFn = async () => ({ status: 200, body: JSON.stringify([{ success: { username: 'APPKEY', clientkey: 'CK' } }]) });
  const { req, res } = mockReqRes({ ip: '192.168.0.2' });
  await handleHuePair(req, res, SECRET, hueRequest);
  assert.equal(res.statusCode, 200);
  const out = JSON.parse(res.chunks);
  assert.equal(out.appkey, 'APPKEY');
  assert.equal(out.clientkey, 'CK');
});

test('clip rejects non-whitelisted path', async () => {
  const hueRequest: HueRequestFn = async () => ({ status: 200, body: '{}' });
  const { req, res } = mockReqRes({ ip: '1.2.3.4', appkey: 'K', method: 'GET', path: 'config' });
  await handleHueClip(req, res, SECRET, hueRequest);
  assert.equal(res.statusCode, 400);
});

test('clip pipes status + body for whitelisted path', async () => {
  const hueRequest: HueRequestFn = async (opts) => { assert.match(opts.path, /clip\/v2\/resource\/light\//); return { status: 207, body: '{"data":[]}' }; };
  const { req, res } = mockReqRes({ ip: '1.2.3.4', appkey: 'K', method: 'GET', path: 'light/abc' });
  await handleHueClip(req, res, SECRET, hueRequest);
  assert.equal(res.statusCode, 207);
  assert.equal(res.chunks, '{"data":[]}');
});

test('unauthorized without token', async () => {
  const { req, res } = mockReqRes({ ip: '1.2.3.4', appkey: 'K', method: 'GET', path: 'light/abc' }, '');
  await handleHueClip(req, res, SECRET, async () => ({ status: 200, body: '{}' }));
  assert.equal(res.statusCode, 401);
});
