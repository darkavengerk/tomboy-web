# 노트 이미지 복사 (Note image copy)

**Date:** 2026-06-09
**Status:** Approved

## Goal

Let users copy a note image — both the actual image bytes (paste like any
normally-copied image into other apps/web/PC) and its URL — via:

- **Right-click** on desktop
- **Long-press** on mobile (a menu pops up)

Two surfaces show note images, both must support this:

1. The **inline image preview** in the note body (`imagePreviewPlugin`).
2. The **full-screen viewer** (`ImageViewerModal`).

Menu items: **이미지 복사** + **이미지 주소 복사**.

## Components

### 1. `lib/editor/imageActions/copyImage.ts` — clipboard core

- `copyImageToClipboard(href)`:
  - Resolve raw bytes via the existing image cache:
    `getBlob(href)` → on miss `lookupOrFetch(href)` then `getBlob(href)` again.
    This reuses the registered Dropbox-SDK fetcher route, so `www.dropbox.com`
    CORS isn't a problem, and the bytes are local (a `Blob`), so a canvas drawn
    from them is **not** tainted.
  - Convert to **PNG**: `createImageBitmap(blob)` → `<canvas>` → `toBlob('image/png')`.
    Browsers' clipboard `write` reliably accepts `image/png`; converting handles
    jpeg/webp/etc. sources uniformly.
  - Write with the **Promise-in-`ClipboardItem`** pattern
    (`new ClipboardItem({ 'image/png': workPromise })`) so `navigator.clipboard.write()`
    is invoked synchronously within the user gesture — required for Safari/iOS.
  - Korean toast: success "이미지 복사됨" / failure "이미지 복사 실패".
- `copyImageUrlToClipboard(href)`: `navigator.clipboard.writeText(href)` + toast
  ("이미지 주소 복사됨" / "복사 실패").

### 2. `lib/stores/imageActionMenu.svelte.ts` — menu state

Mirrors `imageViewer.svelte.ts`. Module `$state` holding `{ x, y, href } | null`,
with `open(x, y, href)` / `close()`.

### 3. `lib/components/ImageActionMenu.svelte`

Mirrors `ImageViewerModal` placement (mounted once at root in `+layout.svelte`).
Small menu positioned at `(x, y)` with backdrop-to-dismiss + Esc. Two items:
**이미지 복사**, **이미지 주소 복사**, calling the `copyImage.ts` utils. Reuses
`EditorContextMenu`'s visual style. Clamps to the viewport so it doesn't overflow
(important on mobile long-press near screen edges).

### 4. `imagePreviewPlugin.ts` `renderImagePreview` — inline triggers

- `contextmenu` (mouse): `preventDefault()` → `imageActionMenu.open(e.clientX, e.clientY, href)`.
- Touch long-press: `touchstart` starts a ~500 ms timer; `touchmove` past a small
  threshold or an early `touchend` cancels it; on fire → open the menu at the touch
  point and set a `suppressNextClick` flag so the synthetic `click` doesn't also
  open the viewer. Add `-webkit-touch-callout: none` / `user-select: none` to
  `.tomboy-image-preview` so iOS's native callout doesn't fight the long-press.
- Existing click→viewer behavior otherwise unchanged.

### 5. `ImageViewerModal.svelte` — viewer triggers

To avoid clashing with the viewer's pan/pinch gestures, add **two small toolbar
buttons** (복사 / 주소) next to the existing close button, plus a `contextmenu`
handler on the viewer image that opens the same `ImageActionMenu`. All call the
`copyImage.ts` utils.

### 6. Guide card

Append a `<details class="guide-card">` to 설정 → 가이드 (`guideSubTab: editor`)
documenting right-click/long-press image copy, per the CLAUDE.md guide-surface rule.

## Testing

- Unit: `imageActionMenu` store open/close; `copyImageUrlToClipboard` calls
  `writeText` (mocked clipboard).
- Image-byte copy (canvas / `createImageBitmap` / clipboard `write`) is not
  reliably testable in jsdom — verified manually via `npm run dev`, with the
  byte-resolution + PNG-conversion isolated so it can be mocked.

## Invariants / trade-offs

- Replacing the native mobile long-press "save image" menu with our copy menu is
  intentional — that's the feature.
- Rendering-only: the `.note` XML and document are never mutated (same invariant as
  the existing image preview plugin).
- No new env vars, no data-model changes.
- PNG chosen as the single clipboard image format for cross-browser reliability.
