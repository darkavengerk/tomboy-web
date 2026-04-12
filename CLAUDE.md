# Tomboy Web

Mobile-first, PWA-style web port of the Tomboy desktop note-taking app.
Notes live in the browser (IndexedDB); Dropbox is used as a sync/backup backend.

## Tech stack

- **SvelteKit** with `@sveltejs/adapter-static` — deploys as a pure static SPA
- **Svelte 5 runes**: `$state`, `$derived`, `$props`, `$effect`
- **TipTap 3** for rich-text editing (with custom Tomboy extensions)
- **IndexedDB** via `idb` for local note storage
- **Dropbox SDK** with OAuth PKCE (no client secret) for sync
- **TypeScript** everywhere; `svelte-check` for type checking; vitest for unit tests

No server runtime. Deploys to Vercel / any static host. All state is client-side.

## Working directory

Primary workspace is `app/`. Run commands from there:

```bash
cd app
npm run dev       # vite dev server
npm run build     # static SPA build to build/
npm run check     # svelte-check (type check)
npm run test      # vitest
```

`ref/` contains the original Tomboy desktop source — reference only, do not edit.

## Architecture

```
app/src/
├── routes/
│   ├── +layout.svelte             # app shell: TopNav, offline/install banners, mode tracking
│   ├── +page.svelte               # 홈 — redirects to the home-marked note (or latest)
│   ├── sleepnote/+page.svelte     # 슬립노트 — redirects to a fixed "sleep note" GUID
│   ├── notes/+page.svelte         # 전체 — note list with notebook filter, sort, and inline search
│   ├── note/[id]/+page.svelte     # single note editor (one-note-per-page)
│   ├── settings/+page.svelte      # Dropbox auth, manual sync, notes path
│   └── admin/                     # desktop-only Dropbox sync admin (see "Admin page")
│       ├── +layout.svelte         # sub-nav: 대시보드 / 리비전 / 파일 탐색 / 도구
│       ├── +page.svelte           # dashboard (server/local manifest summary)
│       ├── revisions/+page.svelte         # paginated server revision list
│       ├── revisions/[rev]/+page.svelte   # per-rev change diff + soft rollback
│       ├── notes/[guid]/+page.svelte      # per-note history (scans loaded revs)
│       ├── browse/+page.svelte            # raw Dropbox file tree browser
│       └── tools/+page.svelte             # local-IDB zip backup, full-history zip
├── lib/
│   ├── core/
│   │   ├── note.ts                 # NoteData interface, Tomboy date format
│   │   ├── noteArchiver.ts         # .note XML <-> NoteData
│   │   ├── noteContentArchiver.ts  # <note-content> XML <-> TipTap JSON
│   │   ├── noteManager.ts          # CRUD wrapper over noteStore
│   │   ├── notebooks.ts            # notebook helpers (list, filter)
│   │   └── home.ts                 # home-note pointer (appSettings-backed)
│   ├── storage/
│   │   ├── db.ts                   # idb schema (DB: "tomboy-web")
│   │   ├── noteStore.ts            # note persistence ops
│   │   └── appSettings.ts          # small key/value store for app preferences
│   ├── sync/
│   │   ├── dropboxClient.ts        # OAuth PKCE, Dropbox file ops, Tomboy manifest helpers
│   │   ├── syncManager.ts          # revision-based bidirectional sync
│   │   ├── manifest.ts             # local sync manifest in IndexedDB
│   │   └── adminClient.ts          # manifest diff, per-note fetch, soft-rollback wrapper
│   ├── editor/
│   │   ├── TomboyEditor.svelte     # TipTap instance
│   │   ├── Toolbar.svelte
│   │   ├── extensions/             # TomboySize, TomboyMonospace, TomboyInternalLink, TomboyUrlLink
│   │   └── autoLink/               # internal-link auto-detection (findTitleMatches, titleProvider, autoLinkPlugin)
│   ├── components/
│   │   ├── TopNav.svelte           # top nav: 홈 / 슬립노트 / 전체 + 새 노트, 즐겨찾기, 설정
│   │   ├── NoteList.svelte         # reusable note list rendering
│   │   ├── NotebookChips.svelte, NotebookPicker.svelte
│   │   ├── SyncPlanView.svelte, TabBar.svelte, Toast.svelte
│   ├── stores/
│   │   ├── appMode.svelte.ts       # current app mode: 'home' | 'sleepnote' | 'notes'
│   │   ├── adminCache.svelte.ts    # cross-page cache for /admin (manifests, pagination)
│   │   ├── noteListCache.ts        # note list + scroll position cache
│   │   └── toast.ts
│   ├── nav/history.js              # back/forward availability tracker
│   ├── search/noteSearch.ts        # title/body search used by the 전체 page
│   └── utils/guid.ts
```

## Navigation & modes

The top nav has three primary entries, and **exactly one is always selected** (reflected by `aria-current="page"`):

| Entry | Route         | Mode        |
|-------|---------------|-------------|
| 홈     | `/`           | `home`      |
| 슬립노트 | `/sleepnote`  | `sleepnote` |
| 전체    | `/notes`      | `notes`     |

The current mode is a Svelte 5 rune stored in `lib/stores/appMode.svelte.ts`, persisted to `sessionStorage`. Behavior:

- Clicking a nav entry sets the mode and navigates.
- `afterNavigate` in `+layout.svelte` also derives the mode from the URL via `modeFromUrl`:
  - `/` → `home`, `/sleepnote` → `sleepnote`, `/notes` → `notes`
  - `/note/[id]?from=home|sleepnote|notes` → that mode
  - Anything else → mode is left unchanged (so viewing a note / settings keeps the last-selected mode highlighted).
- Home redirects to the user's "home note" (`getHomeNoteGuid()` in `core/home.ts`), falling back to the most recently changed note.
- Sleepnote redirects to a fixed GUID (`1c97d161-1489-4c32-93d9-d8c383330b9c`). It is intentionally a second "home-like" landing — a single note loaded directly. Future mode-specific behavior will hang off `appMode.value`.

The `새 노트` (+) button in the TopNav creates a new note and navigates to it. There is no dedicated `/search` route — search is embedded in the 전체 page (see below).

## 전체 (notes) page

`routes/notes/+page.svelte` combines three controls in a single filter bar:

- **Left**: notebook picker + sort select (최근 수정순 / 생성순).
- **Right**: inline search input.

The rendered list is `filterByNotebook(allNotes, selectedNotebook)` → `searchNotes(..., query)` — the search narrows whatever the notebook filter already selected.

## Responsive spacing

The TopNav and the 전체 filter bar size themselves with `clamp(min, Xvw, max)` for gaps, paddings, button sizes, and font sizes so they shrink on narrow viewports instead of overflowing. When adding new controls to these bars, follow the same pattern — do not hardcode pixel paddings.

## Key invariants

- **Notes are stored in the user's browser IndexedDB** — server restarts / redeploys do not affect user data.
- **`.note` XML format is preserved verbatim** for round-trip compatibility with Tomboy desktop.
- **Sync is explicit only** — the user clicks "지금 동기화" in settings. No auto-sync on startup, focus, or save. (Auto-sync was removed intentionally; do not reintroduce without asking.)
- **Sync protocol** follows Tomboy's revision scheme: server stores notes at `/{rev/100}/{rev}/{guid}.note` and a root `/manifest.xml` lists `(guid, rev)` pairs. `syncManager.sync()` is the authoritative implementation.
- **Mobile-first, single-note-per-page** UI — avoid split views or desktop-only patterns.
- **All UI strings are in Korean.** Match the existing tone.
- **One nav entry is always selected.** When adding new top-level destinations, either make them a mode or leave the existing mode selected while there.

## Svelte 5 conventions

- Use runes (`$state`, `$derived`, `$derived.by`, `$props`, `$effect`) — not legacy stores or `export let`.
- Module-level reactive state lives in `.svelte.ts` files (e.g. `appMode.svelte.ts`) so runes are compiled.
- Event props are lowercase: `onchange`, `onclick`, `oninternallink`.
- `bind:this={componentRef}` returns the component instance; expose methods with `export function` inside `<script>`.

## Deployment

- Target: Vercel (static). `adapter-static` produces `app/build/`.
- No server-side storage needed or wanted — the app is client-only.
- Dropbox app key is read from `PUBLIC_DROPBOX_APP_KEY` (Vite public env).

## Testing

- Unit tests: `npm run test` (vitest + @testing-library/svelte). Component tests live in `app/tests/unit/`.
- There is no automated sync test against real Dropbox. To verify sync changes, use the settings page "지금 동기화" button against a real account.

## Auto-link detection

Like the original Tomboy desktop app, text typed in the editor is automatically
turned into an internal link whenever it matches the title of another existing
note. The feature lives under `app/src/lib/editor/autoLink/`:

- `findTitleMatches.ts` — pure, exhaustively tested text-matching utility.
  Unicode-aware word boundaries (`\p{L}\p{N}_`) so ASCII and CJK behave
  consistently. Longest title wins on overlap. Case-insensitive match with the
  original casing preserved on the resulting `target`. Titles are treated as
  literal strings (regex special chars are escaped), so titles like `C++` work.
- `titleProvider.ts` — subscribes to `noteListCache.onInvalidate` so the title
  list stays current when notes are created / renamed / deleted elsewhere. Per
  editor it can be configured with an `excludeGuid` so the current note never
  auto-links to itself.
- `autoLinkPlugin.ts` — ProseMirror plugin installed by `TomboyInternalLink`.
  Its `appendTransaction` scans only changed block ranges, reconciles
  `tomboyInternalLink` marks to match the desired set, and uses a meta flag
  (`autoLinkPluginKey` + `{skip:true}`) to prevent infinite loops. Text inside
  `tomboyUrlLink` or `tomboyMonospace` marks is deliberately skipped.
- `TomboyEditor.svelte` accepts a `currentGuid?` prop; `routes/note/[id]/+page.svelte`
  passes it through so self-linking is suppressed. The provider dispatches a
  `{refresh:true}` meta transaction via `autoLinkPluginKey` whenever the note
  list changes.

Scope notes:

- Only the *currently open* note is updated live. If a note is renamed while
  another note is not open, that other note's stored body is not rewritten —
  its links reconcile on the next edit. (Out of scope for this pass; mirrors
  Tomboy's `NoteRenameWatcher` only partially.)
- `<link:broken>` serialization still comes from the archiver; the plugin does
  not currently flip `broken:true` based on missing targets while editing.

Tests for this feature live in `app/tests/unit/editor/`:
`findTitleMatches.test.ts`, `titleProvider.test.ts`, `autoLinkPlugin.test.ts`,
and `autoLinkRoundtrip.test.ts`.

## Admin page

`/admin` is a desktop-oriented operator UI for inspecting and manipulating the
Dropbox sync state. It is **not** part of the normal mobile flow and is
intentionally excluded from the TopNav — entry is a link in the 설정 page's
"고급" section. Because all Dropbox credentials are in the user's own browser,
no extra auth gate is used; URL access is sufficient.

The mobile-first / `clamp(...)` sizing invariant does **not** apply here — the
admin pages use information-dense fixed layouts (grids, tables) because the
expected client is a desktop browser.

### Sub-pages

| Route                         | Purpose |
|-------------------------------|---------|
| `/admin`                      | dashboard: server rev, local last-sync rev, `server-id` match, paths |
| `/admin/revisions`            | paginated server-revision list (10 per page, load-more button) |
| `/admin/revisions/[rev]`      | per-rev added / modified / removed notes, line diff via `jsdiff`, soft-rollback button |
| `/admin/notes/[guid]`         | history of one note across the **currently cached** revs, per-rev preview, local restore |
| `/admin/browse`               | raw Dropbox `filesListFolder` + file content preview |
| `/admin/tools`                | local-IDB zip backup, full-history zip backup |

### Shared cache

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

### Revision pagination

`dropboxClient.listRevisions()` exists but walks the whole `{rev/100}/{rev}/`
folder tree and is slow for any non-trivial history. The admin pages do **not**
use it for listing — they start from `rootManifest.revision` and fetch
`downloadRevisionManifest(rev)` / `rev-1` / `rev-2` / ... in descending
batches of 10. Missing revs (rare — only rollback artifacts) become
`null` in the Map and render as "매니페스트 없음".

### Soft rollback

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

### Per-note history

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

### Backup

`/admin/tools` has two zip exporters:

- **로컬 상태 백업** — reads all notes from IndexedDB, `serializeNote()`s each
  to a `.note` file, zips with the local manifest JSON. No network calls.
  Includes local-dirty changes that haven't been synced yet. This is the
  recommended pre-rollback safety net.
- **전체 히스토리 백업** — walks every server revision via `listRevisions()`
  and downloads each distinct `(guid, rev)` file. Slow; intended as a long-
  term archive rather than a routine safety net.

### Dependencies

The admin page adds two npm deps: `diff` (line diff for rev detail) and
`jszip` (zip generation for backups).
