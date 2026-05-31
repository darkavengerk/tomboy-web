---
name: tomboy-geomap
description: Use when working on the in-note geo map embed feature (app/src/lib/editor/geoMap/). Covers the RFC 5870 geo:lat,lon URL parser, the ProseMirror widget-decoration plugin that scans text for geo URLs and mounts inline Leaflet maps, the navigator.geolocation insertion helper with Korean error toasts, the Leaflet 1.9 + OSM tile choices, the Vite marker-icon mergeOptions workaround, atomic-key handling at URL boundaries, the deliberate non-modal inline design, and the spec/sync invariants the feature relies on.
---

# Geo map embed

Notes containing a `geo:lat,lon` URL get an inline **square Leaflet map
card** rendered directly below the URL — no modal, no separate viewer
page. The Toolbar's 📍 button reads `navigator.geolocation` and inserts
the URL at the cursor as a `tomboyUrlLink`-marked text. Detection is
mark-agnostic: a `geo:` URL typed/pasted as plain text auto-renders too.

The feature is intentionally a **thin widget decoration over existing
plumbing** — it adds no new marks, no schema changes, no new
serialization paths. The `geo:lat,lon` URL is stored verbatim as text
(usually wrapped in `tomboyUrlLink`); the map card is a runtime
visualisation only. This is what makes Dropbox + Firebase sync work
without any changes: the .note XML round-trip is untouched, every
device renders the card on its own from the same text.

## File map

- `app/src/lib/editor/geoMap/`
  - `parseGeoUrl.ts` — pure RFC 5870 basic-form parser. Exports
    `parseGeoUrl(input): GeoCoords | null` and the `GeoCoords` interface.
  - `renderGeoMap.ts` — Leaflet lazy loader + `mountGeoMap(container,
    coords): { destroy }`. Owns the marker-icon Vite path workaround
    and the module-level singleton import promise.
  - `geoMapPlugin.ts` — ProseMirror plugin: `findGeoUrlRanges(doc)`,
    `createGeoMapPlugin()`, `handleGeoAtomicKey()`. Scans every text
    node, emits widget decorations at `r.to` (side: 1) for each valid
    geo URL, and treats the URL run as atomic for Backspace / Delete /
    arrow keys.
  - `insertCurrentLocation.ts` — `navigator.geolocation`
    `getCurrentPosition` wrapper with 10s timeout + high-accuracy.
    Inserts `geo:LAT,LON` text wrapped in a `tomboyUrlLink` mark
    (then unsets the mark so subsequent typing is plain). Korean error
    toasts for codes 1/2/3 + the no-geolocation case.
- `app/src/lib/editor/TomboyEditor.svelte` — registers the plugin as
  an `Extension.create({ name: 'tomboyGeoMap', addProseMirrorPlugins:
  () => [createGeoMapPlugin()] })` after the existing
  `tomboyImagePreview` block, and hosts the `.tomboy-geo-map` CSS
  (`aspect-ratio: 1/1`, `width: 100%`, `.leaflet-container { width:
  100%; height: 100% }`).
- `app/src/lib/editor/Toolbar.svelte` — drawer 📍 button next to the
  image-upload control. Calls `insertCurrentLocation(editor)`.
- `app/tests/unit/editor/`
  - `parseGeoUrl.test.ts` — 12+ cases (valid, negative, integer,
    optional `;params`, out-of-range, malformed).
  - `geoMapPlugin.test.ts` — 14 tests, with
    `vi.mock('$lib/editor/geoMap/renderGeoMap.js', ...)` because
    Leaflet doesn't render in jsdom.
  - `insertCurrentLocation.test.ts` — 6 tests, mocks
    `navigator.geolocation`.

## URL format & parsing

Accepted shape is RFC 5870 basic form:

```
geo:<lat>,<lon>[;<params>]
```

Regex: `/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(;.*)?$/`

- `lat ∈ [-90, 90]`, `lon ∈ [-180, 180]` — out-of-range returns null.
- Optional altitude / `;crs=...` / `;u=...` params are tolerated but
  discarded. The parser only emits `{lat, lon}`.
- Whitespace, leading `geo://`, uppercase scheme — all **rejected**.
  The auto-detection has to be unambiguous in plain text.
- `insertCurrentLocation` emits 6-decimal precision (`toFixed(6)`),
  which is ~10 cm — enough for a building, not so precise that GPS
  noise dominates.

## Plugin model — widget decoration, URL stays visible

Mirrors the existing `imagePreviewPlugin` pattern with **one key
difference**: the URL text is NOT hidden. For images the URL is just
a path and showing it adds nothing; for geo coordinates the URL IS
the meaningful info ("where was I?") and users may want to copy it
or read it at a glance.

```
findGeoUrlRanges(doc):
  walk every text node, regex-scan for geo:lat,lon
  → [{from, to, href, lat, lon}, ...]
  filter by parseGeoUrl (range-checks)
```

The plugin's `state.apply` rebuilds the decoration set after any doc
change. Each decoration is `Decoration.widget(r.to, builder, {
  side: 1,
  key: `geo:${r.from}:${r.to}:${r.href}`
})`. The stable key avoids tearing down + remounting the Leaflet
instance on every keystroke.

The widget builder calls `mountGeoMap(container, { lat, lon })` and
attaches a MutationObserver that fires `destroy()` when the
container is removed from the DOM — this is the Leaflet cleanup
hook. Without it, scrolling away from a map (which removes its
container) would leak the Leaflet instance + its tile-load listeners.

## `renderGeoMap.ts` — lazy Leaflet + marker-icon Vite workaround

Leaflet is loaded via dynamic `import('leaflet')` behind a
module-level singleton promise:

```ts
let leafletPromise: Promise<typeof L> | null = null;
async function loadLeaflet() {
  if (!leafletPromise) leafletPromise = import('leaflet').then(m => m.default ?? m);
  return leafletPromise;
}
```

So even if 30 map widgets mount in the same document, Leaflet's JS
and CSS are loaded exactly once.

**Marker icon path workaround.** Leaflet's default icon URLs are
hard-coded relative paths that break under Vite's static asset
hashing. The fix mounts static imports onto the `L.Icon.Default`
prototype:

```ts
import iconUrl from 'leaflet/dist/images/marker-icon.png';
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({ iconUrl, iconRetinaUrl, shadowUrl });
```

This MUST run before the first `L.marker(...)` call. The
`renderGeoMap` module runs it once at first `mountGeoMap` call. The
`delete _getIconUrl` is non-optional — leaving it in place lets the
default getter clobber the merged URLs.

**`tap` option must not be passed.** Leaflet 1.9 removed `tap` from
`MapOptions` types (modern Leaflet has tap-on-by-default). Including
it makes `npm run check` fail. The current `mountGeoMap` does not
pass it.

**`mountGeoMap(container, coords)`** is the only exported runtime
entry. It:

1. Calls `loadLeaflet()`.
2. Applies the icon-mergeOptions side effect (once).
3. Sets `container.innerHTML = ''` and removes the placeholder
   "지도 로딩 중…" text.
4. Mounts a Leaflet map at the coords (default zoom 15), OSM tile
   layer, places a marker with a `lat, lon` popup.
5. Returns `{ destroy() { map.remove(); } }`.

OSM tiles use the public `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`
endpoint with the standard attribution string. No API key. If a future
change needs commercial tile traffic, add a `attribution` opt and a
config setting — don't change the parser or the URL contract.

## Insertion — `insertCurrentLocation`

```ts
const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
  navigator.geolocation.getCurrentPosition(resolve, reject, {
    enableHighAccuracy: true,
    timeout: 10000,
  });
});
const text = `geo:${pos.coords.latitude.toFixed(6)},${pos.coords.longitude.toFixed(6)}`;
editor
  .chain()
  .insertContent({
    type: 'text',
    text,
    marks: [{ type: 'tomboyUrlLink', attrs: { href: text } }],
  })
  .unsetMark('tomboyUrlLink')
  .run();
```

The trailing `.unsetMark('tomboyUrlLink')` is so subsequent typing
after the inserted URL is plain text, not a continuation of the link
mark.

Korean error toasts (via `pushToast(msg, { kind: 'error' })`):

| code | toast |
|------|-------|
| 1 PERMISSION_DENIED | `위치 권한이 거부되었습니다. 브라우저 설정에서 권한을 허용해 주세요.` |
| 2 POSITION_UNAVAILABLE | `위치 정보를 가져올 수 없습니다. GPS 신호를 확인해 주세요.` |
| 3 TIMEOUT | `위치 정보를 가져오는 데 너무 오래 걸렸습니다. 다시 시도해 주세요.` |
| no navigator.geolocation | `이 브라우저는 위치 기능을 지원하지 않습니다.` |

## Atomic-key handling at URL boundaries

`handleGeoAtomicKey(view, event, ranges)` — called from the plugin's
`props.handleKeyDown`:

- **Backspace** at offset `to`: delete the whole `[from, to]` URL
  (and its widget along with it). Without this, Backspace would only
  shave one character at a time and leave a broken `geo:37.xxxx,127.x`
  fragment that no longer matches the regex but still has its widget
  ghosting nearby until the next transaction rebuilds decos.
- **Delete** at offset `from`: same, forward-direction.
- **Arrow Left at offset `to`** / **Arrow Right at offset `from`**:
  jump the cursor across the whole URL run as if it were a single
  character. Plain navigation through a 30-char URL feels broken
  otherwise.

Tests cover all three behaviors for both URL boundaries. The plugin
returns `true` from `handleKeyDown` only when the cursor is exactly
at one of these boundaries, so normal editing inside or outside the
URL keeps standard PM semantics.

## CSS — responsive square card

Lives in `TomboyEditor.svelte`:

```css
.tomboy-editor :global(.tomboy-geo-map) {
  display: flex; align-items: center; justify-content: center;
  width: 100%; aspect-ratio: 1 / 1; margin: 8px 0;
  background: #f0f0f0; border-radius: 4px; overflow: hidden;
  color: #888; font-size: 0.85rem;
}
.tomboy-editor :global(.tomboy-geo-map .leaflet-container) {
  width: 100%; height: 100%;
}
```

`aspect-ratio: 1/1` + `width: 100%` is intentional — there is no
`max-width` cap. The card fits whatever column the note is rendered
in (mobile single-note, desktop NoteWindow, future split columns).
The `.tomboy-geo-map` outer node also doubles as the loading
placeholder (centered "지도 로딩 중…" text) until `mountGeoMap`
swaps it for the Leaflet container.

`display: flex` + `align-items/justify-content: center` are for the
placeholder text only; once Leaflet mounts, the `.leaflet-container`
child takes 100% of both axes and the flex layout becomes a no-op.

## Mobile vs desktop

Same code, same UX:

- Toolbar 📍 button is in the drawer alongside image upload. It is
  not in the mobile key tray — geolocation insertion is rare enough
  that drawer-depth is fine.
- The map card itself: single-finger pan inside the Leaflet container,
  two-finger gesture (mobile native behavior) for page scroll because
  Leaflet has `dragging: true` by default. No special touch wiring.
- Editing around the map: identical PM atomic-key handling on both
  platforms.

No mobile-only code path. The branch flag — if ever needed for a
future "mobile gets a smaller card / different zoom" tweak — would
go in CSS via media query, not in the plugin.

## Sync, serialization, and storage

- The `geo:` URL is stored verbatim as text in the note. When it
  carries a `tomboyUrlLink` mark, the .note XML serializes it as
  `<link:url>geo:37.x,127.y</link:url>` exactly like a regular URL.
- Round-trips through Tomboy desktop are safe — the desktop doesn't
  understand `geo:` but it does understand `<link:url>`, so it
  renders the URL as a clickable link with no map. Re-opening on
  this app re-renders the card.
- Dropbox sync, Firebase real-time sync, .note import/export: all
  untouched. The plugin operates entirely on rendered editor state
  and never modifies what gets persisted.
- No new IndexedDB tables, no localStorage state, no app settings.
  Adding a feature flag would be wrong — it's a pure cosmetic widget
  with no failure mode that needs an off-switch.

## Library choice — Leaflet + OSM, not Mapbox / Google / MapLibre

- **Leaflet 1.9** — small (~40KB gzipped), no API key, has been
  shipping the same API for a decade. Perfect fit for a static-SPA
  PWA that can't carry server-side tile credentials.
- **OSM tiles direct** — the public tile endpoint is free for
  moderate use and requires only the attribution string. No usage
  cap to worry about until the app gets thousands of users.
- **Why not MapLibre / OpenLayers / Google Maps:** MapLibre is
  newer-and-cleaner but requires a vector tile source (either paid
  or self-hosted). OpenLayers is bigger and more abstract than we
  need. Google Maps requires an API key in the static SPA bundle,
  which is a deployment hazard. Mapbox is paid.

If a future change needs vector tiles, switch to MapLibre **inside
`renderGeoMap.ts`** — the rest of the feature doesn't care which
library actually drives the canvas, only that `mountGeoMap(container,
coords)` returns a `{ destroy }`.

## Testing

- `parseGeoUrl.test.ts` exhaustively covers basic-form parsing
  including range validation and optional `;params`.
- `geoMapPlugin.test.ts` exercises `findGeoUrlRanges`, decoration
  emission, key handling, and the cleanup MutationObserver. Leaflet
  is `vi.mock`'d so jsdom never tries to render tiles.
- `insertCurrentLocation.test.ts` mocks `navigator.geolocation` and
  asserts the toast for each error code + the success insert with
  correct precision + mark.
- No DOM test for actual Leaflet rendering — jsdom can't lay out the
  tile container. Manual verification in a real browser is the only
  signal for "the card actually looks right" (the plan's Task 7
  checklist).
- `npm run build && find build -name 'marker-*.png' | head` is the
  smoke test for the marker-icon Vite path workaround. The PNGs
  should land in the build output.

## Known non-goals & dead ends — do not pursue without asking

- **No modal / lightbox / fullscreen view.** Tapping the map does
  nothing extra — the inline card IS the view. The earlier
  brainstorm explicitly rejected a modal because it doubles the UI
  surface for no real gain on mobile. If the user later asks for it,
  the right place is a `dblclick` or long-press handler in the
  widget, NOT a separate route.
- **No reverse geocoding.** The marker popup is `lat, lon`, not a
  place name. Reverse geocoding would require an API key (Nominatim
  has rate limits, paid services need keys). Out of scope.
- **No directions / routing / radius search.** Pure display widget.
- **No editing the location by dragging the marker.** Marker is
  static. To change a location, edit the URL text.
- **No mark of its own.** A previous design considered a
  `tomboyGeoLink` mark to disambiguate from regular URLs; rejected
  because it would have broken .note round-trip and required
  serialization changes. Detection from the URL string is enough.
- **No removing `tomboyUrlLink` from the URL after insert.**
  Stripping the mark would make the URL non-clickable in Tomboy
  desktop. The current flow inserts the link mark, then unsets it
  only on the cursor's NEXT position so further typing is plain.

## Common breakage modes

- **Marker icons broken in production build only.** Means the
  `mergeOptions` workaround broke or someone removed the `delete
  _getIconUrl` line. `npm run preview` reproduces this; `npm run
  dev` does NOT (Vite dev serves assets from different paths).
- **Card stuck on "지도 로딩 중…".** Either Leaflet failed to load
  (network blocked / CSP) or `mountGeoMap` threw before clearing the
  container. Check console.
- **Card duplicates on every keystroke / Leaflet logs warnings about
  re-init.** The decoration `key` is unstable. Verify it's
  `geo:${r.from}:${r.to}:${r.href}` — the href in the key is what
  makes edits that don't change the URL skip the remount.
- **Backspace at URL end deletes one char then leaves a broken
  fragment + lingering widget.** `handleGeoAtomicKey` isn't being
  consulted — verify the plugin's `props.handleKeyDown` wires it up
  and that it returns `true` at the boundary.
