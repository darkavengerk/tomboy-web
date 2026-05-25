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

See the **`tomboy-notesync`** skill. Second sync channel alongside
Dropbox: (1) per-IDB-write debounced push to `users/{uid}/notes/{guid}`,
(2) doc-level attach while a note is open, (3) collection-level
incremental sync via `serverUpdatedAt > lastFirebaseSyncAt`. Default
**OFF** (설정 → 동기화 설정). Dropbox stays as backup + authority for
the never-opened-anywhere backlog.

Quick map: `app/src/lib/sync/firebase/` (orchestrator, `notePayload`,
`conflictResolver`, `pushQueue`, `openNoteRegistry`, `incrementalSync`,
`noteSyncClient.firestore.ts`), `app/src/lib/firebase/app.ts` (shared
singletons + `ensureSignedIn`, used by schedule + diary too).
`noteManager.notifyNoteSaved(guid)` after every IDB write;
`attachOpenNote`/`detachOpenNote` in note routes;
`installRealNoteSync()` in root `+layout.svelte`. Watermark:
`appSettings.firebaseNotesLastSyncAt`.

Cross-cutting invariants worth caching:

- **Same uid as schedule + diary** — `dbx-{sanitized account_id}`.
  Shared `users/{uid}/...` namespace.
- **Last-write-wins on `changeDate`** (tiebreak: `metadataChangeDate`,
  then prefer-local). Equivalent payload → `noop`, which also suppresses
  echo of our own write (no separate tracker).
- **Incremental cursor uses `serverUpdatedAt`, NOT `changeDate`.**
  `changeDate` is wall-clock ISO, unsafe across TZ offsets. Conflict
  resolution still uses `changeDate`.
- **Soft-delete only.** Tombstones bump `changeDate` /
  `metadataChangeDate` alongside `deleted=true`.
- **Dropbox-pulled notes don't auto-push to Firestore.**
  `applyIncomingRemoteNote` uses `putNoteSynced` + bypasses
  `notifyNoteSaved`. Pull propagates on next open (attach-side reconcile)
  or via other devices' incremental cursor.
- **900 KB payload ceiling** (Firestore 1 MiB with slack). Oversized
  notes throw + are skipped.

**Don't** add an echo tracker, **don't** reintroduce Dropbox auto-sync
to fix the closed-note gap, and **don't** reach into `firebase/firestore`
outside `noteSyncClient.firestore.ts` — every other module consumes
`FirestorePrimitives`.

## 일정 알림 (schedule-note push notifications)

See the **`tomboy-schedule`** skill. Parser format (Korean date/time list
items under `N월`), fire-time rules (07:00 day-of for every entry; +T-1h
+ T-0 for time-bearing entries; weekly Mon 07:00 / monthly 1st 07:00
KST), `fnv1a64` item-id, Dropbox-bridged custom-token auth, PWA install,
auto-weekday plugin, focus-scoped 보내기 gate.

Hook: `noteManager.updateNoteFromEditor` → `syncScheduleFromNote` after
saving; if the saved guid is the schedule note, the diff lands in pending
+ `flushIfEnabled()` drains to Firestore. Notes received via Dropbox
sync do NOT trigger this.

Quick map: `app/src/lib/schedule/`, `lib/editor/autoWeekday/`,
`lib/editor/sendListItem/`, `lib/core/schedule.ts`,
`app/src/service-worker.ts` (Firebase init, iOS-branched
`onBackgroundMessage`), `functions/src/index.ts` (`fireSchedules`,
`sendTestPush`, `dropboxAuthExchange`), `firestore.rules` +
`firestore.indexes.json`, PWA infra (`app.html`,
`static/manifest.webmanifest`, `static/icons/icon-{180,192,512}.png`).

Cross-cutting invariants worth caching:

- **Auth uid = `dbx-{sanitized account_id}`** via `dropboxAuthExchange`
  custom token (NOT anonymous). Shared with note sync + diary.
- **Multi-device coverage requires notifications enabled on every
  device** — Dropbox sync doesn't propagate schedule updates.
- **iOS auto-displays FCM `notification` payloads** — SW must be log-only
  on iOS to avoid duplicates. PWA install metadata (PNG `apple-touch-icon`)
  is load-bearing for push subscription persistence.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)

## 터미널 노트 (SSH terminal in a note)

See the **`tomboy-terminal`** skill. Note body = ssh URL + optional
`bridge:` + optional `spectate:` (1–3 metadata paragraphs, any order) +
optional `connect:` / `pinned:` / `history:` sections.

Spectator mode runs on a **1:N SpectatorHub model**: one shared ssh +
tmux -CC client per `(target, session)`, with per-WS
`SpectatorSubscription`s filtering `%output` to their own pane (either
follow-active or pinned to an ordinal). Pin is persisted as
`spectate: <session>:<N>`, ordinal-based (window switch → re-resolves).
WS frames `subscribe-pane` (client → bridge) and `pane-unavailable`
(bridge → client) wire the pin protocol. Last subscription close
destroys the hub immediately (no grace timer).

Quick map:

- `app/src/lib/editor/terminal/` — `parseTerminalNote.ts`, `wsClient.ts`,
  `TerminalView.svelte`, `bridgeSettings.ts`, `historyStore.ts`,
  `connectAutoRun.ts`, `oscCapture.ts`, `HistoryPanel.svelte`,
  `terminalBell.ts`, `imagePasteClient.ts`, `clipboardImage.ts`,
  `stickyMods.ts`.
- `routes/note/[id]/+page.svelte`, `lib/desktop/NoteWindow.svelte` —
  branch between `TerminalView` and `TomboyEditor` on
  `parseTerminalNote(editorContent)` at load + after every IDB reload.
- `bridge/src/` — `server.ts`, `auth.ts`, `pty.ts`, `hosts.ts`, `wol.ts`,
  `tmuxControlClient.ts`, `spectatorHub.ts` (Hub + Subscription +
  Registry), `spectatorSession.ts` (pure helpers only — no class),
  `imageTransfer.ts`. Deployment: `Containerfile`,
  `deploy/term-bridge.container` (Quadlet), `deploy/Caddyfile`,
  `deploy/tomboy-spectator.tmux`.

Cross-cutting invariants worth caching (full set lives in the skill):

- **Bridge ≠ model host.** Pi bridge has no GPU. Ollama / ocr-service /
  claude-service live on a separate desktop (RTX 3080), reached via
  `OLLAMA_BASE_URL` / `OCR_SERVICE_URL` / `RAG_SEARCH_URL`. Same-machine
  assumption has bitten past work — don't.
- **No credentials in the note.** Auth flows through the PTY directly;
  Bearer tokens live in `appSettings.terminalBridgeToken`. Terminal
  output is ephemeral (never written to `xmlContent`).
- **`ssh://localhost` ≠ `ssh://user@localhost`** — former drops into
  the container's own shell; latter forces ssh through host sshd. The
  containerized deployment relies on the latter.
- **WOL config lives in `BRIDGE_HOSTS_FILE` (`hosts.json`), never in
  the note.** Note format stays `ssh://[user@]host[:port]` + optional
  `bridge:` + optional `spectate:`.
- **Spectator hub is shared per `(target, session)`** — one ssh + tmux
  -CC + ControlMaster socket; subscriptions filter `%output` fan-out by
  paneId. Last close → immediate `hub.destroy()`. Image transfer reuses
  the hub's ControlMaster socket.
- **Spectator MUST NOT constrain tmux window size.** Bridge claims
  500x200 via stty + refresh-client; target must set `window-size
  smallest`. Both halves required.
- **Nav buttons (`« 1 2 3 4 »`) act on the SESSION** — they move the
  desktop user's view too (intentional; mobile acts AS the user).
- **Pin is ordinal-based, not paneId-based.** `spectate: <s>:<N>`
  persists the ordinal. Don't introduce a pin-by-paneId variant.
- **이미지 붙여넣기는 ControlMaster 멀티플렉싱으로 재인증 없이 전송.**
  셸은 `pty.write(bracketedPaste(path))`, 관전은
  `subscription.sendInput` → `hub.sendInput` → `tmux send-keys -H`.
  노트 포맷에 경로·패스워드 힌트 필드를 추가하지 말 것.

## 리마커블 일기 OCR 파이프라인 (pipeline/)

See the **`tomboy-diary`** skill. End-to-end: rM 태블릿 → 라즈베리파이
인박스 → 데스크탑 OCR (Qwen2.5-VL-7B, 4-bit nf4 on RTX 3080) → Firestore.
Setup: `pipeline/pi/README.md`. Design docs:
`docs/superpowers/{specs,plans}/2026-05-10-remarkable-diary-pipeline*.md`.

Quick map: `pipeline/desktop/stages/{s1_fetch,s2_prepare,s3_ocr,s4_write}.py`
(4-stage flow), `pipeline/desktop/lib/`, `pipeline/desktop/ocr_backends/`,
`pipeline/desktop/bootstrap.py` (generates `pipeline/config/pipeline.yaml`),
`pipeline/pi/inbox_watcher.py` + `deploy/`,
`app/src/lib/editor/NoteXmlViewer.svelte` (디버그 모달, "원본 XML 보기").

Cross-cutting invariants worth caching:

- **노트 제목 안의 `[<rm-page-uuid>]` 마커 = 매핑 키 + 보호 신호.** 교정 후
  uuid를 제목에서 지우면 같은 페이지를 다시 OCR해도 그 노트는 덮어쓰이지
  않고 새 노트가 생김. 다른 보호 메커니즘 없음.
- **`sanitize_account_id` (`pipeline/desktop/bootstrap.py`) MUST be
  byte-identical to `functions/src/index.ts:280-281`** — uid 미스매치
  시 앱이 파이프라인 노트를 못 봄. 두 파일을 같이 수정해야 함.
- **Firestore 네임스페이스는 앱과 공유** (`users/{uid}/notes/{guid}`,
  `uid = dbx-{sanitized account_id}`). 노트북 멤버십 = `system:notebook:일기`.
- **Dropbox는 이미지 호스팅 전용**
  (`/Apps/Tomboy/diary-images/{YYYY}/{MM}/{DD}/{rm-page-uuid}/page.png`);
  노트 본문은 `<link:url>` 마크로 공유 링크 wrapping 필수.

⚠️ 노트가 앱에 안 보이면 **설정 → 동기화 설정 → "파이어베이스 실시간
노트 동기화"** 가 켜져 있는지 먼저 확인 (default OFF).

## OCR 노트 + GPU 모니터

See the **`tomboy-ocr-note`** skill. Notes whose first line is
`ocr://<model>` are OCR-trigger notes: pasting an image runs a two-stage
flow (GOT-OCR-2.0-hf on desktop ocr-service → Ollama translation
English→Korean) and streams `[원문]` / `[번역]` into the note.
`/admin/gpu` shows VRAM + per-model unload. Distinct from the diary
pipeline (different stack + trigger + output).

Quick map: `app/src/lib/ocrNote/`, `app/src/lib/gpuMonitor/`,
`app/src/routes/admin/gpu/+page.svelte`, `bridge/src/{ocr,gpu}.ts`,
`ocr-service/` (Python FastAPI, transformers-native, Containerfile +
Quadlet).

Cross-cutting invariants worth caching:

- **Model: `stepfun-ai/GOT-OCR-2.0-hf` (HF native), NOT the legacy
  `GOT-OCR2_0` custom-code variant** — legacy chains compatibility breaks
  with every transformers/torch update.
- **`spec.legacy` is the flow switch.** Absence of `translate:` →
  `legacy=true` → single-call combined-prompt flow (preserved for old
  notes). Presence → two-stage flow. `target_lang:` is dropped silently
  (don't reintroduce — flow is fixed English→Korean).
- **OCR single-shot, translation streams.** ocr-service idle
  auto-unloads after `OCR_IDLE_UNLOAD_S` (default 300s); coexists with
  Ollama on the same GPU pool, neither sees the other's allocation.
- **`BRIDGE_SECRET` (Pi) == `BRIDGE_SHARED_TOKEN` (ocr-service)**
  byte-identical. `OCR_SERVICE_URL` has no default — bridge refuses to
  boot without it (prevents same-machine assumption).
- **Bridge tests use `node:test` + `mintToken(SECRET)`**, NOT vitest.
- **Dependency cage**: `torch>=2.4,<2.5` / `transformers>=4.49,<4.50` /
  `accelerate<1.0`. Lift via Ubuntu 24.04 + Python 3.12 base.

## 채팅 노트 (`llm://` + `claude://`)

두 백엔드 채팅 노트. 시그니처: `llm://<model>` (Ollama, 데스크탑 서비스)
또는 `claude://[<model>]` (Claude Code CLI subprocess, 구독 OAuth).
공통: Q:/A: 턴 구조, 보내기 버튼, 스트리밍, abort, 한국어 에러. 헤더 —
Ollama: `temperature`/`num_ctx`/`top_p`/`seed`/`num_predict`/`rag`;
Claude: `cwd` (있으면 도구 활성, 없으면 chat-only)/`allowedTools`/`model`;
공통: `system`. `parseChatNote`가 두 시그니처 모두 인식,
cross-backend 헤더는 silently ignored.

Quick map: `app/src/lib/chatNote/` (`parseChatNote`, `defaults`,
`backends/{ollama,claude}.ts`, `buildClaudeMessages.ts`),
`app/src/lib/editor/chatNote/ChatSendBar.svelte` (spec.backend 분기),
`bridge/src/claude.ts` (POST /claude/chat 프록시),
`claude-service/` (데스크탑 Fastify, `claude -p` stream-json → SSE).

Cross-cutting invariants worth caching:

- **Claude 백엔드는 구독 OAuth 강제.** `claude-service/src/runner.ts`가
  spawn 시 `ANTHROPIC_API_KEY=''`를 명시적으로 빈 문자열 — host 환경의
  API 키 leak 차단.
- **claude-service는 데스크탑에만** (ocr-service와 같은 머신). Pi
  브릿지에는 절대 깔지 않음 (CPU only, OAuth 자격증명은 host의
  `~/.claude`).
- **도구 활성 게이트 = `cwd:` 헤더 존재 여부.** 없으면 spawn args에
  `--disallowedTools '*'` 강제. 있으면 디폴트 도구셋 또는 `allowedTools:`.
- **이미지는 Dropbox URL 패스스루.** `tomboyUrlLink` 마크 + 이미지
  확장자 → Anthropic `image/url` content block 직통, base64 변환 없음.
- **세션 resume 안 함.** 노트가 single source of truth, 매 전송마다
  transcript 전체를 messages 배열로 재직렬화. 사용자가 Q:/A: 히스토리
  편집 시 다음 보내기에 그대로 반영.
- **이중 백엔드 호환성**: `llm://` 노트 zero behavior change.
  `LlmNoteSpec` / `LLM_*` 상수는 `chatNote/` 안 alias로 살아있음.

⚠️ Claude 백엔드 사용 전: 데스크탑에서 `claude login` 1회 실행 필수.
셋업: `claude-service/deploy/README.md`.

