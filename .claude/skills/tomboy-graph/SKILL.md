---
name: tomboy-graph
description: Use when working on the 3D note graph view at /desktop/graph (files in app/src/lib/graph/ and app/src/routes/desktop/graph/). Covers buildGraph, FpsControls, label LOD, force tuning, selection modes, embedded NoteWindow, link visibility, wheel forwarding, and performance knobs.
---

# 3D note graph (`/desktop/graph`)

A desktop-only space-exploration view of the notes' internal-link graph.
Nodes are all non-deleted notes; edges are `<link:internal>` marks between
them. The user flies through the cloud with FPS-style controls and reads
notes as they pass, with a live, editable `NoteWindow` embedded in a side
panel. Reached via the "그래프" button in the desktop `SidePanel` rail
(opens in a new tab).

Because `/desktop/*` is treated as `isChromeless` in the root layout, the
TopNav is automatically suppressed — the graph page takes over the full
viewport.

## Files

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

## Graph data

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
and the color. Normal notes interpolate HSL from vivid yellow
(`hsl(48, 100%, 55%)`) at size=1 to pure white (`hsl(48, 0%, 100%)`) at
size=2 via `degreeColor(size)`. The saturation curve is `(1-t)^0.6`
(ease-out) so low-degree nodes stay *fully* yellow rather than fading
to a milky pastel; most of the desaturation happens near the top tier.
The home note is gold (`#f5c542`) and the sleep note (`SLEEP_NOTE_GUID`)
is purple (`#9b6cff`) regardless of degree, marking them as the two
"starting" landings. The camera does **not** auto-center on the starter
notes —
previous versions flew the view to the home+sleep midpoint on first
engine stop, but that felt like being yanked away on page load, so the
framework's default initial camera position is used instead.

Sphere geometry uses `SphereGeometry(radius, 24, 16)` — the earlier
`(10, 8)` setting was visibly polygonal against the black background.
24×16 keeps silhouettes round at the displayed sizes while staying
within a comfortable ~770K tri budget for a 2000-node graph.

## Category (notebook) nodes — experimental toggle

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

## Label LOD

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

## Live-tunable force simulation

A second top-bar number input, "노드 간격" (`bind:value={nodeSpacing}`,
default `500`, min 5, step 5), exposes d3-force's many-body charge
strength (applied as `-nodeSpacing`). Raising it pushes nodes further
apart — looser, lower-density cloud; lowering it tightens the cluster.
A `$effect` calls `applyNodeSpacing(fg, nodeSpacing)` whenever the input
changes; the helper mutates `graph.d3Force('charge').strength(...)` and
wraps `graph.d3ReheatSimulation()` in a try/catch — the internal
`three-forcegraph` layout isn't always ready on first call, but the new
strength still takes effect on the next tick.

A third input, "이동 속도" (`bind:value={moveSpeed}`, default `60`, min
20, step 20), writes directly to `fpsRef.speed`. The FpsControls update
loop reads `this.speed` per frame, so the change is live. Hold **Shift**
or **right mouse button** for a ×3 sprint; the right-mouse handler is
wired in `FpsControls.handleMouseDown`/`handleMouseUp` and falls back to
`false` on lock loss or window blur. `contextmenu` is also
`preventDefault()`-ed on the canvas so the browser menu doesn't steal
the sprint input.

## Link visibility (selective)

A top-bar checkbox "링크 표시" (`bind:checked={showLinks}`) flips link
rendering. Default **on** but **selective** — rather than drawing every
edge, only links satisfying at least one of these criteria render:

1. An endpoint node is a hub (size ≥ 1.6)
2. An endpoint node is the currently selected note
3. An endpoint node is under the reticle (`currentCenterId`)

Because 3d-force-graph's `linkOpacity` / `linkVisibility` accessors are
evaluated on data change rather than per frame, selective filtering is
done by directly toggling each link's internal `__lineObj.visible`
(and `__arrowObj.visible` for the arrow head) inside the RAF loop. For
a 2000-link graph this is a few thousand cheap property reads/writes
per frame — trivial. The shared per-frame `currentCenterId` is set
inside `updateHoverHalo()` so `updateLinkVisibility()` doesn't have to
call `findCenterNode()` again.

When `showLinks` is off, every link is forced invisible on the next
tick — no special handling needed, the RAF loop just does it.

## Controls: WASD-only, pointer-lock

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

## Selection: two modes, one pipeline

Selection is driven by a single debounced auto-select tick (350ms) that
asks a mode-dependent picker each frame. The mode flips on explicit user
action so a deliberate click doesn't get overwritten by the continuous
ticker a few hundred ms later.

- **`aim` mode (default)** — `findAimedNode()` returns the nearest-in-
  frustum node to the "aim point" (camera + forward × 40). Something is
  (almost) always selected as you fly, which suits free exploration.

- **`center` mode** — `findCenterNode()` projects every live node to NDC,
  converts to pixel offset from the reticle, and returns whichever one
  is within `CENTER_PICK_RADIUS_PX` (50px) of the crosshair. Ties broken
  by screen-space distance (not depth), so a tiny far-away node wins
  over a larger one off to the side. A strict "reticle-inside-sphere"
  test used to lose faraway nodes entirely; the 50px halo keeps them
  pickable. If the reticle is over empty space, the picker returns
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

## HUD overlays

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

## Embedded note

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

## Wheel forwarding

Because the graph page has no other scrollable content, a window-level
capture-phase `wheel` listener forwards wheel events to the embedded
note's `.tomboy-editor` scroll container whenever the cursor isn't
already inside the panel. `deltaMode` line/page is normalized to pixels.
This lets the user read long notes without having to precisely hover the
panel (the graph's built-in wheel-zoom is sacrificed deliberately — WASD
covers distance control).

## Performance

Targets ~2000 nodes, which is within 3d-force-graph's comfortable range.
Knobs used to keep the simulation cheap: `cooldownTicks: 200`,
`warmupTicks: 40`, `d3AlphaDecay: 0.05`, `d3VelocityDecay: 0.3`,
`nodeResolution: 8` for sphere geometry. Frustum-filtered selection scan
and the two projection-based picks (`findAimedNode`, `findCenterNode`)
are both O(N) per frame but cheap — reuse scratch `Vector3`s to avoid
allocs. A single RAF loop drives FPS movement, auto-select, halo
updates, and hover-halo updates together.

## Dependencies

The graph page adds four npm deps: `3d-force-graph`, `three`,
`three-spritetext` (runtime), and `@types/three` (dev).
