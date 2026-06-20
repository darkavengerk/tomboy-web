import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mintToken } from './auth.js';
import {
  handleHuePair, handleHueClip, handleHueHealth, handleHueCredsDelete,
  type HueRequestFn
} from './hue.js';
import type { HueCreds, HueCredsStore } from './hueCreds.js';

const SECRET = 'unit-test-secret';
const TOKEN = mintToken(SECRET);

function makeReq(method: string, token: string | undefined, body?: unknown): any {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const r: any = Readable.from(raw ? [Buffer.from(raw)] : []);
  r.headers = token ? { authorization: `Bearer ${token}` } : {};
  r.method = method;
  return r;
}
function makeRes(): any {
  const res: any = { statusCode: 0, headers: {}, body: '' };
  res.writeHead = (s: number, h?: any) => { res.statusCode = s; if (h) res.headers = h; return res; };
  res.end = (b?: string) => { if (b !== undefined) res.body = b; return res; };
  return res;
}
function fakeStore(initial: HueCreds | null = null, throwOnWrite = false) {
  let cur = initial;
  const store: HueCredsStore = {
    read: () => cur,
    write: (c) => { if (throwOnWrite) throw new Error('disk full'); cur = c; },
    clear: () => { cur = null; }
  };
  return { store, get: () => cur };
}
const okPair: HueRequestFn = async () => ({ status: 200, body: JSON.stringify([{ success: { username: 'APPKEY', clientkey: 'CK' } }]) });
const linkBtn: HueRequestFn = async () => ({ status: 200, body: JSON.stringify([{ error: { type: 101 } }]) });

test('pair 성공 → store 저장 + persisted:true', async () => {
  const f = fakeStore();
  const res = makeRes();
  await handleHuePair(makeReq('POST', TOKEN, { ip: '192.168.0.50' }), res, SECRET, okPair, f.store);
  assert.equal(res.statusCode, 200);
  const b = JSON.parse(res.body);
  assert.equal(b.appkey, 'APPKEY'); assert.equal(b.persisted, true);
  assert.deepEqual(f.get(), { ip: '192.168.0.50', appkey: 'APPKEY', clientkey: 'CK' });
});

test('pair write 실패 → persisted:false + persistError, 페어링은 200', async () => {
  const f = fakeStore(null, true);
  const res = makeRes();
  await handleHuePair(makeReq('POST', TOKEN, { ip: '192.168.0.50' }), res, SECRET, okPair, f.store);
  assert.equal(res.statusCode, 200);
  const b = JSON.parse(res.body);
  assert.equal(b.appkey, 'APPKEY'); assert.equal(b.persisted, false);
  assert.match(b.persistError, /disk full/);
});

test('pair 링크버튼 → 409, 미저장', async () => {
  const f = fakeStore();
  const res = makeRes();
  await handleHuePair(makeReq('POST', TOKEN, { ip: '192.168.0.50' }), res, SECRET, linkBtn, f.store);
  assert.equal(res.statusCode, 409);
  assert.equal(f.get(), null);
});

test('clip: 파일 우선(body 무시) — store ip/appkey 가 hueRequest 로 전달', async () => {
  const f = fakeStore({ ip: 'FILE_IP', appkey: 'FILE_KEY', clientkey: '' });
  let seen: any;
  const relay: HueRequestFn = async (o) => { seen = o; return { status: 200, body: '{"data":[]}' }; };
  const res = makeRes();
  await handleHueClip(makeReq('POST', TOKEN, { ip: 'CLIENT_IP', appkey: 'CLIENT_KEY', method: 'GET', path: 'room' }), res, SECRET, relay, f.store);
  assert.equal(res.statusCode, 200);
  assert.equal(seen.ip, 'FILE_IP'); assert.equal(seen.appkey, 'FILE_KEY');
});

test('clip: 파일 없음 + body creds → body 사용', async () => {
  const f = fakeStore(null);
  let seen: any;
  const relay: HueRequestFn = async (o) => { seen = o; return { status: 200, body: '{}' }; };
  const res = makeRes();
  await handleHueClip(makeReq('POST', TOKEN, { ip: 'CLIENT_IP', appkey: 'CLIENT_KEY', method: 'GET', path: 'light' }), res, SECRET, relay, f.store);
  assert.equal(seen.ip, 'CLIENT_IP'); assert.equal(seen.appkey, 'CLIENT_KEY');
});

test('clip: 파일 있으면 body creds 생략해도 통과', async () => {
  const f = fakeStore({ ip: 'FILE_IP', appkey: 'FILE_KEY', clientkey: '' });
  const relay: HueRequestFn = async () => ({ status: 200, body: '{}' });
  const res = makeRes();
  await handleHueClip(makeReq('POST', TOKEN, { method: 'GET', path: 'room' }), res, SECRET, relay, f.store);
  assert.equal(res.statusCode, 200);
});

test('clip: creds 어디에도 없음 → 400', async () => {
  const f = fakeStore(null);
  const relay: HueRequestFn = async () => ({ status: 200, body: '{}' });
  const res = makeRes();
  await handleHueClip(makeReq('POST', TOKEN, { method: 'GET', path: 'room' }), res, SECRET, relay, f.store);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'bad_request');
});

test('health: 구성됨 → {configured:true, ip}, 비밀 미노출', async () => {
  const f = fakeStore({ ip: '192.168.0.50', appkey: 'SECRET_KEY', clientkey: 'SECRET_CK' });
  const res = makeRes();
  await handleHueHealth(makeReq('GET', TOKEN), res, SECRET, f.store);
  assert.equal(res.statusCode, 200);
  const b = JSON.parse(res.body);
  assert.deepEqual(b, { configured: true, ip: '192.168.0.50' });
  assert.equal(res.body.includes('SECRET_KEY'), false);
  assert.equal(res.body.includes('SECRET_CK'), false);
});

test('health: 미구성 → {configured:false}', async () => {
  const f = fakeStore(null);
  const res = makeRes();
  await handleHueHealth(makeReq('GET', TOKEN), res, SECRET, f.store);
  assert.deepEqual(JSON.parse(res.body), { configured: false });
});

test('creds delete → clear + {cleared:true}', async () => {
  const f = fakeStore({ ip: 'x', appkey: 'y', clientkey: '' });
  const res = makeRes();
  await handleHueCredsDelete(makeReq('DELETE', TOKEN), res, SECRET, f.store);
  assert.equal(JSON.parse(res.body).cleared, true);
  assert.equal(f.get(), null);
});

test('미인증 401 — health / creds delete', async () => {
  const f = fakeStore(null);
  const r1 = makeRes(); await handleHueHealth(makeReq('GET', undefined), r1, SECRET, f.store);
  assert.equal(r1.statusCode, 401);
  const r2 = makeRes(); await handleHueCredsDelete(makeReq('DELETE', 'bad.token'), r2, SECRET, f.store);
  assert.equal(r2.statusCode, 401);
});

test('clip: 비화이트리스트 리소스 → 400 forbidden_path, 릴레이 미호출', async () => {
  const f = fakeStore({ ip: '1.2.3.4', appkey: 'K', clientkey: '' });
  let called = false;
  const relay: HueRequestFn = async () => { called = true; return { status: 200, body: '{}' }; };
  const res = makeRes();
  await handleHueClip(makeReq('POST', TOKEN, { method: 'GET', path: 'config' }), res, SECRET, relay, f.store);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'forbidden_path');
  assert.equal(called, false);
});

test('clip: dotdot 경로 traversal 거부(화이트리스트 첫 세그먼트라도), 릴레이 미호출', async () => {
  const f = fakeStore({ ip: '1.2.3.4', appkey: 'K', clientkey: '' });
  let called = false;
  const relay: HueRequestFn = async () => { called = true; return { status: 200, body: '{}' }; };
  const res = makeRes();
  await handleHueClip(makeReq('POST', TOKEN, { method: 'GET', path: 'light/../../config' }), res, SECRET, relay, f.store);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'forbidden_path');
  assert.equal(called, false);
});

test('clip: 미허용 메서드 → 400 bad_method', async () => {
  const f = fakeStore({ ip: '1.2.3.4', appkey: 'K', clientkey: '' });
  const relay: HueRequestFn = async () => ({ status: 200, body: '{}' });
  const res = makeRes();
  await handleHueClip(makeReq('POST', TOKEN, { method: 'FAKE', path: 'light' }), res, SECRET, relay, f.store);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'bad_method');
});

test('clip / pair: 미인증 401', async () => {
  const f = fakeStore({ ip: '1.2.3.4', appkey: 'K', clientkey: '' });
  const relay: HueRequestFn = async () => ({ status: 200, body: '{}' });
  const r1 = makeRes();
  await handleHueClip(makeReq('POST', undefined, { method: 'GET', path: 'light' }), r1, SECRET, relay, f.store);
  assert.equal(r1.statusCode, 401);
  const r2 = makeRes();
  await handleHuePair(makeReq('POST', 'bad.token', { ip: '1.2.3.4' }), r2, SECRET, okPair, f.store);
  assert.equal(r2.statusCode, 401);
});
