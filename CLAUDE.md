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
│   ├── firebase/
│   │   └── app.ts                  # shared Firebase singletons + Dropbox-bridged ensureSignedIn
│   ├── sync/
│   │   ├── dropboxClient.ts        # OAuth PKCE, Dropbox file ops, Tomboy manifest helpers
│   │   ├── syncManager.ts          # revision-based bidirectional sync (backup channel)
│   │   ├── manifest.ts             # local sync manifest in IndexedDB
│   │   ├── adminClient.ts          # manifest diff, per-note fetch, soft-rollback wrapper
│   │   └── firebase/               # realtime note sync — Firestore (see tomboy-notesync)
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
- **Dropbox sync is explicit only** — the user clicks "지금 동기화" in settings. No auto-sync on startup, focus, or save. (Auto-sync was removed intentionally; do not reintroduce without asking.) Dropbox is the **backup channel**.
- **Firebase realtime note sync is opt-in, OFF by default.** When enabled, the open note streams in/out via Firestore, AND a collection-level cursor (`serverUpdatedAt > lastFirebaseSyncAt`) delivers catch-up + realtime updates for every other note that exists in Firestore. Notes that have never been opened on any Firebase-enabled device are not in Firestore. See the **`tomboy-notesync`** skill.
- **Dropbox sync protocol** follows Tomboy's revision scheme: server stores notes at `/{rev/100}/{rev}/{guid}.note` and a root `/manifest.xml` lists `(guid, rev)` pairs. `syncManager.sync()` is the authoritative implementation.
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

## Column split (`---` → vertical divider)

See the **`tomboy-hrsplit`** skill. A top-level `---` paragraph is a
horizontal-rule marker; Ctrl/Cmd+click toggles it into a vertical column
divider, splitting the note into N+1 independent columns via CSS Grid +
`grid-template-rows: masonry`. Files in `app/src/lib/editor/hrSplit/`,
CSS + plugin wiring in `TomboyEditor.svelte`.

**Browser support is Firefox-only**, and Firefox release still hides
masonry behind `about:config → layout.css.grid-template-masonry-value.enabled`.
On non-masonry engines the column split visually degrades to a short
stub divider (no runaway, just looks wrong); the plugin detects the
unsupported case via `CSS.supports('grid-template-rows', 'masonry')`
and skips the runtime divider-height sync entirely. **Do not reintroduce
per-column DOM wrappers** — they're incompatible with PM's mutation
observer and produced the editor-corruption bugs in commit `20d6d88`
(reverted).

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

## 파이어베이스 실시간 노트 동기화

A second sync channel that runs alongside Dropbox. Three flows:

1. **Push** — every IDB write (editor save, rename cascade, delete, favorite
   toggle) gets debounced and pushed to `users/{uid}/notes/{guid}`.
2. **Per-note attach** — while a note is open, a doc-level `onSnapshot`
   keeps it in lockstep with other devices in real time.
3. **Incremental collection sync** — a single live cursor over
   `users/{uid}/notes` filtered by `serverUpdatedAt > lastFirebaseSyncAt`
   delivers both the catch-up of changes accumulated while offline AND
   realtime updates from other devices. This is what makes a note created
   on device A reach device B without B having to open the note first.

Dropbox stays untouched as the backup channel and the authority for the
never-opened-anywhere backlog. Default **OFF** — the user enables it
explicitly in 설정 → 동기화 설정. See the **`tomboy-notesync`** skill for
the full design.

Quick map:

- `app/src/lib/sync/firebase/` — pure modules (`notePayload`,
  `conflictResolver`, `pushQueue`, `openNoteRegistry`, `incrementalSync`)
  plus the orchestrator and the production Firestore wiring.
- `app/src/lib/firebase/app.ts` — shared lazy Firebase singletons +
  `ensureSignedIn` (also used by the schedule feature).
- `noteManager.ts` — calls `notifyNoteSaved(guid)` after every IDB write
  (`createNote`, editor save, rename cascade, delete, favorite toggle).
  `createNote` is hooked so a freshly-created (yet unedited) note is
  reachable from other devices' link clicks before the user types anything.
- `routes/note/[id]/+page.svelte` and `lib/desktop/NoteWindow.svelte` —
  call `attachOpenNote(guid)` on mount, `detachOpenNote(guid)` on unmount.
- `routes/+layout.svelte` — calls `installRealNoteSync()` once at app start
  to wire the orchestrator with real adapters and apply the persisted flag.
- `routes/settings/+page.svelte` (config tab) — the toggle.
- `appSettings.firebaseNotesLastSyncAt` (millis) — incremental sync
  watermark; advanced after each batch, never regresses.

Invariants:

- **Same uid as schedule** — `dbx-{sanitized account_id}`. Both features
  share `users/{uid}/...` namespace under the existing
  `firestore.rules` wildcard. No new function, no new index.
- **Last-write-wins on `changeDate`.** Tiebreaker: `metadataChangeDate`,
  then prefer-local. Equivalent payloads → `noop` (this is also how
  echo-of-our-own-write is suppressed; no separate tracker).
- **Incremental cursor uses `serverUpdatedAt`, not `changeDate`.**
  `changeDate` is a wall-clock ISO string — unsafe to range-query across
  timezone offsets. `serverUpdatedAt` is server-side and monotonic.
  Conflict resolution still uses `changeDate`; the two timestamps serve
  different purposes.
- **Soft-delete only.** Tombstones (`deleted=true`) stay in Firestore so
  other devices can learn about deletions on next reconcile.
  `noteStore.deleteNote` bumps `changeDate`/`metadataChangeDate` along
  with `deleted=true` so the tombstone wins the conflict resolver's
  timestamp ladder on the receiver — without that, the same-changeDate
  tombstone would tie with the receiver's local row and the resolver's
  `tie-prefers-local` fallback would silently undo the delete.
- **Pull path fans out via `invalidateCache()`.** When
  `reconcileWithRemote` decides `pull`, it calls `invalidateCache()`
  after `putNoteSynced` so SidePanel, the auto-link title→guid index,
  and the `/notes` list page refresh automatically. `noop` and `push`
  paths leave IDB unchanged and skip the fan-out.
- **Dropbox-pulled notes don't auto-push to Firestore.**
  `applyIncomingRemoteNote` writes via `putNoteSynced` and bypasses
  `notifyNoteSaved`. The next time the user opens the pulled note, the
  attach-side reconcile pushes it (and the incremental cursor on every
  other Firebase-enabled device picks it up immediately after).
- **1 MiB document limit.** `noteToFirestorePayload` enforces a
  conservative 900 KB ceiling on the JSON-serialized payload; oversized
  notes throw and are skipped by the queue.

Don't add an echo tracker, don't reintroduce Dropbox auto-sync to "fix"
the closed-note Firestore gap, and don't reach into `firebase/firestore`
outside `noteSyncClient.firestore.ts` — every other module consumes the
`FirestorePrimitives` interface so it stays unit-testable.

## 일정 알림 (schedule-note push notifications)

A user-designated note's list-item lines are parsed each save; matching
`(date, time, label)` triples are diff'd and a Cloud Function fires Web Push
on a per-slot schedule. Every entry expands into one or three notification
slots: every entry (with or without a time) fires at 07:00 on the event
day; entries with a time additionally fire 1 hour before the event AND
exactly at the event time — three pings/day for time-bearing items, one
for date-only. **Two summary pushes** also fire from the server: every
Monday at 07:00 KST a "이번 주 일정" digest, and on the 1st of each month
at 07:00 KST a "이번 달 일정" digest. Summaries are computed live from
Firestore at fire time, so any device's edits show up.
**All devices that share a Dropbox account share the same Firestore
namespace**, so any device with notifications enabled can fire alarms for
every device. See the **`tomboy-schedule`** skill for the full format
spec, fire-time rules, ID model, auth bridge, PWA install requirements,
and operational gotchas.

The schedule note also gets two editor-only conveniences (see the skill
file for the full spec):

- **Auto-weekday on day prefix** — typing `12 ` (digit + space) at the start
  of a list-item under a `N월` section auto-fills `12(<요일>)`. Existing
  malformed `(요일)` content (wrong char, English `Wed`, garbage, extra
  whitespace, gap before parens) is corrected on every doc change AND on
  note open via a `setMeta(autoWeekdayPluginKey, { rescan })` pass. Only
  active when `currentGuid === scheduleNoteGuid` (passed as
  `isScheduleNote` prop on `<TomboyEditor>`).
- **"보내기" Ctrl gate is focus-scoped** — list items in the
  `SEND_SOURCE_GUID` note show the "보내기" button only when (a) Ctrl is
  held / mobile Ctrl-lock is on, AND (b) the source note window is the
  focused window (desktop) / the visible note (mobile). On the mobile
  route this also requires `installModKeyListeners()` to be wired in
  `+page.svelte` so the physical Ctrl key updates `modKeys` state.

Quick map:

- `app/src/lib/schedule/` — parser, diff, Firestore client adapter, snapshot/
  pending stores, notification orchestrator, **auto-weekday pure logic
  (`autoWeekday.ts`)**. Pure-function tests in `app/tests/unit/schedule/`.
- `app/src/lib/editor/autoWeekday/autoWeekdayPlugin.ts` — ProseMirror
  plugin that orchestrates auto-fill / scan-on-open via the pure logic
  above. Tests in `app/tests/unit/editor/autoWeekdayPlugin.test.ts`.
- `app/src/lib/editor/sendListItem/sendActiveGate.ts` — pure
  `shouldSendListBeActive` helper used by both desktop NoteWindow and
  mobile route to gate the "보내기" buttons.
- `app/src/lib/core/schedule.ts` — `getScheduleNoteGuid` / `setScheduleNote`,
  mirrors `home.ts`.
- `app/src/service-worker.ts` — Firebase init via `$env/static/public` +
  iOS-branched `onBackgroundMessage` + `notificationclick`. Uses PNG icons.
- `functions/src/index.ts` — `fireSchedules` (1-min schedule),
  `sendTestPush` (callable), `dropboxAuthExchange` (callable, mints
  Firebase custom token from a Dropbox access token).
- `firestore.rules`, `firestore.indexes.json` — uid-scoped security +
  collectionGroup index for `(notified, fireAt)`.
- `app/src/app.html`, `app/static/manifest.webmanifest`,
  `app/static/icons/icon-{180,192,512}.png` — PWA install metadata
  required for iOS to recognise the home-screen entry as a real PWA
  with persistent push subscription.

Hook: `noteManager.updateNoteFromEditor` calls `syncScheduleFromNote` after
saving; if the saved guid is the schedule note, the diff lands in a single
pending slot, and `flushIfEnabled()` drains it to Firestore (only when the
user has explicitly enabled notifications). Notes received via Dropbox sync
do NOT trigger this hook — Firestore is updated only by direct editor saves
on a notifications-enabled device. (Multi-device coverage relies on every
participating device having notifications enabled, which lands them under
the same `dbx-{account_id}` Firebase uid.)

Invariants:

- **Auth uid = `dbx-{sanitized Dropbox account_id}`** via custom token
  minted by the `dropboxAuthExchange` Cloud Function. NOT anonymous.
  Every device on the same Dropbox account = same uid = shared data.
- **Item id = `fnv1a64(date|hh:mm|label).hex16`.** Any text change mints a
  new id, so edits are always `add+remove` pairs in Firestore. There is no
  in-place "update" path.
- **Firing window is 2 minutes** (`[fireAt, fireAt+2min)`). One missed
  scheduler tick is absorbed; this also bounds the duplicate-fire risk
  from label-only edits near fire-time.
- **Snapshot promotion only on flush success.** Failed flushes leave both
  pending and snapshot intact, so retry is safe (Firestore upsert/delete
  are idempotent).
- **iOS auto-displays FCM `notification` payloads.** SW
  `onBackgroundMessage` is iOS-branched: log-only on iOS, explicit
  `showNotification` on desktop. Calling it on iOS too produces
  duplicates (Apple's push pipeline renders the payload itself).
- **PWA install metadata is load-bearing.** `apple-touch-icon` MUST be
  PNG. SVG-only manifest icons make iOS treat the home-screen entry as
  a Safari bookmark, breaking push subscription persistence across
  PWA restarts.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)

## 터미널 노트 (SSH terminal in a note)

A note whose body is **1–2 metadata paragraphs + optional `connect:` / `pinned:` / `history:` sections** matching:

```
ssh://[user@]host[:port]
bridge: wss://my-pc.example.com/ws    # optional
                                       # optional blank
connect:                               # optional, single bucket — auto-runs on WS open
- tmux a -t main

pinned:                                # optional, non-tmux pinned bucket (no cap)
- ls -la

pinned:tmux:@1:                        # optional, per-tmux-window pinned bucket
- htop

history:                               # optional, non-tmux bucket
- sudo systemctl restart caddy

history:tmux:@1:                       # optional, per-tmux-window bucket
- tail -f /var/log/caddy.log
```

is matched as a terminal note. By default the note opens in the regular `<TomboyEditor>` with a "SSH 터미널 노트입니다 — `<target>` [접속]" banner above. Clicking 접속 swaps to `<TerminalView>` and starts the WS session (`terminalConnectMode` flag, false by default). The TerminalView's "편집 모드" button drops back to the editor by setting `terminalConnectMode = false`.

Title is unconstrained; the body is. A 3rd free paragraph (or any non-recognized block), any list/markup outside recognized sections, or a malformed section header (or scheme) falls back to a regular note. The `.note` XML stores plain text — Tomboy desktop sees a normal note and Dropbox/Firebase sync are unchanged. **Terminal output is never persisted** — it lives only in the open xterm scrollback.

The matching WebSocket bridge lives at the repo root in `bridge/` — Node +
`ws` + `node-pty`, deployed as a rootless Podman + Quadlet container
fronted by Caddy. The bridge can run **either on the ssh target machine
itself, or on a separate always-on host (e.g., a Raspberry Pi)** that
ssh's into the workstation over the LAN; the latter unlocks an optional
**Wake-on-LAN** step before the ssh spawn (`bridge/src/{hosts,wol}.ts`).
See the **`tomboy-terminal`** skill for the WS protocol, the Bearer-token
auth flow, the SSH spawn modes (`!t.user` vs ssh path), the WOL host
map, the deployment recipe, the SELinux + user-namespace constraints,
host-side sshd requirements, and Vercel cross-origin notes.

Quick map:

- `app/src/lib/editor/terminal/` — `parseTerminalNote.ts`, `wsClient.ts`,
  `TerminalView.svelte`, `bridgeSettings.ts`. Parser tests in
  `app/tests/unit/editor/`.
- `app/src/lib/editor/terminal/historyStore.ts` — read-modify-write history/pinned mutation + per-guid serialization + 500ms debounce. Exposes `pinCommandInTerminalHistory`, `unpinCommandInTerminalHistory`.
- `app/src/lib/editor/terminal/connectAutoRun.ts` — pure `runConnectScript` helper; sends each `connect:` item as `text + '\r'` with 50 ms gap, skips empty lines, swallows per-line send errors.
- `app/src/lib/editor/terminal/oscCapture.ts` — pure OSC 133 parser / command-extraction helpers.
- `app/src/lib/editor/terminal/HistoryPanel.svelte` — desktop side panel + mobile bottom sheet UI for captured history + pinned commands.
- `routes/note/[id]/+page.svelte` and `lib/desktop/NoteWindow.svelte` —
  branch between `TerminalView` and `TomboyEditor` based on
  `parseTerminalNote(editorContent)` at load and after every IDB reload.
- `routes/settings/+page.svelte` (config tab → "터미널 브릿지") — default
  bridge URL + login form.
- `bridge/` — `src/server.ts`, `src/auth.ts`, `src/pty.ts`,
  `src/hosts.ts` (WOL host map loader), `src/wol.ts` (magic packet +
  TCP polling), `Containerfile`, `deploy/term-bridge.container`
  (Quadlet), `deploy/Caddyfile`.

Invariants:

- **Note body = 1–2 metadata paragraphs + optional `connect:` / `pinned:` / `history:` sections.** A 3rd free paragraph (or any non-recognized block) means it's no longer a terminal note — by design, so the user opts out simply by typing more.
- **Default view is the editor.** Terminal notes open in `<TomboyEditor>` with a banner; clicking 접속 sets `terminalConnectMode = true` and starts the WS session. "편집 모드" sets it back to false. There is no separate "terminal edit mode" flag.
- **`connect:` is single-bucket only** — no `connect:tmux:...` variant. On every WS `'open'` transition (initial mount or reconnect), `runConnectScript` sends each item as `text + '\r'` in order with a 50 ms gap. The `connectFired` flag in `TerminalView.svelte` ensures one run per open lifetime; reconnect resets it so the next open re-runs.
- **Client `status='open'` is gated on the bridge's `{type:'ready'}` frame, not on the WebSocket handshake.** The bridge emits `ready` after `spawnForTarget` returns and `pty.onData/onExit` are wired (`server.ts` startSession). Without this gate, `data` frames sent during the async spawn are dropped silently by `if (!pty) return` in the bridge — which is exactly what made `connect:` auto-run appear to "do nothing." A 3 s `READY_FALLBACK_MS` timer in `wsClient.ts` keeps older bridges working.
- **`pinned:` mirrors `history:` per-bucket layout but has no capacity cap.** Pinning a history item moves it to pinned (single physical existence per bucket); unpinning prepends it back to the top of history. Each panel row shows a star toggle: ★ (pinned) / ☆ (not pinned), plus a × delete button.
- **`history:` header text is fixed** — exactly that string, not localized. Same for `connect:` and `pinned:`.
- **History items are plain text only.** Marks ignored, nested lists ignored.
- **History capacity = 20, FIFO + move-to-top dedup.** Older items are dropped when a new command pushes the list past the cap. Pinned items are not counted.
- **Per-item × delete** removes a row immediately with no confirm. The panel header's ⌫ (clear-all bucket) still goes through `confirm(...)`.
- **Serializer emits sections in fixed order:** `connect:` → `pinned:` (sorted, non-tmux first) → `history:` (sorted, non-tmux first). Empty sections are dropped — do not preserve empty headers.
- **`TerminalNoteSpec` has `connect: string[]` and `pinneds: Map<string, string[]>`** in addition to existing `histories` and `history`.
- **Re-input does not auto-press Enter.** Click stages text into the prompt; Shift+click sends `\r`. The user explicitly executes.
- **Whitespace-prefixed commands are NOT captured** (HISTCONTROL=ignorespace convention). Use a leading space to keep a one-off command out of history.
- **OSC 133 shell integration is opt-in per remote** — without the snippet installed, capture is NO-OP and the existing terminal note behaviour is 100% unchanged.
- **No credentials in the note.** Auth flows through the PTY directly.
  Don't add a `password:` field to the note format.
- **Terminal output is ephemeral.** Never written back to `xmlContent`.
- **Bearer tokens, not cookies.** Stored in
  `appSettings.terminalBridgeToken`. Sent on the first WS frame and on
  `/health` via `Authorization: Bearer ...`. Never put the password in
  the note, the URL, or any WS frame.
- **`BRIDGE_SECRET` is stable across restarts.** Rotating it invalidates
  every issued token; clients see `unauthorized` on the next WS connect.
- **`ssh://localhost` ≠ `ssh://user@localhost`.** The former takes the
  in-container login-shell path (`!t.user` is the gate); the latter
  forces ssh through the host's sshd. The containerized deployment
  relies on the latter — write `ssh://you@localhost` for notes that
  target the bridge's host.
- **Containerized rootless Podman deployment requires `Network=host`,
  `UserNS=keep-id`, and `:z` (lowercase) on the `.ssh` bind mount.** Any
  one missing breaks key auth or container-to-host loopback.
- **`history:` (non-tmux) and `history:tmux:<window_id>:` are independent buckets.** Dedup, 20-cap, and debounce all apply per-bucket. Never introduce cross-bucket dedup.
- **Window key uses `@<window_id>` only** — session_id is intentionally not part of the key. Keys stay stable for the lifetime of a tmux window, which matches the user's working unit.
- **PS1 polls the shell context on every prompt.** The shell snippet emits `OSC 133 ; W ; <window_id>` (inside tmux) or `OSC 133 ; W` (outside) at every prompt. This single signal handles tmux start, last-shell exit, attach, window switch, and outside-tmux automatically — `currentWindowKey` is always in sync with what the next command will do. `;C;<hex>;<id>` payload (or its absence) is the secondary correctness baseline.
- **`after-select-window` and `client-attached` hooks are optional micro-optimizations.** They only matter for two no-prompt-redraw transitions (window switch while idle; attach while the active shell already sat at a prompt) where they reduce panel-update latency from "next prompt" to "instant." Detach is the one transition we can't catch instantly — the panel updates on the user's next prompt in the outside shell.
- **The bridge has full shell access** to whatever host runs it.
  `BRIDGE_PASSWORD` is the only line of defense — front it with TLS +
  fail2ban while it's publicly reachable.
- **WOL config lives in `BRIDGE_HOSTS_FILE` (`hosts.json`), never in the
  note.** Note format stays `ssh://[user@]host[:port]` + optional
  `bridge:`. The bridge looks up the host token (case-insensitive); a
  hit triggers a TCP probe → magic packet → port polling, a miss skips
  the wake step entirely (no behaviour change).
- **WOL has no effect when the target is already up** — the immediate
  TCP probe short-circuits before any magic packet or progress
  message.
- **Future improvement ideas:** see `docs/tmux-note-integration.md` for the integration roadmap.

## 리마커블 일기 OCR 파이프라인 (pipeline/)

See the **`tomboy-diary`** skill for the end-to-end workflow, the
operational invariants surfaced during M1–M3 bring-up (uid sanitize
parity with the Cloud Function, busybox+dropbear rM quirks, rmrl vs
rmscene, scp `-P` vs ssh `-p`, the `<link:url>` mark wrapping, the
4-bit Qwen2.5-VL VRAM tuning), the known pitfalls with concrete
symptom→fix mappings, and the recovery playbook.

`pipeline/`은 reMarkable에서 손글씨로 쓴 일기 페이지를 OCR해서 Tomboy 노트로
넣는 별도 파이프라인. 3개 머신을 거침: rM 태블릿 → 라즈베리파이(24/7 인박스) →
데스크탑(Bazzite + RTX 3080) → Firestore.

설계 문서 (M1–M3 bring-up 이전 시점의 의도):
`docs/superpowers/specs/2026-05-10-remarkable-diary-pipeline-design.md`.
구현 계획: `docs/superpowers/plans/2026-05-10-remarkable-diary-pipeline.md`.
rM-side / Pi-side 셋업 레시피 (드라이런 가능한 한 줄짜리 명령들):
`pipeline/pi/README.md`.

핵심 invariant — **노트 제목 안의 `[<rm-page-uuid>]` 마커가 매핑 키 + 보호 신호**.
사용자가 교정 후 제목에서 uuid를 제거하면 같은 페이지를 다시 OCR해도 그 노트는
덮어쓰이지 않고 새 노트가 생김. 다른 보호 메커니즘 없음 (단순함이 핵심).

Pi inbox 는 **페이지 단위 평탄** — `<page-uuid>.{rm,metadata}` 쌍이
`~/diary/inbox/` 에 직접. rM 의 native `.metadata` 는 노트북 단위만 있어서
push 스크립트가 페이지 단위 `.metadata` 스텁을 합성 (`lastModified` 만 의미
있음). `inbox_watcher` 는 `*.metadata` 글로빙으로 페이지를 인식.

s2_prepare 의 렌더러는 **rmscene + Pillow** (rmrl 아님 — rmrl 은 `.content`
sibling 필요, 우리 페이지 평탄 레이아웃이랑 호환 안 됨). rM2 좌표계는 **x 만
centered (~±702), y 는 top-anchored (0~1872)** — translate 는 x 만.

s3_ocr 의 LocalVlmBackend 는 Qwen2.5-VL-7B 를 **nf4 + double-quant + fp16
compute** 로 RTX 3080 10GB 에 맞춤. `AutoModelForImageTextToText` 로
로드 (Qwen2.5 와 v2.0 의 클래스가 다르므로 Auto 가 안전). 모듈 top 에서
`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` 세팅.

s4_write 의 페이로드는 본문에 **`<link:url>` 마크로 이미지 URL 을 감쌈** —
`TomboyUrlLink` 가 input/paste rule 이 없어서 plain URL 은 클릭 안 됨.

빠른 지도:

- `pipeline/desktop/stages/{s1_fetch, s2_prepare, s3_ocr, s4_write}.py` — 4단계.
- `pipeline/desktop/lib/{config, state, log, tomboy_payload, firestore_client, dropbox_uploader}.py` — 공유 모듈.
- `pipeline/desktop/ocr_backends/{base, local_vlm}.py` — Plugin 인터페이스 + Qwen2.5-VL-7B 구현. `__init__.py` 가 `local_vlm` 을 side-effect import 해서 backend 레지스트리 채움.
- `pipeline/desktop/tools/{extract_corrections, segment_lines}.py` — fine-tuning 데이터 준비.
- `pipeline/desktop/bootstrap.py` — `sanitize_account_id` 가 `functions/src/index.ts:280-281` 와 byte-identical 해야 함 (uid 미스매치 = 앱이 노트 못 봄).
- `pipeline/pi/inbox_watcher.py` + `pipeline/pi/deploy/` — Pi 측 인박스.
- `pipeline/pi/README.md` — rM-side (SSH 키 흐름, systemd timer), Pi-side (sshd hardening, fail2ban, NAT) 전체 셋업.
- `pipeline/config/pipeline.yaml` (gitignore) — `bootstrap.py`로 1회 생성.
- `app/src/lib/editor/NoteXmlViewer.svelte` — 노트의 raw xmlContent 를 보는 디버그 모달 (메뉴 → "원본 XML 보기"). bring-up 중 추가.

Firestore 쓰기는 `users/{uid}/notes/{guid}` 네임스페이스를 앱과 공유. uid는
`dbx-{sanitized account_id}` 형식인데 **sanitize 규칙이 Cloud Function
(`functions/src/index.ts:280-281`) 과 정확히 일치해야 함** — `dbid:` prefix
유지, `[^A-Za-z0-9_-]` → `_`, 128자 truncate. 노트북 멤버십은
`system:notebook:일기` 태그로 표현 — 앱의 `FirestoreNotePayload` 형식과
동일. Dropbox는 이미지 호스팅 전용
(`/Apps/Tomboy/diary-images/{YYYY}/{MM}/{DD}/{rm-page-uuid}/page.png`);
노트 본문엔 `<link:url>` 마크로 감싼 공유 링크 URL만.

⚠️ 노트가 앱에 안 보이면 **설정 → 동기화 설정 → "파이어베이스 실시간 노트 동기화"**
가 켜져 있는지 먼저 확인. **default OFF**.

