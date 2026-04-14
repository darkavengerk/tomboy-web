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

## 3D note graph (`/desktop/graph`)

A desktop-only space-exploration view of the notes' internal-link graph.
Nodes are all non-deleted notes; edges are `<link:internal>` marks between
them. The user flies through the cloud with FPS-style controls and reads
notes as they pass, with a live, editable `NoteWindow` embedded in a side
panel. Reached via the "그래프" button in the desktop `SidePanel` rail
(opens in a new tab).

Because `/desktop/*` is treated as `isChromeless` in the root layout, the
TopNav is automatically suppressed — the graph page takes over the full
viewport.

### Files

```
app/src/
├── routes/desktop/graph/
│   └── +page.svelte                # UI, HUD, controls wiring
└── lib/graph/
    ├── buildGraph.ts               # NoteData[] → {nodes, links} with log-scaled sizes
    ├── extractInternalLinks.ts     # Walks a TipTap JSON doc for `tomboyInternalLink` mark targets
    ├── plainText.ts                # TipTap JSON → plain-text preview (currently unused; kept for reuse)
    ├── FpsControls.ts              # PointerLock + WASD fly camera
    └── constants.ts                # Shared `SLEEP_NOTE_GUID`
```

Unit tests live in `app/tests/unit/graph/` — `buildGraph.test.ts` covers
the title-collision / self-link / broken-target / log-size-scaling rules,
`extractInternalLinks.test.ts` covers TipTap JSON walking.

### Graph data

`buildGraph(notes, { homeGuid, sleepGuid, onProgress? })` produces
`{ nodes, links }`. For each note it calls `deserializeContent()` and
collects every `tomboyInternalLink` mark target. Link targets store the
destination note's **title** (not its GUID), so a lowercase-trimmed title
→ GUID map resolves them; on title collision the most recently modified
note wins, matching what the editor's auto-link picker does. Self-links
and targets marked `broken: true` are dropped.

Each node gets a `size` in [1, 2] derived from its (in + out) degree:

```ts
size = 1 + log1p(degree) / log1p(maxDegree)
```

This drives **both** the sphere radius (`3 * size`, so up to 2× the base)
and the color. Normal notes interpolate HSL hue from yellow (48°) at
size=1 to red (0°) at size=2 via `degreeColor(size)`. The home note is
gold (`#f5c542`) and the sleep note (`SLEEP_NOTE_GUID`) is purple
(`#9b6cff`) regardless of degree, marking them as the two "starting"
landings. The camera does **not** auto-center on the starter notes —
previous versions flew the view to the home+sleep midpoint on first
engine stop, but that felt like being yanked away on page load, so the
framework's default initial camera position is used instead.

Sphere geometry uses `SphereGeometry(radius, 24, 16)` — the earlier
`(10, 8)` setting was visibly polygonal against the black background.
24×16 keeps silhouettes round at the displayed sizes while staying
within a comfortable ~770K tri budget for a 2000-node graph.

### Category (notebook) nodes — experimental toggle

A checkbox in the top bar (`bind:checked={includeCategories}`) opts into
adding synthetic nodes for notebooks. When on, `buildGraph` emits an
extra node per distinct `system:notebook:<name>` tag (id
`category:<name>`, flagged `isCategory: true`) and a directed edge from
each member note to its notebook. Category size follows the same
log-scaled degree formula as notes, but based on member count.

Visually, categories render as translucent teal `BoxGeometry` cubes
(`#4fd1c5`, opacity 0.75) side = `radius × 1.6`, so they're obviously
"meta" entities versus the sphere notes. Their labels are always
visible regardless of distance — same treatment as the hub tier —
because there's typically only a handful and they act as landmarks.

Categories are deliberately **excluded from selection**:
`findAimedNode`, `findCenterNode`, and `titleToGuid` all filter
`isCategory`, so auto-select / click / internal-link resolution only
ever pick real notes. A category at the reticle won't even highlight
(the hover halo skips it too).

The toggle rebuilds the graph in place: a `$effect` watches
`includeCategories` and calls the closure-captured `rebuildGraphData()`
hook set in `init()`, which:

1. Re-runs `buildGraph(loadedNotes, { includeCategories, ... })`.
2. Clears `labelEntries` so `nodeThreeObject` can freshly repopulate.
3. Calls `graph.graphData(newData)`.
4. Re-grabs the live node array and rebuilds `liveNodes` /
   `liveNodesById` (3d-force-graph mutates these references during
   the force simulation).
5. Calls `refreshIndices()` for `nodesById`, `titleToGuid`,
   `backlinksByGuid`, and the `stats` counter.

An early `$effect` firing (before init finishes) is harmless because
`rebuildGraphData` is still `null`; init reads the current
`includeCategories` value when it does the initial build.

### Label LOD

Title sprites are driven by camera distance with a fade band, split into
just two buckets by node size:

- **Hub nodes** (`size ≥ 1.6`) — always visible, full opacity. Skip
  `labelEntries` entirely; `label.visible` is set once in
  `nodeThreeObject` and never touched again.
- **Everyone else** — distance fade around `labelBaseDistance`:

  | Range                            | Opacity |
  |----------------------------------|---------|
  | `d ≤ base`                       | 1 (fully visible) |
  | `base < d < 2 × base`            | linear fade 1 → 0 |
  | `d ≥ 2 × base`                   | hidden (`visible = false`) |

  Non-hub labels are created with `material.transparent = true` so the
  interpolated opacity blends; `updateLabelVisibility()` reads the
  current `labelBaseDistance` each RAF tick, so the top-bar input tunes
  the whole graph live with no rebuild. Squared distance is used for
  the cheap in/out checks; `Math.sqrt` is only called inside the fade
  band.

The base is a Svelte 5 `$state` (default `400`, min 50, step 50) exposed
as a number input (`.lod-input`) in the top bar.

Labels keep a translucent black background (`rgba(0,0,0,0.45)`) with 1px
padding — without it overlapping titles in dense clusters become
unreadable.

### Live-tunable force simulation

A second top-bar number input, "노드 간격" (`bind:value={nodeSpacing}`,
default `50`, min 5, step 5), exposes d3-force's many-body charge
strength (applied as `-nodeSpacing`). Raising it pushes nodes further
apart — looser, lower-density cloud; lowering it tightens the cluster.
A `$effect` calls `applyNodeSpacing(fg, nodeSpacing)` whenever the input
changes; the helper mutates `graph.d3Force('charge').strength(...)` and
wraps `graph.d3ReheatSimulation()` in a try/catch — the internal
`three-forcegraph` layout isn't always ready on first call, but the new
strength still takes effect on the next tick.

### Link visibility toggle

A top-bar checkbox "링크 표시" (`bind:checked={showLinks}`) flips link
rendering. Default **off** — the node cloud alone tends to read more
clearly, and turning the web on only when you need to trace structure
keeps dense graphs legible.

Implementation is a one-liner pair: `linkOpacity(show ? 0.6 : 0)`
plus `linkDirectionalArrowLength(show ? 2 : 0)`. Both are applied in
the initial chain and re-applied via a `$effect` on toggle.

### Controls: WASD-only, pointer-lock

3d-force-graph's built-in navigation is fully disabled
(`enableNavigationControls(false)`). The only supported camera mode is
pointer-lock FPS via `FpsControls.ts`:

- **Mouse** → yaw/pitch (YXZ Euler, pitch clamped to ±(π/2 − ε))
- **W/A/S/D** → forward / strafe, following the camera's *look direction*.
  Forward includes pitch (looking down + W flies down-forward). Strafe
  stays horizontal (`right = cross(forward_XZ, worldUp)`), so pitched
  views don't cause lateral drift.
- **Space / C** → world-Y up / down
- **Shift** → ×3 speed boost
- **ESC** → unlock, camera halts

Entering lock is trivial:

- **Any canvas click** while unlocked → `fps.lock()`. 3d-force-graph's
  `onNodeClick` / `onBackgroundClick` are intentionally unused — their
  raycast relies on mouse coords that freeze during pointer lock.
- **Any movement key** (W/A/S/D/Space) while unlocked → `fps.lock()`.
  Keys pressed into `<input>` / `<textarea>` / contenteditable (the note
  editor) are ignored so typing doesn't hijack the page. `FpsControls`
  tracks `keydown` regardless of lock state, so the key you pressed to
  trigger the lock is already in the pressed set by the time the lock
  engages — movement starts on the same frame, no OS auto-repeat wait.

Browser security forbids acquiring pointer lock without a user gesture,
so truly auto-locking on page load is not possible; the unlocked state
shows a pulsing "클릭 또는 WASD 로 이동 시작" hint to minimize friction.

### Selection: two modes, one pipeline

Selection is driven by a single debounced auto-select tick (350ms) that
asks a mode-dependent picker each frame. The mode flips on explicit user
action so a deliberate click doesn't get overwritten by the continuous
ticker a few hundred ms later.

- **`aim` mode (default)** — `findAimedNode()` returns the nearest-in-
  frustum node to the "aim point" (camera + forward × 40). Something is
  (almost) always selected as you fly, which suits free exploration.

- **`center` mode** — `findCenterNode()` projects every live node to NDC
  and returns whichever one's projected sphere *actually covers the
  reticle* (ties broken by depth). Distance-agnostic — the note you see
  directly at the crosshair wins, regardless of whether something else is
  closer in 3D. If the reticle is on empty space, the picker returns
  `null` and auto-select keeps the current selection (no blanking).

Flips:
- Clicking a node in locked mode → `center`. The click primes the
  debounce state with the clicked id so the mode switch is seamless.
- Pressing any movement key (W/A/S/D/Space/C), even while already locked,
  → `aim`. "Moving means exploring" is the mnemonic: click to focus on
  one note, start moving and the selection tracks your heading again.
- Closing the panel (`onclose`) or hitting "자동 선택 다시 켜기" → resets
  to `aim`.
- Backlink / internal-link navigation flies the camera and resets to
  `aim` so auto-select picks up the arrival target.

Auto-select can be turned off by closing the panel via the `NoteWindow`'s
own × button; the top-bar chip re-arms it.

### HUD overlays

All `pointer-events: none`, so they never eat canvas input.

- **Reticle** at screen center — thin ring + cross ticks, `mix-blend-mode:
  screen` so it stays visible over any background color. Marks the aim
  point used by both selection modes.
- **Selection halo** — slim cyan `RingGeometry(1, 1.08)` billboarded at
  the selected node, scaled to the node's sphere radius (`3 * size`) so
  the ring's inner edge traces the silhouette exactly. Opacity 0.55 with
  a gentle Z-axis spin. On selection change (click / auto-select /
  backlink) it pulses +45% for 420ms as click feedback.
- **Hover halo** — identical ring in faint white (opacity 0.22) around
  whichever node `findCenterNode()` currently returns. Hidden when the
  hover target equals the selected target to avoid double-rings. Acts as
  a "click would pick this" preview.

### Embedded note

The side panel is `height: 50vh; width: 420px` (half the viewport, so the
graph stays visible) with a `position: relative` `.note-host` wrapper.
Inside, the full desktop `NoteWindow.svelte` is rendered via `{#key
selectedGuid}` so swapping selection re-mounts it cleanly. CSS overrides
NoteWindow's absolute `left/top/width/height` to fill the host
(`!important`), so the component adapts without live size-prop updates.

Because NoteWindow is the real one, every feature works in-place:
editing, toolbar, the ⋯ menu (favorites, notebook assignment, home-note
toggle, delete, compare-with-server), internal-link clicking. The
`onopenlink(title)` callback resolves the title → guid via a local
`titleToGuid` Map and `focusNode()`s the camera there; auto-select then
picks up the new target. `onclose` turns off auto-select and hides the
panel.

A backlinks footer (max `25%` of panel height) lists notes that link *to*
the current note; clicking a backlink re-arms auto-select, sets
`selectedGuid`, and flies the camera.

### Wheel forwarding

Because the graph page has no other scrollable content, a window-level
capture-phase `wheel` listener forwards wheel events to the embedded
note's `.tomboy-editor` scroll container whenever the cursor isn't
already inside the panel. `deltaMode` line/page is normalized to pixels.
This lets the user read long notes without having to precisely hover the
panel (the graph's built-in wheel-zoom is sacrificed deliberately — WASD
covers distance control).

### Performance

Targets ~2000 nodes, which is within 3d-force-graph's comfortable range.
Knobs used to keep the simulation cheap: `cooldownTicks: 200`,
`warmupTicks: 40`, `d3AlphaDecay: 0.05`, `d3VelocityDecay: 0.3`,
`nodeResolution: 8` for sphere geometry. Frustum-filtered selection scan
and the two projection-based picks (`findAimedNode`, `findCenterNode`)
are both O(N) per frame but cheap — reuse scratch `Vector3`s to avoid
allocs. A single RAF loop drives FPS movement, auto-select, halo
updates, and hover-halo updates together.

### Dependencies

The graph page adds four npm deps: `3d-force-graph`, `three`,
`three-spritetext` (runtime), and `@types/three` (dev).
