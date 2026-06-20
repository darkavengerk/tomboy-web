# Hue 브릿지-보관 크레덴셜 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 브릿지가 Hue 크레덴셜(ip/appkey/clientkey)을 쓰기 가능 JSON 파일에 단일 소스로 보관하여, 기기당 Hue 페어링 설정을 없앤다.

**Architecture:** 브릿지에 파일-기반 creds 스토어(`hueCreds.ts`)를 추가하고, `/hue/pair` 가 페어링 성공 시 파일에 저장, `/hue/clip` 이 `파일 ?? 클라이언트` 순서로 creds 를 해석(파일 우선). 신규 `GET /hue/health`(구성 여부 조회) + `DELETE /hue/creds`(해제). 앱은 로컬 creds 가 없으면 health 로 브릿지 구성 여부를 확인해 creds 없이 호출.

**Tech Stack:** Node + ws 브릿지(ESM, `node --test` + tsx), SvelteKit + Svelte 5 runes 앱(vitest), CLIP v2 릴레이.

**Spec:** `docs/superpowers/specs/2026-06-20-hue-bridge-held-creds-design.md`

**권위 규칙(전 작업 공통):** 브릿지 파일이 존재하면 항상 그것이 이긴다. 클라가 보낸 ip/appkey 는 파일이 없을 때만 폴백.

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `bridge/src/hueCreds.ts` (신규) | `BRIDGE_HUE_FILE` JSON read/write/clear + `HueCredsStore` 인터페이스 + `fileHueCredsStore` | 1 |
| `bridge/src/hueCreds.test.ts` (신규) | hueCreds 단위 테스트(temp file) | 1 |
| `bridge/src/hue.ts` (수정) | pair persist, clip 폴백, `handleHueHealth`, `handleHueCredsDelete` | 2 |
| `bridge/src/hue.test.ts` (신규) | 핸들러 테스트(주입 store + hueRequest) | 2 |
| `bridge/src/server.ts` (수정) | `/hue/health`, `/hue/creds` 라우트 배선 | 2 |
| `app/src/lib/hue/hueClient.ts` (수정) | `hueHealth`(TTL 캐시), `hueConfigured`, `getHueContext` 재작성, `hueClip` 옵셔널 creds, `huePair` persisted, `hueClearBridgeCreds`, `invalidateHueHealthCache` | 3 |
| `app/tests/unit/hue/hueClient.test.ts` (신규) | hueClient 분기 테스트(fetch mock) | 3 |
| `app/src/routes/settings/+page.svelte` (수정) | 페어링 persisted 메시지, 구성 소스 상태줄, 브릿지 해제 버튼 | 4 |
| `.claude/skills/tomboy-hue/SKILL.md`, `CLAUDE.md`, 가이드 카드, `bridge/deploy` README | 문서 | 5 |

---

### Task 1: 브릿지 `hueCreds.ts` — 파일-기반 creds 스토어

**Goal:** `BRIDGE_HUE_FILE` 경로의 JSON 에서 Hue creds 를 원자적으로 read/write/clear 하는 순수 모듈을 TDD 로 만든다.

**Files:**
- Create: `bridge/src/hueCreds.ts`
- Test: `bridge/src/hueCreds.test.ts`

**Acceptance Criteria:**
- [ ] `BRIDGE_HUE_FILE` 미설정 → `readHueCreds()` null, `writeHueCreds()` throw, `clearHueCreds()` no-op
- [ ] write→read 라운드트립 정상; 저장 파일 perms `0600`
- [ ] 원자적 쓰기(temp 파일 경유 rename)
- [ ] 손상 JSON / 필드 누락(ip 또는 appkey 빈값) → null
- [ ] `clearHueCreds()` 후 read null; 파일 없을 때 clear 예외 없음
- [ ] `fileHueCredsStore` 가 세 함수를 노출

**Verify:** `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/bridge && node --import tsx --test src/hueCreds.test.ts` → 모든 테스트 pass

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `bridge/src/hueCreds.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { readHueCreds, writeHueCreds, clearHueCreds, fileHueCredsStore } from './hueCreds.js';

// 각 테스트는 고유 임시 경로를 BRIDGE_HUE_FILE 로 지정한다. hueCreds 는 호출마다
// process.env 를 다시 읽으므로(캐시 없음) 테스트 간 간섭이 없다.
function withFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'huecreds-'));
  return join(dir, name);
}
function setEnv(p: string | undefined) {
  if (p === undefined) delete process.env.BRIDGE_HUE_FILE;
  else process.env.BRIDGE_HUE_FILE = p;
}

test('env 미설정: read null / write throw / clear no-op', () => {
  setEnv(undefined);
  assert.equal(readHueCreds(), null);
  assert.throws(() => writeHueCreds({ ip: '1.2.3.4', appkey: 'A', clientkey: 'C' }));
  assert.doesNotThrow(() => clearHueCreds());
});

test('write→read 라운드트립 + perms 0600', () => {
  const p = withFile('hue.json'); setEnv(p);
  writeHueCreds({ ip: '192.168.0.50', appkey: 'APPKEY', clientkey: 'CK' });
  assert.deepEqual(readHueCreds(), { ip: '192.168.0.50', appkey: 'APPKEY', clientkey: 'CK' });
  assert.equal(statSync(p).mode & 0o777, 0o600);
});

test('손상 JSON → null', () => {
  const p = withFile('bad.json'); setEnv(p);
  writeFileSync(p, '{ not json');
  assert.equal(readHueCreds(), null);
});

test('필드 누락(appkey 빈값) → null', () => {
  const p = withFile('partial.json'); setEnv(p);
  writeFileSync(p, JSON.stringify({ ip: '1.2.3.4', appkey: '', clientkey: '' }), { mode: 0o600 });
  assert.equal(readHueCreds(), null);
});

test('clear 후 read null; 없는 파일 clear 예외 없음', () => {
  const p = withFile('hue.json'); setEnv(p);
  writeHueCreds({ ip: '1.2.3.4', appkey: 'A', clientkey: '' });
  clearHueCreds();
  assert.equal(existsSync(p), false);
  assert.equal(readHueCreds(), null);
  assert.doesNotThrow(() => clearHueCreds());
});

test('fileHueCredsStore 위임', () => {
  const p = withFile('hue.json'); setEnv(p);
  fileHueCredsStore.write({ ip: '10.0.0.1', appkey: 'K', clientkey: '' });
  assert.equal(fileHueCredsStore.read()?.ip, '10.0.0.1');
  fileHueCredsStore.clear();
  assert.equal(fileHueCredsStore.read(), null);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/bridge && node --import tsx --test src/hueCreds.test.ts`
Expected: FAIL — `Cannot find module './hueCreds.js'`

- [ ] **Step 3: 구현** — `bridge/src/hueCreds.ts`

```ts
import { readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';

export interface HueCreds { ip: string; appkey: string; clientkey: string; }

/** BRIDGE_HUE_FILE 경로(빈값/미설정이면 undefined). 호출마다 재평가 — 캐시 없음. */
function credsPath(): string | undefined {
  const p = process.env.BRIDGE_HUE_FILE;
  return p && p.trim() ? p : undefined;
}

/** 파일/env 없음·파싱 실패·ip/appkey 누락 → null. clientkey 빈값은 허용(엔터테인먼트 미사용). */
export function readHueCreds(): HueCreds | null {
  const p = credsPath();
  if (!p) return null;
  let raw: string;
  try { raw = readFileSync(p, 'utf8'); } catch { return null; } // ENOENT 포함
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v.ip !== 'string' || typeof v.appkey !== 'string' || typeof v.clientkey !== 'string') return null;
  if (!v.ip || !v.appkey) return null;
  return { ip: v.ip, appkey: v.appkey, clientkey: v.clientkey };
}

/** 원자적 쓰기(같은 디렉터리 temp → rename), perms 0600. env 미설정/쓰기 실패 시 throw. */
export function writeHueCreds(c: HueCreds): void {
  const p = credsPath();
  if (!p) throw new Error('BRIDGE_HUE_FILE not configured');
  const tmp = `${p}.${process.pid}.tmp`;
  const data = JSON.stringify({ ip: c.ip, appkey: c.appkey, clientkey: c.clientkey });
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, p);
  try { chmodSync(p, 0o600); } catch { /* best effort */ }
}

/** 파일 삭제. env 미설정/파일 없음 → no-op. */
export function clearHueCreds(): void {
  const p = credsPath();
  if (!p) return;
  try { unlinkSync(p); } catch { /* ENOENT ok */ }
}

export interface HueCredsStore {
  read(): HueCreds | null;
  write(c: HueCreds): void; // throws on failure
  clear(): void;
}

/** 실제 파일 백엔드. 핸들러 기본 store; 테스트는 인메모리 fake 를 주입. */
export const fileHueCredsStore: HueCredsStore = {
  read: readHueCreds,
  write: writeHueCreds,
  clear: clearHueCreds
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/bridge && node --import tsx --test src/hueCreds.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po && git add bridge/src/hueCreds.ts bridge/src/hueCreds.test.ts && git commit -m "feat(bridge): hueCreds 파일 스토어(BRIDGE_HUE_FILE, 원자적 0600)"
```

---

### Task 2: 브릿지 `hue.ts` — pair persist + clip 폴백 + health + creds delete

**Goal:** 페어링이 creds 를 파일에 저장하고, clip 이 파일을 우선 사용하며, `GET /hue/health` · `DELETE /hue/creds` 를 추가하고 라우트를 배선한다.

**Files:**
- Modify: `bridge/src/hue.ts`
- Modify: `bridge/src/server.ts:218-231` (hue 라우트 블록)
- Test: `bridge/src/hue.test.ts` (신규)

**Acceptance Criteria:**
- [ ] `handleHuePair` 성공 시 `store.write()` 호출 + 응답 `{appkey, clientkey, persisted:true}`; write throw 시 `persisted:false` + `persistError`; 링크버튼(409) 시 미저장
- [ ] `handleHueClip` 이 `store.read() ?? body` 순서로 ip/appkey 해석(파일 우선); 파일 있으면 body 의 ip/appkey 생략 허용; 둘 다 없으면 400 `bad_request`
- [ ] `handleHueHealth` → 구성됨 `{configured:true, ip}` (응답에 appkey/clientkey **부재**), 미구성 `{configured:false}`
- [ ] `handleHueCredsDelete` → `store.clear()` 후 `{cleared:true}`
- [ ] 모든 신규/수정 핸들러 `verifyToken` 게이트 — 미인증 401
- [ ] `server.ts` 에 `GET /hue/health`, `DELETE /hue/creds` 라우트 배선
- [ ] `node --test` 전체 그린, `tsc -p . --noEmit` 0 errors

**Verify:** `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/bridge && node --import tsx --test src/hue.test.ts && npx tsc -p . --noEmit` → pass + 0 errors

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `bridge/src/hue.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mintToken } from './auth.js';
import {
  handleHuePair, handleHueClip, handleHueHealth, handleHueCredsDelete,
  type HueRequestFn, type HueRequestResult
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/bridge && node --import tsx --test src/hue.test.ts`
Expected: FAIL — `handleHueHealth`/`handleHueCredsDelete` export 없음 + pair/clip 시그니처 store 인자 없음

- [ ] **Step 3: `hue.ts` 수정**

상단 import 추가:
```ts
import { fileHueCredsStore, type HueCredsStore } from './hueCreds.js';
```

`handleHuePair` 시그니처에 store 추가 + 성공 분기 교체:
```ts
export async function handleHuePair(
  req: IncomingMessage, res: ServerResponse, secret: string,
  hueRequest: HueRequestFn = realHueRequest, store: HueCredsStore = fileHueCredsStore
): Promise<void> {
  // ... (앞부분 동일: 토큰/ip 검증, hueRequest('api', POST))
  if (first?.error?.type === 101) { res.writeHead(409, json()).end(JSON.stringify({ error: 'link_button' })); return; }
  if (first?.success?.username) {
    const appkey = String(first.success.username);
    const clientkey = String(first.success.clientkey ?? '');
    let persisted = false; let persistError: string | undefined;
    try { store.write({ ip, appkey, clientkey }); persisted = true; }
    catch (e) { persistError = e instanceof Error ? e.message : 'write_failed'; }
    const out: Record<string, unknown> = { appkey, clientkey, persisted };
    if (persistError) out.persistError = persistError;
    res.writeHead(200, json()).end(JSON.stringify(out));
    return;
  }
  res.writeHead(502, json()).end(JSON.stringify({ error: 'pair_failed' }));
}
```

`handleHueClip` 시그니처에 store 추가 + creds 해석 교체:
```ts
export async function handleHueClip(
  req: IncomingMessage, res: ServerResponse, secret: string,
  hueRequest: HueRequestFn = realHueRequest, store: HueCredsStore = fileHueCredsStore
): Promise<void> {
  if (!verifyToken(secret, extractBearer(req.headers.authorization))) return unauthorized(res);
  let body: Record<string, unknown>;
  try { body = await readJson(req); } catch { res.writeHead(400, json()).end(JSON.stringify({ error: 'bad_json' })); return; }
  const file = store.read();
  const ip = file?.ip ?? (typeof body.ip === 'string' ? body.ip.trim() : '');
  const appkey = file?.appkey ?? (typeof body.appkey === 'string' ? body.appkey : '');
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
```

파일 끝에 신규 핸들러 2개 추가:
```ts
/** GET /hue/health → 브릿지가 creds 를 보관 중인지. appkey/clientkey 절대 미반환. */
export async function handleHueHealth(
  req: IncomingMessage, res: ServerResponse, secret: string, store: HueCredsStore = fileHueCredsStore
): Promise<void> {
  if (!verifyToken(secret, extractBearer(req.headers.authorization))) return unauthorized(res);
  const c = store.read();
  const out = c ? { configured: true, ip: c.ip } : { configured: false };
  res.writeHead(200, json()).end(JSON.stringify(out));
}

/** DELETE /hue/creds → 브릿지 보관 creds 삭제(해제). */
export async function handleHueCredsDelete(
  req: IncomingMessage, res: ServerResponse, secret: string, store: HueCredsStore = fileHueCredsStore
): Promise<void> {
  if (!verifyToken(secret, extractBearer(req.headers.authorization))) return unauthorized(res);
  store.clear();
  res.writeHead(200, json()).end(JSON.stringify({ cleared: true }));
}
```

- [ ] **Step 4: `server.ts` 라우트 배선** — `bridge/src/server.ts`

import 줄(`handleHueDiscover, handleHuePair, handleHueClip` 가 있는 곳)에 추가:
```ts
import { handleHueDiscover, handleHuePair, handleHueClip, handleHueHealth, handleHueCredsDelete } from './hue.js';
```
(현재 import 경로에 맞춰 같은 구문에 두 핸들러만 더한다.)

`/hue/clip` 라우트(228-231) 바로 뒤에 추가:
```ts
	if (url === '/hue/health' && req.method === 'GET') {
		await handleHueHealth(req, res, SECRET);
		return;
	}

	if (url === '/hue/creds' && req.method === 'DELETE') {
		await handleHueCredsDelete(req, res, SECRET);
		return;
	}
```
(CORS `applyCors` 는 이미 `GET, POST, DELETE, OPTIONS` 를 허용하므로 변경 불필요.)

- [ ] **Step 5: 테스트 + 타입체크 통과 확인**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/bridge && node --import tsx --test src/hue.test.ts && npx tsc -p . --noEmit`
Expected: hue.test.ts PASS (11 tests), tsc 0 errors

- [ ] **Step 6: 브릿지 전체 테스트 회귀 확인**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/bridge && npm test`
Expected: 전체 그린

- [ ] **Step 7: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po && git add bridge/src/hue.ts bridge/src/hue.test.ts bridge/src/server.ts && git commit -m "feat(bridge): Hue creds 파일 우선 — pair persist + clip 폴백 + /hue/health + DELETE /hue/creds"
```

---

### Task 3: 앱 `hueClient.ts` — health/configured/context 재작성 + 옵셔널 creds

**Goal:** 앱이 로컬 creds 없이도 브릿지 보관 creds 로 동작하도록 `hueHealth`(TTL 캐시)·`hueConfigured`·`getHueContext` 를 재작성하고, `hueClip` 의 ip/appkey 를 옵셔널로, `huePair` 에 `persisted` 를, `hueClearBridgeCreds` 를 추가한다.

**Files:**
- Modify: `app/src/lib/hue/hueClient.ts`
- Test: `app/tests/unit/hue/hueClient.test.ts` (신규)

**Acceptance Criteria:**
- [ ] `hueHealth()` — 브릿지/토큰 없으면 null; 200 `{configured,ip}` 반환; 비-OK/네트워크오류 null; 동일 키 15초 TTL 캐시
- [ ] `invalidateHueHealthCache()` 로 캐시 무효화
- [ ] `hueConfigured()` — 로컬 creds 있으면 `{ok:true,source:'local',ip}`; 없고 health.configured 면 `{ok:true,source:'bridge',ip}`; 그 외 `{ok:false,source:'none'}`
- [ ] `getHueContext()` — 브릿지/토큰 없으면 null; 로컬 creds 있으면 ip/appkey 동봉; 없고 브릿지 구성됨이면 creds 생략 컨텍스트; 둘 다 없으면 null
- [ ] `hueClip()` — `ClipReq.ip/appkey` 옵셔널; 빈값/undefined 면 요청 바디에서 생략
- [ ] `huePair()` 반환에 `persisted`(+옵션 `persistError`) 포함
- [ ] `hueClearBridgeCreds()` — `DELETE /hue/creds` 호출 후 캐시 무효화, ok 불리언
- [ ] `npm run check` 0 errors; hueClient.test.ts pass

**Verify:** `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npx vitest run tests/unit/hue/hueClient.test.ts && npm run check` → pass + 0 errors

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/hue/hueClient.test.ts`

```ts
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
  hueHealth, hueConfigured, getHueContext, hueClip, hueClearBridgeCreds, invalidateHueHealthCache
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
    return { ok: r.ok, json: async () => (r.json ? r.json() : {}) } as any;
  }));
}

describe('hueHealth', () => {
  it('브릿지/토큰 없으면 null', async () => {
    mToken.mockResolvedValue(undefined);
    expect(await hueHealth()).toBeNull();
  });
  it('configured 반환 + TTL 캐시(두 번째 호출은 fetch 안 함)', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ configured: true, ip: '1.2.3.4' }) }) as any);
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
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({}) } as any; }));
    await hueClip('https://b', 'TOK', { method: 'GET', path: 'room' });
    expect(sent).toEqual({ method: 'GET', path: 'room' });
    expect('ip' in sent).toBe(false);
    expect('appkey' in sent).toBe(false);
  });
});

describe('hueClearBridgeCreds', () => {
  it('DELETE 호출 + ok', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ cleared: true }) }) as any);
    vi.stubGlobal('fetch', f);
    expect(await hueClearBridgeCreds()).toBe(true);
    expect(f).toHaveBeenCalledWith(expect.stringContaining('/hue/creds'), expect.objectContaining({ method: 'DELETE' }));
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npx vitest run tests/unit/hue/hueClient.test.ts`
Expected: FAIL — `hueHealth`/`hueConfigured`/`invalidateHueHealthCache`/`hueClearBridgeCreds` export 없음 + hueClip 시그니처 불일치

- [ ] **Step 3: `hueClient.ts` 수정**

`ClipReq`/`HueContext` 인터페이스 교체 + `hueClip`/`huePair` 수정 + 신규 함수 추가. 전체 교체본:
```ts
import { bridgeToHttpBase, getDefaultTerminalBridge, getTerminalBridgeToken } from '$lib/editor/terminal/bridgeSettings.js';
import { getHueBridgeIp, getHueAppKey } from '$lib/storage/hueSettings.js';

export interface ClipReq { method: string; path: string; ip?: string; appkey?: string; body?: unknown; }
export interface ClipResult { status: number; data: unknown; }

export class HueError extends Error {
  constructor(public kind: 'no_bridge' | 'unreachable' | 'http', public status = 0) { super(kind); this.name = 'HueError'; }
}

export async function hueClip(httpBase: string, token: string, req: ClipReq): Promise<ClipResult> {
  const payload: Record<string, unknown> = { method: req.method, path: req.path };
  if (req.ip) payload.ip = req.ip;
  if (req.appkey) payload.appkey = req.appkey;
  if (req.body !== undefined) payload.body = req.body;
  let resp: Response;
  try {
    resp = await fetch(`${httpBase}/hue/clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
  } catch { throw new HueError('unreachable'); }
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

export async function huePair(
  httpBase: string, token: string, ip: string
): Promise<{ appkey: string; clientkey: string; persisted: boolean; persistError?: string } | { error: 'link_button' | 'failed' }> {
  let resp: Response;
  try {
    resp = await fetch(`${httpBase}/hue/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ip }) });
  } catch { return { error: 'failed' }; }
  if (resp.status === 409) return { error: 'link_button' };
  if (!resp.ok) return { error: 'failed' };
  const j = (await resp.json()) as { appkey?: string; clientkey?: string; persisted?: boolean; persistError?: string };
  return { appkey: j.appkey ?? '', clientkey: j.clientkey ?? '', persisted: !!j.persisted, persistError: j.persistError };
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

// ── health 캐시 + 컨텍스트 ───────────────────────────────────
export interface HueHealth { configured: boolean; ip?: string; }

let healthCache: { at: number; key: string; val: HueHealth | null } | null = null;
const HEALTH_TTL_MS = 15_000;

/** 페어링/해제 직후 호출해 다음 hueHealth 가 신선한 값을 읽게 한다. */
export function invalidateHueHealthCache(): void { healthCache = null; }

/** 브릿지 보관 creds 구성 여부. 브릿지/토큰 없거나 불통 → null. 15초 TTL 캐시. */
export async function hueHealth(): Promise<HueHealth | null> {
  const bridge = await getDefaultTerminalBridge();
  const token = await getTerminalBridgeToken();
  if (!bridge || !token) return null;
  const key = `${bridge} ${token}`;
  const now = Date.now();
  if (healthCache && healthCache.key === key && now - healthCache.at < HEALTH_TTL_MS) return healthCache.val;
  let val: HueHealth | null = null;
  try {
    const r = await fetch(`${bridgeToHttpBase(bridge)}/hue/health`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) {
      const d = (await r.json().catch(() => null)) as { configured?: boolean; ip?: string } | null;
      if (d && typeof d.configured === 'boolean') val = { configured: d.configured, ip: d.ip };
    }
  } catch { val = null; }
  healthCache = { at: now, key, val };
  return val;
}

export type HueSource = 'bridge' | 'local' | 'none';

/** UI 표시용 구성 상태 + 소스. */
export async function hueConfigured(): Promise<{ ok: boolean; source: HueSource; ip?: string }> {
  const ip = await getHueBridgeIp();
  const appkey = await getHueAppKey();
  if (ip && appkey) return { ok: true, source: 'local', ip };
  const h = await hueHealth();
  if (h?.configured) return { ok: true, source: 'bridge', ip: h.ip };
  return { ok: false, source: 'none' };
}

export interface HueContext { httpBase: string; token: string; ip?: string; appkey?: string; }

/** CLIP 호출용 컨텍스트. 로컬 creds 우선 동봉, 없으면 브릿지 구성 확인 후 creds 생략. 사용 불가면 null. */
export async function getHueContext(): Promise<HueContext | null> {
  const bridge = await getDefaultTerminalBridge();
  const token = await getTerminalBridgeToken();
  if (!bridge || !token) return null;
  const httpBase = bridgeToHttpBase(bridge);
  const ip = await getHueBridgeIp();
  const appkey = await getHueAppKey();
  if (ip && appkey) return { httpBase, token, ip, appkey };
  const h = await hueHealth();
  if (h?.configured) return { httpBase, token };
  return null;
}

/** 컨텍스트 바운드 CLIP 호출. 컨텍스트 없으면 HueError('no_bridge'). */
export async function hueCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const ctx = await getHueContext();
  if (!ctx) throw new HueError('no_bridge');
  const { status, data } = await hueClip(ctx.httpBase, ctx.token, { ip: ctx.ip, appkey: ctx.appkey, method, path, body });
  if (status >= 400) throw new HueError('http', status);
  return data;
}

/** 브릿지 보관 creds 삭제(모든 기기 영향). */
export async function hueClearBridgeCreds(): Promise<boolean> {
  const bridge = await getDefaultTerminalBridge();
  const token = await getTerminalBridgeToken();
  if (!bridge || !token) return false;
  try {
    const r = await fetch(`${bridgeToHttpBase(bridge)}/hue/creds`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    invalidateHueHealthCache();
    return r.ok;
  } catch { return false; }
}
```

- [ ] **Step 4: 테스트 통과 + 타입체크**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npx vitest run tests/unit/hue/hueClient.test.ts && npm run check`
Expected: PASS + 0 errors. (참고: `getHueContext` 의 반환 `ip/appkey` 가 옵셔널이 됐지만 `hueCall` 이 그대로 전달하므로 호출부 RoomControl/MasterDashboard/BulbControl 무변경.)

- [ ] **Step 5: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po && git add app/src/lib/hue/hueClient.ts app/tests/unit/hue/hueClient.test.ts && git commit -m "feat(hue): 앱 — 브릿지 보관 creds 지원(health TTL 캐시 + 옵셔널 creds + 해제)"
```

---

### Task 4: 설정 Hue 섹션 — persisted 메시지 + 구성 소스 상태 + 브릿지 해제

**Goal:** 설정 Hue 탭에서 페어링이 브릿지에 저장됨을 표시하고(실패 시 폴백 안내), 구성 소스(브릿지/로컬)를 보여주며, 브릿지 보관 creds 를 해제하는 버튼을 추가한다.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (Hue 스크립트 160-213 + 마크업 1433-1480)

**Acceptance Criteria:**
- [ ] `connectHue` 성공 시 로컬 저장 + `invalidateHueHealthCache()` + 메시지: `persisted` 면 "브릿지에 저장됨 — 모든 기기 사용 가능", 아니면 "이 기기에만 저장됨(브릿지 저장 실패: <persistError>)"
- [ ] 상태줄이 `hueConfigured()` 소스 표시 — 브릿지 구성 시 "브릿지에 구성됨 — <ip>" + "브릿지에서 해제" 버튼, 로컬 시 "이 기기에 저장됨 — <ip>" + 기존 로컬 해제
- [ ] "브릿지에서 해제" → 확인 후 `hueClearBridgeCreds()` + 로컬도 정리 + 상태 새로고침
- [ ] `npm run check` 0 errors

**Verify:** `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npm run check` → 0 errors (+ `npm run dev` 로 설정 Hue 탭 수동 확인)

**Steps:**

- [ ] **Step 1: import + 상태 추가** (스크립트 73-79 import 블록, 160-164 상태)

import 교체:
```ts
  import { hueDiscover, huePair, hueConfigured, hueClearBridgeCreds, invalidateHueHealthCache, type HueSource } from '$lib/hue/hueClient.js';
```
상태 추가(`hueMsg` 아래):
```ts
  let hueSource = $state<HueSource>('none');
  let hueStatusIp = $state('');
```

- [ ] **Step 2: `loadHueState` 교체** (166-169)

```ts
  async function loadHueState(): Promise<void> {
    hueIp = await getHueBridgeIp();
    const conf = await hueConfigured();
    hueSource = conf.source;
    hueStatusIp = conf.ip ?? hueIp;
    hueConnected = conf.ok;
  }
```

- [ ] **Step 3: `connectHue` 성공 분기 교체** (199-206)

```ts
    const r = await huePair(ctx.base, ctx.token, hueIp.trim());
    if ('error' in r) {
      hueMsg = r.error === 'link_button' ? '허브 링크 버튼을 누르고 다시 [연결]' : 'Hue 연결 실패';
      return;
    }
    // 로컬에도 저장(폴백) + 브릿지 캐시 무효화
    await setHueCredentials(hueIp.trim(), r.appkey, r.clientkey);
    invalidateHueHealthCache();
    hueMsg = r.persisted
      ? '브릿지에 저장됨 — 모든 기기에서 사용 가능'
      : `이 기기에만 저장됨(브릿지 저장 실패: ${r.persistError ?? '알 수 없음'})`;
    await loadHueState();
```

- [ ] **Step 4: 해제 함수 추가/교체** (209-213)

```ts
  async function disconnectHue(): Promise<void> {
    await clearHueCredentials();
    invalidateHueHealthCache();
    hueMsg = '이 기기 로컬 연결 해제됨';
    await loadHueState();
  }

  async function disconnectHueBridge(): Promise<void> {
    if (!confirm('브릿지에서 Hue 연결을 해제하면 모든 기기에서 조명 제어가 중단됩니다. 계속할까요?')) return;
    const ok = await hueClearBridgeCreds();
    await clearHueCredentials();
    hueMsg = ok ? '브릿지에서 해제됨' : '브릿지 해제 실패 — 토큰/연결 확인';
    await loadHueState();
  }
```

- [ ] **Step 5: 마크업 상태 블록 교체** (1441-1443)

```svelte
				{#if hueConnected}
					{#if hueSource === 'bridge'}
						<p class="info-text small">상태: <code>브릿지에 구성됨</code> — {hueStatusIp}</p>
						<button class="btn btn-secondary" onclick={disconnectHueBridge}>브릿지에서 해제</button>
					{:else}
						<p class="info-text small">상태: <code>이 기기에 저장됨</code> — {hueStatusIp}</p>
						<button class="btn btn-secondary" onclick={disconnectHue}>이 기기 연결 해제</button>
					{/if}
```
(닫는 `{:else}`…페어링 폼…`{/if}` 구조는 유지.)

안내 문구(1435-1438) 한 줄 보강:
```svelte
					<p class="info-text">
						Philips Hue 허브를 위 브릿지를 통해 연결합니다. 한 기기에서 한 번만 연결하면
						브릿지가 키를 보관하여 같은 브릿지 URL·토큰을 쓰는 모든 기기에서 별도 설정 없이
						<code>조명::</code> 노트로 조명을 제어할 수 있습니다.
					</p>
```

- [ ] **Step 6: 타입체크 + 수동 확인**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npm run check`
Expected: 0 errors. 수동: `npm run dev` → 설정 → Hue 탭에서 상태줄·버튼 렌더 확인.

- [ ] **Step 7: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po && git add app/src/routes/settings/+page.svelte && git commit -m "feat(settings): Hue — 브릿지 저장 페어링 + 구성 소스 표시 + 브릿지 해제"
```

---

### Task 5: 문서 — SKILL.md, CLAUDE.md, 가이드 카드, 배포 README

**Goal:** 브릿지-보관 크레덴셜 불변식과 1회 페어링=모든 기기 흐름을 스킬/CLAUDE/사용자 가이드/배포 문서에 반영한다.

**Files:**
- Modify: `.claude/skills/tomboy-hue/SKILL.md`
- Modify: `CLAUDE.md` (tomboy-hue 행 + 크로스커팅 토큰 패턴)
- Modify: `app/src/routes/settings/+page.svelte` (가이드 `env` 서브탭에 조명 브릿지-페어링 카드)
- Modify: `bridge/deploy/README.md` (또는 bridge 배포 문서) — `BRIDGE_HUE_FILE`

**Acceptance Criteria:**
- [ ] SKILL.md 에 "브릿지 보관 creds(BRIDGE_HUE_FILE), 파일 우선, /hue/health, DELETE /hue/creds, 1회 페어링" 불변식 추가
- [ ] CLAUDE.md tomboy-hue 행에 hueCreds.ts/BRIDGE_HUE_FILE 반영; 크로스커팅 env 패턴 목록에 `BRIDGE_HUE_FILE` 한 줄
- [ ] 설정 가이드 `env` 서브탭에 `<details class="guide-card">` 조명 카드(1회 페어링=모든 기기, 브릿지 해제)
- [ ] bridge 배포 README 에 `BRIDGE_HUE_FILE` env + 권장 경로/볼륨 1줄
- [ ] `npm run check` 0 errors

**Verify:** `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npm run check` → 0 errors (+ 가이드 카드 수동 확인)

**Steps:**

- [ ] **Step 1: SKILL.md 불변식 추가** — `.claude/skills/tomboy-hue/SKILL.md` 핵심 불변식 절에 추가:

```markdown
- **브릿지가 creds 를 보관한다(단일 소스).** `bridge/src/hueCreds.ts` 가 `BRIDGE_HUE_FILE` JSON(`{ip,appkey,clientkey}`, 0600)을 read/write/clear. `/hue/pair` 성공 시 파일에 persist(`persisted` 플래그 반환), `/hue/clip` 은 `파일 ?? 클라` 순서로 creds 해석(**파일 우선**). 기기당 Hue 설정 0 — 한 기기에서 1회 페어링하면 같은 브릿지 토큰을 쓰는 모든 기기가 자동 동작.
- **`GET /hue/health`** `{configured, ip}` (appkey/clientkey 미반환) — 앱 `hueClient.hueHealth`(15초 TTL 캐시)가 호출해 로컬 creds 없는 기기의 구성 여부 판단. **`DELETE /hue/creds`** 로 브릿지 보관 creds 해제. 둘 다 `verifyToken` 게이트.
- 앱 `getHueContext`: 로컬 creds 있으면 동봉, 없으면 health 로 브릿지 구성 확인 후 creds 생략 호출. 사용 불가면 null(위젯 렌더 게이트).
```
(구식 "Hue 크레덴셜은 appSettings" 서술이 있으면 "로컬은 폴백, 브릿지 파일이 단일 소스" 로 보정.)

- [ ] **Step 2: CLAUDE.md 갱신**

tomboy-hue 행 paths 에 `bridge/src/hueCreds.ts` 추가 + 설명에 "브릿지 보관 creds(BRIDGE_HUE_FILE, 파일 우선) — 기기당 설정 0" 삽입.

"Cross-cutting infra invariants" 의 env-≡ 패턴 목록에 한 줄 추가:
```markdown
- **`BRIDGE_HUE_FILE` (Pi bridge env)** 가 가리키는 JSON 이 Hue `{ip,appkey,clientkey}` 단일 소스. `/hue/clip` 은 파일 우선(클라 creds 는 폴백). 설정 안 하면 기존처럼 클라가 매 요청 creds 동봉.
```

- [ ] **Step 3: 가이드 카드 추가** — `settings/+page.svelte` 가이드 `env` 서브탭(`guideSubTab === 'env'` 블록)에 기존 카드 패턴대로:

```svelte
				<details class="guide-card">
					<summary>Hue 조명 — 한 번만 연결하면 모든 기기에서</summary>
					<p class="info-text">
						브릿지가 Hue 키를 보관하므로, 어느 기기든 <strong>한 번</strong> 설정 → Hue 에서
						허브를 연결하면 같은 브릿지를 쓰는 다른 기기는 별도 설정 없이
						<code>조명::</code> 노트로 조명을 제어합니다.
					</p>
					<ul class="guide-list">
						<li>연결: 설정 → Hue → 브릿지 찾기/IP 입력 → 허브 링크버튼 → [연결].</li>
						<li>"브릿지에 저장됨" 이 뜨면 모든 기기 공유. "이 기기에만 저장됨" 이면 브릿지 저장이 실패한 것(메시지의 사유 확인).</li>
						<li>해제: "브릿지에서 해제" 는 모든 기기에 영향. "이 기기 연결 해제" 는 로컬만.</li>
						<li>오류 toast 에 HTTP 상태가 함께 표시됩니다(어디서 막혔는지 진단용).</li>
					</ul>
				</details>
```

- [ ] **Step 4: 배포 문서** — `bridge/deploy/README.md`(없으면 `bridge/README.md`)에 추가:

```markdown
### Hue creds 보관 (선택)

`BRIDGE_HUE_FILE` 환경변수에 쓰기 가능한 JSON 경로를 지정하면, 앱에서 1회 페어링한
Hue 키(`{ip, appkey, clientkey}`)를 브릿지가 보관한다(0600). 이후 같은 브릿지 토큰을
쓰는 모든 기기가 별도 Hue 설정 없이 조명을 제어한다. 미설정 시 각 기기가 매 요청에
creds 를 동봉하는 기존 동작 유지.

- 권장 경로: 컨테이너 영속 볼륨 내부, 예 `BRIDGE_HUE_FILE=/data/hue.json`.
- rootless Podman/Quadlet: 해당 경로가 포함된 볼륨이 마운트되어 있는지 확인.
```

- [ ] **Step 5: 타입체크 + 수동 확인**

Run: `cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po/app && npm run check`
Expected: 0 errors. 수동: 설정 → 가이드 → 환경 탭에서 조명 카드 확인.

- [ ] **Step 6: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/po && git add .claude/skills/tomboy-hue/SKILL.md CLAUDE.md app/src/routes/settings/+page.svelte bridge/deploy/README.md bridge/README.md 2>/dev/null; git commit -m "docs(hue): 브릿지 보관 creds — SKILL/CLAUDE/가이드/배포 README"
```

---

## Self-Review

**Spec coverage:**
- 브릿지 파일 스토어 → Task 1 ✅
- pair persist + clip 폴백 + health + creds delete → Task 2 ✅
- 앱 health/configured/context/clip/clear → Task 3 ✅
- 설정 UI(persisted/소스/해제) → Task 4 ✅
- 보안(verifyToken 게이트, 비밀 미노출, 0600) → Task 1/2 AC + 테스트 ✅
- 오류 처리(persisted:false, 400, health null 폴백) → Task 2/3 테스트 ✅
- 문서(SKILL/CLAUDE/가이드/배포) → Task 5 ✅

**Placeholder scan:** 없음 — 모든 코드 블록 완전.

**Type consistency:** `HueCreds`/`HueCredsStore`(Task1) → hue.ts 핸들러(Task2) 일치. `ClipReq`(ip/appkey 옵셔널, Task3) ↔ `hueClip` payload 생략 로직 일치. `HueSource`(Task3) → 설정 import(Task4) 일치. `huePair` 반환 `persisted/persistError`(Task3) ↔ connectHue 소비(Task4) 일치. `invalidateHueHealthCache`/`hueClearBridgeCreds`/`hueConfigured` export(Task3) ↔ Task4 import 일치.

**권위 규칙 일관성:** clip = `file ?? client`(Task2), 앱은 로컬 동봉하되 서버가 파일 우선(Task3 주석) — 일관.
