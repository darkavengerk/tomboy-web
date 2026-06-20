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
| `tomboy-backlinkindex` | In-memory backlink index + rename sweep + flushSave race fix | `lib/core/backlinkIndex.ts`, `lib/core/noteManager.ts` |
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
| `tomboy-dataautomation` | `자동화::` note ⟳ button → bridge → desktop runner → refresh `DATA::` chart-note CSV | `lib/automation/`, `lib/editor/automationNote/`, `bridge/src/automation.ts`, `automation-service/` |
| `tomboy-musicextract` | `음악추출::` 노트 ⟳ → 데스크탑 yt-dlp → mp3(단일/재생목록/`챕터:` 분할) → 브릿지 `/files` 저장·재생 | `lib/musicExtract/`, `lib/editor/musicExtractNote/`, `bridge/src/music.ts`, `music-service/` |
| `tomboy-musicplayer` | `음악::` 노트 재생 — 전역 단일 오디오 엔진 + 싱글톤 큐, 노트별 이어듣기, 세션 복원, 모바일 알약/데스크탑 레일, iOS 자동재생 함정 | `lib/music/`, `lib/editor/musicNote/` |
| `tomboy-remarkable-send` | 노트 → PDF 번들(forward + backward 트리 + 이미지/차트) → 브릿지 SSH → reMarkable xochitl | `lib/remarkable/`, `bridge/src/remarkableSendPdf.ts` |
| `tomboy-notebundle` | `[체크박스]탭:N`/`묶음:N` + 내부링크 리스트 → 인-에디터 파일철 두 종류(탭=활성중심 재귀 윈도우 / 묶음=5바 타이틀 윈도우) + 임베디드 TomboyEditor. 제목 `탭::`/`묶음::` → 본문 전체가 풀-노트 파일철(전용 노트). 데스크탑 노트 드래그 핸들 → 묶음 위 드롭 = 리스트에 항목 추가(묶음 전용) | `lib/editor/noteBundle/` |
| `tomboy-tally` | `집계::` 익명 투표/퀴즈 전용 노트 — 본문 파싱(`|중복가능|정답:N`) + 클라 집계/채점 + top-level Firestore `polls/{guid}` + 호스트/게스트 분기 + `/poll/<제목>` 키오스크 공유링크 | `lib/tally/`, `lib/editor/tallyNote/`, `routes/poll/[title]/` |
| `tomboy-bridgedash` | `브릿지::` 노트 ⟳ → 브릿지 `GET /status` 집계 → 시스템(디스크/메모리/온도)+서비스 도달성+파일+연결을 `---` 섹션·```csv 표로 본문 스냅샷 렌더 | `lib/bridgeStatus/`, `lib/editor/bridgeNote/`, `bridge/src/status.ts` |
| `tomboy-hue` | `조명::` 노트 — Hue 허브 전구/존/씬 제어(브릿지 직통 CLIP v2) | `lib/hue/`, `lib/editor/hueNote/`, `bridge/src/hue.ts` |

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
- **User-facing features must be documented in 설정 → 가이드.** Whenever you add a new note format (e.g., terminal/schedule/sleep/diary/remarkable/OCR/chat note), a new editor inline block (e.g., CSV/TSV table, HR split, geo map, inline radio), or a new environment / compatibility requirement (e.g., Firefox flag, iOS PWA, permission flow), append a `<details class="guide-card">` to the appropriate sub-tab in `app/src/routes/settings/+page.svelte` (`guideSubTab`: `notes` / `editor` / `env`). The guide tab is the user's discovery surface — features that aren't there might as well not exist. Skill bodies, code comments, and PR descriptions do NOT substitute for this. Mirror the existing card pattern: short `<summary>`, one `<p class="info-text">` intro, optional `<pre class="snippet">`, then a `<ul class="guide-list">` with constraints / gotchas / link buttons to related tabs.

## Title uniqueness & rename cascade

The trimmed title is the link identity. Every data-entry point funnels through one of these:

- **Editor blur** — `titleUniqueGuard.handleTitleBlur` toasts + snaps cursor back on collision; latches reported title to avoid re-toast (`TomboyEditor.svelte`).
- **Editor save** — `noteManager.updateNoteFromEditor` re-checks via `checkTitleConflict`; silently refuses on collision (UI surfaces the error).
- **Import + sync-pull** — `titleRewrite.prepareIncomingNoteForLocal` auto-suffixes ` (2)`, ` (3)`, …, rewrites first line inside `<note-content>`, sets `localDirty=true` (propagates back on next sync), toasts the rename.

Rename cascade (when editor save changes a title):

1. Persist renamed note.
2. `rewriteBacklinksForRename` looks up affected notes via the in-memory backlink index (O(M)) and rewrites `<link:internal|broken>OLD</link:…>` → `<link:…>NEW</link:…>` in parallel via `Promise.allSettled`. Each rewritten note becomes `localDirty=true`. See `tomboy-backlinkindex` skill.
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

## z-index 레이어 규약

Single source of truth: the `--z-*` token scale in `app/src/app.css` `:root`. Tiers are 100 apart so there's room to wedge between without renumbering. **Never hardcode a competing z-index; never bump a number to "win" — pick the right tier or add one to the scale.**

| Token | Value | Owns |
|---|---|---|
| `--z-sticky` | 100 | fixed/sticky in-page chrome that scrolls **under** the nav (eq `StickyHeader`) |
| `--z-nav` | 200 | primary nav chrome — mobile `TopNav`, desktop `SidePanel` rail |
| `--z-sheet` | 300 | bottom-sheets & dropdowns (`NotebookPicker`, TopNav favorites, `/notes` sort, mobile `NoteActionSheet`) |
| `--z-menu` | 400 | context menus & hover popovers (`NoteContextMenu`, `EditorContextMenu`, footnote preview, terminal `HistoryPanel`) |
| `--z-banner` | 500 | app status banners (offline / install prompt, in `+layout.svelte`) |
| `--z-toast` | 600 | transient toasts — deliberately **above** banners |
| `--z-modal` | 700 | modal dialogs (`ImageViewerModal`, `NoteXmlViewer`, terminal send-overlay, `SendToRemarkableModal`, desktop `SpreadOverlay`) |
| `--z-popover` | 800 | popover opened **on top of** a modal (`ImageActionMenu` over the image viewer) |

**The decision rule — tokenize only root-level competitors.** Use a `--z-*` token **iff** the element competes at the document/layout root, i.e. it is either:
1. portaled/`appendChild`'d to `<body>` (`lib/utils/portal.ts`, or manual `document.body.appendChild` — `EditorContextMenu`, `footnote/preview.ts`, `tableBlockPlugin.ts`), **or**
2. `position:fixed` and **not** nested inside an ancestor stacking context.

Everything else keeps a **small hand-picked int (0–20)** and stays **untokenized**: local stacking contexts (editor widget buttons, labeled-divider `::before`/label pair under `isolation:isolate`, image-frame toolbar, graph/codegraph HUDs, spread-overlay close button) and **in-page furniture** (music bar, meta chips, FABs, bottom toolbar, find-bar, chat send pill). These only need to beat sibling/editor content and sit below `--z-sticky`; converting them to tokens is noise and can break intra-context order. A scrim+panel pair shares **one** tier — the panel is a **later DOM sibling**, so it paints on top at equal z (don't add `+1`).

**Stacking-context gotcha (load-bearing):** a value only competes inside its nearest stacking-context ancestor (created by `position`+`z-index`, `transform`, `opacity<1`, `isolation:isolate`, `filter`, …). So `z-index:20` on the image-frame toolbar never fights `TopNav`'s `--z-nav`; and a modal mounted **inside** a desktop `NoteWindow` (`.note-window` is `position:absolute`+inline-z → its own context) is **trapped** there — `SendToRemarkableModal`/`TerminalView` send-overlay cover only in-window content regardless of their token. To truly clear the desktop bands a modal must `use:portal` to `<body>`.

**Desktop workspace is its own band system** (`lib/desktop/`), documented at `DESKTOP_PINNED_Z` in `session.svelte.ts`. Windows live inside `.canvas` (`position:fixed`, **no** z-index → `z:auto`): each window's `z = ++nextZ` (rises on focus), pinned windows add `DESKTOP_PINNED_Z`. That whole stack is sealed inside `.canvas`, so it never numerically meets the `--z-*` tokens — `.canvas`'s **sibling DOM order** under `.desktop-root` is what puts `SidePanel` (`--z-nav`) and `SpreadOverlay` (`--z-modal`) above it. Keep window z dynamic; never give windows a static tier.

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

**Note↔note paste fidelity** — the custom serializers above are lossy by design (footnote/checkbox/radio atoms, images, datetime/size marks don't survive `tiptapToHtml`). So `buildClipboardHtml` wraps the html flavor in `<div data-pm-slice="O E []" data-tomboy-slice="<slice JSON>">…</div>`:

- `clipboardFidelity.ts` (`ClipboardFidelity` extension) — paste-side. Its `clipboardParser` detects `data-tomboy-slice` → `Slice.fromJSON` exact restore (silent fallback to schema HTML parse on corrupt/cross-version payload). Its `clipboardTextParser` replaces PM's default `split(/(?:\r\n?|\n)+/)` (which collapsed blank lines) with one-paragraph-per-line, empty line = empty paragraph.
- `data-pm-slice="O E []"` must match PM's `/^(\d+) (\d+)(?: -(\d+))? (.*)/` (trailing `[]` = empty context) — it makes parseFromClipboard skip maxOpen renormalization and TipTap paste rules treat the payload as PM-internal.
- Ctrl+Shift+V stays the plain-text escape hatch: marks dropped, but marker text (`[^N]`, `[x]`) re-atomizes via each node's `transformPasted`, and blank lines now survive.
- Context-menu 붙여넣기 routes through `view.pasteHTML`/`pasteText` (same pipeline as Ctrl+V); 복사 prefers `execCommand('copy')` (sync copy event — Chrome's async `clipboard.write` may sanitize `data-*` attrs off `text/html`).

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

Common shape: `Q:`/`A:` turns, send button, streaming, abort, Korean errors. Headers — Ollama: `temperature`/`num_ctx`/`top_p`/`seed`/`num_predict`/`rag`; Claude: `model`/`effort` (low|medium|high|xhigh|max); both: `system`. `parseChatNote` recognizes both signatures; cross-backend and legacy headers (옛 `cwd`/`allowedTools` 포함) silently ignored.

Files: `lib/chatNote/` (`parseChatNote`, `defaults`, `backends/{ollama,claude}.ts`, `buildClaudeMessages.ts`), `lib/editor/chatNote/ChatSendBar.svelte` (backend branch), `bridge/src/claude.ts` (POST `/claude/chat` proxy), `claude-service/` (desktop Fastify, `claude -p` stream-json → SSE).

Invariants:

- **Claude backend forces subscription OAuth.** `claude-service/src/runner.ts` spawns with `ANTHROPIC_API_KEY=''` explicit empty — prevents host API-key leak.
- **claude-service is desktop-only** (same machine as ocr-service). Never on Pi bridge (CPU-only, and OAuth creds live in host `~/.claude`).
- **Claude backend는 항상 클린 모드.** 런너(`claude-service/src/runner.ts`)가 항상 `--system-prompt`(코딩 에이전트 프롬프트 교체) + `--exclude-dynamic-system-prompt-sections` + `--disallowedTools '*'`(도구 off) + `--effort`(없으면 high)로 spawn. 노트로 코딩을 하지 않으므로 도구 게이트(`cwd`/`allowedTools`)는 제거됨. spawn cwd는 항상 `$HOME`.
- **기본값은 설정 Claude 탭에서 변경.** `system`/`model`/`effort` 기본값은 `appSettings`(`claudeDefault*`)에 저장되고 설정 Claude 탭에서 편집. 새 `claude://` 노트 헤더에 자동으로 채워지고(`chatNotePlugin` 자동 헤더), 헤더가 비면 전송 시 폴백. 우선순위: 노트 헤더 > 설정 기본값 > `CLAUDE_HEADER_DEFAULTS` 안전망.
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
