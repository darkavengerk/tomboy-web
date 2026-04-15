---
name: tomboy-admin
description: Use when working on the /admin Dropbox sync operator UI (app/src/routes/admin/, lib/stores/adminCache.svelte.ts, lib/sync/adminClient.ts). Covers the dashboard, paginated revision browser, soft rollback, per-note history, raw Dropbox browser, and zip backup tools.
---

# Admin page

`/admin` is a desktop-oriented operator UI for inspecting and manipulating the
Dropbox sync state. It is **not** part of the normal mobile flow and is
intentionally excluded from the TopNav — entry is a link in the 설정 page's
"고급" section. Because all Dropbox credentials are in the user's own browser,
no extra auth gate is used; URL access is sufficient.

The mobile-first / `clamp(...)` sizing invariant does **not** apply here — the
admin pages use information-dense fixed layouts (grids, tables) because the
expected client is a desktop browser.

## Sub-pages

| Route                         | Purpose |
|-------------------------------|---------|
| `/admin`                      | dashboard: server rev, local last-sync rev, `server-id` match, paths |
| `/admin/revisions`            | paginated server-revision list (10 per page, load-more button) |
| `/admin/revisions/[rev]`      | per-rev added / modified / removed notes, line diff via `jsdiff`, soft-rollback button |
| `/admin/notes/[guid]`         | history of one note across the **currently cached** revs, per-rev preview, local restore |
| `/admin/browse`               | raw Dropbox `filesListFolder` + file content preview |
| `/admin/tools`                | local-IDB zip backup, full-history zip backup |

## Shared cache

`lib/stores/adminCache.svelte.ts` is a module-level `$state` cache that all
admin pages read from. It holds the root server manifest, the local sync
manifest, a `Map<rev, TomboyServerManifest | null>` of fetched per-revision
manifests, and pagination cursors. The cache survives client-side navigation
between admin tabs, so switching away and back does **not** refetch.
Explicit refresh is available as "새로고침" on the dashboard and "처음부터
다시 로드" on the revisions page.

Public API:

- `initAdminCache(forceRefresh?)` — idempotent entry; pages call this in `onMount`.
- `loadMoreRevs(count?)` — extends the paginated display list by fetching more
  per-rev manifests in parallel. Skips revs already in the Map.
- `ensureRevLoaded(rev)` — ad-hoc fetch into the Map without affecting the
  paginated list; used when a user navigates directly to `/admin/revisions/N`.
- `resetAdminCache()` — clears everything.

Because Svelte 5 `$state` doesn't proxy `Map` / `Set` mutations, the cache
uses copy-on-write (replace the Map with `new Map(oldMap)` on every update)
to keep reactivity working.

## Revision pagination

`dropboxClient.listRevisions()` exists but walks the whole `{rev/100}/{rev}/`
folder tree and is slow for any non-trivial history. The admin pages do **not**
use it for listing — they start from `rootManifest.revision` and fetch
`downloadRevisionManifest(rev)` / `rev-1` / `rev-2` / ... in descending
batches of 10. Missing revs (rare — only rollback artifacts) become
`null` in the Map and render as "매니페스트 없음".

## Soft rollback

`/admin/revisions/[rev]` exposes rollback to a historical revision. The
implementation is in `dropboxClient.softRollbackToRevision(targetRev)`:

1. Read the current root manifest (for `serverId` + current rev).
2. Read the target rev's manifest.
3. Commit a new manifest at `currentRev + 1` whose `(guid, rev)` map is
   copied verbatim from the target rev's manifest.
4. Since old `.note` files at their historical revs are never deleted, the
   new root manifest can simply point `guid → oldRev` without re-uploading.
5. Full server history is preserved (all prior revs remain on disk).

`adminClient.rollbackAndResync(targetRev)` wraps this: after the server-side
commit, it also does `purgeAllLocal()` + `clearManifest()` + `sync()` so the
client re-downloads the rolled-back state. **This step is required** — without
it, `syncManager.computePlan()`'s `rev <= localKnownRev` check would skip the
rolled-back notes (their revs went *down* from the client's perspective).

## Per-note history

`/admin/notes/[guid]` iterates `adminCache.manifestsByRev` and collects revs
where the guid appears, deduping by the note's own rev number (so an
unchanged note isn't listed once per server rev). The search is bounded by
whatever the cache currently holds — there is a "리비전 10개 더 스캔"
button that calls `loadMoreRevs()` to extend the scanned range. This keeps
the page instant at the cost of needing manual expansion for deep history.

Per-rev "이 버전을 로컬에 복원" marks the target note's local copy
`localDirty = true` with the historical content; the next regular sync
uploads it as a new revision. The local sync manifest's `noteRevisions[guid]`
is not touched (it still represents the last synced rev).

## Backup

`/admin/tools` has two zip exporters:

- **로컬 상태 백업** — reads all notes from IndexedDB, `serializeNote()`s each
  to a `.note` file, zips with the local manifest JSON. No network calls.
  Includes local-dirty changes that haven't been synced yet. This is the
  recommended pre-rollback safety net.
- **전체 히스토리 백업** — walks every server revision via `listRevisions()`
  and downloads each distinct `(guid, rev)` file. Slow; intended as a long-
  term archive rather than a routine safety net.

## Dependencies

The admin page adds two npm deps: `diff` (line diff for rev detail) and
`jszip` (zip generation for backups).
