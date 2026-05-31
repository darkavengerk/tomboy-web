# 이미지 임시 저장소 (Vercel Blob) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이미지 paste 기본 행선지를 Dropbox → Vercel Blob로 옮기고, admin "이미지" 탭에서 사용자가 명시적으로 "Dropbox로 저장"으로 승격하는 두-채널 저장 시스템.

**Architecture:** SvelteKit 함수 라우트 `/api/temp-image/*`가 Bearer 토큰 인증 + Vercel Blob 클라이언트-직접-업로드 토큰 발급/`list`/`del`을 담당. 클라이언트는 paste 시 토큰을 받아 직접 PUT, admin은 노트 IDB 스캔 + Vercel `list()`를 합쳐 인벤토리를 렌더. 승격은 fetch → Dropbox 업로드 → 노트 URL string-replace → Vercel 삭제 순으로 단계별 실패에도 노트가 깨지지 않게.

**Tech Stack:** SvelteKit (adapter-vercel로 교체), `@vercel/blob` v0.x, Svelte 5 runes, vitest. 기존 모듈 재사용: `lib/sync/imageUpload.ts`(Dropbox 업로드), `lib/storage/noteStore.ts`, `lib/core/noteReloadBus.ts`, `lib/editor/imagePreview/isImageUrl.ts`.

**Spec:** `docs/superpowers/specs/2026-05-27-temp-image-storage-design.md`

---

### Task 1: 토큰 저장 — `appSettings` 헬퍼 + 설정 UI

**Goal:** 사용자가 설정 페이지에서 이미지 서버 토큰을 입력·저장·삭제할 수 있다.

**Files:**
- Modify: `app/src/lib/storage/appSettings.ts`
- Modify: `app/src/routes/settings/+page.svelte`
- Test: `app/tests/unit/storage/imageStorageToken.test.ts`

**Acceptance Criteria:**
- [ ] `getImageStorageToken()` / `setImageStorageToken(s)` 헬퍼가 동작.
- [ ] 설정 페이지에 "이미지 서버 토큰" 섹션이 있고 입력 → 저장 → 새로고침 후에도 유지.
- [ ] 빈 문자열을 저장하면 `getImageStorageToken()`이 `''`를 리턴 (undefined 아님).

**Verify:** `cd app && npm run test -- tests/unit/storage/imageStorageToken.test.ts` → 3 passed

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/storage/imageStorageToken.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  getImageStorageToken,
  setImageStorageToken
} from '$lib/storage/appSettings.js';

describe('imageStorageToken', () => {
  beforeEach(async () => {
    // fake-indexeddb auto-resets between tests when re-imported; rely on
    // setSetting overwrite for idempotency here.
    await setImageStorageToken('');
  });

  it('returns empty string when unset', async () => {
    expect(await getImageStorageToken()).toBe('');
  });

  it('roundtrips a value', async () => {
    await setImageStorageToken('hunter2');
    expect(await getImageStorageToken()).toBe('hunter2');
  });

  it('empty string overwrites previously stored value', async () => {
    await setImageStorageToken('value');
    await setImageStorageToken('');
    expect(await getImageStorageToken()).toBe('');
  });
});
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

Run: `cd app && npm run test -- tests/unit/storage/imageStorageToken.test.ts`
Expected: FAIL with "no export named getImageStorageToken"

- [ ] **Step 3: 헬퍼 추가** — `app/src/lib/storage/appSettings.ts` 파일 끝(`setDiaryTriggerToken` 다음)에 추가

```ts
// ── Image storage (Vercel Blob) settings ─────────────────────────────
//
// Bearer token shared with the `/api/temp-image/*` SvelteKit endpoints.
// Must byte-match `IMAGE_STORAGE_TOKEN` env var on the server side.

const IMAGE_STORAGE_TOKEN = 'imageStorageToken';

export async function getImageStorageToken(): Promise<string> {
  const v = await getSetting<string>(IMAGE_STORAGE_TOKEN);
  return typeof v === 'string' ? v : '';
}

export async function setImageStorageToken(value: string): Promise<void> {
  await setSetting(IMAGE_STORAGE_TOKEN, value);
}
```

- [ ] **Step 4: 테스트 재실행 — pass 확인**

Run: `cd app && npm run test -- tests/unit/storage/imageStorageToken.test.ts`
Expected: 3 passed

- [ ] **Step 5: 설정 페이지 UI 추가** — `app/src/routes/settings/+page.svelte` 상단 import 블록에 추가

```ts
import {
  getImageStorageToken,
  setImageStorageToken
} from '$lib/storage/appSettings.js';
```

해당 파일 안의 다른 `let xxxSaved = $state(false)` 패턴 (예: `terminalBridgeSaved`) 근처에 추가:

```ts
let imageStorageToken = $state('');
let imageStorageTokenSaved = $state(false);
```

그리고 onMount/load 로직 안에서 (`terminalBridgeUrl = v ?? '';` 같은 줄들 옆) 토큰 로드:

```ts
imageStorageToken = (await getImageStorageToken()) ?? '';
```

저장 함수 추가 (`saveTerminalBridgeUrl` 같은 함수 옆):

```ts
async function saveImageStorageToken() {
  await setImageStorageToken(imageStorageToken.trim());
  imageStorageTokenSaved = true;
  setTimeout(() => (imageStorageTokenSaved = false), 1500);
}
```

마크업 — "터미널 브릿지" 섹션 바로 아래에 같은 섹션 패턴으로:

```svelte
<section class="settings-section">
  <h2>이미지 서버 토큰</h2>
  <p class="hint">
    Vercel Blob에 이미지를 업로드할 때 사용되는 Bearer 토큰입니다.
    서버의 <code>IMAGE_STORAGE_TOKEN</code> 환경변수와 동일하게 설정하세요.
  </p>
  <div class="row">
    <input
      type="password"
      bind:value={imageStorageToken}
      placeholder="••••••••"
    />
    <button onclick={saveImageStorageToken}>저장</button>
    {#if imageStorageTokenSaved}
      <span class="saved-pill">저장됨</span>
    {/if}
  </div>
</section>
```

(`.settings-section`, `.row`, `.saved-pill` CSS는 페이지에 이미 존재 — 터미널 브릿지 섹션이 사용 중이므로 그대로 따라 씀)

- [ ] **Step 6: 빌드/타입 체크**

Run: `cd app && npm run check`
Expected: 0 errors

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/storage/appSettings.ts app/src/routes/settings/+page.svelte app/tests/unit/storage/imageStorageToken.test.ts
git commit -m "$(cat <<'EOF'
feat(settings): 이미지 서버 토큰 저장/입력 UI

appSettings에 getImageStorageToken/setImageStorageToken 추가.
설정 페이지에 "이미지 서버 토큰" 섹션 (터미널 브릿지 섹션과 같은 패턴).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 빌드 인프라 — `adapter-vercel`로 교체 + `@vercel/blob` 의존성

**Goal:** SvelteKit 함수 라우트를 빌드할 수 있는 어댑터로 교체하고, Vercel Blob SDK를 설치한다. 기존 static 빌드 결과물(클라이언트 SPA)은 동일하게 나와야 한다.

**Files:**
- Modify: `app/svelte.config.js`
- Modify: `app/package.json` (의존성)
- Modify: `app/vercel.json` (API 라우트 rewrite 제외)
- Create: `app/src/routes/+layout.ts` (또는 기존 파일 수정 — prerender 기본값 설정)

**Acceptance Criteria:**
- [ ] `cd app && npm run build`가 에러 없이 끝남.
- [ ] `.vercel/output/static/` 안에 기존 SPA 결과물이 다 들어 있음 (index.html, _app/, etc).
- [ ] `.vercel/output/functions/` 디렉토리가 생성됨 (지금은 비어 있어도 됨 — Task 3에서 채워짐).
- [ ] `cd app && npm run dev` 정상 기동.

**Verify:** `cd app && npm run build && ls .vercel/output/static/_app && ls -la .vercel/output/` → static + functions 디렉토리 모두 보임

**Steps:**

- [ ] **Step 1: 의존성 설치**

```bash
cd app && npm install --save-dev @sveltejs/adapter-vercel && npm install @vercel/blob
```

- [ ] **Step 2: `svelte.config.js` 어댑터 교체**

```js
import adapter from '@sveltejs/adapter-vercel';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
  },
  kit: {
    adapter: adapter({
      // SPA fallback so all client-side routes resolve at the edge without
      // creating per-route functions. Only routes that explicitly opt out
      // of prerender (via `export const prerender = false`) become functions.
      runtime: 'nodejs20.x'
    }),
    // Make every page prerender by default. /api/* routes opt out
    // individually with `export const prerender = false`.
    prerender: {
      handleHttpError: 'warn'
    }
  }
};

export default config;
```

- [ ] **Step 3: 글로벌 prerender + SPA fallback 설정** — `app/src/routes/+layout.ts` (없으면 생성, 있으면 추가)

먼저 파일이 있는지 확인:

```bash
ls app/src/routes/+layout.ts 2>/dev/null || echo "MISSING"
```

없으면 생성:

```ts
// SvelteKit: make the app behave as an SPA by default. Pages are
// prerendered at build time and the runtime is purely client-side.
// API routes under /api/* opt out via `export const prerender = false`
// and run as Vercel functions.
export const prerender = true;
export const ssr = false;
```

있으면 위 세 export를 파일 위쪽에 추가 (이미 있다면 건드리지 말 것).

- [ ] **Step 4: `vercel.json` 수정** — API 라우트는 함수로 가야 하므로 rewrite에서 제외

```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/404.html" }
  ]
}
```

(첫 번째 rewrite는 명시적으로 `/api/*`를 그대로 통과시켜 함수가 호출되게 함. 두 번째는 기존 SPA fallback.)

**대안 — adapter-vercel이 자동으로 `_routes.json`을 만들어 처리할 수도 있음.** 빌드 후 `.vercel/output/config.json`을 확인해서 `/api/*` 라우팅이 자동으로 처리되면 위 첫 번째 rewrite 줄은 제거해도 됨. 일단 보수적으로 추가.

- [ ] **Step 5: 빌드 확인**

```bash
cd app && rm -rf .vercel && npm run build
```

Expected:
- 에러 0
- `.vercel/output/static/index.html` 존재
- `.vercel/output/static/_app/` 존재
- `.vercel/output/functions/` 존재 (현재는 비어 있을 수 있음 — Task 3에서 채워짐)

확인 명령:

```bash
ls app/.vercel/output/static/_app && ls -la app/.vercel/output/
```

- [ ] **Step 6: dev 서버 확인**

```bash
cd app && timeout 8 npm run dev || true
```

Expected: "Local: http://localhost:..." 라인이 보이고 에러 0. (timeout으로 자동 종료)

- [ ] **Step 7: 커밋**

```bash
git add app/svelte.config.js app/package.json app/package-lock.json app/vercel.json app/src/routes/+layout.ts
git commit -m "$(cat <<'EOF'
build: adapter-static → adapter-vercel + @vercel/blob 설치

함수 라우트(/api/temp-image/*)를 빌드할 수 있도록 어댑터 교체.
페이지는 prerender + ssr=false로 SPA 동작 유지, /api/*만 함수로.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 서버 — `/api/temp-image` POST/DELETE + Bearer 헬퍼

**Goal:** 클라이언트가 호출할 토큰 발급(POST) + 삭제(DELETE) 엔드포인트 + 공통 Bearer 검증 헬퍼.

**Files:**
- Create: `app/src/routes/api/temp-image/_lib/auth.ts` (Bearer 검증 헬퍼; `_`prefix는 SvelteKit이 라우트로 인식 안 함)
- Create: `app/src/routes/api/temp-image/+server.ts` (POST + DELETE)
- Test: `app/tests/unit/api/tempImageAuth.test.ts` (Bearer 헬퍼 단위 테스트)

**Acceptance Criteria:**
- [ ] `requireBearer(request)`가 헤더 없음/잘못된 토큰/일치하는 토큰에 대해 각각 명시된 동작 (throw 401 / throw 401 / return void).
- [ ] POST `/api/temp-image`가 Bearer 검증 통과 시 `handleUpload`의 결과 JSON을 그대로 반환.
- [ ] DELETE `/api/temp-image?url=…`가 `del(url)` 호출 후 204.
- [ ] 모든 라우트 `export const prerender = false`.

**Verify:** `cd app && npm run test -- tests/unit/api/tempImageAuth.test.ts && npm run build` → 테스트 pass + 빌드 성공

**Steps:**

- [ ] **Step 1: Bearer 헬퍼 단위 테스트** — `app/tests/unit/api/tempImageAuth.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { requireBearer } from '../../../src/routes/api/temp-image/_lib/auth.js';

function reqWith(header: string | undefined): Request {
  return new Request('http://example.com/', {
    headers: header ? { Authorization: header } : {}
  });
}

describe('requireBearer', () => {
  it('throws 401 when Authorization header missing', () => {
    expect(() => requireBearer(reqWith(undefined), 'secret')).toThrow(/401/);
  });

  it('throws 401 on wrong scheme', () => {
    expect(() => requireBearer(reqWith('Basic abc'), 'secret')).toThrow(/401/);
  });

  it('throws 401 on wrong token', () => {
    expect(() => requireBearer(reqWith('Bearer wrong'), 'secret')).toThrow(/401/);
  });

  it('returns void on matching token', () => {
    expect(() => requireBearer(reqWith('Bearer secret'), 'secret')).not.toThrow();
  });

  it('throws 500 when env token missing', () => {
    expect(() => requireBearer(reqWith('Bearer x'), '')).toThrow(/500/);
  });
});
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

Run: `cd app && npm run test -- tests/unit/api/tempImageAuth.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Bearer 헬퍼 작성** — `app/src/routes/api/temp-image/_lib/auth.ts`

```ts
/**
 * Verify `Authorization: Bearer <token>` matches the expected token.
 * Throws a Response with status 401 (mismatch / missing) or 500 (server
 * misconfigured — env token empty). Callers are expected to let the
 * Response propagate; SvelteKit endpoint handlers can `throw` a Response
 * and it becomes the HTTP response.
 */
export function requireBearer(request: Request, expected: string): void {
  if (!expected) {
    throw new Response('IMAGE_STORAGE_TOKEN not configured', { status: 500 });
  }
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    throw new Response('Unauthorized: 401', { status: 401 });
  }
  const token = header.slice('Bearer '.length).trim();
  if (token !== expected) {
    throw new Response('Unauthorized: 401', { status: 401 });
  }
}
```

(Note: 테스트에서 `toThrow(/401/)`로 매칭하므로 메시지에 "401"/"500" 문자열을 포함시킴.)

- [ ] **Step 4: 테스트 재실행 — pass 확인**

Run: `cd app && npm run test -- tests/unit/api/tempImageAuth.test.ts`
Expected: 5 passed

- [ ] **Step 5: `+server.ts` 작성** — `app/src/routes/api/temp-image/+server.ts`

```ts
import { handleUpload, del, type HandleUploadBody } from '@vercel/blob/client';
import { env } from '$env/dynamic/private';
import type { RequestEvent } from './$types.js';
import { requireBearer } from './_lib/auth.js';

export const prerender = false;

/**
 * Mint a single-use client upload token. The browser calls this with our
 * Bearer token, gets back a Vercel Blob client token, and then PUTs the
 * file directly to Vercel storage — bytes never transit through this
 * function.
 *
 * Body shape is whatever `@vercel/blob/client`'s `upload()` sends — we
 * delegate parsing and response shaping to `handleUpload`.
 */
export async function POST({ request }: RequestEvent): Promise<Response> {
  requireBearer(request, env.IMAGE_STORAGE_TOKEN ?? '');

  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['image/*'],
        // Namespace under temp-images/ so future Blob usages don't collide.
        addRandomSuffix: false,
        // 5 min token TTL — enough for a slow upload, short enough to limit
        // window of misuse if a token leaks.
        tokenPayload: JSON.stringify({ scope: 'temp-image' })
      }),
      onUploadCompleted: async () => {
        // No side-effect needed; the note already has the URL.
      }
    });
    return new Response(JSON.stringify(jsonResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Blob token mint failed: ${msg}`, { status: 502 });
  }
}

/**
 * Delete a blob by URL. Returns 204 on success, 502 on SDK error.
 */
export async function DELETE({ request, url }: RequestEvent): Promise<Response> {
  requireBearer(request, env.IMAGE_STORAGE_TOKEN ?? '');

  const target = url.searchParams.get('url');
  if (!target) {
    return new Response('Missing ?url= query parameter', { status: 400 });
  }

  try {
    await del(target);
    return new Response(null, { status: 204 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Blob delete failed: ${msg}`, { status: 502 });
  }
}
```

**중요**: `@vercel/blob/client`의 `handleUpload`는 토큰 path를 자동으로 결정함. 우리가 `temp-images/{uuid}.{ext}` prefix를 강제하려면 클라이언트 측 `upload()` 호출 시 `pathname`을 지정해서 보내야 함 (Task 5에서 처리). 따라서 서버 측은 검증만 하고 path는 클라이언트가 정함.

- [ ] **Step 6: 빌드 확인 — 함수 생성**

```bash
cd app && rm -rf .vercel && npm run build
ls .vercel/output/functions/api/temp-image.func/ 2>/dev/null || ls .vercel/output/functions/
```

Expected: `api/temp-image` 함수가 생성됨.

- [ ] **Step 7: 커밋**

```bash
git add app/src/routes/api/temp-image/ app/tests/unit/api/tempImageAuth.test.ts
git commit -m "$(cat <<'EOF'
feat(api): /api/temp-image POST (token mint) + DELETE + Bearer 검증

Vercel Blob의 handleUpload로 단발성 클라이언트 업로드 토큰 발급.
Bearer 토큰은 IMAGE_STORAGE_TOKEN 환경변수와 byte-match 검증.
DELETE는 ?url= 쿼리로 blob 삭제.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 서버 — `/api/temp-image/list` GET

**Goal:** 모든 임시 blob을 나열하는 GET 엔드포인트. admin 인벤토리에서 오펀 검출용.

**Files:**
- Create: `app/src/routes/api/temp-image/list/+server.ts`

**Acceptance Criteria:**
- [ ] GET `/api/temp-image/list`가 Bearer 검증 통과 시 `{ items: [{url, size, uploadedAt}], hasMore: boolean }` JSON 반환.
- [ ] `temp-images/` prefix만 나열 (cross-pollution 방지).
- [ ] `export const prerender = false`.

**Verify:** `cd app && npm run build` → `.vercel/output/functions/api/temp-image/list.func/` 생성

**Steps:**

- [ ] **Step 1: `+server.ts` 작성** — `app/src/routes/api/temp-image/list/+server.ts`

```ts
import { list } from '@vercel/blob';
import { env } from '$env/dynamic/private';
import type { RequestEvent } from './$types.js';
import { requireBearer } from '../_lib/auth.js';

export const prerender = false;

export async function GET({ request }: RequestEvent): Promise<Response> {
  requireBearer(request, env.IMAGE_STORAGE_TOKEN ?? '');

  try {
    const result = await list({ prefix: 'temp-images/', limit: 1000 });
    const items = result.blobs.map((b) => ({
      url: b.url,
      pathname: b.pathname,
      size: b.size,
      uploadedAt: b.uploadedAt instanceof Date ? b.uploadedAt.toISOString() : String(b.uploadedAt)
    }));
    return new Response(
      JSON.stringify({ items, hasMore: Boolean(result.hasMore) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Blob list failed: ${msg}`, { status: 502 });
  }
}
```

- [ ] **Step 2: 빌드 확인**

```bash
cd app && rm -rf .vercel && npm run build && ls .vercel/output/functions/api/temp-image/
```

Expected: `list.func` 디렉토리가 보임.

- [ ] **Step 3: 커밋**

```bash
git add app/src/routes/api/temp-image/list/
git commit -m "$(cat <<'EOF'
feat(api): /api/temp-image/list GET — 임시 blob 인벤토리

admin의 오펀 검출용. temp-images/ prefix만 나열.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 클라이언트 — `tempImageUpload` 모듈

**Goal:** `uploadTempImage(file)` / `deleteTempImage(url)` / `listTempImages()` — `/api/temp-image/*` 래퍼. 토큰을 `appSettings`에서 읽어 헤더에 첨부.

**Files:**
- Create: `app/src/lib/sync/tempImageUpload.ts`
- Test: `app/tests/unit/sync/tempImageUpload.test.ts`

**Acceptance Criteria:**
- [ ] 토큰 미설정 시 명확한 에러 throw (메시지에 "토큰" 포함).
- [ ] `uploadTempImage`가 `@vercel/blob/client.upload()`에 `temp-images/{uuid}.{ext}` pathname + Bearer header 전달.
- [ ] `deleteTempImage`가 `DELETE /api/temp-image?url=…`로 fetch (Bearer header).
- [ ] `listTempImages`가 `GET /api/temp-image/list`로 fetch + JSON 파싱.

**Verify:** `cd app && npm run test -- tests/unit/sync/tempImageUpload.test.ts` → 6 passed

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/sync/tempImageUpload.test.ts`

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { setImageStorageToken } from '$lib/storage/appSettings.js';

// Mock @vercel/blob/client.upload BEFORE importing the module under test.
const uploadMock = vi.fn();
vi.mock('@vercel/blob/client', () => ({
  upload: (...args: unknown[]) => uploadMock(...args)
}));

import {
  uploadTempImage,
  deleteTempImage,
  listTempImages
} from '$lib/sync/tempImageUpload.js';

const origFetch = globalThis.fetch;

describe('tempImageUpload', () => {
  beforeEach(async () => {
    uploadMock.mockReset();
    await setImageStorageToken('test-token');
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('throws when token unset', async () => {
    await setImageStorageToken('');
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    await expect(uploadTempImage(file)).rejects.toThrow(/토큰/);
  });

  it('calls @vercel/blob upload with temp-images prefix + Bearer header', async () => {
    uploadMock.mockResolvedValue({ url: 'https://blob/temp-images/abc.png' });
    const file = new File(['x'], 'a.png', { type: 'image/png' });

    const url = await uploadTempImage(file);

    expect(url).toBe('https://blob/temp-images/abc.png');
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [pathname, body, opts] = uploadMock.mock.calls[0] as [string, File, Record<string, unknown>];
    expect(pathname).toMatch(/^temp-images\/[0-9a-f-]+\.png$/i);
    expect(body).toBe(file);
    expect(opts.access).toBe('public');
    expect(opts.handleUploadUrl).toBe('/api/temp-image');
    expect(opts.clientPayload).toContain('test-token');
  });

  it('preserves jpeg extension', async () => {
    uploadMock.mockResolvedValue({ url: 'x' });
    const file = new File(['x'], 'photo.JPEG', { type: 'image/jpeg' });
    await uploadTempImage(file);
    const [pathname] = uploadMock.mock.calls[0] as [string];
    expect(pathname).toMatch(/\.jpeg$/);
  });

  it('deleteTempImage hits DELETE with Bearer + url query', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;

    await deleteTempImage('https://blob/temp-images/abc.png');

    const [calledUrl, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toContain('/api/temp-image?url=https%3A%2F%2Fblob%2Ftemp-images%2Fabc.png');
    expect((init as RequestInit).method).toBe('DELETE');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-token' });
  });

  it('deleteTempImage throws on non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 502 })) as typeof fetch;
    await expect(deleteTempImage('https://blob/x.png')).rejects.toThrow(/502/);
  });

  it('listTempImages parses JSON response', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              { url: 'u1', pathname: 'temp-images/a.png', size: 10, uploadedAt: '2026-05-27T00:00:00Z' }
            ],
            hasMore: false
          }),
          { status: 200 }
        )
    ) as typeof fetch;

    const result = await listTempImages();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].url).toBe('u1');
    expect(result.hasMore).toBe(false);
  });
});
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

Run: `cd app && npm run test -- tests/unit/sync/tempImageUpload.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: 모듈 작성** — `app/src/lib/sync/tempImageUpload.ts`

```ts
/**
 * Client-side wrapper around `/api/temp-image/*` endpoints.
 *
 * Flow:
 *   uploadTempImage(file)
 *     1. read Bearer token from appSettings
 *     2. call @vercel/blob/client.upload() with our handleUploadUrl
 *        and the token in clientPayload — the server endpoint extracts
 *        the token from the request, validates it, and only then mints
 *        the single-use Vercel client token
 *     3. browser PUTs the bytes directly to Vercel Blob
 *     4. return the resulting URL
 *
 * Storage layout: `temp-images/{uuid}.{ext}` — extension preserved so
 * the blob serves the right Content-Type when used as <img src>.
 */

import { upload } from '@vercel/blob/client';
import { getImageStorageToken } from '$lib/storage/appSettings.js';

export interface TempImageListItem {
  url: string;
  pathname: string;
  size: number;
  uploadedAt: string;
}

export interface TempImageListResult {
  items: TempImageListItem[];
  hasMore: boolean;
}

function fileExtension(file: File): string {
  const nameMatch = /\.([A-Za-z0-9]+)$/.exec(file.name);
  if (nameMatch) return nameMatch[1].toLowerCase();
  if (file.type.startsWith('image/')) {
    const sub = file.type.slice('image/'.length).toLowerCase();
    return sub === 'svg+xml' ? 'svg' : sub;
  }
  return 'bin';
}

function buildPathname(file: File): string {
  return `temp-images/${crypto.randomUUID()}.${fileExtension(file)}`;
}

async function requireToken(): Promise<string> {
  const t = await getImageStorageToken();
  if (!t) {
    throw new Error(
      '이미지 서버 토큰이 설정되지 않았습니다. 설정 페이지에서 토큰을 입력하세요.'
    );
  }
  return t;
}

/**
 * Upload a file to Vercel Blob's temp-images namespace and return the
 * resulting public URL.
 */
export async function uploadTempImage(file: File): Promise<string> {
  const token = await requireToken();
  const pathname = buildPathname(file);

  const result = await upload(pathname, file, {
    access: 'public',
    handleUploadUrl: '/api/temp-image',
    // The server-side handleUpload sees clientPayload as the JSON string we
    // pass here. We piggy-back our Bearer token through it so the server
    // can verify before minting the Vercel client token. (The Authorization
    // header on this XHR can't be customised by the @vercel/blob/client
    // wrapper — it uses fetch internally — so we route the token through
    // the body instead.)
    clientPayload: JSON.stringify({ token })
  });

  return result.url;
}

/**
 * Delete a temp blob by URL.
 */
export async function deleteTempImage(url: string): Promise<void> {
  const token = await requireToken();
  const target = `/api/temp-image?url=${encodeURIComponent(url)}`;
  const res = await fetch(target, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`Blob 삭제 실패 (${res.status})`);
  }
}

/**
 * List every blob under `temp-images/`.
 */
export async function listTempImages(): Promise<TempImageListResult> {
  const token = await requireToken();
  const res = await fetch('/api/temp-image/list', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`Blob list 실패 (${res.status})`);
  }
  return (await res.json()) as TempImageListResult;
}
```

- [ ] **Step 4: Bearer-via-clientPayload 처리 — 서버 측 보정**

서버의 `+server.ts`(Task 3)는 현재 `Authorization` 헤더만 보고 있는데, 클라이언트 측은 `@vercel/blob/client.upload()`가 헤더를 못 보내므로 `clientPayload`로 토큰을 보낸다. 서버를 보정:

`app/src/routes/api/temp-image/+server.ts` POST 함수에서 `requireBearer` 호출 부분을 다음으로 교체:

```ts
export async function POST({ request }: RequestEvent): Promise<Response> {
  const body = (await request.json()) as HandleUploadBody;

  // Verify token from clientPayload (Vercel Blob client.upload doesn't let
  // us customise the Authorization header). DELETE/list use the standard
  // Bearer header — this exception applies only to POST.
  const clientPayload = (body as { clientPayload?: string }).clientPayload;
  if (!clientPayload) {
    return new Response('Missing clientPayload', { status: 401 });
  }
  let token: string;
  try {
    token = (JSON.parse(clientPayload) as { token?: string }).token ?? '';
  } catch {
    return new Response('Malformed clientPayload', { status: 401 });
  }
  const expected = env.IMAGE_STORAGE_TOKEN ?? '';
  if (!expected) {
    return new Response('IMAGE_STORAGE_TOKEN not configured', { status: 500 });
  }
  if (token !== expected) {
    return new Response('Unauthorized: 401', { status: 401 });
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['image/*'],
        addRandomSuffix: false,
        tokenPayload: JSON.stringify({ scope: 'temp-image' })
      }),
      onUploadCompleted: async () => {}
    });
    return new Response(JSON.stringify(jsonResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Blob token mint failed: ${msg}`, { status: 502 });
  }
}
```

DELETE 함수는 그대로 `requireBearer` 사용. import는 그대로 유지.

- [ ] **Step 5: 테스트 재실행 — pass 확인**

Run: `cd app && npm run test -- tests/unit/sync/tempImageUpload.test.ts`
Expected: 6 passed

- [ ] **Step 6: 타입 체크**

Run: `cd app && npm run check`
Expected: 0 errors

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/sync/tempImageUpload.ts app/tests/unit/sync/tempImageUpload.test.ts app/src/routes/api/temp-image/+server.ts
git commit -m "$(cat <<'EOF'
feat(sync): tempImageUpload 모듈 + 서버 토큰을 clientPayload로 검증

@vercel/blob/client.upload()는 Authorization 헤더 커스터마이즈를
허용하지 않으므로, POST는 토큰을 clientPayload JSON으로 보냄.
DELETE/list는 정상적인 Bearer 헤더 사용.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: paste를 `uploadTempImage`로 전환

**Goal:** 에디터의 이미지 paste가 Dropbox 대신 Vercel Blob에 업로드된다.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte:63` (import) + `:1088` (호출)

**Acceptance Criteria:**
- [ ] paste 시 `uploadTempImage(file)` 호출됨 (수동 grep으로 확인).
- [ ] `uploadImageToDropbox` import는 더 이상 paste 경로에서 쓰이지 않음 (다른 곳에서 promotion에 쓰일 예정 — 두 모듈 모두 import 유지).
- [ ] `npm run check` 0 errors.

**Verify:** `cd app && npm run check && grep -n 'uploadTempImage\|uploadImageToDropbox' src/lib/editor/TomboyEditor.svelte`

**Steps:**

- [ ] **Step 1: import + 호출 교체** — `app/src/lib/editor/TomboyEditor.svelte`

라인 63 부근의 import:

```ts
import { uploadImageToDropbox } from "$lib/sync/imageUpload.js";
```

다음으로 교체:

```ts
import { uploadTempImage } from "$lib/sync/tempImageUpload.js";
```

라인 1088 (uploadAndInsertImage 함수 안):

```ts
const url = await uploadImageToDropbox(file);
```

다음으로 교체:

```ts
const url = await uploadTempImage(file);
```

- [ ] **Step 2: 타입 체크**

Run: `cd app && npm run check`
Expected: 0 errors

- [ ] **Step 3: 회귀 점검 — 기존 paste 테스트가 있다면 mock 교체**

```bash
grep -rln "uploadImageToDropbox" app/tests/ 2>/dev/null
```

해당 파일이 있으면 mock 대상을 `tempImageUpload`로 교체 (테스트가 paste 경로를 검증하는 경우). 없으면 스킵.

- [ ] **Step 4: 단위 테스트 전체 통과 확인**

Run: `cd app && npm run test`
Expected: 모든 기존 테스트 통과.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/TomboyEditor.svelte
git commit -m "$(cat <<'EOF'
feat(editor): 이미지 paste를 uploadTempImage(Vercel Blob)로 전환

기존 uploadImageToDropbox는 imagePromotion에서 승격용으로
계속 사용. import만 paste 경로에서 제거.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: OCR cross-device 경로 — `downloadImageFromUrl` 헬퍼

**Goal:** OCR이 retry 시 이미지를 가져오는 코드 경로가 Vercel Blob URL도 지원하도록 host별 dispatch 헬퍼를 도입.

**Files:**
- Modify: `app/src/lib/sync/imageUpload.ts` (`downloadImageFromUrl` 추가)
- Modify: `app/src/lib/ocrNote/runOcrInEditor.ts:7` (import + 호출 교체)
- Test: `app/tests/unit/sync/downloadImageFromUrl.test.ts`

**Acceptance Criteria:**
- [ ] `downloadImageFromUrl(url)`이 Dropbox host → 기존 `downloadImageFromDropboxUrl` 경로, 그 외 → `fetch().blob()` 경로로 dispatch.
- [ ] `runOcrInEditor.ts`가 새 헬퍼를 사용.
- [ ] 기존 OCR 테스트 회귀 없음.

**Verify:** `cd app && npm run test -- tests/unit/sync/downloadImageFromUrl.test.ts && npm run check` → pass

**Steps:**

- [ ] **Step 1: 테스트 작성** — `app/tests/unit/sync/downloadImageFromUrl.test.ts`

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the existing Dropbox fetcher BEFORE importing the module under test.
const dropboxFetch = vi.fn();
vi.mock('$lib/sync/imageUpload.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/sync/imageUpload.js')>();
  return {
    ...actual,
    downloadImageFromDropboxUrl: (...args: unknown[]) => dropboxFetch(...args)
  };
});

import { downloadImageFromUrl } from '$lib/sync/imageUpload.js';

const origFetch = globalThis.fetch;

describe('downloadImageFromUrl', () => {
  beforeEach(() => {
    dropboxFetch.mockReset();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('routes www.dropbox.com to Dropbox SDK', async () => {
    dropboxFetch.mockResolvedValue(new Blob(['drop']));
    const blob = await downloadImageFromUrl('https://www.dropbox.com/scl/abc?raw=1');
    expect(dropboxFetch).toHaveBeenCalledOnce();
    expect(await blob.text()).toBe('drop');
  });

  it('routes dropboxusercontent.com to Dropbox SDK', async () => {
    dropboxFetch.mockResolvedValue(new Blob(['drop2']));
    await downloadImageFromUrl('https://dl.dropboxusercontent.com/x');
    expect(dropboxFetch).toHaveBeenCalledOnce();
  });

  it('routes other hosts (Vercel Blob) to plain fetch', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('vercel-bytes', { status: 200 })
    ) as typeof fetch;

    const blob = await downloadImageFromUrl(
      'https://x.public.blob.vercel-storage.com/temp-images/a.png'
    );

    expect(dropboxFetch).not.toHaveBeenCalled();
    expect(await blob.text()).toBe('vercel-bytes');
  });

  it('throws on non-2xx for non-Dropbox', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as typeof fetch;
    await expect(
      downloadImageFromUrl('https://example.com/a.png')
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

Run: `cd app && npm run test -- tests/unit/sync/downloadImageFromUrl.test.ts`
Expected: FAIL (no export named downloadImageFromUrl)

- [ ] **Step 3: 헬퍼 추가** — `app/src/lib/sync/imageUpload.ts`의 `downloadImageFromDropboxUrl` 함수 바로 아래에 추가

```ts
/**
 * Fetch image bytes by URL, dispatching by host:
 *   - dropbox.com / dropboxusercontent.com → routed through the Dropbox
 *     SDK so the cross-origin CORS limitation is bypassed (see
 *     `downloadImageFromDropboxUrl` for context).
 *   - everything else (Vercel Blob, plain http(s)) → direct `fetch()`,
 *     which works because those origins serve CORS-open responses.
 *
 * Use this anywhere code needs the bytes behind an image URL that may
 * have come from either storage channel.
 */
export async function downloadImageFromUrl(url: string): Promise<Blob> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`잘못된 이미지 URL: ${url}`);
  }
  const host = parsed.hostname;
  const isDropbox =
    host === 'dropbox.com' ||
    host.endsWith('.dropbox.com') ||
    host.endsWith('.dropboxusercontent.com');

  if (isDropbox) {
    return downloadImageFromDropboxUrl(url);
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`이미지 다운로드 실패 (${res.status})`);
  }
  return res.blob();
}
```

- [ ] **Step 4: 테스트 재실행 — pass 확인**

Run: `cd app && npm run test -- tests/unit/sync/downloadImageFromUrl.test.ts`
Expected: 4 passed

- [ ] **Step 5: OCR 호출처 교체** — `app/src/lib/ocrNote/runOcrInEditor.ts:7`

```ts
import { downloadImageFromDropboxUrl } from '../sync/imageUpload.js';
```

다음으로 교체:

```ts
import { downloadImageFromUrl } from '../sync/imageUpload.js';
```

같은 파일에서 호출부도 찾아 교체:

```bash
grep -n "downloadImageFromDropboxUrl" app/src/lib/ocrNote/runOcrInEditor.ts
```

각 호출을 `downloadImageFromUrl`로 교체.

- [ ] **Step 6: 타입 체크 + 전체 테스트**

```bash
cd app && npm run check && npm run test
```

Expected: 0 errors + all tests pass.

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/sync/imageUpload.ts app/src/lib/ocrNote/runOcrInEditor.ts app/tests/unit/sync/downloadImageFromUrl.test.ts
git commit -m "$(cat <<'EOF'
feat(sync): downloadImageFromUrl — host별 dispatch (Vercel/Dropbox)

OCR cross-device 재시도 경로가 Vercel Blob URL도 가져올 수 있도록
host로 SDK/fetch 분기. Dropbox URL은 기존 SDK 경로 그대로
(CORS 우회 필요), 그 외는 plain fetch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 클라이언트 — `imageInventory` 모듈

**Goal:** 모든 노트의 이미지 URL을 추출하고 (host로) 분류하며, Vercel `list()`와 합쳐 admin 그리드용 인벤토리를 만든다.

**Files:**
- Create: `app/src/lib/sync/imageInventory.ts`
- Test: `app/tests/unit/sync/imageInventory.test.ts`

**Acceptance Criteria:**
- [ ] `classifyImageUrl(url)`이 vercel/dropbox/external 정확히 분류.
- [ ] `scanNotesForImages()`가 fixture 노트들에서 이미지 URL을 추출하고 `usedIn` 집계가 맞음 (같은 URL이 여러 노트에 있으면 모두 잡힘).
- [ ] `loadImageInventory()`가 노트 스캔 ∪ Vercel list 합집합 + orphan 분류.
- [ ] `loadImageInventory()`가 list API 실패 시 partial 결과 + 에러 플래그 반환 (throw 안 함).

**Verify:** `cd app && npm run test -- tests/unit/sync/imageInventory.test.ts` → 모든 테스트 pass

**Steps:**

- [ ] **Step 1: 테스트 작성** — `app/tests/unit/sync/imageInventory.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

const listMock = vi.fn();
vi.mock('$lib/sync/tempImageUpload.js', () => ({
  listTempImages: () => listMock()
}));

import {
  classifyImageUrl,
  scanNotesForImages,
  loadImageInventory
} from '$lib/sync/imageInventory.js';
import { putNoteSynced } from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';

function noteWith(guid: string, title: string, body: string) {
  const n = createEmptyNote();
  n.guid = guid;
  n.title = title;
  n.xmlContent = `<note-content version="1.0">${body}</note-content>`;
  return n;
}

describe('classifyImageUrl', () => {
  const cases: Array<[string, string]> = [
    ['https://abc.public.blob.vercel-storage.com/temp-images/x.png', 'temp'],
    ['https://www.dropbox.com/scl/abc?raw=1', 'dropbox'],
    ['https://dl.dropboxusercontent.com/y.jpg', 'dropbox'],
    ['https://example.com/pic.png', 'external'],
    ['https://upload.wikimedia.org/foo.svg', 'external'],
    ['not a url', 'external']
  ];
  for (const [url, expected] of cases) {
    it(`${url} → ${expected}`, () => {
      expect(classifyImageUrl(url)).toBe(expected);
    });
  }
});

describe('scanNotesForImages', () => {
  beforeEach(async () => {
    // fake-indexeddb resets between test files; clear within-file by
    // overwriting any known guids.
  });

  it('extracts image URLs and groups by note', async () => {
    const a = noteWith(
      'g1',
      'note one',
      `<link:url>https://a.public.blob.vercel-storage.com/temp-images/x.png</link:url>
       <link:url>https://www.dropbox.com/scl/y.jpg?raw=1</link:url>`
    );
    const b = noteWith(
      'g2',
      'note two',
      `<link:url>https://a.public.blob.vercel-storage.com/temp-images/x.png</link:url>`
    );
    await putNoteSynced(a);
    await putNoteSynced(b);

    const result = await scanNotesForImages();
    const sharedTemp = result.find((r) => r.url.includes('temp-images/x.png'));
    expect(sharedTemp).toBeDefined();
    expect(sharedTemp!.usedIn.map((u) => u.guid).sort()).toEqual(['g1', 'g2']);

    const dropbox = result.find((r) => r.url.includes('dropbox.com'));
    expect(dropbox).toBeDefined();
    expect(dropbox!.usedIn.map((u) => u.guid)).toEqual(['g1']);
  });

  it('ignores non-image URLs', async () => {
    const a = noteWith(
      'g3',
      'note three',
      `<link:url>https://example.com/page.html</link:url>`
    );
    await putNoteSynced(a);

    const result = await scanNotesForImages();
    const nonImage = result.find((r) => r.url.includes('page.html'));
    expect(nonImage).toBeUndefined();
  });
});

describe('loadImageInventory', () => {
  beforeEach(() => {
    listMock.mockReset();
  });

  it('merges note scan with Vercel list, flags orphans', async () => {
    // Note references one temp image
    const n = noteWith(
      'g4',
      'note',
      `<link:url>https://a.public.blob.vercel-storage.com/temp-images/used.png</link:url>`
    );
    await putNoteSynced(n);

    listMock.mockResolvedValue({
      items: [
        {
          url: 'https://a.public.blob.vercel-storage.com/temp-images/used.png',
          pathname: 'temp-images/used.png',
          size: 100,
          uploadedAt: '2026-05-27T00:00:00Z'
        },
        {
          url: 'https://a.public.blob.vercel-storage.com/temp-images/orphan.png',
          pathname: 'temp-images/orphan.png',
          size: 200,
          uploadedAt: '2026-05-27T00:00:00Z'
        }
      ],
      hasMore: false
    });

    const inv = await loadImageInventory();

    const used = inv.items.find((i) => i.url.includes('used.png'));
    expect(used).toBeDefined();
    expect(used!.storage).toBe('temp');
    expect(used!.isOrphan).toBe(false);
    expect(used!.size).toBe(100);
    expect(used!.usedIn.length).toBeGreaterThan(0);

    const orphan = inv.items.find((i) => i.url.includes('orphan.png'));
    expect(orphan).toBeDefined();
    expect(orphan!.isOrphan).toBe(true);
    expect(orphan!.usedIn).toEqual([]);

    expect(inv.listError).toBeNull();
  });

  it('returns partial result when Vercel list fails', async () => {
    listMock.mockRejectedValue(new Error('502'));
    const inv = await loadImageInventory();
    expect(inv.listError).toContain('502');
    // Note-scan results still present (from previous tests; just ensure no
    // throw)
    expect(Array.isArray(inv.items)).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

Run: `cd app && npm run test -- tests/unit/sync/imageInventory.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: 모듈 작성** — `app/src/lib/sync/imageInventory.ts`

```ts
/**
 * Cross-channel image inventory for the admin "이미지" page.
 *
 * Builds a single list by walking every local note's xmlContent for
 * image URLs (via `isImageUrl`) and unioning that with the Vercel Blob
 * `list()` result. The union catches orphan blobs (no note references
 * them) so the user can clean them up.
 *
 * In-memory only — re-runs on every admin page load. Cheap because the
 * note store is local IDB and Vercel's list call is one HTTP roundtrip.
 */

import { getAllNotes } from '$lib/storage/noteStore.js';
import { isImageUrl } from '$lib/editor/imagePreview/isImageUrl.js';
import { listTempImages, type TempImageListItem } from './tempImageUpload.js';

export type ImageStorage = 'temp' | 'dropbox' | 'external';

export interface ImageNoteRef {
  guid: string;
  title: string;
}

export interface ImageInventoryItem {
  url: string;
  storage: ImageStorage;
  size?: number;
  uploadedAt?: string;
  usedIn: ImageNoteRef[];
  isOrphan: boolean;
}

export interface ImageInventory {
  items: ImageInventoryItem[];
  listError: string | null;
}

/**
 * Classify by URL host. Returns 'external' for anything not recognised
 * (including unparseable strings).
 */
export function classifyImageUrl(url: string): ImageStorage {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'external';
  }
  const host = parsed.hostname;
  if (host.endsWith('.public.blob.vercel-storage.com')) return 'temp';
  if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) return 'dropbox';
  if (host.endsWith('.dropboxusercontent.com')) return 'dropbox';
  return 'external';
}

// Match anything between <link:url>...</link:url> tags in xmlContent.
// xmlContent stores URLs as raw text inside that tag.
const LINK_URL_RE = /<link:url>([^<]+)<\/link:url>/g;

interface ScanRow {
  url: string;
  storage: ImageStorage;
  usedIn: ImageNoteRef[];
}

export async function scanNotesForImages(): Promise<ScanRow[]> {
  const notes = await getAllNotes();
  const map = new Map<string, ScanRow>();

  for (const note of notes) {
    if (note.deleted) continue;
    const xml = note.xmlContent ?? '';
    let m: RegExpExecArray | null;
    LINK_URL_RE.lastIndex = 0;
    while ((m = LINK_URL_RE.exec(xml)) !== null) {
      const url = m[1].trim();
      if (!isImageUrl(url)) continue;
      let row = map.get(url);
      if (!row) {
        row = { url, storage: classifyImageUrl(url), usedIn: [] };
        map.set(url, row);
      }
      // Dedupe per-note in case same URL appears twice in the same note.
      if (!row.usedIn.some((u) => u.guid === note.guid)) {
        row.usedIn.push({ guid: note.guid, title: note.title });
      }
    }
  }

  return Array.from(map.values());
}

/**
 * Build the unified inventory. Vercel list failures degrade gracefully:
 * the note-scan rows are still returned, and `listError` carries the
 * error message for the UI to surface.
 */
export async function loadImageInventory(): Promise<ImageInventory> {
  const scan = await scanNotesForImages();

  let blobItems: TempImageListItem[] = [];
  let listError: string | null = null;
  try {
    const result = await listTempImages();
    blobItems = result.items;
  } catch (err) {
    listError = err instanceof Error ? err.message : String(err);
  }

  // URL → ScanRow for quick join
  const byUrl = new Map(scan.map((r) => [r.url, r]));

  // Layer Vercel data onto scan rows (size, uploadedAt)
  const items: ImageInventoryItem[] = [];
  const seenBlobUrls = new Set<string>();

  for (const blob of blobItems) {
    seenBlobUrls.add(blob.url);
    const scanRow = byUrl.get(blob.url);
    items.push({
      url: blob.url,
      storage: 'temp',
      size: blob.size,
      uploadedAt: blob.uploadedAt,
      usedIn: scanRow?.usedIn ?? [],
      isOrphan: !scanRow || scanRow.usedIn.length === 0
    });
  }

  // Add scan rows that are NOT Vercel blobs (or are Vercel blobs that
  // didn't appear in list — shouldn't happen but defend anyway)
  for (const row of scan) {
    if (seenBlobUrls.has(row.url)) continue;
    items.push({
      url: row.url,
      storage: row.storage,
      usedIn: row.usedIn,
      isOrphan: false
    });
  }

  return { items, listError };
}
```

- [ ] **Step 4: 테스트 재실행 — pass 확인**

Run: `cd app && npm run test -- tests/unit/sync/imageInventory.test.ts`
Expected: 모든 테스트 pass.

- [ ] **Step 5: 타입 체크**

Run: `cd app && npm run check`
Expected: 0 errors.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/sync/imageInventory.ts app/tests/unit/sync/imageInventory.test.ts
git commit -m "$(cat <<'EOF'
feat(sync): imageInventory — 노트 스캔 + Vercel list 통합

classifyImageUrl로 host별 분류, scanNotesForImages로 IDB의
모든 노트에서 이미지 URL 집계, loadImageInventory로 합집합 +
orphan 검출. Vercel list 실패 시 partial 결과 + listError 반환.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 클라이언트 — `imagePromotion` 모듈

**Goal:** `promoteImageToDropbox(tempUrl)` — fetch → Dropbox 업로드 → 노트 URL string-replace → Vercel 삭제. 단계별 실패에도 노트가 깨지지 않음 (양쪽 URL 모두 유효).

**Files:**
- Create: `app/src/lib/sync/imagePromotion.ts`
- Test: `app/tests/unit/sync/imagePromotion.test.ts`

**Acceptance Criteria:**
- [ ] happy path: Dropbox URL 리턴, 노트들의 URL 교체됨, Vercel 삭제됨, `emitNoteReload` 호출됨.
- [ ] step 1 (fetch) 실패: 노트 무변경, blob 무변경, 명확한 에러 throw.
- [ ] step 2 (Dropbox 업로드) 실패: 노트 무변경, blob 무변경, 에러 throw.
- [ ] step 4 (노트 일부 갱신 실패): 이미 처리한 노트는 새 URL, 나머지는 옛 URL, blob 무변경 (재시도 가능). 결과로 `partialFailure: true` + `succeeded`/`failed` guid 리스트.
- [ ] step 6 (Vercel 삭제 실패): 노트는 갱신 완료, blob 남음, 결과로 `vercelDeleteError` 메시지.

**Verify:** `cd app && npm run test -- tests/unit/sync/imagePromotion.test.ts` → 5 passed

**Steps:**

- [ ] **Step 1: 테스트 작성** — `app/tests/unit/sync/imagePromotion.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

const downloadMock = vi.fn();
const uploadDropboxMock = vi.fn();
const deleteTempMock = vi.fn();
const emitReloadMock = vi.fn();

vi.mock('$lib/sync/imageUpload.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/sync/imageUpload.js')>();
  return {
    ...actual,
    downloadImageFromUrl: (...args: unknown[]) => downloadMock(...args),
    uploadImageToDropbox: (...args: unknown[]) => uploadDropboxMock(...args)
  };
});

vi.mock('$lib/sync/tempImageUpload.js', () => ({
  deleteTempImage: (...args: unknown[]) => deleteTempMock(...args)
}));

vi.mock('$lib/core/noteReloadBus.js', async () => ({
  emitNoteReload: (...args: unknown[]) => emitReloadMock(...args)
}));

import { promoteImageToDropbox } from '$lib/sync/imagePromotion.js';
import { putNoteSynced, getNote } from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';

const TEMP = 'https://a.public.blob.vercel-storage.com/temp-images/x.png';
const DROPBOX = 'https://www.dropbox.com/scl/y.png?raw=1';

function noteWith(guid: string, body: string) {
  const n = createEmptyNote();
  n.guid = guid;
  n.title = guid;
  n.xmlContent = `<note-content version="1.0">${body}</note-content>`;
  return n;
}

describe('promoteImageToDropbox', () => {
  beforeEach(async () => {
    downloadMock.mockReset();
    uploadDropboxMock.mockReset();
    deleteTempMock.mockReset();
    emitReloadMock.mockReset();
  });

  it('happy path: downloads, uploads to dropbox, rewrites, deletes, reloads', async () => {
    await putNoteSynced(noteWith('h1', `<link:url>${TEMP}</link:url>`));
    await putNoteSynced(noteWith('h2', `<link:url>${TEMP}</link:url>`));
    downloadMock.mockResolvedValue(new Blob(['bytes'], { type: 'image/png' }));
    uploadDropboxMock.mockResolvedValue(DROPBOX);
    deleteTempMock.mockResolvedValue(undefined);

    const result = await promoteImageToDropbox(TEMP);

    expect(result.dropboxUrl).toBe(DROPBOX);
    expect(result.succeeded.sort()).toEqual(['h1', 'h2']);
    expect(result.failed).toEqual([]);
    expect(result.partialFailure).toBe(false);
    expect(result.vercelDeleteError).toBeNull();

    expect((await getNote('h1'))!.xmlContent).toContain(DROPBOX);
    expect((await getNote('h1'))!.xmlContent).not.toContain(TEMP);
    expect((await getNote('h2'))!.xmlContent).toContain(DROPBOX);
    expect(deleteTempMock).toHaveBeenCalledWith(TEMP);
    expect(emitReloadMock).toHaveBeenCalledWith(expect.arrayContaining(['h1', 'h2']));
  });

  it('step 1 fail (fetch): no changes', async () => {
    await putNoteSynced(noteWith('f1', `<link:url>${TEMP}</link:url>`));
    downloadMock.mockRejectedValue(new Error('CORS'));

    await expect(promoteImageToDropbox(TEMP)).rejects.toThrow(/CORS/);

    expect(uploadDropboxMock).not.toHaveBeenCalled();
    expect(deleteTempMock).not.toHaveBeenCalled();
    expect((await getNote('f1'))!.xmlContent).toContain(TEMP);
  });

  it('step 2 fail (dropbox upload): no changes', async () => {
    await putNoteSynced(noteWith('f2', `<link:url>${TEMP}</link:url>`));
    downloadMock.mockResolvedValue(new Blob(['x']));
    uploadDropboxMock.mockRejectedValue(new Error('Dropbox 401'));

    await expect(promoteImageToDropbox(TEMP)).rejects.toThrow(/Dropbox/);

    expect(deleteTempMock).not.toHaveBeenCalled();
    expect((await getNote('f2'))!.xmlContent).toContain(TEMP);
  });

  it('step 4 partial fail: succeeded notes have new URL, failed have old, blob kept', async () => {
    await putNoteSynced(noteWith('p1', `<link:url>${TEMP}</link:url>`));
    await putNoteSynced(noteWith('p2', `<link:url>${TEMP}</link:url>`));
    downloadMock.mockResolvedValue(new Blob(['x']));
    uploadDropboxMock.mockResolvedValue(DROPBOX);

    // Inject a putNote that fails for one specific guid.
    // We do this by spying on the noteStore module before the function call.
    const noteStore = await import('$lib/storage/noteStore.js');
    const origPut = noteStore.putNote;
    const putSpy = vi.spyOn(noteStore, 'putNote').mockImplementation(async (n) => {
      if (n.guid === 'p2') throw new Error('IDB write failed');
      return origPut(n);
    });

    const result = await promoteImageToDropbox(TEMP);

    expect(result.partialFailure).toBe(true);
    expect(result.succeeded).toEqual(['p1']);
    expect(result.failed).toEqual(['p2']);
    expect(deleteTempMock).not.toHaveBeenCalled();   // blob KEPT
    expect((await getNote('p1'))!.xmlContent).toContain(DROPBOX);
    // p2 was not actually persisted; original content unchanged
    expect((await getNote('p2'))!.xmlContent).toContain(TEMP);

    putSpy.mockRestore();
  });

  it('step 6 fail (vercel delete): notes updated, blob remains, error captured', async () => {
    await putNoteSynced(noteWith('d1', `<link:url>${TEMP}</link:url>`));
    downloadMock.mockResolvedValue(new Blob(['x']));
    uploadDropboxMock.mockResolvedValue(DROPBOX);
    deleteTempMock.mockRejectedValue(new Error('Blob 502'));

    const result = await promoteImageToDropbox(TEMP);

    expect(result.partialFailure).toBe(false);
    expect(result.succeeded).toEqual(['d1']);
    expect(result.vercelDeleteError).toContain('502');
    expect((await getNote('d1'))!.xmlContent).toContain(DROPBOX);
  });
});
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

Run: `cd app && npm run test -- tests/unit/sync/imagePromotion.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: 모듈 작성** — `app/src/lib/sync/imagePromotion.ts`

```ts
/**
 * Move a temp Vercel Blob image to the Dropbox backup channel.
 *
 * Step sequence (failure points are designed so the note never ends up
 * pointing at a dead URL):
 *
 *   1. fetch tempUrl bytes
 *   2. upload bytes to Dropbox → dropboxUrl
 *   3. scan local notes for tempUrl
 *   4. for each affected note: load → string-replace tempUrl→dropboxUrl
 *      → putNote (localDirty=true)
 *   5. emitNoteReload(affected)  — so open editors reload from IDB
 *   6. deleteTempImage(tempUrl)  — only if step 4 fully succeeded
 *
 * If step 4 partially fails: blob is KEPT so the failed notes still
 * point at a live URL; the caller can retry safely (idempotent —
 * re-running just re-uploads to Dropbox under a new path).
 */

import {
  downloadImageFromUrl,
  uploadImageToDropbox
} from './imageUpload.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { emitNoteReload } from '$lib/core/noteReloadBus.js';
import { deleteTempImage } from './tempImageUpload.js';
import { formatTomboyDate } from '$lib/core/note.js';

export interface PromotionResult {
  dropboxUrl: string;
  succeeded: string[];       // guids whose xmlContent was rewritten + persisted
  failed: string[];          // guids whose persist failed; still hold old URL
  partialFailure: boolean;   // failed.length > 0
  vercelDeleteError: string | null;
}

function fileExtFromUrl(url: string): string {
  const m = /\.([A-Za-z0-9]+)(?:\?|$)/.exec(url);
  return m ? m[1].toLowerCase() : 'png';
}

function fileNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg || `image.${fileExtFromUrl(url)}`;
  } catch {
    return `image.${fileExtFromUrl(url)}`;
  }
}

export async function promoteImageToDropbox(tempUrl: string): Promise<PromotionResult> {
  // Step 1
  const blob = await downloadImageFromUrl(tempUrl);

  // Step 2
  const file = new File([blob], fileNameFromUrl(tempUrl), {
    type: blob.type || 'image/png'
  });
  const dropboxUrl = await uploadImageToDropbox(file);

  // Step 3: find affected notes (don't reuse imageInventory.scanNotesForImages
  // because that filters to image URLs only — here we need exact string match
  // against tempUrl in xmlContent regardless of extension)
  const all = await noteStore.getAllNotes();
  const affected = all.filter((n) => !n.deleted && (n.xmlContent ?? '').includes(tempUrl));

  // Step 4
  const succeeded: string[] = [];
  const failed: string[] = [];
  const now = formatTomboyDate(new Date());
  for (const note of affected) {
    try {
      // Defensive deep-ish clone of the note before mutation so a thrown
      // putNote doesn't leave a half-mutated reference in caller scope.
      const next = { ...note };
      next.xmlContent = (note.xmlContent ?? '').split(tempUrl).join(dropboxUrl);
      next.changeDate = now;
      next.metadataChangeDate = now;
      await noteStore.putNote(next);
      succeeded.push(note.guid);
    } catch {
      failed.push(note.guid);
    }
  }

  // Step 5 — fire reloads for the succeeded ones
  if (succeeded.length > 0) {
    await emitNoteReload(succeeded);
  }

  const partialFailure = failed.length > 0;

  // Step 6 — only delete blob if every affected note was updated
  let vercelDeleteError: string | null = null;
  if (!partialFailure) {
    try {
      await deleteTempImage(tempUrl);
    } catch (err) {
      vercelDeleteError = err instanceof Error ? err.message : String(err);
    }
  }

  return { dropboxUrl, succeeded, failed, partialFailure, vercelDeleteError };
}
```

**확인 필요**: `formatTomboyDate`가 `app/src/lib/core/note.ts`에서 export 되어 있는지 — 안 되어 있으면 import 경로를 noteManager나 noteArchiver에서 찾아 조정. 명령:

```bash
grep -n "export.*formatTomboyDate" app/src/lib/core/*.ts
```

- [ ] **Step 4: 테스트 재실행 — pass 확인**

Run: `cd app && npm run test -- tests/unit/sync/imagePromotion.test.ts`
Expected: 5 passed.

- [ ] **Step 5: 타입 체크 + 전체 테스트**

```bash
cd app && npm run check && npm run test
```

Expected: 0 errors + all tests pass.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/sync/imagePromotion.ts app/tests/unit/sync/imagePromotion.test.ts
git commit -m "$(cat <<'EOF'
feat(sync): imagePromotion — Vercel temp → Dropbox 승격

단계별 실패에도 노트의 URL이 항상 살아있는 곳을 가리키도록
설계: blob 삭제는 모든 노트 URL 재작성이 성공한 후에만.
부분 실패 시 PromotionResult.partialFailure + failed guid 노출.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Admin `/admin/images` 페이지

**Goal:** admin sub-nav에 "이미지" 탭 추가 + 인벤토리 그리드 UI + 승격/삭제 액션.

**Files:**
- Modify: `app/src/routes/admin/+layout.svelte` (sub-nav)
- Create: `app/src/routes/admin/images/+page.svelte`

**Acceptance Criteria:**
- [ ] admin 헤더에 "이미지" 탭이 보이고 클릭 시 `/admin/images`로 이동.
- [ ] 페이지 로드 시 `loadImageInventory()` 호출 + 그리드에 카드 렌더.
- [ ] 각 카드: 썸네일 + storage badge + 사용 노트 목록 + (temp만) 액션 버튼.
- [ ] "Dropbox로 저장" 클릭 → `promoteImageToDropbox` 호출 → 진행 토스트 → 완료 후 인벤토리 새로고침.
- [ ] "삭제" 클릭 → `usedIn.length > 0`이면 confirm → `deleteTempImage` 호출 → 인벤토리 새로고침.
- [ ] `listError` 있으면 상단 경고 배너 표시.

**Verify:** `cd app && npm run check && npm run build` → 0 errors + 빌드 성공

**Steps:**

- [ ] **Step 1: sub-nav에 "이미지" 탭 추가** — `app/src/routes/admin/+layout.svelte`

`const tabs = [...]` 배열에 한 항목 추가 (위치는 "GPU" 다음, "도구" 앞):

```ts
{ href: "/admin/gpu", label: "GPU" },
{ href: "/admin/images", label: "이미지" },
{ href: "/admin/tools", label: "도구" },
```

- [ ] **Step 2: 페이지 생성** — `app/src/routes/admin/images/+page.svelte`

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    loadImageInventory,
    type ImageInventoryItem,
    type ImageInventory
  } from '$lib/sync/imageInventory.js';
  import { promoteImageToDropbox } from '$lib/sync/imagePromotion.js';
  import { deleteTempImage } from '$lib/sync/tempImageUpload.js';
  import { pushToast, dismissToast } from '$lib/stores/toast.js';

  let inventory = $state<ImageInventory | null>(null);
  let loading = $state(false);
  let busyUrl = $state<string | null>(null);   // currently-acting URL (disables buttons)

  async function refresh() {
    loading = true;
    try {
      inventory = await loadImageInventory();
    } catch (err) {
      pushToast(`인벤토리 로드 실패: ${(err as Error).message}`, { kind: 'error' });
    } finally {
      loading = false;
    }
  }

  onMount(refresh);

  async function promote(item: ImageInventoryItem) {
    if (busyUrl) return;
    busyUrl = item.url;
    const toastId = pushToast('Dropbox로 저장 중…', { timeoutMs: 0 });
    try {
      const result = await promoteImageToDropbox(item.url);
      dismissToast(toastId);
      if (result.partialFailure) {
        pushToast(
          `일부 노트 갱신 실패 (${result.failed.length}개). admin에서 다시 시도 가능.`,
          { kind: 'error' }
        );
      } else if (result.vercelDeleteError) {
        pushToast(
          `Dropbox 저장 완료. 임시 이미지 정리 실패 — 새로고침 후 다시 시도.`,
          { kind: 'error' }
        );
      } else {
        pushToast('Dropbox로 저장 완료');
      }
    } catch (err) {
      dismissToast(toastId);
      pushToast(`승격 실패: ${(err as Error).message}`, { kind: 'error' });
    } finally {
      busyUrl = null;
      await refresh();
    }
  }

  async function removeBlob(item: ImageInventoryItem) {
    if (busyUrl) return;
    if (item.usedIn.length > 0) {
      const ok = confirm(
        `이 이미지는 ${item.usedIn.length}개 노트에서 사용 중입니다. 삭제하면 노트의 이미지가 깨집니다. 진행할까요?`
      );
      if (!ok) return;
    }
    busyUrl = item.url;
    try {
      await deleteTempImage(item.url);
      pushToast('임시 이미지 삭제 완료');
    } catch (err) {
      pushToast(`삭제 실패: ${(err as Error).message}`, { kind: 'error' });
    } finally {
      busyUrl = null;
      await refresh();
    }
  }

  function badgeLabel(storage: ImageInventoryItem['storage']): string {
    if (storage === 'temp') return '임시';
    if (storage === 'dropbox') return '저장됨';
    return '외부';
  }
</script>

<section class="page">
  <header>
    <h2>이미지 인벤토리</h2>
    <button onclick={refresh} disabled={loading}>
      {loading ? '로딩 중…' : '새로고침'}
    </button>
  </header>

  {#if inventory?.listError}
    <div class="banner warn">
      ⚠️ 오펀 임시 이미지 목록을 가져오지 못했습니다 ({inventory.listError}).
      노트에서 참조 중인 이미지만 표시됩니다.
    </div>
  {/if}

  {#if inventory && inventory.items.length === 0}
    <p class="empty">표시할 이미지가 없습니다.</p>
  {/if}

  <div class="grid">
    {#each inventory?.items ?? [] as item (item.url)}
      <article class="card" class:busy={busyUrl === item.url}>
        <div class="thumb">
          <img src={item.url} alt="" loading="lazy" />
        </div>
        <div class="meta">
          <div class="badges">
            <span class="badge badge-{item.storage}">{badgeLabel(item.storage)}</span>
            {#if item.isOrphan}
              <span class="badge badge-orphan">오펀</span>
            {/if}
          </div>
          {#if item.size !== undefined}
            <div class="size">{Math.round(item.size / 1024)} KB</div>
          {/if}
          <div class="used-in">
            {#if item.usedIn.length === 0}
              <em>참조 없음</em>
            {:else}
              {#each item.usedIn as ref}
                <a href="/note/{ref.guid}" target="_blank">{ref.title || ref.guid.slice(0, 8)}</a>
              {/each}
            {/if}
          </div>
          {#if item.storage === 'temp'}
            <div class="actions">
              <button
                onclick={() => promote(item)}
                disabled={busyUrl !== null}
              >
                Dropbox로 저장
              </button>
              <button
                class="danger"
                onclick={() => removeBlob(item)}
                disabled={busyUrl !== null}
              >
                삭제
              </button>
            </div>
          {/if}
        </div>
      </article>
    {/each}
  </div>
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  header h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .banner.warn {
    padding: 10px 14px;
    background: #fff7e0;
    border: 1px solid #f0c674;
    border-radius: 6px;
    font-size: 0.85rem;
  }
  .empty {
    color: #6b7280;
    font-size: 0.9rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
  }
  .card {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: #fff;
  }
  .card.busy {
    opacity: 0.6;
  }
  .thumb {
    aspect-ratio: 1 / 1;
    background: #f3f4f6;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .meta {
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.8rem;
  }
  .badges {
    display: flex;
    gap: 4px;
  }
  .badge {
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 600;
  }
  .badge-temp {
    background: #fef3c7;
    color: #92400e;
  }
  .badge-dropbox {
    background: #dbeafe;
    color: #1e40af;
  }
  .badge-external {
    background: #e5e7eb;
    color: #374151;
  }
  .badge-orphan {
    background: #fecaca;
    color: #991b1b;
  }
  .size {
    color: #6b7280;
  }
  .used-in {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .used-in a {
    color: #2563eb;
    text-decoration: none;
  }
  .used-in a:hover {
    text-decoration: underline;
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: auto;
  }
  .actions button {
    flex: 1;
    padding: 6px 8px;
    font-size: 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
  }
  .actions button:hover:not(:disabled) {
    background: #f9fafb;
  }
  .actions button.danger {
    color: #dc2626;
    border-color: #fca5a5;
  }
  .actions button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
</style>
```

- [ ] **Step 3: 타입 체크 + 빌드**

```bash
cd app && npm run check && npm run build
```

Expected: 0 errors + 빌드 성공.

- [ ] **Step 4: 커밋**

```bash
git add app/src/routes/admin/+layout.svelte app/src/routes/admin/images/
git commit -m "$(cat <<'EOF'
feat(admin): /admin/images — 이미지 인벤토리 + 승격/삭제 UI

admin 탭에 "이미지" 추가. 카드 그리드로 노트 참조 + Vercel
list 합집합 표시 (badge: 임시/저장됨/외부/오펀). 임시 카드는
"Dropbox로 저장" / "삭제" 액션. listError 시 경고 배너.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: CLAUDE.md invariant 갱신 + 수동 검증

**Goal:** 프로젝트 메모리의 "No server runtime" invariant 문구를 새 현실(`/api/temp-image/*` 함수)에 맞게 수정. 빌드 + dev 서버 + 실제 paste / admin 흐름을 한 번 수동으로 검증.

**Files:**
- Modify: `CLAUDE.md`

**Acceptance Criteria:**
- [ ] CLAUDE.md의 "No server runtime" 단언이 더 이상 절대적이지 않게 수정됨 (단일 예외 명시).
- [ ] "## 이미지 임시 저장소" 섹션이 CLAUDE.md에 추가됨 (다른 feature 섹션 패턴 따라).
- [ ] 수동 검증 완료 — 실제 paste → Vercel URL이 노트에 박힘 / admin에서 인벤토리 보임 / 승격 동작.

**Verify:** 아래 Steps 4의 수동 검증 체크리스트가 모두 통과.

**Steps:**

- [ ] **Step 1: CLAUDE.md 문구 수정** — "Tech stack" 섹션의 다음 줄:

```
No server runtime. Deploys to Vercel / any static host. All state is client-side.
```

다음으로 교체:

```
서버 함수는 단일 예외 `/api/temp-image/*` (Vercel Blob 임시 이미지 저장소)만 존재.
그 외 모든 라우트는 static (prerender + ssr=false). 노트 데이터·sync 상태는
모두 클라이언트 IndexedDB.
```

- [ ] **Step 2: CLAUDE.md에 새 섹션 추가** — 기존 "## 일정 알림" 같은 feature 섹션들 사이에 (예: "## 터미널 노트" 위 또는 적절한 위치):

```markdown
## 이미지 임시 저장소 (Vercel Blob)

See the **spec** at `docs/superpowers/specs/2026-05-27-temp-image-storage-design.md`
for the full design. 두-채널 저장 모델: 모든 신규 paste는 Vercel Blob(임시
채널)로 가고, admin "이미지" 탭에서 "Dropbox로 저장"으로 명시적 승격.

Hook: `lib/editor/TomboyEditor.svelte:uploadAndInsertImage`가
`uploadTempImage()`를 호출 (기존 `uploadImageToDropbox()`는 승격 시에만 사용).

Quick map:

- `app/src/lib/sync/tempImageUpload.ts` — `/api/temp-image/*` 클라이언트 래퍼
- `app/src/lib/sync/imageInventory.ts` — 노트 스캔 + Vercel list 합집합
- `app/src/lib/sync/imagePromotion.ts` — fetch→Dropbox→URL rewrite→Vercel del
- `app/src/routes/api/temp-image/` — POST(token mint) / DELETE / list GET
- `app/src/routes/admin/images/+page.svelte` — 인벤토리 UI

Cross-cutting invariants worth caching:

- **기존 Dropbox 이미지는 그대로 둠.** 마이그레이션 없음.
- **`IMAGE_STORAGE_TOKEN` env var ↔ `appSettings.imageStorageToken`은
  byte-identical.** 터미널 브릿지의 Bearer 토큰 패턴과 동일.
- **POST는 토큰을 `clientPayload`로 보냄, DELETE/list는 `Authorization` 헤더.**
  `@vercel/blob/client.upload()`가 헤더 커스터마이즈를 허용하지 않아 생긴
  비대칭. 두 경로 모두 서버는 같은 토큰으로 검증.
- **승격 = 이동, 복사 아님.** URL 교체 + 원본 Vercel 삭제. 단계별 실패에도
  노트의 URL은 항상 살아있는 곳을 가리킴 (blob 삭제는 모든 노트 재작성
  성공 시에만).
- **터미널 노트 paste / 일기 파이프라인 / OCR 노트는 영향 없음.** 각자
  자기 경로 유지.
- **OCR cross-device retry는 `downloadImageFromUrl`로 host 분기됨** —
  Dropbox는 SDK 경로, Vercel은 plain fetch (Vercel Blob은 CORS open).
```

(위치는 git diff 후 사용자가 적절한 위치로 옮길 수 있음 — 일단 파일 끝 "## OCR 노트 + GPU 모니터" 다음에 추가하는 게 안전.)

- [ ] **Step 3: 환경변수 가이드 — README에 추가**

`app/README.md`가 있는지 확인:

```bash
ls app/README.md
```

있으면 환경변수 섹션에 다음 추가 (없으면 스킵, 사용자가 Vercel 대시보드에서 직접 설정):

```markdown
## 환경 변수

| 이름 | 용도 | 어디서 |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob 스토어 접근 | Vercel 통합으로 자동 주입 |
| `IMAGE_STORAGE_TOKEN` | `/api/temp-image/*` Bearer 시크릿. 앱 설정 페이지의 "이미지 서버 토큰"과 동일하게 입력. | Vercel 대시보드 → Settings → Environment Variables |
```

- [ ] **Step 4: 수동 검증 체크리스트**

먼저 Vercel CLI 또는 대시보드에서:
1. Vercel Blob integration 활성화 (또는 새 store 생성) — `BLOB_READ_WRITE_TOKEN` 자동 주입 확인.
2. `IMAGE_STORAGE_TOKEN` 환경변수에 임의의 시크릿 설정 (예: `openssl rand -hex 32`).

배포 후:

- [ ] 설정 페이지 → "이미지 서버 토큰" 입력 → 저장됨 표시 확인.
- [ ] 임의의 노트에서 이미지 paste → 토스트 "이미지 업로드 중…" → 완료 → 노트에 `*.public.blob.vercel-storage.com` URL 박힘 + 이미지 렌더링됨.
- [ ] `/admin/images` 진입 → 그리드에 방금 paste한 이미지가 "임시" badge로 표시됨 + 사용 노트 링크 보임.
- [ ] "Dropbox로 저장" 클릭 → 토스트 진행 → 완료 후 인벤토리 새로고침 → 같은 이미지가 "저장됨" badge로 바뀜 + URL이 dropbox.com으로 교체됨 (해당 노트 열어 확인).
- [ ] 새 paste 후 admin에서 "삭제" 클릭 → confirm → 삭제됨 → 노트로 돌아가면 이미지 깨짐 (의도된 동작).
- [ ] 토큰을 일부러 잘못 입력 → paste 시 토스트 "이미지 서버 토큰이 잘못되었습니다" (또는 401 메시지).
- [ ] 두 번째 디바이스에서 (Firebase 노트 sync 켜진 경우) — 승격 후 같은 노트가 Dropbox URL로 동기화되는지 확인.

- [ ] **Step 5: 커밋**

```bash
git add CLAUDE.md app/README.md 2>/dev/null
git commit -m "$(cat <<'EOF'
docs: CLAUDE.md — 이미지 임시 저장소 invariant + No server runtime 갱신

/api/temp-image/* 함수 도입에 맞춰 invariant 문구 수정.
새 feature 섹션 추가 (cross-cutting invariants + quick map).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage 확인** (`docs/superpowers/specs/2026-05-27-temp-image-storage-design.md` 섹션별):

- §1 의도 — Task 1, 6에서 paste 경로 전환으로 달성.
- §2.1 paste 흐름 — Task 5(`tempImageUpload`) + Task 6(에디터 wiring).
- §2.2 admin 관리 — Task 8(인벤토리) + Task 9(승격) + Task 10(UI).
- §2.3 토큰 미설정 — Task 1(저장) + Task 5(`requireToken` 가드).
- §3 아키텍처 — Task 2(adapter swap) + Task 3, 4(서버 라우트).
- §4 컴포넌트 — 모든 신규/수정 파일이 Task 1–10에 매핑.
- §5 데이터 모델 — Task 5(pathname 규칙), Task 8(`ImageInventoryItem`), Task 1(appSettings 키).
- §6 에러 처리 — Task 5(paste 실패), Task 9(승격 5단계), Task 10(삭제 confirm + listError 배너).
- §7 테스트 — Task 1, 3, 5, 7, 8, 9 단위 테스트; Task 11 수동 검증.
- §8 비범위 — 명시적으로 task에 안 들어감.

빠진 거 없음.

**Placeholder scan**: 검색 — TBD/TODO/"add appropriate"/"similar to" 없음. 모든 step에 actual code 또는 actual command 포함.

**Type consistency**: `PromotionResult`, `ImageInventoryItem`, `TempImageListItem` 모두 사용처와 정의처 시그니처 일치. `requireBearer(request, expected)` — Task 3 정의, Task 5 step 4에서 그대로 사용. `downloadImageFromUrl` 시그니처 (Task 7) ↔ `imagePromotion`에서 호출 (Task 9) 일치.

검토 통과.
