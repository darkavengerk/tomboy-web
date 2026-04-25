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
│       ├── +layout.svelte         # sub-nav: 대시보드 / 리비전 / 파일 탐색 / 슬립노트 / 도구
│       ├── +page.svelte           # dashboard (server/local manifest summary)
│       ├── revisions/+page.svelte         # paginated server revision list
│       ├── revisions/[rev]/+page.svelte   # per-rev change diff + soft rollback
│       ├── notes/[guid]/+page.svelte      # per-note history (scans loaded revs)
│       ├── browse/+page.svelte            # raw Dropbox file tree browser
│       ├── sleepnote/+page.svelte         # slip-note format checker (see tomboy-sleepnote)
│       └── tools/+page.svelte             # local-IDB zip backup, full-history zip
├── lib/
│   ├── core/
│   │   ├── note.ts                 # NoteData interface, Tomboy date format
│   │   ├── noteArchiver.ts         # .note XML <-> NoteData
│   │   ├── noteContentArchiver.ts  # <note-content> XML <-> TipTap JSON
│   │   ├── noteManager.ts          # CRUD wrapper; rename sweeps backlinks
│   │   ├── titleRewrite.ts         # xml title/link rewrite + incoming-note dedupe
│   │   ├── titleInvariantCheck.ts  # duplicate-title scanner for /admin dashboard
│   │   ├── noteReloadBus.ts        # per-guid reload pubsub (used by rename sweep)
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
│   │   ├── TomboyEditor.svelte     # TipTap instance; blur-time title-uniqueness guard
│   │   ├── Toolbar.svelte
│   │   ├── titleUniqueGuard.ts     # title-conflict check, blur validator, save-path guard
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
- **Titles are globally unique, case-sensitive, trimmed.** Internal-link marks store the destination note's *title*, so title lookups at every layer (auto-link, graph, `findNoteByTitle`) are exact-case. Renaming a note sweeps backlinks; import / sync-pull collisions auto-suffix `(2)`, `(3)`, … See "Title uniqueness & rename cascade" below.
- **Sync is explicit only** — the user clicks "지금 동기화" in settings. No auto-sync on startup, focus, or save. (Auto-sync was removed intentionally; do not reintroduce without asking.)
- **Sync protocol** follows Tomboy's revision scheme: server stores notes at `/{rev/100}/{rev}/{guid}.note` and a root `/manifest.xml` lists `(guid, rev)` pairs. `syncManager.sync()` is the authoritative implementation.
- **Mobile-first, single-note-per-page** UI — avoid split views or desktop-only patterns.
- **All UI strings are in Korean.** Match the existing tone.
- **One nav entry is always selected.** When adding new top-level destinations, either make them a mode or leave the existing mode selected while there.

## Title uniqueness & rename cascade

Tomboy's internal-link marks store the destination note's **title** as text,
not its guid. So the title is effectively the link identity — two notes with
the same title would make every link ambiguous. The app enforces a single
hard invariant: **trimmed titles are globally unique and compared with
exact case**.

**Enforcement surfaces** — every data-entry point into the note store funnels
through one of these checks:

- **Editor typing** — `TomboyEditor.svelte` fires a blur-time validator
  (`titleUniqueGuard.handleTitleBlur`) when the cursor leaves the first
  block. On collision it toasts, snaps the cursor back to the title line,
  and latches the reported title so repeated blurs don't re-toast.
- **Editor save** — `noteManager.updateNoteFromEditor` re-checks at save
  time via `checkTitleConflict` and silently refuses the write on
  collision (the UI is responsible for surfacing the error).
- **Import** (`importNoteXml`) and **sync-pull** (`syncManager.applyIncomingRemoteNote`) —
  both use `titleRewrite.prepareIncomingNoteForLocal`: if the incoming
  title collides with a DIFFERENT local guid, suffix with ` (2)`, ` (3)`,
  …, rewrite the first line inside `<note-content>`, mark `localDirty =
  true` so the rename propagates back on next sync, and toast the rename.

**Rename cascade** — when a title actually changes through the editor save
path:

1. `updateNoteFromEditor` persists the renamed note.
2. `rewriteBacklinksForRename` scans every other non-deleted note and
   literal-replaces `<link:internal>OLD</link:internal>` /
   `<link:broken>OLD</link:broken>` with the new title. Each rewritten
   note is written back via `putNote` (becoming `localDirty = true`), so
   the sweep propagates on next sync.
3. `noteReloadBus.emitNoteReload(affected)` fires for every rewritten
   guid. Any open editor subscribed via `subscribeNoteReload` drops its
   pending debounced doc and reloads from IDB — otherwise a stale
   in-memory doc would clobber the rewrite on its next save.

All title→guid lookups (the auto-link title index, `buildGraph`,
`findNoteByTitle`, slip-note chain traversal via `mustGetByTitle`) are now
**exact-case trimmed**. The one exception is `lib/sleepnote/validator.ts`,
which is deliberately lenient (case-insensitive) because it is a
reporting tool, not a data-mutation path.

**Admin surface** — the `/admin` dashboard shows a "제목 중복 경고" block
whenever `titleInvariantCheck.scanDuplicateTitles` finds 2+ notes sharing
a trimmed title. The invariant is enforced prospectively by the
surfaces above, but notes created before enforcement (or imported via
direct IDB manipulation) may still violate it — the dashboard surfaces
them so the user can merge/rename by hand.

## Cross-window mutation pattern (desktop)

Any operation that rewrites multiple notes at once — slip-note chain
splicing is the current instance — must assume other windows may hold
stale `pendingDoc` state for the same guids. The contract is:

```ts
await desktopSession.flushAll();           // drain pending editor saves
const { affectedGuids } = await multiNoteOp(...);
await desktopSession.reloadWindows(affectedGuids);
```

`flushAll` drains every `registerFlushHook`; `reloadWindows` fires every
matching `registerReloadHook`. Both live in `lib/desktop/session.svelte.ts`
and swallow per-hook errors so a single broken window can never stall the
op. Note that `reloadHooks` (desktop session) and `noteReloadBus` (core)
are **independent channels**: the first covers open editor windows for
chain-type ops, the second is specifically for the rename backlink sweep
so it works outside the desktop workspace too.

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

## Editor shortcuts

- **Ctrl/Cmd+D** — insert today's date as `yyyy-mm-dd`, wrapped in the
  `tomboyDatetime` mark so Tomboy's `<datetime>` round-trip is preserved.
  The mark is unset right after insertion so subsequent typing is plain
  text. Helper in `lib/editor/insertDate.ts`. The browser bookmark shortcut
  is suppressed.
- **Alt+→ / Alt+←** — surgical list depth change in `lib/editor/listItemDepth.ts`.
  Only the operated `<li>` moves a level; its descendants stay at their
  current absolute visual depth (sink: children become the operated item's
  siblings under the previous item; lift: children stay under the old
  parent, the operated item moves out). **Tab/Shift+Tab keep the standard
  TipTap behavior** (whole subtree moves) intentionally — the surgical
  variant is the alt-modifier opt-in.
  Multi-selection supported: the operation range is `[$from.index..$to.index]`
  within the deepest common-ancestor list; the whole block moves together,
  including any non-selected intermediate items (standard editor block
  indent behavior).

## Copy with format

`lib/editor/copyFormatted.ts` — four serializers consume editor JSON (or a
selection slice via `copySelectionAsJson`):

- `tiptapToPlainText` — bare text. List items emit only their content (no
  `- ` prefix, no nesting indent) so pasting into another list merges
  cleanly. One `\n` per block boundary.
- `tiptapToStructuredText` — plain text that keeps list structure. Bullet
  glyphs cycle by depth to mirror the browser's default `list-style-type`
  cascade: `•` → `○` → `■` (clamped at depth 2+). Ordered lists use
  `1. 2. 3.` Two-space indent per nesting level. Marks are stripped and
  markdown meta chars are not escaped. Right-click → 형식 복사 → "리스트
  형식 유지".
- `tiptapToHtml` — minimal semantic HTML (`<p>`, `<ul>`, `<li>`, `<strong>`,
  etc). Emitted alongside plain text on every Ctrl+C/X so rich editors
  preserve list structure on paste.
- `tiptapToMarkdown` — bold, italic, strike, monospace, url-link
  `[x](href)`, internal-link `[[x]]`, and bullet list nesting. Top-level
  blocks join with a single `\n` (mirrors the editor's line-per-block
  display; strict markdown renderers that require `\n\n` between
  paragraphs should use the HTML path instead).

Clipboard (`lib/editor/clipboardPlainText.ts`) writes both `text/plain`
(via `tiptapToPlainText`) and `text/html` (via `tiptapToHtml`) for Ctrl+C
and Ctrl+X. The right-click context menu's main 복사 item does the same;
the 형식 복사 submenu forces a single format via `writeText`.

## Desktop window resize & z-order

- **8-way resize**: `lib/desktop/dragResize.ts` exposes `applyResize(base, dir, dx, dy, min)` — pure geometry math; N/W handles shift x/y so the opposite edge stays pinned on clamp. `lib/desktop/ResizeHandles.svelte` renders the 4 edges + 4 corners used by both `NoteWindow` and `SettingsWindow`. Session has `updateGeometry(guid, g)` for atomic 4-field updates.
- **Pin (항상 위)**: `DesktopWindowState.pinned?: boolean`, persisted. Effective z in `DesktopWorkspace.svelte` is `(win.pinned ? 1_000_000 : 0) + win.z` — pinned windows always above unpinned regardless of raw z. Title bar has a toggle; API: `togglePin`, `isPinned`.
- **Send to back**: middle-click on a title bar calls `sendToBack(guid)` — sets `win.z = minZ - 1` where `minZ` is the lowest z among the other windows in the current workspace. Pinned status unchanged.

## Desktop context menu

`lib/editor/EditorContextMenu.svelte` — right-click menu in `NoteWindow`
only (enabled via `TomboyEditor`'s `enableContextMenu` prop; mobile route
leaves it off). Items: 잘라내기, 복사, 형식 복사 (HTML / 일반 텍스트 /
Markdown), 붙여넣기, 오늘 날짜 삽입, 리스트로 만들기, 깊이 ↑/↓ (hidden
outside a list), 링크 열기 (only when cursor is on a URL or internal link
mark).

## Desktop mode (`/desktop`)

A multi-window operator UI for desktop browsers, separate from the mobile
single-note flow. `lib/desktop/` contains:

- `DesktopWorkspace.svelte` — root layout that hosts floating windows.
- `NoteWindow.svelte` — draggable/resizable note editor window (currently
  bottom-right corner resize only via `dragResize.ts`).
- `SettingsWindow.svelte` — settings as a floating window.
- `SidePanel.svelte` — left rail (note list, "그래프" launcher, etc.).
- `session.svelte.ts` — `$state` module: open windows, positions, sizes,
  z-order stack, focus.
- `dragResize.ts` — pointer-driven move + resize helpers.

Routes under `/desktop/*` are `isChromeless` in the root layout (TopNav
suppressed). `/desktop/graph` is documented in the `tomboy-graph` skill.

## Auto-link detection

See the **`tomboy-autolink`** skill. Lives in `app/src/lib/editor/autoLink/`;
tests in `app/tests/unit/editor/`. Self-link suppression via `currentGuid`
prop on `TomboyEditor.svelte`.

## Slip-notes (슬립노트)

See the **`tomboy-sleepnote`** skill. Notes in the `[0] Slip-Box` notebook form
`이전`/`다음` linked-list chains rooted at the fixed index note (GUID
`1c97d161-…` — same as `/sleepnote`). The `/admin/sleepnote` tab validates the
strict format of every chain note; module lives at
`app/src/lib/sleepnote/validator.ts`.

## Admin page

See the **`tomboy-admin`** skill for full details on `/admin` (Dropbox sync
operator UI: dashboard, paginated revision browser, soft rollback, per-note
history, raw Dropbox browser, zip backup tools).

Quick map: routes in `app/src/routes/admin/`, shared cache in
`lib/stores/adminCache.svelte.ts`, server-side ops in
`lib/sync/{adminClient,dropboxClient}.ts`. Mobile-first / `clamp(...)` sizing
invariant does **not** apply on these pages.

## 일정 알림 (schedule-note push notifications)

A user-designated note's list-item lines are parsed each save; matching
`(date, time, label)` triples are diff'd and a Cloud Function fires Web Push
30 min before each time-bearing event (or at 07:00 for date-only entries).
See the **`tomboy-schedule`** skill for the full format spec, fire-time
rules, ID model, and pipeline.

Quick map:

- `app/src/lib/schedule/` — parser, diff, Firestore client adapter, snapshot/
  pending stores, notification orchestrator. Pure-function tests in
  `app/tests/unit/schedule/`.
- `app/src/lib/core/schedule.ts` — `getScheduleNoteGuid` / `setScheduleNote`,
  mirrors `home.ts`.
- `app/src/service-worker.ts` — Firebase init + `onBackgroundMessage` +
  `notificationclick`.
- `functions/src/index.ts` — `fireSchedules` Cloud Function (every 1 min,
  `asia-northeast3`).
- `firestore.rules`, `firestore.indexes.json` — security + collectionGroup
  index for `(notified, fireAt)`.

Hook: `noteManager.updateNoteFromEditor` calls `syncScheduleFromNote` after
saving; if the saved guid is the schedule note, the diff lands in a single
pending slot, and `flushIfEnabled()` drains it to Firestore (only when the
user has explicitly enabled notifications).

Invariants:

- **Item id = `fnv1a64(date|hh:mm|label).hex16`.** Any text change mints a
  new id, so edits are always `add+remove` pairs in Firestore. There is no
  in-place "update" path.
- **Firing window is 2 minutes** (`[fireAt, fireAt+2min)`). One missed
  scheduler tick is absorbed; this also bounds the duplicate-fire risk
  from label-only edits near fire-time.
- **Snapshot promotion only on flush success.** Failed flushes leave both
  pending and snapshot intact, so retry is safe (Firestore upsert/delete
  are idempotent).
- **One schedule note, one device** in v1, but the schema/Function already
  multicast across `users/{uid}/devices/*`.

