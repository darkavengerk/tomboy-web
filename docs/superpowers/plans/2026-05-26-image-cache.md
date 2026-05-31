# 이미지 캐시 (IDB + LRU) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 노트 이미지를 IndexedDB에 영구 캐시해서 업로드 직후 재다운로드를 없애고, 노트를 다시 열거나 OCR을 다시 돌릴 때도 캐시 히트로 즉시 사용한다.

**Architecture:** 새 모듈 `app/src/lib/imageCache/`가 IDB store + LRU + ObjectURL pool을 캡슐화하고, 4곳(`imageUpload`, `imagePreviewPlugin`, `downloadImageFromDropboxUrl`, settings UI)이 공개 API를 호출. 명시적 한도(디폴트 500MB) + `lastAccess` 기준 LRU evict.

**Tech Stack:** TypeScript, `idb` (이미 의존성), Svelte 5 runes, vitest + `fake-indexeddb`, ProseMirror plugin.

**Spec:** `docs/superpowers/specs/2026-05-26-image-cache-design.md`

---

## File Structure

**신규 (모듈)**
- `app/src/lib/imageCache/imageCacheStore.ts` — IDB store layer (open + CRUD + LRU cursor)
- `app/src/lib/imageCache/objectUrlPool.ts` — ObjectURL 라이프사이클 (모듈-레벨 Map)
- `app/src/lib/imageCache/imageCache.ts` — 공개 API (`lookupOrFetch`, `prime`, `getBlob`, `clearAll`, `getStats`, `setQuota`) + inflight dedup + LRU 트리거

**신규 (테스트)**
- `app/tests/unit/imageCache/imageCacheStore.test.ts`
- `app/tests/unit/imageCache/objectUrlPool.test.ts`
- `app/tests/unit/imageCache/imageCache.test.ts`
- `app/tests/unit/editor/imagePreviewPluginCache.test.ts`

**수정**
- `app/src/lib/storage/db.ts` — DB version bump + `imageCache` store + `by_lastAccess` index
- `app/src/lib/storage/appSettings.ts` — `imageCacheTotalBytes`, `imageCacheQuotaBytes` getter/setter
- `app/src/lib/sync/imageUpload.ts` — 업로드 후 `prime` 호출 + `downloadImageFromDropboxUrl` 캐시 lookup wrap
- `app/src/lib/editor/imagePreview/imagePreviewPlugin.ts` — `renderImagePreview`에 sync peek + async lookup
- `app/src/routes/settings/+page.svelte` — 캐시 사용량/한도 블록
- `app/src/routes/admin/tools/+page.svelte` — "이미지 캐시 비우기" 액션

---

## Task 1: IDB schema + imageCacheStore

**Goal:** IndexedDB에 `imageCache` store + `by_lastAccess` 인덱스를 추가하고, store 레벨 CRUD + LRU cursor 헬퍼를 제공한다.

**Files:**
- Modify: `app/src/lib/storage/db.ts` — DB 버전 bump + 새 store/index
- Create: `app/src/lib/imageCache/imageCacheStore.ts`
- Create: `app/tests/unit/imageCache/imageCacheStore.test.ts`

**Acceptance Criteria:**
- [ ] DB 마이그레이션 `upgrade` 핸들러가 `imageCache` store(`keyPath: 'url'`) + `by_lastAccess` 인덱스를 생성
- [ ] `getImageRecord(url)` → 레코드 또는 undefined
- [ ] `putImageRecord(record)` → 기존 url 덮어쓰기
- [ ] `deleteImageRecord(url)` → 삭제
- [ ] `evictLRU(targetBytesToFree)` → `by_lastAccess` 오름차순 cursor로 삭제, 회수한 URL 배열 + 회수한 바이트 합 반환
- [ ] `cursorSumSize()` → 모든 record `size` 합 (정합성 보정용)
- [ ] 모든 함수는 동일 트랜잭션 안에서 race-free
- [ ] 기존 IDB 사용 코드(노트 CRUD) 영향 없음 (DB upgrade는 backward-compat)

**Verify:** `cd app && npm run test -- imageCacheStore` → 모든 케이스 PASS

**Steps:**

- [ ] **Step 1: `db.ts` 현재 스키마 파악**

Read `app/src/lib/storage/db.ts` — 현재 `DB_VERSION`, 기존 store 목록, `upgrade` 핸들러의 switch 구조 확인.

- [ ] **Step 2: 새 DB 버전 + 마이그레이션 추가**

Modify `app/src/lib/storage/db.ts`:

```ts
// DB 버전 N → N+1로 bump.
// upgrade(db, oldVersion, ...) switch에 추가:
if (oldVersion < N+1) {
  const store = db.createObjectStore('imageCache', { keyPath: 'url' });
  store.createIndex('by_lastAccess', 'lastAccess');
}
```

기존 store 생성 블록은 건드리지 말 것 — `if (oldVersion < X)` 게이팅 유지.

- [ ] **Step 3: `imageCacheStore.test.ts` 작성 (실패하는 테스트)**

```ts
// app/tests/unit/imageCache/imageCacheStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  getImageRecord,
  putImageRecord,
  deleteImageRecord,
  evictLRU,
  cursorSumSize,
  type ImageCacheRecord,
} from '../../../src/lib/imageCache/imageCacheStore';

function makeRecord(url: string, size: number, lastAccess: number): ImageCacheRecord {
  return {
    url,
    blob: new Blob([new Uint8Array(size)], { type: 'image/png' }),
    contentType: 'image/png',
    size,
    lastAccess,
    insertedAt: lastAccess,
  };
}

describe('imageCacheStore', () => {
  beforeEach(async () => {
    // fake-indexeddb는 모듈 import 시점 DB는 동일 인스턴스를 공유.
    // 각 테스트 전에 store 비우기.
    indexedDB.deleteDatabase('tomboy-web');
  });

  it('put → get round-trip', async () => {
    const rec = makeRecord('https://a/x.png', 100, 1000);
    await putImageRecord(rec);
    const got = await getImageRecord('https://a/x.png');
    expect(got?.url).toBe(rec.url);
    expect(got?.size).toBe(100);
    expect(got?.blob.size).toBe(100);
    expect(got?.contentType).toBe('image/png');
  });

  it('get for missing url → undefined', async () => {
    const got = await getImageRecord('https://nope/x.png');
    expect(got).toBeUndefined();
  });

  it('delete removes record', async () => {
    await putImageRecord(makeRecord('https://a/x.png', 100, 1000));
    await deleteImageRecord('https://a/x.png');
    expect(await getImageRecord('https://a/x.png')).toBeUndefined();
  });

  it('put overwrites existing url', async () => {
    await putImageRecord(makeRecord('https://a/x.png', 100, 1000));
    await putImageRecord(makeRecord('https://a/x.png', 200, 2000));
    const got = await getImageRecord('https://a/x.png');
    expect(got?.size).toBe(200);
    expect(got?.lastAccess).toBe(2000);
  });

  it('evictLRU removes oldest-lastAccess first until target freed', async () => {
    await putImageRecord(makeRecord('https://a/1.png', 100, 100));
    await putImageRecord(makeRecord('https://a/2.png', 200, 200));
    await putImageRecord(makeRecord('https://a/3.png', 300, 300));

    const { evictedUrls, freedBytes } = await evictLRU(250);

    // 100 (lastAccess=100) + 200 (lastAccess=200) = 300 freed
    // (한 번 더 봐서 250을 채우면 멈춤)
    expect(freedBytes).toBeGreaterThanOrEqual(250);
    expect(evictedUrls).toContain('https://a/1.png');
    expect(evictedUrls).toContain('https://a/2.png');
    expect(evictedUrls).not.toContain('https://a/3.png');

    expect(await getImageRecord('https://a/3.png')).toBeDefined();
    expect(await getImageRecord('https://a/1.png')).toBeUndefined();
  });

  it('evictLRU on empty store returns 0', async () => {
    const { evictedUrls, freedBytes } = await evictLRU(1000);
    expect(evictedUrls).toEqual([]);
    expect(freedBytes).toBe(0);
  });

  it('cursorSumSize returns sum of all record sizes', async () => {
    await putImageRecord(makeRecord('https://a/1.png', 100, 100));
    await putImageRecord(makeRecord('https://a/2.png', 250, 200));
    expect(await cursorSumSize()).toBe(350);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
cd app && npm run test -- imageCacheStore
```

Expected: 모든 케이스 FAIL — 모듈 미존재.

- [ ] **Step 5: `imageCacheStore.ts` 작성**

```ts
// app/src/lib/imageCache/imageCacheStore.ts
import { getDb } from '../storage/db';

export interface ImageCacheRecord {
  url: string;
  blob: Blob;
  contentType: string;
  size: number;
  lastAccess: number;
  insertedAt: number;
}

const STORE = 'imageCache';

export async function getImageRecord(url: string): Promise<ImageCacheRecord | undefined> {
  const db = await getDb();
  return db.get(STORE, url) as Promise<ImageCacheRecord | undefined>;
}

export async function putImageRecord(record: ImageCacheRecord): Promise<void> {
  const db = await getDb();
  await db.put(STORE, record);
}

export async function deleteImageRecord(url: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, url);
}

export async function evictLRU(targetBytesToFree: number): Promise<{
  evictedUrls: string[];
  freedBytes: number;
}> {
  if (targetBytesToFree <= 0) return { evictedUrls: [], freedBytes: 0 };

  const db = await getDb();
  const tx = db.transaction(STORE, 'readwrite');
  const index = tx.store.index('by_lastAccess');

  const evictedUrls: string[] = [];
  let freedBytes = 0;

  let cursor = await index.openCursor();
  while (cursor && freedBytes < targetBytesToFree) {
    const rec = cursor.value as ImageCacheRecord;
    evictedUrls.push(rec.url);
    freedBytes += rec.size;
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
  return { evictedUrls, freedBytes };
}

export async function cursorSumSize(): Promise<number> {
  const db = await getDb();
  const tx = db.transaction(STORE, 'readonly');
  let total = 0;
  let cursor = await tx.store.openCursor();
  while (cursor) {
    total += (cursor.value as ImageCacheRecord).size;
    cursor = await cursor.continue();
  }
  await tx.done;
  return total;
}

export async function clearImageStore(): Promise<void> {
  const db = await getDb();
  await db.clear(STORE);
}
```

`getDb()`의 정확한 시그니처는 기존 `db.ts`에서 확인 후 맞춤. DB 타입 인터페이스에 `imageCache` store schema 추가 필요 (TypeScript IDB schema 타입).

- [ ] **Step 6: Run tests until green**

```bash
cd app && npm run test -- imageCacheStore
```

Expected: 모두 PASS. 타입 에러 시 `db.ts`의 `DBSchema` 타입에 `imageCache` 추가.

- [ ] **Step 7: 전체 type check**

```bash
cd app && npm run check
```

Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/imageCache/imageCacheStore.ts \
        app/src/lib/storage/db.ts \
        app/tests/unit/imageCache/imageCacheStore.test.ts
git commit -m "feat(imageCache): IDB store + by_lastAccess 인덱스 + LRU cursor"
```

---

## Task 2: ObjectURL pool

**Goal:** 같은 URL에 대해 같은 ObjectURL을 재사용하는 모듈-레벨 풀을 제공한다. evict 시 revoke를 호출자가 명시할 수 있게.

**Files:**
- Create: `app/src/lib/imageCache/objectUrlPool.ts`
- Create: `app/tests/unit/imageCache/objectUrlPool.test.ts`

**Acceptance Criteria:**
- [ ] `peek(url)` — 동기, 풀에 있으면 ObjectURL, 없으면 null
- [ ] `getOrCreate(url, blob)` — 풀에 있으면 그대로, 없으면 `URL.createObjectURL(blob)` 호출 + 등록 + 반환
- [ ] `revoke(url)` — 풀에서 제거 + `URL.revokeObjectURL` 호출
- [ ] `revokeAll()` — 모두 revoke + 풀 비우기
- [ ] 같은 url을 두 번 `getOrCreate`해도 `createObjectURL`은 1번만 호출

**Verify:** `cd app && npm run test -- objectUrlPool` → 모든 케이스 PASS

**Steps:**

- [ ] **Step 1: `objectUrlPool.test.ts` 작성**

```ts
// app/tests/unit/imageCache/objectUrlPool.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  peek,
  getOrCreate,
  revoke,
  revokeAll,
  __resetForTest,
} from '../../../src/lib/imageCache/objectUrlPool';

describe('objectUrlPool', () => {
  let createSpy: ReturnType<typeof vi.spyOn>;
  let revokeSpy: ReturnType<typeof vi.spyOn>;
  let counter = 0;

  beforeEach(() => {
    __resetForTest();
    counter = 0;
    createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:fake-${++counter}`);
    revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  it('peek on missing url returns null', () => {
    expect(peek('https://a/x.png')).toBeNull();
  });

  it('getOrCreate returns ObjectURL and registers it', () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    const url = getOrCreate('https://a/x.png', blob);
    expect(url).toBe('blob:fake-1');
    expect(peek('https://a/x.png')).toBe('blob:fake-1');
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('getOrCreate twice for same url → same ObjectURL, single create', () => {
    const blob = new Blob(['x']);
    const a = getOrCreate('https://a/x.png', blob);
    const b = getOrCreate('https://a/x.png', blob);
    expect(a).toBe(b);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('revoke removes from pool and calls revokeObjectURL', () => {
    const blob = new Blob(['x']);
    const u = getOrCreate('https://a/x.png', blob);
    revoke('https://a/x.png');
    expect(peek('https://a/x.png')).toBeNull();
    expect(revokeSpy).toHaveBeenCalledWith(u);
  });

  it('revoke on missing url is a no-op', () => {
    revoke('https://nope/x.png');
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('revokeAll clears pool and revokes each', () => {
    getOrCreate('https://a/1.png', new Blob(['x']));
    getOrCreate('https://a/2.png', new Blob(['y']));
    revokeAll();
    expect(peek('https://a/1.png')).toBeNull();
    expect(peek('https://a/2.png')).toBeNull();
    expect(revokeSpy).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests → FAIL (모듈 없음)**

```bash
cd app && npm run test -- objectUrlPool
```

- [ ] **Step 3: `objectUrlPool.ts` 작성**

```ts
// app/src/lib/imageCache/objectUrlPool.ts
const pool = new Map<string, string>();

export function peek(url: string): string | null {
  return pool.get(url) ?? null;
}

export function getOrCreate(url: string, blob: Blob): string {
  const existing = pool.get(url);
  if (existing) return existing;
  const obj = URL.createObjectURL(blob);
  pool.set(url, obj);
  return obj;
}

export function revoke(url: string): void {
  const obj = pool.get(url);
  if (!obj) return;
  URL.revokeObjectURL(obj);
  pool.delete(url);
}

export function revokeAll(): void {
  for (const obj of pool.values()) URL.revokeObjectURL(obj);
  pool.clear();
}

export function __resetForTest(): void {
  pool.clear();
}
```

- [ ] **Step 4: Run tests → PASS**

```bash
cd app && npm run test -- objectUrlPool
```

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/imageCache/objectUrlPool.ts \
        app/tests/unit/imageCache/objectUrlPool.test.ts
git commit -m "feat(imageCache): ObjectURL pool (모듈-레벨 재사용 + revoke)"
```

---

## Task 3: imageCache 공개 API (LRU + inflight dedup + appSettings)

**Goal:** Store + Pool 위에 공개 API를 만든다 — `lookupOrFetch`, `prime`, `getBlob`, `clearAll`, `getStats`, `setQuota`. quota/totalBytes는 appSettings에 저장.

**Files:**
- Modify: `app/src/lib/storage/appSettings.ts` — `imageCacheTotalBytes`, `imageCacheQuotaBytes` getter/setter 추가
- Create: `app/src/lib/imageCache/imageCache.ts`
- Create: `app/tests/unit/imageCache/imageCache.test.ts`

**Acceptance Criteria:**
- [ ] `prime(url, blob, contentType)` — store에 저장 + ObjectURL 풀 등록 + `totalBytes` 갱신
- [ ] `lookupOrFetch(url)` — 캐시 히트 시 `{src: ObjectURL, fromCache: true}` + `lastAccess` 비동기 갱신 (60초 디바운스)
- [ ] `lookupOrFetch` 미스 시 `fetch(url)` → 성공이면 prime → `{src: ObjectURL, fromCache: false}`; 실패면 `{src: url (원본), fromCache: false}`, 캐시 미저장
- [ ] 같은 URL 동시 호출 → fetch 1회만 (inflight Map)
- [ ] `getBlob(url)` — store에서 직접 blob 반환 (`lastAccess` 갱신 포함), 미스면 null
- [ ] `prime`/lookup-put 시 `totalBytes + newSize > quota`이면 LRU evict (단일 이미지가 quota 초과면 캐시 미저장 + 에러 없음)
- [ ] `clearAll()` — store 비우기 + 풀 revokeAll + `totalBytes = 0`
- [ ] `getStats()` — `{count, totalBytes, quotaBytes}`. 부팅 후 첫 호출 또는 명시적 보정 시 `cursorSumSize`로 정합성 검증
- [ ] `setQuota(bytes)` — 저장 + 새 한도 < 현재 사용량이면 즉시 evict

**Verify:** `cd app && npm run test -- imageCache.test` → 모든 케이스 PASS

**Steps:**

- [ ] **Step 1: `appSettings.ts` 확장**

Read 기존 `app/src/lib/storage/appSettings.ts` — 현재 key/value 패턴 파악. 같은 패턴으로 추가:

```ts
const KEY_IMAGE_CACHE_TOTAL_BYTES = 'imageCacheTotalBytes';
const KEY_IMAGE_CACHE_QUOTA_BYTES = 'imageCacheQuotaBytes';
const DEFAULT_IMAGE_CACHE_QUOTA = 500 * 1024 * 1024; // 500 MB

export async function getImageCacheTotalBytes(): Promise<number> {
  const v = await getSetting(KEY_IMAGE_CACHE_TOTAL_BYTES);
  return typeof v === 'number' ? v : 0;
}

export async function setImageCacheTotalBytes(bytes: number): Promise<void> {
  await setSetting(KEY_IMAGE_CACHE_TOTAL_BYTES, Math.max(0, bytes));
}

export async function getImageCacheQuotaBytes(): Promise<number> {
  const v = await getSetting(KEY_IMAGE_CACHE_QUOTA_BYTES);
  return typeof v === 'number' && v > 0 ? v : DEFAULT_IMAGE_CACHE_QUOTA;
}

export async function setImageCacheQuotaBytes(bytes: number): Promise<void> {
  await setSetting(KEY_IMAGE_CACHE_QUOTA_BYTES, Math.max(0, bytes));
}
```

함수명(`getSetting`/`setSetting`)은 기존 파일 컨벤션에 맞춰 조정.

- [ ] **Step 2: `imageCache.test.ts` 작성**

```ts
// app/tests/unit/imageCache/imageCache.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  lookupOrFetch,
  prime,
  getBlob,
  clearAll,
  getStats,
  setQuota,
  __resetForTest as resetCache,
} from '../../../src/lib/imageCache/imageCache';
import { __resetForTest as resetPool } from '../../../src/lib/imageCache/objectUrlPool';

function fakeBlob(bytes: number, type = 'image/png'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  indexedDB.deleteDatabase('tomboy-web');
  resetCache();
  resetPool();
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob) => `blob:${(b as any).size}-${Math.random()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as any;
  await setQuota(1000); // 작은 quota로 LRU 테스트
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('imageCache', () => {
  it('prime → lookupOrFetch returns fromCache:true', async () => {
    await prime('https://a/x.png', fakeBlob(100), 'image/png');
    const r = await lookupOrFetch('https://a/x.png');
    expect(r.fromCache).toBe(true);
    expect(r.src.startsWith('blob:')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lookupOrFetch miss → fetch + cache, returns fromCache:false', async () => {
    const blob = fakeBlob(100);
    fetchMock.mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(blob), headers: new Map([['content-type', 'image/png']]) });
    const r = await lookupOrFetch('https://a/x.png');
    expect(r.fromCache).toBe(false);
    expect(r.src.startsWith('blob:')).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    // 다음 호출은 히트
    const r2 = await lookupOrFetch('https://a/x.png');
    expect(r2.fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce(); // 여전히 1번
  });

  it('lookupOrFetch fetch failure → fallback to original url, no cache', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const r = await lookupOrFetch('https://a/x.png');
    expect(r.src).toBe('https://a/x.png');
    expect(r.fromCache).toBe(false);

    // 두 번째도 miss
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const r2 = await lookupOrFetch('https://a/x.png');
    expect(r2.fromCache).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('concurrent lookupOrFetch dedupes fetch', async () => {
    const blob = fakeBlob(100);
    fetchMock.mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(blob), headers: new Map() });
    const [a, b, c] = await Promise.all([
      lookupOrFetch('https://a/x.png'),
      lookupOrFetch('https://a/x.png'),
      lookupOrFetch('https://a/x.png'),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.src).toBe(b.src);
    expect(b.src).toBe(c.src);
  });

  it('prime over quota triggers LRU evict', async () => {
    // quota=1000, prime 400+400+400=1200 → 첫 항목 evict 필요
    await prime('https://a/1.png', fakeBlob(400), 'image/png');
    await new Promise(r => setTimeout(r, 5)); // lastAccess 순서 보장
    await prime('https://a/2.png', fakeBlob(400), 'image/png');
    await new Promise(r => setTimeout(r, 5));
    await prime('https://a/3.png', fakeBlob(400), 'image/png');

    const stats = await getStats();
    expect(stats.totalBytes).toBeLessThanOrEqual(1000);
    expect(stats.count).toBe(2); // 1번 evict됨
    expect(await getBlob('https://a/1.png')).toBeNull();
    expect(await getBlob('https://a/3.png')).not.toBeNull();
  });

  it('single image larger than quota → cached: false, no error', async () => {
    await setQuota(100);
    await prime('https://a/big.png', fakeBlob(500), 'image/png'); // no throw
    const stats = await getStats();
    expect(stats.count).toBe(0);
    expect(stats.totalBytes).toBe(0);
  });

  it('clearAll empties store and pool', async () => {
    await prime('https://a/x.png', fakeBlob(100), 'image/png');
    await clearAll();
    const s = await getStats();
    expect(s.count).toBe(0);
    expect(s.totalBytes).toBe(0);
    expect(await getBlob('https://a/x.png')).toBeNull();
  });

  it('setQuota shrink → immediate evict to fit', async () => {
    await prime('https://a/1.png', fakeBlob(400), 'image/png');
    await new Promise(r => setTimeout(r, 5));
    await prime('https://a/2.png', fakeBlob(400), 'image/png');
    await setQuota(500);
    const s = await getStats();
    expect(s.totalBytes).toBeLessThanOrEqual(500);
    expect(s.quotaBytes).toBe(500);
  });

  it('getBlob returns blob on hit, null on miss', async () => {
    await prime('https://a/x.png', fakeBlob(100), 'image/png');
    const b = await getBlob('https://a/x.png');
    expect(b).not.toBeNull();
    expect(b?.size).toBe(100);
    expect(await getBlob('https://nope/x.png')).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests → FAIL**

```bash
cd app && npm run test -- imageCache.test
```

- [ ] **Step 4: `imageCache.ts` 작성**

```ts
// app/src/lib/imageCache/imageCache.ts
import {
  getImageRecord,
  putImageRecord,
  deleteImageRecord,
  evictLRU,
  cursorSumSize,
  clearImageStore,
  type ImageCacheRecord,
} from './imageCacheStore';
import * as pool from './objectUrlPool';
import {
  getImageCacheTotalBytes,
  setImageCacheTotalBytes,
  getImageCacheQuotaBytes,
  setImageCacheQuotaBytes,
} from '../storage/appSettings';

export interface LookupResult {
  src: string;
  fromCache: boolean;
}

const inflight = new Map<string, Promise<LookupResult>>();
const lastAccessWriteAt = new Map<string, number>();
const LAST_ACCESS_DEBOUNCE_MS = 60_000;

let totalBytesCache: number | null = null; // 부팅 후 첫 stats 호출 때 보정

async function readTotal(): Promise<number> {
  if (totalBytesCache !== null) return totalBytesCache;
  totalBytesCache = await getImageCacheTotalBytes();
  return totalBytesCache;
}

async function writeTotal(bytes: number): Promise<void> {
  totalBytesCache = bytes;
  await setImageCacheTotalBytes(bytes);
}

async function makeRoom(newSize: number, quota: number): Promise<boolean> {
  let total = await readTotal();
  if (total + newSize <= quota) return true;

  const need = total + newSize - quota;
  const { evictedUrls, freedBytes } = await evictLRU(need);
  for (const u of evictedUrls) pool.revoke(u);
  total = Math.max(0, total - freedBytes);
  await writeTotal(total);

  return total + newSize <= quota;
}

export async function prime(url: string, blob: Blob, contentType: string): Promise<void> {
  const size = blob.size;
  const quota = await getImageCacheQuotaBytes();

  if (size > quota) return; // 단일 이미지가 quota 초과 — silent skip

  const existing = await getImageRecord(url);
  if (existing) {
    // 덮어쓰기: 기존 size 빼고 새 size 더함
    await writeTotal(Math.max(0, (await readTotal()) - existing.size));
    pool.revoke(url);
  }

  const ok = await makeRoom(size, quota);
  if (!ok) return; // evict 다 했는데도 못 들어감 (단일 이미지 too large 보호)

  const now = Date.now();
  const rec: ImageCacheRecord = {
    url, blob, contentType, size, lastAccess: now, insertedAt: now,
  };
  await putImageRecord(rec);
  await writeTotal((await readTotal()) + size);
  pool.getOrCreate(url, blob); // 풀에 미리 등록
}

async function bumpLastAccess(url: string): Promise<void> {
  const now = Date.now();
  const last = lastAccessWriteAt.get(url) ?? 0;
  if (now - last < LAST_ACCESS_DEBOUNCE_MS) return;
  lastAccessWriteAt.set(url, now);

  const rec = await getImageRecord(url);
  if (!rec) return;
  rec.lastAccess = now;
  await putImageRecord(rec);
}

export async function lookupOrFetch(url: string): Promise<LookupResult> {
  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = (async (): Promise<LookupResult> => {
    const rec = await getImageRecord(url);
    if (rec) {
      bumpLastAccess(url).catch(() => {});
      return { src: pool.getOrCreate(url, rec.blob), fromCache: true };
    }
    try {
      const res = await fetch(url);
      if (!res.ok) return { src: url, fromCache: false };
      const blob = await res.blob();
      const contentType = res.headers.get('content-type') ?? blob.type ?? 'application/octet-stream';
      await prime(url, blob, contentType).catch(() => {});
      return { src: pool.getOrCreate(url, blob), fromCache: false };
    } catch {
      return { src: url, fromCache: false };
    }
  })();

  inflight.set(url, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(url);
  }
}

export async function getBlob(url: string): Promise<Blob | null> {
  const rec = await getImageRecord(url);
  if (!rec) return null;
  bumpLastAccess(url).catch(() => {});
  return rec.blob;
}

export async function clearAll(): Promise<void> {
  await clearImageStore();
  pool.revokeAll();
  lastAccessWriteAt.clear();
  await writeTotal(0);
}

export async function getStats(): Promise<{
  count: number;
  totalBytes: number;
  quotaBytes: number;
}> {
  // 첫 호출이면 cursor scan으로 정합성 보정
  const actual = await cursorSumSize();
  const cached = await readTotal();
  if (cached !== actual) await writeTotal(actual);

  // count는 별도 cursor 불필요한 경우 — 간단히 store cursor count
  const { count } = await countAndSize();
  return { count, totalBytes: actual, quotaBytes: await getImageCacheQuotaBytes() };
}

async function countAndSize(): Promise<{ count: number; bytes: number }> {
  // cursorSumSize와 합칠 수 있지만 정합성 명확성 위해 분리 — 작은 N이라 비용 미미
  const { default: _ } = await import('idb');
  // 실제 구현: store.count + cursor — 헬퍼를 imageCacheStore로 빼도 됨
  // (실 구현에서는 imageCacheStore에 `countRecords()`도 추가 권장)
  return { count: 0, bytes: 0 };
}

export async function setQuota(bytes: number): Promise<void> {
  const clamped = Math.max(0, Math.floor(bytes));
  await setImageCacheQuotaBytes(clamped);
  // 즉시 evict로 새 한도 맞춤
  const total = await readTotal();
  if (total > clamped) {
    const need = total - clamped;
    const { evictedUrls, freedBytes } = await evictLRU(need);
    for (const u of evictedUrls) pool.revoke(u);
    await writeTotal(Math.max(0, total - freedBytes));
  }
}

export function __resetForTest(): void {
  inflight.clear();
  lastAccessWriteAt.clear();
  totalBytesCache = null;
}
```

**중요**: 위 `countAndSize` placeholder는 구현 시 `imageCacheStore.ts`에 `countRecords(): Promise<number>` 헬퍼를 추가하고 호출하는 것으로 바꿀 것. Step 5에서 함께 처리.

- [ ] **Step 5: `imageCacheStore.ts`에 `countRecords` 추가**

```ts
// imageCacheStore.ts 끝에 추가
export async function countRecords(): Promise<number> {
  const db = await getDb();
  return db.count(STORE);
}
```

`imageCache.ts`의 `getStats`에서 사용:

```ts
import { countRecords } from './imageCacheStore';
// ...
export async function getStats(): Promise<...> {
  const actual = await cursorSumSize();
  const cached = await readTotal();
  if (cached !== actual) await writeTotal(actual);
  const count = await countRecords();
  return { count, totalBytes: actual, quotaBytes: await getImageCacheQuotaBytes() };
}
```

(`countAndSize` 함수와 `import idb` 라인 삭제)

- [ ] **Step 6: Run tests → PASS**

```bash
cd app && npm run test -- imageCache.test
```

전부 PASS까지 디버깅. 특히 LRU evict 테스트는 `lastAccess` 타임스탬프 ordering이 5ms gap으로 확실히 분리되는지 확인.

- [ ] **Step 7: 전체 type check**

```bash
cd app && npm run check
```

Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/imageCache/imageCache.ts \
        app/src/lib/imageCache/imageCacheStore.ts \
        app/src/lib/storage/appSettings.ts \
        app/tests/unit/imageCache/imageCache.test.ts
git commit -m "feat(imageCache): 공개 API (lookupOrFetch/prime/getBlob) + LRU + inflight dedup"
```

---

## Task 4: 업로드 prime + OCR cache wrap (둘 다 imageUpload.ts)

**Goal:** `uploadImageToDropbox`가 업로드 직후 `prime`을 호출하고, `downloadImageFromDropboxUrl`이 SDK fetch 전에 cache lookup하도록 만든다.

**Files:**
- Modify: `app/src/lib/sync/imageUpload.ts:165` 근처 (`downloadImageFromDropboxUrl`) + 업로드 함수 끝

**Acceptance Criteria:**
- [ ] `uploadImageToDropbox` 성공 후 `imageCache.prime(url, blob, contentType)` 호출 (`.catch(() => {})`로 캐시 실패는 swallow)
- [ ] `downloadImageFromDropboxUrl(url)` 시작 시 `imageCache.getBlob(url)` 먼저 시도; null 아니면 그대로 반환
- [ ] Cache miss → 기존 SDK 호출 → 결과 blob을 `prime`으로 캐시 (실패 swallow)
- [ ] 기존 호출자 시그니처 무변경 (반환 타입 동일: `Promise<Blob>`)

**Verify:**
1. `cd app && npm run check` → 0 errors
2. `cd app && npm run test` → 기존 테스트 깨지지 않음
3. (수동) 큰 이미지 붙여넣고 DevTools Network 탭에서 `<img>` Dropbox GET 요청이 안 나가는지 확인

**Steps:**

- [ ] **Step 1: 현재 `imageUpload.ts:165-185` Read**

`uploadImageToDropbox` 끝과 `downloadImageFromDropboxUrl` 정의 확인.

- [ ] **Step 2: import 추가**

`imageUpload.ts` 상단에:

```ts
import { prime as cachePrime, getBlob as cacheGetBlob } from '../imageCache/imageCache';
```

- [ ] **Step 3: 업로드 끝에 prime 호출**

`uploadImageToDropbox` 함수에서 최종 URL 반환 직전:

```ts
const finalUrl = toDirectImageUrl(sharedLinkUrl);
cachePrime(finalUrl, file, file.type).catch((err) => {
  console.warn('[imageCache] prime failed', err);
});
return finalUrl;
```

정확한 변수명(`sharedLinkUrl`, `file`)은 Read 결과에 맞춤.

- [ ] **Step 4: `downloadImageFromDropboxUrl` 캐시 wrap**

```ts
export async function downloadImageFromDropboxUrl(url: string): Promise<Blob> {
  const cached = await cacheGetBlob(url);
  if (cached) return cached;

  const dbx = /* 기존 코드 그대로 */;
  const res = await dbx.sharingGetSharedLinkFile({ url });
  const blob = res.result.fileBlob as Blob; // 정확한 path는 Read 결과 확인
  cachePrime(url, blob, blob.type || 'application/octet-stream').catch((err) => {
    console.warn('[imageCache] prime after download failed', err);
  });
  return blob;
}
```

- [ ] **Step 5: Type check**

```bash
cd app && npm run check
```

- [ ] **Step 6: 기존 테스트 회귀 확인**

```bash
cd app && npm run test
```

Expected: 새 실패 없음.

- [ ] **Step 7: 수동 검증 (선택, 빠른 sanity)**

`npm run dev` → 노트 열고 큰 이미지 붙여넣기 → DevTools Network 탭에서:
- 업로드 후 `<img>`가 표시될 때 Dropbox GET 요청이 발생하지 않아야 함
- 노트를 닫았다가 다시 열면 마찬가지로 GET 요청 없음 (캐시 히트)

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/sync/imageUpload.ts
git commit -m "feat(imageCache): 업로드 후 prime + downloadImageFromDropboxUrl 캐시 wrap"
```

---

## Task 5: imagePreviewPlugin 통합 (sync peek + async lookup)

**Goal:** 위젯 데코레이션이 `<img>`를 만들 때 sync ObjectURL pool을 먼저 확인하고, miss면 비동기 `lookupOrFetch`로 캐시 채움. 플리커 없이 원본 URL을 fallback으로 사용.

**Files:**
- Modify: `app/src/lib/editor/imagePreview/imagePreviewPlugin.ts` — `renderImagePreview` 함수
- Create: `app/tests/unit/editor/imagePreviewPluginCache.test.ts`

**Acceptance Criteria:**
- [ ] `<img>` 생성 시 `pool.peek(href)`로 동기 확인 → 있으면 ObjectURL을 src로 즉시 사용
- [ ] 미스 → `src = href` (원본) + 백그라운드 `lookupOrFetch(href)` 호출
- [ ] resolve 후 `fromCache && src !== href`이면 `img.src` 교체
- [ ] fetch 실패 시 `img.src`는 원본 URL 유지 (현재와 동일 거동)
- [ ] 같은 URL이 한 노트에 여러 번 등장해도 위젯 키는 그대로 (PM이 재생성 안 함)

**Verify:** `cd app && npm run test -- imagePreviewPluginCache` → 모든 케이스 PASS + `npm run check` → 0 errors

**Steps:**

- [ ] **Step 1: 현재 `imagePreviewPlugin.ts:116` 근처 Read**

`renderImagePreview` 시그니처 + `<img>` 생성 코드 확인. 함수가 sync인지 async인지 확인 (PM widget builder는 보통 sync).

- [ ] **Step 2: 테스트 작성 (실패하는)**

```ts
// app/tests/unit/editor/imagePreviewPluginCache.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

// renderImagePreview를 직접 export하지 않으면 plugin 통합 테스트로 대체.
// 가능하면 renderImagePreview를 export하거나 별도 헬퍼로 분리.
import { renderImagePreview } from '../../../src/lib/editor/imagePreview/imagePreviewPlugin';
import * as cache from '../../../src/lib/imageCache/imageCache';
import * as pool from '../../../src/lib/imageCache/objectUrlPool';

describe('imagePreviewPlugin cache integration', () => {
  beforeEach(() => {
    indexedDB.deleteDatabase('tomboy-web');
    pool.__resetForTest();
    cache.__resetForTest();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('sync pool hit → img.src is ObjectURL immediately', () => {
    pool.getOrCreate('https://a/x.png', new Blob(['x']));
    const img = renderImagePreview('https://a/x.png');
    expect(img.src).toBe('blob:fake');
  });

  it('miss → img.src is original href, then replaced after lookup resolves', async () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    const lookupSpy = vi.spyOn(cache, 'lookupOrFetch').mockResolvedValue({
      src: 'blob:resolved', fromCache: false,
    });
    const img = renderImagePreview('https://a/y.png');
    expect(img.src).toBe('https://a/y.png');
    // 비동기 resolve 대기
    await Promise.resolve();
    await Promise.resolve();
    expect(lookupSpy).toHaveBeenCalledWith('https://a/y.png');
    // src 교체 확인
    expect(img.src).toBe('blob:resolved');
  });

  it('lookup returns fromCache:false + src=href → src unchanged', async () => {
    vi.spyOn(cache, 'lookupOrFetch').mockResolvedValue({
      src: 'https://a/z.png', fromCache: false,
    });
    const img = renderImagePreview('https://a/z.png');
    await new Promise(r => setTimeout(r, 0));
    expect(img.src).toBe('https://a/z.png');
  });
});
```

- [ ] **Step 3: Plugin 코드 수정**

`renderImagePreview` 안에서 `<img>` 생성 후:

```ts
const img = document.createElement('img');
img.loading = 'lazy';

const sync = pool.peek(href);
if (sync) {
  img.src = sync;
} else {
  img.src = href; // fallback
  imageCache.lookupOrFetch(href).then((r) => {
    if (r.src !== img.src) img.src = r.src;
  }).catch(() => {
    // 캐시 실패는 fallback URL 유지
  });
}
// ... 기존 코드 (className, onclick 등) 유지
return img;
```

import 추가:

```ts
import * as pool from '../../imageCache/objectUrlPool';
import * as imageCache from '../../imageCache/imageCache';
```

`renderImagePreview`가 export되어 있지 않다면 export 추가 (테스트에서 import 가능하게).

- [ ] **Step 4: Run tests → PASS**

```bash
cd app && npm run test -- imagePreviewPluginCache
```

- [ ] **Step 5: Type check + 전체 회귀**

```bash
cd app && npm run check
cd app && npm run test
```

Expected: 새 실패 없음.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/imagePreview/imagePreviewPlugin.ts \
        app/tests/unit/editor/imagePreviewPluginCache.test.ts
git commit -m "feat(imageCache): imagePreviewPlugin sync peek + async lookup 통합"
```

---

## Task 6: 설정 페이지 UI (사용량/한도/비우기)

**Goal:** 설정 페이지에 이미지 캐시 사용량, 한도 조절, 캐시 비우기 UI를 추가한다.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` — 동기화 섹션 근처에 새 블록

**Acceptance Criteria:**
- [ ] "이미지 캐시" 섹션 표시: `사용 중: NNN MB / NNN MB (M개)` 형식
- [ ] 한도 input (number, MB 단위, 100 ~ 5000 range) — 변경 시 `setQuota(value * 1024 * 1024)` 호출
- [ ] "캐시 비우기" 버튼 — `confirm` 다이얼로그 후 `clearAll()` + toast + 통계 새로고침
- [ ] 페이지 mount 시 `getStats()`로 초기 표시; 한도 변경/비우기 후 재호출
- [ ] Korean UI strings, `clamp(...)` 사이징 컨벤션 따름 (CLAUDE.md)

**Verify:**
1. `cd app && npm run check` → 0 errors
2. (수동) 설정 페이지에서 통계가 정확히 표시되고, 한도 변경/비우기가 즉시 반영됨

**Steps:**

- [ ] **Step 1: 현재 `settings/+page.svelte` 구조 Read**

동기화 섹션 위치, 기존 toast/confirm 패턴 확인.

- [ ] **Step 2: 새 블록 추가**

```svelte
<script lang="ts">
  // 기존 import 아래
  import { getStats, setQuota, clearAll } from '$lib/imageCache/imageCache';
  import { toast } from '$lib/stores/toast';

  let stats = $state<{ count: number; totalBytes: number; quotaBytes: number } | null>(null);
  let quotaMbInput = $state(500);

  async function refreshStats() {
    stats = await getStats();
    quotaMbInput = Math.round(stats.quotaBytes / (1024 * 1024));
  }

  $effect(() => {
    refreshStats();
  });

  function formatMb(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(1);
  }

  async function handleQuotaChange() {
    const clamped = Math.max(100, Math.min(5000, Math.floor(quotaMbInput)));
    await setQuota(clamped * 1024 * 1024);
    await refreshStats();
    toast.show(`이미지 캐시 한도 ${clamped}MB로 변경`);
  }

  async function handleClear() {
    if (!confirm('이미지 캐시를 모두 비우시겠습니까?')) return;
    await clearAll();
    await refreshStats();
    toast.show('이미지 캐시 비움');
  }
</script>

<!-- 동기화 섹션 아래 어딘가 -->
<section class="image-cache-section">
  <h2>이미지 캐시</h2>
  {#if stats}
    <p class="usage">
      사용 중: <strong>{formatMb(stats.totalBytes)}MB</strong> /
      {formatMb(stats.quotaBytes)}MB ({stats.count}개)
    </p>
    <label>
      한도 (MB):
      <input
        type="number"
        min="100"
        max="5000"
        step="50"
        bind:value={quotaMbInput}
        onchange={handleQuotaChange}
      />
    </label>
    <button type="button" onclick={handleClear}>캐시 비우기</button>
  {:else}
    <p>불러오는 중…</p>
  {/if}
</section>

<style>
  .image-cache-section {
    padding: clamp(0.5rem, 2vw, 1rem);
    /* 기존 섹션 컨벤션 따름 */
  }
  .image-cache-section .usage {
    font-size: clamp(0.85rem, 2.5vw, 1rem);
  }
</style>
```

기존 settings 페이지의 섹션 컨벤션(클래스명, 마크업 wrapper 등)에 맞춰 조정.

- [ ] **Step 3: Type check**

```bash
cd app && npm run check
```

- [ ] **Step 4: 수동 검증**

```bash
cd app && npm run dev
```

브라우저에서 `/settings` → "이미지 캐시" 섹션 보이고, 통계 표시되고, 한도 변경/비우기 동작 확인.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "feat(imageCache): 설정 페이지 — 사용량/한도/비우기 UI"
```

---

## Task 7: /admin/tools "이미지 캐시 비우기" 액션

**Goal:** 관리자 도구 페이지에 이미지 캐시 비우기 액션을 동일하게 추가 (관리자 도구 일관성).

**Files:**
- Modify: `app/src/routes/admin/tools/+page.svelte`

**Acceptance Criteria:**
- [ ] 기존 도구 액션 목록에 "이미지 캐시 비우기" 추가 (zip 백업 등과 같은 패턴)
- [ ] 클릭 시 확인 다이얼로그 + `clearAll()` + toast
- [ ] 사용량 정보도 함께 표시 (선택)

**Verify:**
1. `cd app && npm run check` → 0 errors
2. (수동) `/admin/tools`에서 액션 보이고 동작

**Steps:**

- [ ] **Step 1: 기존 `admin/tools/+page.svelte` Read**

zip 백업/기타 액션의 마크업 패턴 확인.

- [ ] **Step 2: 액션 추가**

```svelte
<script lang="ts">
  // 기존 import 옆
  import { clearAll, getStats } from '$lib/imageCache/imageCache';

  let imageCacheStats = $state<{ count: number; totalBytes: number; quotaBytes: number } | null>(null);

  $effect(() => {
    getStats().then((s) => (imageCacheStats = s));
  });

  async function handleClearImageCache() {
    if (!confirm('이미지 캐시를 모두 비우시겠습니까?')) return;
    await clearAll();
    imageCacheStats = await getStats();
    toast.show('이미지 캐시 비움');
  }
</script>

<!-- 기존 도구 액션 옆 -->
<section>
  <h3>이미지 캐시</h3>
  {#if imageCacheStats}
    <p>현재 {(imageCacheStats.totalBytes / 1024 / 1024).toFixed(1)}MB ({imageCacheStats.count}개)</p>
  {/if}
  <button type="button" onclick={handleClearImageCache}>이미지 캐시 비우기</button>
</section>
```

- [ ] **Step 3: Type check**

```bash
cd app && npm run check
```

- [ ] **Step 4: 수동 검증**

`/admin/tools`에서 액션 보이고 동작 확인.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/admin/tools/+page.svelte
git commit -m "feat(imageCache): /admin/tools — 이미지 캐시 비우기 액션"
```

---

## Self-Review Notes

**Spec coverage check** — 모든 spec 섹션이 task로 mapping됨:
- IDB schema → Task 1
- 공개 API → Task 3
- LRU 알고리즘 → Task 3
- 동시성 (inflight dedup) → Task 3
- Stale URL 처리 → Task 3 (lookupOrFetch fetch 실패 경로)
- ObjectURL 라이프사이클 → Task 2 (pool) + Task 3 (evict 시 revoke)
- 통합 지점 4곳 → Task 4 (imageUpload + OCR), Task 5 (plugin), Task 6/7 (UI)
- Migration → 모든 task에서 빈 캐시로 시작 (별도 작업 없음, spec 그대로)
- 디폴트 quota 500MB → Task 3 (appSettings 디폴트)

**Type consistency** — API 시그니처가 task 간 일치 확인:
- `lookupOrFetch(url) → {src, fromCache}` (Task 3 정의, Task 5에서 사용) ✓
- `prime(url, blob, contentType)` (Task 3, Task 4) ✓
- `getBlob(url) → Blob | null` (Task 3, Task 4) ✓
- `clearAll()` (Task 3, Task 6, Task 7) ✓
- `getStats() → {count, totalBytes, quotaBytes}` (Task 3, Task 6, Task 7) ✓
- `setQuota(bytes)` (Task 3, Task 6) ✓

**User-gate scan**: spec과 task 모두에 user-gate 신호 없음 (Nouns/Scope 미발견, Verbs only). 일반 task로 처리.
