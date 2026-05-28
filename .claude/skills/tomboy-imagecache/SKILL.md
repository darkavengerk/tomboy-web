---
name: tomboy-imagecache
description: Use when working on the in-note image cache (`app/src/lib/imageCache/`) — IDB-backed persistent blob cache + LRU + ObjectURL pool + pluggable fetcher registry. Covers the public API (`lookupOrFetch`/`prime`/`getBlob`/`clearAll`/`getStats`/`setQuota`), the four integration points (`imageUpload.ts` upload-prime + OCR-download wrap, `imagePreviewPlugin.ts` sync-peek+async-lookup, `/settings`+`/admin/tools` UI), the ImageFetcher interface that solves the `www.dropbox.com` CORS problem, the LRU + quota policy, the DB v3→v4 migration, the cache-key canonicalization invariant (`?raw=1` byte-identical), and the test-isolation patterns (generation counter, fake-indexeddb).
---

# Image Cache

Persistent IndexedDB cache of image blobs so that:
- **Just-uploaded images** never re-download (prime at upload time)
- **Notes opened on this device** keep cached blobs across reloads
- **OCR re-runs** read from cache instead of re-downloading

## Module layout

```
app/src/lib/imageCache/
├── imageCacheStore.ts      # IDB CRUD + by-lastAccess cursor + evictLRU
├── objectUrlPool.ts        # Module-level Map<url, ObjectURL>
├── imageCache.ts           # Public API + LRU + inflight dedup
└── fetchers/
    ├── types.ts            # ImageFetcher interface
    ├── registry.ts         # register / unregister / findFetcher
    ├── dropboxFetcher.ts   # Dropbox SDK route (CORS workaround)
    └── install.ts          # installImageFetchers() — call from root layout
```

Tests in `app/tests/unit/imageCache/` + `app/tests/unit/editor/imagePreviewPluginCache.test.ts`.

## Public API

```ts
// imageCache.ts
async function lookupOrFetch(url: string): Promise<{
  src: string;        // ObjectURL on hit / fetched OK / fallback to original url
  fromCache: boolean;
}>;

async function prime(url: string, blob: Blob, contentType: string): Promise<void>;
async function getBlob(url: string): Promise<Blob | null>;
async function clearAll(): Promise<void>;
async function getStats(): Promise<{ count, totalBytes, quotaBytes }>;
async function setQuota(bytes: number): Promise<void>;

// objectUrlPool.ts
function peek(url: string): string | null;          // sync, no fetch
function getOrCreate(url: string, blob: Blob): string;
function revoke(url: string): void;
function revokeAll(): void;
```

## Why a fetcher registry (the CORS problem)

`www.dropbox.com/scl/...?raw=1` works as `<img src>` (cross-origin **image** loads bypass CORS) but **fails under `fetch()`** — Dropbox edges return 302 with no `Access-Control-Allow-Origin`. So a naive `fetch(url)` cache-fill path produces a sea of red CORS errors and **silently empty cache** while images still display via `<img>`.

The Dropbox SDK's `sharingGetSharedLinkFile` routes through `api.dropboxapi.com` / `content.dropboxapi.com`, which DO send CORS headers. So Dropbox URLs need a different fetch strategy than plain CDNs.

**The registry pattern:**

```ts
interface ImageFetcher {
  name: string;                          // for logging + unregistration
  matches(url: string): boolean;         // URL host/pattern check
  fetch(url: string): Promise<Blob>;     // throw on failure
}

registerFetcher(f);          // first-match-wins by registration order
unregisterFetcher(name);
findFetcher(url): ImageFetcher | null;
```

`lookupOrFetch` miss → `findFetcher(url)?.fetch(url) ?? fetch(url)`. Plain `fetch()` is the fallback for plain-CORS hosts (CDNs, R2, S3 public buckets).

**To add a new source** (e.g. Vercel Blob): create `fetchers/vercelBlobFetcher.ts` exporting an `ImageFetcher`, then add `registerFetcher(vercelBlobFetcher)` to `fetchers/install.ts`. Nothing else changes.

## LRU + quota

```ts
// app/src/lib/storage/appSettings.ts
imageCacheTotalBytes   // hint; ground truth is cursorSumSize over IDB
imageCacheQuotaBytes   // default 500 * 1024 * 1024
```

`prime` flow:

```
existing? subtract existing.size + pool.revoke(url)
if (newSize > quota) return        // single image > quota → silent skip
while (total + newSize > quota):
  evict oldest by-lastAccess + pool.revoke(evictedUrl)
putImageRecord + pool.getOrCreate(url, blob)
```

`lookupOrFetch` cache hit fires fire-and-forget `lastAccess = now` with **60s per-url debounce** (`lastAccessWriteAt: Map<url, ms>`). `getStats` reconciles `totalBytes` via `cursorSumSize` on every call → drift self-heals.

## ObjectURL pool

Module-level `Map<url, ObjectURL>`. Same URL → same ObjectURL. Pool persists for tab lifetime; SPA navigation doesn't revoke (multiple notes may reference the same image). Revoke triggers:
- LRU evict (in `prime`)
- `clearAll()` → `revokeAll()`
- `setQuota` shrink eviction

## Integration points

| File | What it does | Why |
|---|---|---|
| `lib/sync/imageUpload.ts` `uploadImageToDropbox` end | `cachePrime(finalUrl, file, file.type).catch(...)` | Cache filled before the URL is even visible — zero round-trip for the immediate render |
| `lib/sync/imageUpload.ts` `downloadImageFromDropboxUrl` | `cacheGetBlob(url)` → on miss `dropboxFetcher.fetch(url)` → `cachePrime` | OCR / cross-device path |
| `lib/editor/imagePreview/imagePreviewPlugin.ts` `renderImagePreview` | `pool.peek(href)` sync hit → ObjectURL src; else `img.src = href` + async `lookupOrFetch` → swap src | Widget rendering — sync hit avoids flicker; miss falls back to original URL (current behavior) while cache fills |
| `routes/settings/+page.svelte` + `routes/admin/tools/+page.svelte` | `getStats`/`setQuota`/`clearAll` UI | Usage display, quota slider (100–5000 MB), clear button |

## Root-layout init

`app/src/routes/+layout.svelte` calls `installImageFetchers()` once in `onMount` — registers `dropboxFetcher`. Idempotent (re-registering same `name` replaces the entry).

## IDB schema

```ts
// app/src/lib/storage/db.ts — DB_VERSION = 4
imageCache: {
  key: string;          // url (cache key)
  value: ImageCacheRecord { url, blob, contentType, size, lastAccess, insertedAt };
  indexes: { 'by-lastAccess': number };  // ascending cursor for LRU
}
```

Migration is gated by `if (oldVersion < 4)` — existing notes/manifests untouched.

## Cross-cutting invariants

- **Cache key = exact URL string post-`toDirectImageUrl`.** Same `?raw=1`-appended form is written to note body, captured by `imagePreviewPlugin`'s URL regex, and used by `lookupOrFetch`. **Do not normalize the key anywhere downstream** — even reordering query params breaks the cache silently.
- **`www.dropbox.com` is fetchable by `<img>` only, not by `fetch()`.** This is the load-bearing constraint that justifies the whole fetcher registry. If you ever see "plain fetch works for Dropbox in tests" — you're hitting jsdom not browser CORS.
- **`prime`/`cachePrime` is fire-and-forget with `.catch(console.warn)`.** Cache failure must NEVER block upload or download flows. Don't `await` it in caller without `.catch`.
- **`lookupOrFetch` returns the original URL as fallback on any failure path** (404, CORS, fetcher throw). Browser then loads via `<img src>` as before — broken cache never degrades the visible UX.
- **`lastAccess` writes are debounced 60s per URL** to keep IDB write rate low. LRU accuracy degrades slightly but no data corruption.
- **Single image > quota → silent skip.** No throw, no partial write. Caller still gets a working `lookupOrFetch` (network fetch every time, but it works).
- **Cross-device prefetch is intentionally NOT implemented.** New images from sync are filled lazily on first render. If you find yourself adding prefetch loops, you're outside spec — discuss first.
- **DB-pulled notes don't trigger `prime`.** Only direct user paste does. The closed-note backlog stays unpopulated until opened (acceptable per spec).
- **Inflight dedup via `Map<url, Promise>`.** Concurrent `lookupOrFetch(sameUrl)` shares one fetch; entry deleted in `finally` (covers rejection too).

## Tests

- `imageCacheStore.test.ts` — IDB CRUD + LRU cursor
- `objectUrlPool.test.ts` — peek/getOrCreate/revoke/revokeAll
- `imageCache.test.ts` — full API + fetcher chain integration (registered fetcher used / fetcher throw fallback / no match → plain fetch)
- `fetchers/registry.test.ts` — register/unregister/first-match-wins/throwing matches() safety
- `editor/imagePreviewPluginCache.test.ts` — sync hit, async miss-replace, fetch-fail src-unchanged

**Test setup pattern** (every IDB test):

```ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { _resetDBForTest } from '$lib/storage/db.js';
import { __resetForTest as resetCache } from '$lib/imageCache/imageCache.js';
import { __resetForTest as resetPool } from '$lib/imageCache/objectUrlPool.js';
import { __resetForTest as resetFetchers } from '$lib/imageCache/fetchers/registry.js';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  _resetDBForTest();
  resetCache();
  resetPool();
  resetFetchers();
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => `blob:${(b as Blob).size}-${Math.random()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
```

**Generation counter** in `imageCache.__resetForTest` (`generation++`) prevents fire-and-forget `bumpLastAccess` continuations from a prior test from writing into the next test's IDB. Production path never bumps `generation` so it adds zero overhead.

**`fake-indexeddb` quirk**: `structuredClone` in jsdom does not preserve `Blob.size` getter through IDB round-trips. Tests assert `got?.blob` exists (truthy) instead of `got?.blob.size === N`. Real browsers preserve it.

## Debug signals

| Symptom | Suspect |
|---|---|
| `npm run dev`: CORS errors flooding console + cache count stays 0 for non-paste images | Dropbox fetcher not registered. Check `installImageFetchers()` in `+layout.svelte` onMount. |
| Cache count grows for paste but not for sync'd notes | Same — fetcher missing or `matches()` not catching the URL host |
| Cache exists but image still blinks on load | `pool.peek(href)` returning null synchronously — peek runs before `lookupOrFetch` resolves; pool entry exists only after first miss-fill or explicit prime. Page reload after first render warms pool from IDB. |
| Cache count > 0 but `getStats().totalBytes` is wrong | `imageCacheTotalBytes` appSettings drift. `getStats` reconciles via `cursorSumSize` — call it to self-heal. |
| Quota change doesn't evict | `setQuota` only evicts if new < current usage. `setQuota(0)` clears via LRU. |
| Image deleted from Dropbox but cached version shows | Intentional — cache hit takes precedence. Spec acceptable trade-off. User clears via 설정 / 캐시 비우기. |

## What NOT to add

- **Cross-device prefetch** (background fill of all sync'd notes). Spec is lazy-fill. Discuss before implementing.
- **HEAD request to verify stale URLs** before serving cache. Negates the cache value entirely.
- **Service Worker fetch intercept**. Considered as Approach B during design and rejected — SW is reserved for push/PWA; OCR uses different domain (`api.dropboxapi.com`) which SW can't unify.
- **Self-registering fetchers** (module-level side effects). Use the explicit `installImageFetchers()` call in `+layout.svelte` — tree-shakable and testable.
- **Plain fetch as Dropbox primary path "just in case browser CORS changes"**. It hasn't and won't; the fetcher route is correct.

## Files

| Path | Role |
|---|---|
| `app/src/lib/imageCache/imageCache.ts` | Public API |
| `app/src/lib/imageCache/imageCacheStore.ts` | IDB layer |
| `app/src/lib/imageCache/objectUrlPool.ts` | ObjectURL pool |
| `app/src/lib/imageCache/fetchers/types.ts` | `ImageFetcher` interface |
| `app/src/lib/imageCache/fetchers/registry.ts` | register / unregister / findFetcher |
| `app/src/lib/imageCache/fetchers/dropboxFetcher.ts` | Dropbox SDK fetcher |
| `app/src/lib/imageCache/fetchers/install.ts` | `installImageFetchers()` |
| `app/src/lib/storage/db.ts` | DB v4 migration |
| `app/src/lib/storage/appSettings.ts` | `imageCacheTotalBytes`, `imageCacheQuotaBytes` |
| `app/src/lib/sync/imageUpload.ts` | Upload + download wrapped with `prime`/`getBlob` |
| `app/src/lib/editor/imagePreview/imagePreviewPlugin.ts` | Widget rendering with sync peek + async lookup |
| `app/src/routes/settings/+page.svelte` | Usage + quota + clear UI |
| `app/src/routes/admin/tools/+page.svelte` | Admin clear action |
| `app/src/routes/+layout.svelte` | `installImageFetchers()` call site |

Spec: `docs/superpowers/specs/2026-05-26-image-cache-design.md`
Plan: `docs/superpowers/plans/2026-05-26-image-cache.md`
