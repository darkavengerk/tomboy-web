# Tomboy Web

Mobile-first PWA-style web port of the Tomboy desktop note-taking app. Notes live in the browser (IndexedDB); Dropbox is sync/backup, Firestore is the opt-in realtime channel.

## Tech stack

- **SvelteKit** + `@sveltejs/adapter-vercel`. Only `/api/temp-image/*` is a function; everything else is `prerender + ssr=false` (SPA).
- **Svelte 5 runes** (`$state`, `$derived`, `$derived.by`, `$props`, `$effect`). Module reactive state in `.svelte.ts`.
- **TipTap 3** with custom Tomboy extensions.
- **IndexedDB** via `idb`. **Dropbox SDK** OAuth PKCE. **Firestore** for opt-in realtime note + schedule sync.
- **TypeScript** everywhere. `svelte-check` for types; **vitest + @testing-library/svelte** for unit tests.
- **No lint/format configured** — no eslint/prettier in this repo. Use `npm run check` (svelte-check) for type safety.

Notes + sync state live entirely in the client IndexedDB. Server redeploys do not affect user data.

## Workspaces

Multi-package repo. The mobile app is the primary surface; everything else is supporting infra.

| Dir | Stack | Commands |
|---|---|---|
| `app/` | SvelteKit (primary) | `npm run dev` / `build` / `preview` / `check` / `test` |
| `bridge/` | Node + ws (Pi) | `npm run dev`, tests `node --test` (NOT vitest), `mintToken(SECRET)` helper |
| `functions/` | Firebase Cloud Functions | `cd functions && npm run deploy` |
| `claude-service/` | Fastify (desktop only) | see `claude-service/deploy/README.md` |
| `ocr-service/` | Python FastAPI (desktop only) | Quadlet; see `ocr-service/` |
| `pipeline/` | Python OCR (rM diary) | see `pipeline/pi/README.md` |
| `ref/` | original Tomboy desktop source | **read-only reference, do not edit** |

## Skills index

Most subsystems have dedicated skills — invoke via the `Skill` tool when working in that area. Skill bodies hold detailed invariants; CLAUDE.md keeps only what's cross-cutting.

| Skill | Area | Primary paths |
|---|---|---|
| `tomboy-admin` | `/admin` Dropbox sync operator UI | `app/src/routes/admin/`, `lib/sync/adminClient.ts` |
| `tomboy-autolink` | Auto internal-link detection in editor | `lib/editor/autoLink/` |
| `tomboy-graph` | `/desktop/graph` 3D note graph | `lib/graph/`, `routes/desktop/graph/` |
| `tomboy-sleepnote` | Slip-note linked-list + validator | `lib/sleepnote/validator.ts`, `/admin/sleepnote` |
| `tomboy-schedule` | Schedule-note push notifications | `lib/schedule/`, `lib/editor/autoWeekday/`, `functions/src/` |
| `tomboy-notesync` | Firestore realtime note sync | `lib/sync/firebase/` |
| `tomboy-terminal` | SSH terminal notes + tmux spectator | `lib/editor/terminal/`, `bridge/` |
| `tomboy-diary` | reMarkable diary OCR pipeline | `pipeline/` |
| `tomboy-hrsplit` | `---` → vertical column divider | `lib/editor/hrSplit/` (Firefox masonry only) |
| `tomboy-geomap` | `geo:` URL → inline Leaflet card | `lib/editor/geoMap/` |
| `tomboy-ocr-note` | `ocr://` notes (GOT-OCR + translate) + `/admin/gpu` | `lib/ocrNote/`, `ocr-service/` |
| `tomboy-imagecache` | IDB image cache + LRU + fetcher chain | `lib/imageCache/` |

Two features have no dedicated skill yet and live inline below: **이미지 임시 저장소** (Vercel Blob) and **채팅 노트** (`llm://` + `claude://`).

## Architecture

```
app/src/
├── routes/
│   ├── +layout.svelte             # shell: TopNav, banners, mode tracking, installImageFetchers, installRealNoteSync
│   ├── +page.svelte               # → home-marked note (or latest)
│   ├── sleepnote/+page.svelte     # → fixed sleep note GUID
│   ├── notes/+page.svelte         # 전체 list + notebook filter + sort + inline search
│   ├── note/[id]/+page.svelte     # single-note editor (parseTerminalNote branch → TerminalView)
│   ├── settings/+page.svelte
│   ├── admin/                     # Dropbox sync ops (see tomboy-admin)
│   ├── desktop/                   # multi-window operator UI (isChromeless)
│   └── api/temp-image/            # ONLY server function (Vercel Blob temp storage)
├── lib/
│   ├── core/                      # note model, archiver, manager, title rewrite, home, notebooks
│   ├── storage/                   # idb schema, noteStore, appSettings
│   ├── firebase/app.ts            # shared singletons + Dropbox-bridged ensureSignedIn
│   ├── sync/                      # dropbox + firebase channels, manifest, admin, imagePromotion
│   ├── editor/                    # TomboyEditor + extensions + plugins
│   ├── desktop/                   # /desktop workspace (windows, session, dragResize)
│   ├── imageCache/, schedule/, sleepnote/, chatNote/, ocrNote/, gpuMonitor/, graph/, ...
│   ├── components/, stores/, search/, utils/
```

`전체` page (`routes/notes/+page.svelte`) chains `filterByNotebook(allNotes, selectedNotebook) → searchNotes(..., query)` — search narrows whatever the notebook filter selected. No separate `/search` route.

## Navigation & modes

Top nav has 3 primary entries — **exactly one is always selected** (`aria-current="page"`).

| Entry | Route | Mode |
|---|---|---|
| 홈 | `/` | `home` |
| 슬립노트 | `/sleepnote` | `sleepnote` |
| 전체 | `/notes` | `notes` |

`lib/stores/appMode.svelte.ts` holds the mode (Svelte 5 rune, sessionStorage-persisted). `afterNavigate` in `+layout.svelte` derives mode from URL via `modeFromUrl`:

- `/` → home, `/sleepnote` → sleepnote, `/notes` → notes
- `/note/[id]?from=…` → that mode
- Anything else (settings, admin) → mode unchanged so the last-selected entry stays highlighted

Home redirects to the user's home note (`core/home.ts`) or latest. Sleepnote redirects to the fixed GUID `1c97d161-1489-4c32-93d9-d8c383330b9c`. New top-level destinations must either be a mode or leave the existing mode highlighted while there.

## Whole-app invariants

- **Notes are user-IndexedDB.** Server redeploys never touch user data.
- **`.note` XML preserved verbatim** for Tomboy desktop round-trip.
- **Titles are globally unique, case-sensitive, trimmed.** Internal-link marks store destination *title* (not guid), so collisions = link ambiguity. Enforcement + cascade in next section.
- **Dropbox sync is explicit only** — user clicks "지금 동기화". No auto-sync on startup/focus/save. Dropbox = backup channel. (Auto-sync was removed intentionally; do not reintroduce without asking.)
- **Firestore realtime sync is opt-in, OFF by default.** Per-note attach + collection-level cursor (`serverUpdatedAt > lastFirebaseSyncAt`). Never-opened-anywhere notes only flow via Dropbox. See `tomboy-notesync`.
- **Dropbox sync protocol** follows Tomboy revision scheme: `/{rev/100}/{rev}/{guid}.note` + root `/manifest.xml`. `syncManager.sync()` is authoritative.
- **Mobile-first single-note-per-page** UI on `/note/[id]`. Avoid split views / desktop-only patterns there.
- **All UI strings in Korean.** Match the existing tone.
- **Responsive bars** (TopNav, 전체 filter bar) size with `clamp(min, Xvw, max)` for gaps/paddings/font sizes. Do not hardcode pixel values on those bars.

## Title uniqueness & rename cascade

The trimmed title is the link identity. Every data-entry point funnels through one of these:

- **Editor blur** — `titleUniqueGuard.handleTitleBlur` toasts + snaps cursor back on collision; latches reported title to avoid re-toast (`TomboyEditor.svelte`).
- **Editor save** — `noteManager.updateNoteFromEditor` re-checks via `checkTitleConflict`; silently refuses on collision (UI surfaces the error).
- **Import + sync-pull** — `titleRewrite.prepareIncomingNoteForLocal` auto-suffixes ` (2)`, ` (3)`, …, rewrites first line inside `<note-content>`, sets `localDirty=true` (propagates back on next sync), toasts the rename.

Rename cascade (when editor save changes a title):

1. Persist renamed note.
2. `rewriteBacklinksForRename` literal-replaces `<link:internal|broken>OLD</link:…>` across every non-deleted note. Each rewritten note becomes `localDirty=true`.
3. `noteReloadBus.emitNoteReload(affected)` — open editors subscribed via `subscribeNoteReload` drop pending debounced doc and reload from IDB. Without this, the stale in-memory doc would clobber the rewrite on its next save.

All title→guid lookups (autolink index, `buildGraph`, `findNoteByTitle`, `mustGetByTitle`) are exact-case trimmed. **Exception:** `lib/sleepnote/validator.ts` is deliberately case-insensitive (reporting tool, not a mutation path).

`/admin` dashboard shows "제목 중복 경고" via `titleInvariantCheck.scanDuplicateTitles` for pre-enforcement / direct-IDB violators that need manual cleanup.

## Cross-window mutation pattern (desktop)

Any op that rewrites multiple notes at once (slip-note splicing is the current instance) must assume other windows hold stale `pendingDoc`:

```ts
await desktopSession.flushAll();                     // drain pending editor saves
const { affectedGuids } = await multiNoteOp(...);
await desktopSession.reloadWindows(affectedGuids);   // force IDB reload everywhere
```

`flushAll` / `reloadWindows` in `lib/desktop/session.svelte.ts`; both swallow per-hook errors so one broken window can't stall the op. `reloadHooks` (desktop session) and `noteReloadBus` (core) are **independent channels** — first covers open editor windows for chain-type ops, second works outside the desktop workspace (so rename sweep works on mobile too).

## Svelte 5 conventions

- Runes only. No legacy stores, no `export let`.
- Module reactive state in `.svelte.ts` files so runes compile.
- Event props lowercase: `onchange`, `onclick`, `oninternallink`.
- `bind:this={ref}` returns instance; expose methods with `export function` inside `<script>`.

## Editor shortcuts & UX

- **Ctrl/Cmd+D** — insert `yyyy-mm-dd` wrapped in `tomboyDatetime` mark (Tomboy `<datetime>` round-trip preserved); mark unset right after so subsequent typing is plain (`lib/editor/insertDate.ts`). Browser bookmark shortcut suppressed.
- **Alt+→ / Alt+←** — surgical list-item depth change (`lib/editor/listItemDepth.ts`). Only the operated `<li>` moves; descendants stay at current visual depth. Multi-select supported within deepest common-ancestor list. **Tab / Shift+Tab keep TipTap's standard whole-subtree behavior** — surgical variant is the alt-modifier opt-in.
- **Right-click** — `EditorContextMenu.svelte`, enabled via `enableContextMenu` prop on `TomboyEditor` (NoteWindow only; mobile route leaves it off). Items: 잘라내기/복사/형식 복사 (HTML / 일반 / Markdown)/붙여넣기/오늘 날짜/리스트로 만들기/깊이↑↓ (hidden outside a list)/링크 열기.

## Copy with format

`lib/editor/copyFormatted.ts` — 4 serializers from editor JSON (or `copySelectionAsJson` slice):

- `tiptapToPlainText` — bare. List items emit content only (no `- `, no indent) so paste-into-list merges.
- `tiptapToStructuredText` — keeps list structure. Bullet glyphs cycle by depth (`•` → `○` → `■`, clamped). Ordered = `1. 2. 3.` Two-space indent per level. 형식 복사 → "리스트 형식 유지".
- `tiptapToHtml` — minimal semantic (`<p>`, `<ul>`, `<strong>`, …). Emitted alongside plain text on every Ctrl+C/X.
- `tiptapToMarkdown` — bold/italic/strike/monospace, `[x](href)`, `[[x]]`, bullet nesting. Blocks join with single `\n` (mirrors per-block display; renderers needing `\n\n` between paragraphs should use the HTML path).

`clipboardPlainText.ts` writes both `text/plain` + `text/html` on Ctrl+C/X. Right-click 복사 same; 형식 복사 submenu forces a single format via `writeText`.

## Desktop mode (`/desktop`)

Multi-window operator UI for desktop browsers, separate from mobile single-note flow. `lib/desktop/`:

- `DesktopWorkspace.svelte` — root, hosts floating windows.
- `NoteWindow.svelte` — draggable/resizable note editor. Branches between `TerminalView` and `TomboyEditor` on `parseTerminalNote(editorContent)`.
- `SettingsWindow.svelte`, `SidePanel.svelte`.
- `session.svelte.ts` — `$state` module: windows, positions, sizes, z-stack, focus; `updateGeometry(guid, g)` atomic 4-field update.
- `dragResize.ts` — pointer-driven move + 8-way resize (pure geometry; N/W handles shift x/y so opposite edge stays pinned on clamp; `applyResize(base, dir, dx, dy, min)`).
- `ResizeHandles.svelte` — 4 edges + 4 corners (used by NoteWindow + SettingsWindow).

Window features:

- **Pin (항상 위)** — `DesktopWindowState.pinned?: boolean`, persisted. Effective z = `(pinned ? 1_000_000 : 0) + z` — pinned always above unpinned regardless of raw z. Title bar toggle; API `togglePin` / `isPinned`.
- **Send to back** — middle-click title bar → `sendToBack(guid)` sets z to `minZ - 1` of other windows in workspace. Pin unchanged.

`/desktop/*` is `isChromeless` in the root layout (TopNav suppressed). `/desktop/graph` documented in `tomboy-graph`.

## Cross-cutting infra invariants

These touch multiple skills. Single-skill invariants live inside their skill.

- **`uid = dbx-{sanitized account_id}`** is the shared namespace across app + `functions/src/index.ts` + `pipeline/desktop/bootstrap.py`. `sanitize_account_id` in bootstrap.py **must stay byte-identical to `functions/src/index.ts:280-281`** — drift = app can't see pipeline notes. Used by `users/{uid}/notes/...` Firestore + schedule + diary.
- **Firebase `ensureSignedIn` is Dropbox-bridged.** Custom token via `dropboxAuthExchange` Cloud Function. NOT anonymous. Shared singleton in `lib/firebase/app.ts` consumed by note sync + schedule + diary.
- **Dropbox-pulled notes don't auto-push to Firestore.** `applyIncomingRemoteNote` uses `putNoteSynced` and bypasses `notifyNoteSaved`. Cross-device propagation happens on next open (attach-side reconcile) or via incremental cursor on other devices.
- **Schedule updates do NOT propagate via Dropbox sync.** Multi-device push coverage requires notifications enabled on every device.
- **Image storage = two channels.** New paste → Vercel Blob (temp). User-explicit "Dropbox로 저장" promotes to Dropbox. Existing Dropbox images untouched (no migration). Diary pipeline / terminal note paste / OCR note keep their own paths.
- **`IMAGE_STORAGE_TOKEN` env (Vercel) ≡ `appSettings.imageStorageToken` (client)** byte-identical. Same pattern as `BRIDGE_SECRET` (Pi) ≡ `BRIDGE_SHARED_TOKEN` (ocr-service) and the terminal bridge Bearer token.
- **Cache key for image fetch is the exact post-`toDirectImageUrl` URL** (`?raw=1` byte-identical). Don't normalize downstream — query param reorder silently breaks cache. See `tomboy-imagecache`.
- **`www.dropbox.com` blocks `fetch()` (no CORS) but works as `<img src>`.** Use the `ImageFetcher` registry (`dropboxFetcher` routes via SDK `sharingGetSharedLinkFile`). Plain `fetch()` only as fallback. See `tomboy-imagecache`.

## 이미지 임시 저장소 (Vercel Blob)

Spec: `docs/superpowers/specs/2026-05-27-temp-image-storage-design.md`. Two-channel model: new paste lands in Vercel Blob (temp), user explicitly promotes via `/admin/images` to move into Dropbox.

Hook: `TomboyEditor.svelte:uploadAndInsertImage` calls `uploadTempImage()`. Original `uploadImageToDropbox()` runs only on promotion.

Files:

- `lib/sync/tempImageUpload.ts` — `/api/temp-image/*` client wrapper
- `lib/sync/imageInventory.ts` — note scan + Vercel list union
- `lib/sync/imagePromotion.ts` — fetch → Dropbox → rewrite URLs → Vercel delete
- `lib/sync/imageUpload.ts` — Dropbox upload + `downloadImageFromUrl` host branch
- `routes/api/temp-image/` — POST (token mint via `clientPayload`) / DELETE / list GET
- `routes/api/temp-image/_lib/auth.ts` — Bearer validation + `requireBearerOrResponse`
- `routes/admin/images/+page.svelte` — inventory UI
- `lib/storage/appSettings.ts` — `imageStorageToken` key

Invariants:

- **No migration.** Existing Dropbox images stay. Changes only affect new paste.
- **POST sends token in `clientPayload` JSON** (Vercel `@vercel/blob/client.upload()` disallows custom headers). DELETE/list use `Authorization` header. Server validates both against `IMAGE_STORAGE_TOKEN`.
- **`temp-images/` pathname prefix** in both `tempImageUpload.ts` and `list/+server.ts:PREFIX`. Drift = silent empty list, successful upload.
- **Promotion = move, not copy.** URL rewrite first; Vercel blob deletion only after every note rewritten successfully (`imagePromotion.ts` step 6 guard).
- **OCR cross-device retry via `downloadImageFromUrl`** branches by host: Dropbox → SDK path (CORS workaround), Vercel → plain fetch (Vercel Blob is CORS-open).
- **Image cache integration**: `cachePrime` at upload end; `downloadImageFromUrl`'s Vercel path wraps `cacheGetBlob`/`cachePrime`. Dropbox path is already wrapped by `downloadImageFromDropboxUrl`. No separate `vercelBlobFetcher` — `lookupOrFetch`'s plain-fetch fallback handles Vercel.
- **No auto-expiry.** User must clean up / promote explicitly in admin. Intentional — never silently lose note images.
- **Terminal note paste / 일기 pipeline / OCR note unaffected** (SSH ControlMaster / desktop pipeline / GOT-OCR each keep their own path).

## 채팅 노트 (`llm://` + `claude://`)

Two-backend chat notes. Body signature: `llm://<model>` (Ollama, desktop service) or `claude://[<model>]` (Claude Code CLI subprocess, subscription OAuth).

Common shape: `Q:`/`A:` turns, send button, streaming, abort, Korean errors. Headers — Ollama: `temperature`/`num_ctx`/`top_p`/`seed`/`num_predict`/`rag`; Claude: `cwd` (tool-enable gate)/`allowedTools`/`model`; both: `system`. `parseChatNote` recognizes both signatures; cross-backend headers silently ignored.

Files: `lib/chatNote/` (`parseChatNote`, `defaults`, `backends/{ollama,claude}.ts`, `buildClaudeMessages.ts`), `lib/editor/chatNote/ChatSendBar.svelte` (backend branch), `bridge/src/claude.ts` (POST `/claude/chat` proxy), `claude-service/` (desktop Fastify, `claude -p` stream-json → SSE).

Invariants:

- **Claude backend forces subscription OAuth.** `claude-service/src/runner.ts` spawns with `ANTHROPIC_API_KEY=''` explicit empty — prevents host API-key leak.
- **claude-service is desktop-only** (same machine as ocr-service). Never on Pi bridge (CPU-only, and OAuth creds live in host `~/.claude`).
- **Tool-enable gate = presence of `cwd:` header.** No `cwd:` → spawn args force `--disallowedTools '*'`. With `cwd:` → default toolset or `allowedTools:`.
- **Images = Dropbox URL passthrough.** `tomboyUrlLink` mark + image extension → Anthropic `image/url` content block direct, no base64.
- **No session resume.** Note is source of truth. Every send re-serializes full transcript from Q:/A: history. User-edited history reflected in next send.
- **`llm://` notes unchanged.** `LlmNoteSpec` / `LLM_*` constants remain as aliases inside `chatNote/`.

⚠️ Claude backend prereq: run `claude login` once on the desktop. Setup: `claude-service/deploy/README.md`.

## Deployment

- **Frontend**: Vercel via `adapter-vercel`. Produces `.vercel/output/` with static SPA + `functions/api/temp-image/`. Env vars: `PUBLIC_DROPBOX_APP_KEY` (Vite public), `BLOB_READ_WRITE_TOKEN` (Vercel auto), `IMAGE_STORAGE_TOKEN` (manual, byte-identical to app's "이미지 서버 토큰"). See `app/README.md`.
- **Cloud Functions** (`functions/`): `cd functions && npm run deploy`. Hosts `fireSchedules`, `sendTestPush`, `dropboxAuthExchange`.
- **Bridge / ocr-service / claude-service**: rootless Podman + Quadlet. Pi (bridge) and desktop (services). See respective `deploy/` dirs.
- **Pipeline**: see `pipeline/pi/README.md`.

## Testing

- **`app/`**: `npm run test` (vitest + @testing-library/svelte). Unit tests in `app/tests/unit/` mirroring `src/lib/` paths. `fake-indexeddb` for IDB-touching tests; per-test generation counter pattern for image-cache isolation.
- **`bridge/`**: `node --test` (NOT vitest). `mintToken(SECRET)` helper for auth-required endpoints.
- **No automated sync test against real Dropbox.** Verify sync changes manually via 설정 → "지금 동기화".
- **No e2e.** Cross-flow verification = `npm run dev` + browser.

## graphify

Knowledge graph at `graphify-out/`. Before architecture / cross-module questions, read `graphify-out/GRAPH_REPORT.md` (god nodes, communities) or use `graphify query "..."` / `graphify path "A" "B"` over grep. After code edits in a session: `graphify update .` (AST-only, no API cost).
