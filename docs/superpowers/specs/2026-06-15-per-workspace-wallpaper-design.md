# Per-Workspace Wallpaper + "바탕화면으로 지정" (Set image as wallpaper)

Date: 2026-06-15
Status: Approved design

## Goal

Two related desktop-mode features:

1. **Right-click an image in a note → "바탕화면으로 지정"** sets that image as the
   desktop wallpaper.
2. **Wallpaper becomes per-workspace.** Each of the 4 desktop workspaces can have its
   own wallpaper; the existing single global wallpaper becomes a shared fallback.

Both are desktop-only (`/desktop`). Mobile single-note flow is unaffected.

## Existing infrastructure (already present, reused)

- **Wallpaper render + storage.** `DesktopWorkspace.svelte` renders `<img class="wallpaper">`
  inside `.canvas`. `session.svelte.ts` has `loadWallpaper()` / `setWallpaper(file)` /
  `clearWallpaper()` backed by a single `appSettings['desktop:wallpaper']` Blob (IDB).
  Current set path: drag-drop an image file onto the canvas (`onCanvasDrop`).
- **4 fixed workspaces.** `session.svelte.ts` `WORKSPACE_COUNT = 4`, index 0–3, 2×2 grid,
  Ctrl+Alt+arrow. Switch is a pure visibility toggle (all workspaces' windows render at
  once, non-active hidden by CSS). `currentWorkspace` getter exposes the active index.
  Per-workspace state (`WorkspaceState`) persists as `PersistedV3` JSON; wallpaper Blobs
  live OUTSIDE that JSON in separate appSettings keys.
- **Image right-click menu.** `ImageActionMenu.svelte` (portaled to `<body>`, opened via
  `imageActionMenu.open(x, y, href)` store) already fires on inline-image right-click in
  the editor AND on the full-screen viewer frame. Currently 2 items: 이미지 복사 / 이미지 주소 복사.
  Carries `menu.href` (the clicked image URL).
- **Image blob fetch.** `resolveImageBlob(href)` in `lib/editor/imageActions/copyImage.ts`
  fetches image bytes through the image-cache fetcher chain (handles `www.dropbox.com`
  CORS via the SDK path; Vercel Blob via plain fetch). Same path the viewer "복사" uses.

## Design

### Storage model

- Per-workspace wallpaper keys: `desktop:wallpaper:0` … `desktop:wallpaper:3` (Blob each).
- Existing `desktop:wallpaper` key is **kept as a shared fallback** — no migration write.
- Resolution: `loadWallpaper(i)` returns `get('desktop:wallpaper:' + i)` if present,
  else `get('desktop:wallpaper')` (the legacy global), else `null`.
- A workspace with no own wallpaper shows the fallback; setting a per-workspace wallpaper
  overrides only that workspace.

### `session.svelte.ts`

- `loadWallpaper(i: number): Promise<Blob | null>` — per-workspace key, fallback to global.
- `setWallpaper(blob: Blob, i: number): Promise<void>` — writes `desktop:wallpaper:${i}`.
  Param typed `Blob` (File ⊂ Blob, so the existing drop call still type-checks; cache blobs
  also accepted).
- `clearWallpaper(i: number): Promise<void>` — deletes the per-workspace key (index-aware
  for future; no UI wires it this round — out of scope).
- Module rune `wallpaperEpoch` (counter) + a `wallpaperEpoch` getter on the session export.
  `setWallpaper` bumps it. This is the cross-component signal that the wallpaper changed.
- Convenience: `setWallpaperForCurrent(blob: Blob)` = `setWallpaper(blob, currentWorkspaceIndex)`
  then bump epoch. Lets `ImageActionMenu` set the wallpaper without knowing the index.

### `DesktopWorkspace.svelte`

- Replace the one-shot `onMount` wallpaper load with a `$effect` keyed on
  `desktopSession.currentWorkspace` and `desktopSession.wallpaperEpoch`. On change it
  loads `loadWallpaper(currentWorkspace)` and swaps `wallpaperUrl`.
- **Async race guard:** capture a monotonically-incrementing local token before the await;
  after the await, ignore the result if a newer token exists (fast workspace switching must
  show only the latest workspace's wallpaper).
- **ObjectURL lifecycle:** revoke the previous `wallpaperUrl` on every swap; keep the
  unmount revoke that already exists.
- `onCanvasDrop`: change `setWallpaper(file)` → `setWallpaper(file, currentWorkspace)`, so
  drag-drop also targets only the current workspace (consistent with the right-click action).
  May set `wallpaperUrl` directly for immediacy and still write to the current index.

### `ImageActionMenu.svelte`

- Add a 3rd item **"바탕화면으로 지정"**, shown only in desktop mode.
  - Desktop gate: read `page` from `$app/state` and show the item iff
    `page.url.pathname.startsWith('/desktop')`. Reactive; no new prop on the store/component.
- Handler:
  1. `const blob = await resolveImageBlob(menu.href)`
  2. `await desktopSession.setWallpaperForCurrent(blob)`
  3. `pushToast('배경화면으로 지정했습니다')`
  4. close the menu
  - On failure (fetch/CORS/etc.): catch → failure toast (Korean), close.

### Guide card (project mandate: 설정 → 가이드)

- Append a `<details class="guide-card">` to `app/src/routes/settings/+page.svelte` under
  the `env` guide sub-tab (desktop-mode environment feature). Mirror existing card pattern:
  short `<summary>`, one `<p class="info-text">` intro, a `<ul class="guide-list">` covering:
  desktop-only; per-workspace independence; right-click image → 바탕화면으로 지정; drag-drop also
  targets the current workspace; no per-workspace clear UI yet (replace by setting a new one).

## Edge cases

- **Image fetch failure** (network/CORS/decode): caught → failure toast; wallpaper unchanged.
- **Fast workspace switching:** async token guard ensures only the latest load applies.
- **ObjectURL leak:** revoke on every swap + on unmount.
- **Non-image href:** menu only opens on images, so `menu.href` is always an image URL.
- **Existing users:** legacy global wallpaper keeps showing on all 4 workspaces until each
  gets its own — no data migration, no surprise blank canvas.

## Testing

- `session.svelte.ts` wallpaper unit (fake-indexeddb):
  - `setWallpaper(blob, i)` writes the per-workspace key only.
  - `loadWallpaper(i)` returns the per-workspace blob when present; falls back to the global
    `desktop:wallpaper`; returns `null` when neither exists.
  - `setWallpaper` bumps `wallpaperEpoch`; `setWallpaperForCurrent` targets `currentWorkspace`.
- `ImageActionMenu` desktop-gate render test (testing-library/svelte): the "바탕화면으로 지정"
  item is present when `page` route is `/desktop/...` and absent on a mobile route.
  (If mocking `$app/state` proves brittle, the plan may downgrade this to a manual check; the
  session unit test is the load-bearing one.)
- Manual: `npm run dev` → /desktop → right-click a note image → 지정 → confirm; switch
  workspace (Ctrl+Alt+arrow) → confirm wallpaper differs per workspace; drag-drop on one
  workspace doesn't change another.

## Out of scope

- Per-workspace wallpaper **removal/reset** UI (replace-only this round; `clearWallpaper(i)`
  exists but stays unwired).
- Any mobile wallpaper concept.
- Wallpaper sizing/positioning options (cover stays as-is).

## Files touched

- `app/src/lib/desktop/session.svelte.ts` — index-aware wallpaper fns + epoch + `setWallpaperForCurrent`.
- `app/src/lib/desktop/DesktopWorkspace.svelte` — `$effect` reload + race guard + per-ws drop.
- `app/src/lib/components/ImageActionMenu.svelte` — desktop-gated "바탕화면으로 지정" item + handler.
- `app/src/routes/settings/+page.svelte` — guide card (env sub-tab).
- `app/tests/unit/...` — session wallpaper unit test (+ optional menu-gate test).
