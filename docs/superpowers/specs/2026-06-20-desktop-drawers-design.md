# Desktop Drawers (F2/F3) — Design

**Date:** 2026-06-20
**Status:** Approved, pre-implementation
**Area:** `/desktop` multi-window operator UI (`app/src/lib/desktop/`)

## Summary

Add two **drawers** — ddterm-style slide-in overlays toggled by **F2** (opens from
the left) and **F3** (opens from the right). A drawer is an additional workspace
surface that holds freely-positioned, fully-live note windows. Its main purpose:
park terminal-connection notes (and similar long-lived notes) so they stay
connected in the background and can be revealed on demand.

A drawer is **global** — independent of the existing 2×2 workspace grid. Switching
workspaces (Ctrl+Alt+Arrow) never changes drawer contents. Each drawer is a
**separate space**; the same note can live in multiple surfaces at once.

## Goals

- F2 toggles a left drawer, F3 toggles a right drawer; one drawer visible at a time.
- Notes inside a drawer are freely positioned and individually resizable, with the
  arrangement preserved exactly as left.
- Drawer panel width is drag-resizable.
- Drawer notes stay **alive while the drawer is hidden** — terminal WebSocket
  sessions, TipTap editors, and in-memory state survive the panel sliding off.
- Each drawer remembers each note's **own** position + size, isolated from every
  other surface. Resizing a note in a drawer must not affect that note anywhere else.
- A note can appear in more than one surface (canvas workspace and/or either drawer)
  simultaneously, each an independent live mount.

## Non-goals

- No change to the mobile single-note flow or any non-`/desktop` route.
- No deduplication of multiple live mounts of the same note (see *Known behavior*).
- No drawer-to-drawer direct drag (only one drawer is open at a time; route via canvas).

## Background — existing machinery this reuses

`session.svelte.ts` already models the desktop as a set of surfaces:

- `workspaces: WorkspaceState[4]` (2×2 grid). `WorkspaceState = { windows:
  DesktopWindowState[]; geometryByGuid: Record<guid, GeometrySnapshot>; nextZ }`.
- `DesktopWorkspace.svelte` renders the **union** of all workspaces' windows at
  once (`allWorkspaceWindows`) and hides non-active ones via CSS. This is what keeps
  editors and terminal WS connections alive across workspace switches.
- The `active` prop (`workspaceIndex === currentWorkspace`) gates the per-window
  Firebase `attachOpenNote`/`detachOpenNote`, the global editor registry, and the
  spread snapshot source — all keyed by guid — so the **same guid mounted in two
  workspaces never collides** (only the live mount registers). Confirmed in
  `NoteWindow.svelte` (`$effect`s guarded by `if (!active) return`).

Drawers slot directly into this model as additional surfaces. Keep-alive,
collision-safety, drag, 8-way resize, pin, and minimize all come for free.

## Architecture

### 1. State (`session.svelte.ts`)

Add, as module `$state` siblings to `workspaces`:

```ts
const DRAWER_COUNT = 2;               // 0 = F2 (left), 1 = F3 (right)
let drawers = $state<WorkspaceState[]>(
  Array.from({ length: DRAWER_COUNT }, () => emptyWorkspace())
);
// Which drawer is open + focused; null = canvas is the live surface.
let activeDrawer = $state<number | null>(null);
// Per-drawer panel extent (px from its anchored edge), user-resizable, persisted.
let drawerWidths = $state<number[]>([DEFAULT_DRAWER_WIDTH, DEFAULT_DRAWER_WIDTH]);
```

- `DEFAULT_DRAWER_WIDTH` ≈ 480.
- Drawers reuse `emptyWorkspace()`, `DesktopWindowState`, geometry/z helpers, and
  every shared registry (`flushHooks`, `reloadHooks`, `editorRegistry`,
  `snapshotSources`, `recentOpens`, `closedStack`). Nothing is duplicated.
- `activeDrawer` is **not** persisted — a reload starts with drawers closed.

### 2. Active-surface model (keep-alive contract)

Exactly one surface is "live" at a time. Generalize the `active` computation in
the render:

- canvas window: `active = (workspaceIndex === currentWorkspace) && activeDrawer === null`
- drawer window: `active = (drawerIndex === activeDrawer)`

Opening a drawer sets `activeDrawer = i`; canvas notes become `active = false`
(Firebase detaches, editor unregisters) **but stay mounted** — their editor/WS
state is intact. Closing the drawer (`activeDrawer = null`) makes the canvas live
again. This is the existing per-workspace gating widened by one axis, so a guid
mounted in canvas + both drawers still has only its single live mount registered.

### 3. Per-surface geometry (independent pose)

Each drawer carries its **own `geometryByGuid`**. A note's drawer pose
(x/y/width/height) lives there and is fully isolated from the note's pose on the
canvas or in the other drawer. Notes never persist geometry in their content, so
"서랍은 노트 내 위치/크기 정보를 무시하고 독자 자료구조를 쓴다" is satisfied by the
per-surface `geometryByGuid`. Re-entering a drawer restores that drawer's
remembered pose for the guid; first entry uses the move's drop point (drag) or a
default slot (arrow button).

### 4. Render (`DesktopWorkspace.svelte` + new `DrawerOverlay.svelte`)

- Extend the union render so **drawer windows are always mounted** (keep-alive).
- New `DrawerOverlay.svelte`: a fixed panel anchored to a canvas edge, full canvas
  height, `width = drawerWidths[i]`. Props: `side: 'left' | 'right'`, `index`,
  `open`. Holds its `windows[]` as absolutely-positioned `NoteWindow`s in
  **drawer-local coordinates** (0,0 = drawer top-left). Two overlays rendered:
  index 0 → `side="left"`, index 1 → `side="right"`.
- **Anchoring:** both drawers anchor to the **canvas** region (the area right of the
  SidePanel rail) so the rail stays visible and clickable. Left drawer hides via
  `transform: translateX(-100%)`, right via `translateX(100%)`. The element stays in
  the DOM while hidden (connected → terminal WS alive). Slide is a CSS transition.
- **Panel resize:** the drawer's inner edge (right edge for the left drawer, left
  edge for the right drawer) is a drag handle that updates `drawerWidths[i]`
  (reuse the rail's resize-grip pattern from `SidePanel`).
- **z-index:** the drawer overlay is a root-level `position: fixed` competitor →
  add a `--z-drawer` token to `app/src/app.css`, placed **below `--z-modal`** so
  F4 펼쳐보기 still covers it. The rail is on the left, so left/right drawers never
  spatially fight the rail; pick a tier above canvas windows and below banners.

### 5. Toggle (F2/F3 in `DesktopWorkspace.onKey`)

Handle `F2`/`F3` with no modifiers and `preventDefault`:

- Drawer closed → open it (`activeDrawer = i`).
- This drawer already open → close it (`activeDrawer = null`).
- The other drawer open → switch to this one (only one visible at a time).

### 6. Adding a note to a drawer

Two gestures, both **MOVE** semantics (the window leaves its source surface):

**a) Arrow button (primary).** While any drawer is open, each **canvas** note
window's close (`X`) control morphs into a directional arrow pointing at the open
drawer: **←** when the left drawer (F2) is open, **→** when the right drawer (F3)
is open. Clicking it calls `moveWindowToSurface(canvas → drawer activeDrawer,
guid)`: splice the window state out of the source workspace, push it into the
drawer using the drawer's remembered pose for that guid (or a default slot).
While a drawer is open the plain close action is unavailable on canvas windows;
to close one, close the drawer first (the `X` returns).

**b) Drag (alternate).** Dragging a canvas window by its title bar so the pointer
ends over the open drawer panel performs the same move, placing the window at the
drop point in drawer-local coords. Requires a drag-end surface hit-test in
`dragResize.ts` (add an `onDragEnd(pointer)` style hook or a drop-target callback;
the existing `startPointerDrag` owns the pointermove/up cycle).

**Multiple surfaces:** to place a note in more than one drawer, open it again from
the rail onto the canvas, then arrow/drag *that* mount into the other drawer. Each
surface holds an independent live mount.

### 7. Removing / closing inside a drawer

- A drawer note's own `X` removes it from that drawer (flush pending edits first via
  the existing `runFlushHook`). If it was the note's only live mount, teardown
  disconnects its terminal WS — expected.
- Dragging a drawer window out onto the canvas moves it back to the current
  workspace (reverse `moveWindowToSurface`).

### 8. `moveWindowToSurface` (session API)

```ts
moveWindowToSurface(
  from: { kind: 'workspace' | 'drawer'; index: number },
  to:   { kind: 'workspace' | 'drawer'; index: number },
  guid: string,
  drop?: { x: number; y: number }   // target-local coords (drag); omit → use cached/default
): void
```

- Flush the source window's pending edits first (it stays mounted, just re-parented
  in state — actually a splice+push, so a flush keeps IDB consistent before the
  source instance unmounts).
- Remove the window from the source surface's `windows[]`; cache its source pose in
  the source `geometryByGuid` (so reopening on the source restores it).
- Add to the target surface: if the target's `geometryByGuid[guid]` exists, restore
  it; else use `drop` (clamped to the target panel) or a default slot. Assign a
  fresh z via the target's `nextZ`.
- Set focus/flash on the moved window if the target surface is active.

### 9. Persistence (`session.svelte.ts`)

Add to the persisted snapshot additively and bump `VERSION` 3 → 4:

```ts
interface PersistedV4 {
  version: 4;
  currentWorkspace: number;
  workspaces: [...];                 // unchanged
  drawers: Array<{ windows; geometryByGuid?; nextZ? }>;   // same shape as workspaces
  drawerWidths: number[];
}
```

- Loader: read v4 drawers; a v3/v2 snapshot yields empty drawers + default widths
  (back-compat, no destructive migration).
- Reuse `restoreWorkspaceFromPersisted` for drawer windows. Exclude `history`-kind
  windows from drawers (same `kind !== 'history'` filter as workspaces).
- `activeDrawer` intentionally not persisted (drawers start closed on reload;
  contents restored, panel hidden).

## Files touched

- `app/src/lib/desktop/session.svelte.ts` — drawer state, `activeDrawer`,
  `drawerWidths`, drawer open/close/toggle API, `moveWindowToSurface`, generalized
  active computation surface, persist v4.
- `app/src/lib/desktop/DesktopWorkspace.svelte` — render drawer overlays in the
  union, F2/F3 keybinds, pass surface-aware `active`, arrow-button wiring.
- `app/src/lib/desktop/DrawerOverlay.svelte` — **new** component (panel, slide,
  panel-width resize grip, hosts drawer `NoteWindow`s).
- `app/src/lib/desktop/NoteWindow.svelte` — close button morphs to a directional
  arrow when a drawer is open (prop, e.g. `stashTarget: 'left' | 'right' | null`),
  arrow click emits a "stash to drawer" event.
- `app/src/lib/desktop/dragResize.ts` — drag-end surface hit-test hook for the
  drag gesture.
- `app/src/app.css` — `--z-drawer` token.
- `app/src/routes/settings/+page.svelte` — 가이드 카드 (env or notes sub-tab)
  documenting F2/F3 drawers (project invariant: features must be in 설정 → 가이드).

## Known behavior / caveats

- **Double mount of a terminal note.** A note placed in two surfaces (e.g. canvas +
  a drawer, or both drawers) opens two independent terminal SSH/WS sessions — the
  same pre-existing behavior as opening a note in two workspaces today. Not
  deduplicated; documented for the user.
- **Arrow direction vs literal request.** The user said "오른쪽 화살표"; the design
  makes the arrow directional (← for the left/F2 drawer, → for the right/F3 drawer)
  so it always points at the open drawer. "오른쪽 화살표" is the F3 case. Confirm at
  review if a fixed-direction arrow is preferred.

## Testing

- `app/`: `npm run check` (svelte-check) for types.
- Unit (vitest) where logic is pure/state-only:
  - `moveWindowToSurface` move semantics + per-surface `geometryByGuid` isolation
    (resize in drawer does not mutate canvas pose).
  - toggle state machine (open/close/switch; one drawer at a time).
  - persist v4 round-trip + v3 back-compat (drawers default empty).
  - active-surface computation (drawer open ⇒ canvas windows `active=false`).
- Manual (`npm run dev`): F2/F3 slide direction, keep-alive of a terminal note while
  the drawer is hidden, arrow-button stash, drag stash, panel-width resize,
  independent drawer geometry, reload persistence.
