# Desktop Drawers (F2/F3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two ddterm-style slide-in drawers (F2 left, F3 right) — global overlay surfaces that hold freely-positioned, always-alive note windows, independent of the 2×2 workspace grid.

**Architecture:** A drawer is structurally a `WorkspaceState` (own `windows[]` + `geometryByGuid` + `nextZ`), rendered as a right/left-anchored slide-in panel. Drawer windows render in the existing union so they stay mounted (terminal WS survives when hidden). One surface is "live" at a time (`activeDrawer`); the existing per-window `active`-gating (Firebase attach, editor registry, snapshot) generalizes one axis wider, so the same guid mounted in canvas + drawers never collides. Notes enter a drawer by MOVE — clicking a canvas window's close button (morphed to a directional arrow while a drawer is open), or dragging it into the open panel.

**Tech Stack:** SvelteKit, Svelte 5 runes, TypeScript, vitest + fake-indexeddb.

**Spec:** `docs/superpowers/specs/2026-06-20-desktop-drawers-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `app/src/lib/desktop/session.svelte.ts` | Drawer state, toggle, width, surface-aware window ops, move-between-surfaces, persist v4 | Modify |
| `app/src/lib/desktop/DrawerOverlay.svelte` | Slide-in panel; hosts a drawer's NoteWindows; width-resize grip | Create |
| `app/src/lib/desktop/DesktopWorkspace.svelte` | Render two DrawerOverlays; F2/F3 keys; surface-aware `active`; arrow stash wiring | Modify |
| `app/src/lib/desktop/NoteWindow.svelte` | `surface` prop routes resize/pin/send-to-back; close button morphs to stash arrow | Modify |
| `app/src/lib/desktop/dragResize.ts` | (Task 7) drag-end pointer position for drop hit-test | Modify |
| `app/src/app.css` | `--z-drawer` token | Modify |
| `app/src/routes/settings/+page.svelte` | 가이드 카드 documenting F2/F3 drawers | Modify |
| `app/tests/unit/desktop/drawerState.test.ts` | Toggle / width state machine | Create |
| `app/tests/unit/desktop/moveWindowToSurface.test.ts` | Move semantics + per-surface geometry isolation | Create |
| `app/tests/unit/desktop/drawerPersist.test.ts` | v4 round-trip + v3 back-compat | Create |

---

### Task 1: Drawer state — toggle, width, focused-surface

**Goal:** Add drawer module state plus the toggle/width/active-surface API, with the focused-note getter aware of the open drawer.

**Files:**
- Modify: `app/src/lib/desktop/session.svelte.ts`
- Test: `app/tests/unit/desktop/drawerState.test.ts`

**Acceptance Criteria:**
- [ ] `toggleDrawer(i)` opens a closed drawer, closes the open one, switches when the other is open (only one open at a time).
- [ ] `activeDrawer` / `isDrawerOpen(i)` reflect state; `closeDrawer()` clears it.
- [ ] `getDrawerWidth(i)` / `setDrawerWidth(i, px)` clamp to `[DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH]`.
- [ ] `drawerWindows(i)` returns that drawer's windows (`[]` for out-of-range).
- [ ] `focusedNoteGuid` returns the topmost non-minimized note of the **active surface** (open drawer, else current workspace).
- [ ] Out-of-range indices are silent no-ops.

**Verify:** `cd app && npx vitest run tests/unit/desktop/drawerState.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing test** — create `app/tests/unit/desktop/drawerState.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote } from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';
import { desktopSession } from '$lib/desktop/session.svelte.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	desktopSession._reset();
});

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('desktopSession — drawers: toggle + width', () => {
	it('toggleDrawer opens, closes, and switches (one open at a time)', () => {
		expect(desktopSession.activeDrawer).toBe(null);
		desktopSession.toggleDrawer(0);
		expect(desktopSession.activeDrawer).toBe(0);
		expect(desktopSession.isDrawerOpen(0)).toBe(true);
		// Pressing the same key closes it.
		desktopSession.toggleDrawer(0);
		expect(desktopSession.activeDrawer).toBe(null);
		// Open 0, then 1 → switch to 1 (only one open).
		desktopSession.toggleDrawer(0);
		desktopSession.toggleDrawer(1);
		expect(desktopSession.activeDrawer).toBe(1);
		expect(desktopSession.isDrawerOpen(0)).toBe(false);
		desktopSession.closeDrawer();
		expect(desktopSession.activeDrawer).toBe(null);
	});

	it('out-of-range toggle is a no-op', () => {
		desktopSession.toggleDrawer(5);
		expect(desktopSession.activeDrawer).toBe(null);
	});

	it('setDrawerWidth clamps; getDrawerWidth reads it', () => {
		desktopSession.setDrawerWidth(0, 99999);
		expect(desktopSession.getDrawerWidth(0)).toBe(1200); // DRAWER_MAX_WIDTH
		desktopSession.setDrawerWidth(0, 10);
		expect(desktopSession.getDrawerWidth(0)).toBe(280); // DRAWER_MIN_WIDTH
		desktopSession.setDrawerWidth(0, 500);
		expect(desktopSession.getDrawerWidth(0)).toBe(500);
		// Other drawer unaffected.
		expect(desktopSession.getDrawerWidth(1)).toBe(480); // DEFAULT_DRAWER_WIDTH
	});

	it('drawerWindows is empty for a fresh / out-of-range drawer', () => {
		expect(desktopSession.drawerWindows(0)).toEqual([]);
		expect(desktopSession.drawerWindows(9)).toEqual([]);
	});

	it('focusedNoteGuid follows the active surface', async () => {
		await putNote(createEmptyNote(A));
		await putNote(createEmptyNote(B));
		desktopSession._reset();
		desktopSession.openWindow(A); // canvas
		expect(desktopSession.focusedNoteGuid).toBe(A);
		// Open an (empty) drawer → no note there → focusedNoteGuid is null.
		desktopSession.toggleDrawer(0);
		expect(desktopSession.focusedNoteGuid).toBe(null);
		// Close drawer → back to canvas note.
		desktopSession.closeDrawer();
		expect(desktopSession.focusedNoteGuid).toBe(A);
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd app && npx vitest run tests/unit/desktop/drawerState.test.ts` → FAIL (`toggleDrawer is not a function`).

- [ ] **Step 3: Add constants** — in `session.svelte.ts`, next to `const WORKSPACE_COUNT = 4;` (~line 13):

```ts
const DRAWER_COUNT = 2; // 0 = F2 (left), 1 = F3 (right)
const DEFAULT_DRAWER_WIDTH = 480;
const DRAWER_MIN_WIDTH = 280;
const DRAWER_MAX_WIDTH = 1200;
```

- [ ] **Step 4: Add module state** — right after the `let currentWorkspaceIndex = $state(0);` line (~line 154):

```ts
// Drawers are GLOBAL slide-in surfaces (F2 left, F3 right), independent of
// the 2×2 workspaces. Each is structurally a WorkspaceState (own windows[],
// geometryByGuid, nextZ). activeDrawer = which one is open + live (null =
// canvas live). drawerWidths = per-drawer panel extent (px). Persisted in v4.
let drawers = $state<WorkspaceState[]>(
	Array.from({ length: DRAWER_COUNT }, () => emptyWorkspace())
);
let activeDrawer = $state<number | null>(null);
let drawerWidths = $state<number[]>(
	Array.from({ length: DRAWER_COUNT }, () => DEFAULT_DRAWER_WIDTH)
);
```

- [ ] **Step 5: Add the width clamp helper** — next to `function bumpZ(...)` (~line 359):

```ts
function clampDrawerWidth(px: number): number {
	if (!Number.isFinite(px)) return DEFAULT_DRAWER_WIDTH;
	return Math.max(DRAWER_MIN_WIDTH, Math.min(DRAWER_MAX_WIDTH, Math.round(px)));
}
```

- [ ] **Step 6: Generalize `focusedNoteGuid`** — replace the existing getter body (~line 554) so it reads the active surface:

```ts
get focusedNoteGuid(): string | null {
	const ws = activeDrawer !== null ? drawers[activeDrawer] : current();
	let top: DesktopWindowState | null = null;
	for (const w of ws.windows) {
		if (w.kind !== 'note') continue;
		if (w.minimized) continue;
		if (!top || w.z > top.z) top = w;
	}
	return top?.guid ?? null;
},
```

- [ ] **Step 7: Add the drawer API** — inside the `desktopSession` object, right after the `get currentWorkspace()` getter (~line 514):

```ts
get activeDrawer(): number | null {
	return activeDrawer;
},

get drawerCount(): number {
	return DRAWER_COUNT;
},

isDrawerOpen(index: number): boolean {
	return activeDrawer === index;
},

/** Windows in drawer `index` (empty for an out-of-range index). */
drawerWindows(index: number): DesktopWindowState[] {
	return drawers[index]?.windows ?? [];
},

getDrawerWidth(index: number): number {
	return drawerWidths[index] ?? DEFAULT_DRAWER_WIDTH;
},

setDrawerWidth(index: number, px: number): void {
	if (index < 0 || index >= DRAWER_COUNT) return;
	const next = clampDrawerWidth(px);
	if (next === drawerWidths[index]) return;
	drawerWidths[index] = next;
	schedulePersist();
},

/**
 * Open drawer `index` if closed, close it if it's the open one, or switch to
 * it if the OTHER drawer is open. Only one drawer is visible at a time.
 * Opening makes it the live surface (canvas goes inactive but stays mounted).
 */
toggleDrawer(index: number): void {
	if (index < 0 || index >= DRAWER_COUNT) return;
	activeDrawer = activeDrawer === index ? null : index;
},

closeDrawer(): void {
	activeDrawer = null;
},
```

- [ ] **Step 8: Extend `_reset()`** — inside `_reset()` (~line 1191), after `currentWorkspaceIndex = 0;`:

```ts
drawers = Array.from({ length: DRAWER_COUNT }, () => emptyWorkspace());
activeDrawer = null;
drawerWidths = Array.from({ length: DRAWER_COUNT }, () => DEFAULT_DRAWER_WIDTH);
```

- [ ] **Step 9: Run test to verify it passes** — `cd app && npx vitest run tests/unit/desktop/drawerState.test.ts` → PASS.

- [ ] **Step 10: Commit**

```bash
git add app/src/lib/desktop/session.svelte.ts app/tests/unit/desktop/drawerState.test.ts
git commit -m "feat(desktop): 서랍 상태 — 토글/폭/활성 표면 + focusedNoteGuid 일반화"
```

---

### Task 2: Surface-aware window ops + move between surfaces

**Goal:** Add a `SurfaceRef` abstraction and surface-targeted window mutators (move/geometry/focus/close/pin/send-to-back), plus `moveWindowToSurface` (MOVE semantics) and `stashToActiveDrawer`. This is what makes drawer windows individually movable/resizable with their own per-surface geometry.

**Files:**
- Modify: `app/src/lib/desktop/session.svelte.ts`
- Test: `app/tests/unit/desktop/moveWindowToSurface.test.ts`

**Acceptance Criteria:**
- [ ] `SurfaceRef = { kind: 'workspace' | 'drawer'; index }` exported.
- [ ] `moveWindowToSurface(from, to, guid, drop?)` removes the window from `from`, adds it to `to`; the source pose is cached on the source (restored on return).
- [ ] Per-surface geometry isolation: resizing a window in a drawer does NOT change its workspace pose, and vice-versa.
- [ ] `updateGeometryOn` / `moveWindowOn` / `focusWindowOn` / `closeWindowOn` / `togglePinOn` / `sendToBackOn` operate on the surface named by their `SurfaceRef`.
- [ ] `stashToActiveDrawer(guid)` moves a current-workspace note into the open drawer (no-op if no drawer open).
- [ ] Moving a non-note window or a missing guid is a silent no-op.

**Verify:** `cd app && npx vitest run tests/unit/desktop/moveWindowToSurface.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing test** — create `app/tests/unit/desktop/moveWindowToSurface.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote } from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';
import { desktopSession } from '$lib/desktop/session.svelte.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	desktopSession._reset();
});

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const CANVAS = { kind: 'workspace', index: 0 } as const;
const DRAWER0 = { kind: 'drawer', index: 0 } as const;

describe('desktopSession — moveWindowToSurface', () => {
	it('moves a canvas note into a drawer (MOVE: leaves the source)', async () => {
		await putNote(createEmptyNote(A));
		desktopSession._reset();
		desktopSession.openWindow(A);
		expect(desktopSession.windows.some((w) => w.guid === A)).toBe(true);

		await desktopSession.moveWindowToSurface(CANVAS, DRAWER0, A);
		expect(desktopSession.windows.some((w) => w.guid === A)).toBe(false);
		expect(desktopSession.drawerWindows(0).some((w) => w.guid === A)).toBe(true);
	});

	it('keeps per-surface geometry independent', async () => {
		await putNote(createEmptyNote(A));
		desktopSession._reset();
		desktopSession.openWindow(A);
		// Set a distinct canvas size.
		desktopSession.updateGeometry(A, { x: 10, y: 10, width: 600, height: 600 });

		await desktopSession.moveWindowToSurface(CANVAS, DRAWER0, A);
		// Resize inside the drawer to a different size.
		desktopSession.updateGeometryOn(DRAWER0, A, { x: 5, y: 5, width: 320, height: 320 });
		expect(desktopSession.drawerWindows(0)[0].width).toBe(320);

		// Move back to canvas → canvas pose (600×600) restored, untouched by the
		// drawer resize.
		await desktopSession.moveWindowToSurface(DRAWER0, CANVAS, A);
		const back = desktopSession.windows.find((w) => w.guid === A)!;
		expect(back.width).toBe(600);
		expect(back.height).toBe(600);
	});

	it('stashToActiveDrawer moves the canvas note into the open drawer', async () => {
		await putNote(createEmptyNote(A));
		desktopSession._reset();
		desktopSession.openWindow(A);
		desktopSession.toggleDrawer(0);
		await desktopSession.stashToActiveDrawer(A);
		expect(desktopSession.drawerWindows(0).some((w) => w.guid === A)).toBe(true);
		expect(desktopSession.windows.some((w) => w.guid === A)).toBe(false);
	});

	it('stashToActiveDrawer is a no-op when no drawer is open', async () => {
		await putNote(createEmptyNote(A));
		desktopSession._reset();
		desktopSession.openWindow(A);
		await desktopSession.stashToActiveDrawer(A);
		expect(desktopSession.windows.some((w) => w.guid === A)).toBe(true);
	});

	it('moving a missing guid is a silent no-op', async () => {
		desktopSession._reset();
		await expect(
			desktopSession.moveWindowToSurface(CANVAS, DRAWER0, 'nope')
		).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd app && npx vitest run tests/unit/desktop/moveWindowToSurface.test.ts` → FAIL (`moveWindowToSurface is not a function`).

- [ ] **Step 3: Add the `SurfaceRef` type + resolver** — in `session.svelte.ts`, right after the `DesktopWindowState` interface (~line 80):

```ts
/** Names a window-bearing surface: a 2×2 workspace or a global drawer. */
export type SurfaceRef =
	| { kind: 'workspace'; index: number }
	| { kind: 'drawer'; index: number };
```

And next to `function current()` (~line 322):

```ts
function surfaceState(ref: SurfaceRef): WorkspaceState | null {
	if (ref.kind === 'workspace') return workspaces[ref.index] ?? null;
	return drawers[ref.index] ?? null;
}

/** Mutate a window's geometry on an explicit surface, then cache + persist. */
function mutateGeomOn(
	ref: SurfaceRef,
	guid: string,
	fn: (w: DesktopWindowState) => void
): void {
	const ws = surfaceState(ref);
	if (!ws) return;
	const win = ws.windows.find((w) => w.guid === guid);
	if (!win) return;
	fn(win);
	cacheGeometry(ws, win);
	schedulePersist();
}
```

- [ ] **Step 4: Add the surface-aware API** — inside the `desktopSession` object, right after `updateGeometry(...)` (~line 1036):

```ts
moveWindowOn(ref: SurfaceRef, guid: string, x: number, y: number): void {
	mutateGeomOn(ref, guid, (w) => {
		w.x = Math.max(0, Math.round(x));
		w.y = Math.max(0, Math.round(y));
	});
},

updateGeometryOn(
	ref: SurfaceRef,
	guid: string,
	g: { x: number; y: number; width: number; height: number }
): void {
	mutateGeomOn(ref, guid, (w) => {
		w.x = Math.max(0, Math.round(g.x));
		w.y = Math.max(0, Math.round(g.y));
		w.width = Math.max(MIN_WIDTH, Math.round(g.width));
		w.height = Math.max(MIN_HEIGHT, Math.round(g.height));
	});
},

focusWindowOn(ref: SurfaceRef, guid: string): void {
	const ws = surfaceState(ref);
	if (!ws) return;
	const win = ws.windows.find((w) => w.guid === guid);
	if (!win) return;
	if (win.kind === 'note') recentOpens.record(guid);
	const topZ = ws.windows.reduce((m, w) => Math.max(m, w.z), 0);
	if (win.z === topZ && win.z !== 0) return;
	bumpZ(ws, win);
	schedulePersist();
},

async closeWindowOn(ref: SurfaceRef, guid: string): Promise<void> {
	await runFlushHook(guid);
	const ws = surfaceState(ref);
	if (!ws) return;
	const idx = ws.windows.findIndex((w) => w.guid === guid);
	if (idx < 0) return;
	cacheGeometry(ws, ws.windows[idx]);
	ws.windows.splice(idx, 1);
	// Chain focus to the most-recently-focused remaining visible note on this
	// surface so Esc cascades within the drawer.
	let next: DesktopWindowState | null = null;
	for (const w of ws.windows) {
		if (w.kind !== 'note' || w.minimized) continue;
		if (!next || w.z > next.z) next = w;
	}
	if (next) focusRequest = { guid: next.guid, token: ++focusRequestCounter };
	schedulePersist();
},

togglePinOn(ref: SurfaceRef, guid: string): void {
	const ws = surfaceState(ref);
	if (!ws) return;
	const win = ws.windows.find((w) => w.guid === guid);
	if (!win) return;
	win.pinned = !win.pinned;
	schedulePersist();
},

sendToBackOn(ref: SurfaceRef, guid: string): void {
	const ws = surfaceState(ref);
	if (!ws) return;
	const win = ws.windows.find((w) => w.guid === guid);
	if (!win) return;
	const others = ws.windows.filter((w) => w.guid !== guid);
	if (others.length === 0) return;
	const minZ = others.reduce((m, w) => Math.min(m, w.z), Infinity);
	win.z = minZ - 1;
	schedulePersist();
},

/**
 * Move a note window between surfaces (workspace↔drawer). MOVE semantics: the
 * window leaves the source. Each surface keeps its OWN geometryByGuid, so the
 * note's drawer pose is independent of its canvas pose. On first entry the
 * window uses the target's remembered pose, else `drop` (clamped), else a
 * default slot; re-entry restores the target's remembered pose.
 */
async moveWindowToSurface(
	from: SurfaceRef,
	to: SurfaceRef,
	guid: string,
	drop?: { x: number; y: number }
): Promise<void> {
	const src = surfaceState(from);
	const dst = surfaceState(to);
	if (!src || !dst) return;
	if (from.kind === to.kind && from.index === to.index) return;
	const idx = src.windows.findIndex((w) => w.guid === guid);
	if (idx < 0) return;
	const win = src.windows[idx];
	if (win.kind !== 'note') return;

	// Persist unsaved edits before the source instance unmounts.
	await runFlushHook(guid);

	// Cache the source pose (so reopening on the source restores it), remove it.
	cacheGeometry(src, win);
	src.windows.splice(idx, 1);

	const existing = dst.windows.find((w) => w.guid === guid);
	if (existing) {
		existing.minimized = false;
		bumpZ(dst, existing);
	} else {
		const cached = dst.geometryByGuid[guid];
		let geom: GeometrySnapshot;
		if (cached) {
			geom = cached;
		} else if (drop) {
			geom = {
				x: Math.max(0, Math.round(drop.x)),
				y: Math.max(0, Math.round(drop.y)),
				width: win.width,
				height: win.height
			};
		} else {
			geom = { x: 24, y: 24, width: win.width, height: win.height };
		}
		const moved: DesktopWindowState = {
			guid,
			kind: 'note',
			x: geom.x,
			y: geom.y,
			width: geom.width,
			height: geom.height,
			z: ++dst.nextZ,
			pinned: win.pinned ?? false
		};
		dst.windows.push(moved);
		cacheGeometry(dst, moved);
	}

	// Focus + flash only if the target surface is the live one.
	const targetIsLive =
		(to.kind === 'drawer' && activeDrawer === to.index) ||
		(to.kind === 'workspace' &&
			activeDrawer === null &&
			to.index === currentWorkspaceIndex);
	if (targetIsLive) focusRequest = { guid, token: ++focusRequestCounter };
	recentOpens.record(guid);
	schedulePersist();
},

/** Stash a current-workspace note into the open drawer (no-op if none open). */
async stashToActiveDrawer(guid: string): Promise<void> {
	if (activeDrawer === null) return;
	await this.moveWindowToSurface(
		{ kind: 'workspace', index: currentWorkspaceIndex },
		{ kind: 'drawer', index: activeDrawer },
		guid
	);
},
```

- [ ] **Step 5: Run test to verify it passes** — `cd app && npx vitest run tests/unit/desktop/moveWindowToSurface.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/desktop/session.svelte.ts app/tests/unit/desktop/moveWindowToSurface.test.ts
git commit -m "feat(desktop): 표면 인지 창 조작 + moveWindowToSurface(이동)"
```

---

### Task 3: Persistence v4 — drawers + widths, v3 back-compat

**Goal:** Persist drawer contents and panel widths; bump `VERSION` 3→4; restore on load with back-compat for v3/v2 snapshots (empty drawers).

**Files:**
- Modify: `app/src/lib/desktop/session.svelte.ts`
- Test: `app/tests/unit/desktop/drawerPersist.test.ts`

**Acceptance Criteria:**
- [ ] After a stash + width change, a simulated reload restores the drawer's note and its width.
- [ ] `activeDrawer` is NOT persisted (a reload starts with drawers closed).
- [ ] A v3 snapshot loads without error and yields empty drawers + default widths.
- [ ] Drawer note guids whose notes still exist survive the load filter (deleted ones are dropped, mirroring workspaces).

**Verify:** `cd app && npx vitest run tests/unit/desktop/drawerPersist.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing test** — create `app/tests/unit/desktop/drawerPersist.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { putNote } from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';
import { setSetting } from '$lib/storage/appSettings.js';
import { desktopSession } from '$lib/desktop/session.svelte.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	desktopSession._reset();
});

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('desktopSession — drawer persistence (v4)', () => {
	it('restores drawer contents + width across a simulated reload, closed', async () => {
		await putNote(createEmptyNote(A));
		desktopSession._reset();
		desktopSession.openWindow(A);
		desktopSession.toggleDrawer(0);
		await desktopSession.stashToActiveDrawer(A);
		desktopSession.setDrawerWidth(0, 640);
		await new Promise((r) => setTimeout(r, 400)); // let debounced persist fire

		desktopSession._reset();
		await desktopSession.load();
		expect(desktopSession.drawerWindows(0).some((w) => w.guid === A)).toBe(true);
		expect(desktopSession.getDrawerWidth(0)).toBe(640);
		// Drawers start closed on reload.
		expect(desktopSession.activeDrawer).toBe(null);
	});

	it('loads a legacy v3 snapshot without error (empty drawers, default width)', async () => {
		await putNote(createEmptyNote(A));
		await setSetting('desktop:session', {
			version: 3,
			currentWorkspace: 0,
			workspaces: [
				{ windows: [{ guid: A, x: 0, y: 0, width: 560, height: 520, z: 1 }] },
				{ windows: [] },
				{ windows: [] },
				{ windows: [] }
			]
		});
		desktopSession._reset();
		await desktopSession.load();
		expect(desktopSession.windows.some((w) => w.guid === A)).toBe(true);
		expect(desktopSession.drawerWindows(0)).toEqual([]);
		expect(desktopSession.getDrawerWidth(0)).toBe(480); // DEFAULT_DRAWER_WIDTH
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd app && npx vitest run tests/unit/desktop/drawerPersist.test.ts` → FAIL (drawer empty after reload).

- [ ] **Step 3: Bump VERSION** — change `const VERSION = 3;` (~line 12) to:

```ts
const VERSION = 4;
```

- [ ] **Step 4: Add the v4 persisted shape** — replace the `type Persisted = PersistedV3 | PersistedV2;` line (~line 122) with a new interface above it and an extended union:

```ts
interface PersistedV4 {
	version: 4;
	currentWorkspace: number;
	workspaces: PersistedV3['workspaces'];
	// Drawers reuse the same per-surface persisted shape as workspaces.
	drawers: PersistedV3['workspaces'];
	drawerWidths: number[];
}

type Persisted = PersistedV4 | PersistedV3 | PersistedV2;
```

- [ ] **Step 5: Write drawers in `persistNow`** — replace the body of `persistNow` (~line 297) so it sanitizes + includes drawers:

```ts
async function persistNow(): Promise<void> {
	const sanitizeWindows = (ws: WorkspaceState) => ({
		...ws,
		windows: ws.windows.filter((w) => w.kind !== 'history')
	});
	const snapshot: PersistedV4 = $state.snapshot({
		version: VERSION,
		currentWorkspace: currentWorkspaceIndex,
		workspaces: workspaces.map(sanitizeWindows),
		drawers: drawers.map(sanitizeWindows),
		drawerWidths
	}) as PersistedV4;
	try {
		await setSetting(STORAGE_KEY, snapshot);
	} catch {
		/* ignore — persistence is best-effort */
	}
}
```

- [ ] **Step 6: Collect drawer guids for the keep-filter** — in `collectExistingGuids` (~line 420), after the `else if ('windows' in persisted ...)` block that pushes into `allRaws`, add drawer scanning. Insert right before `const seen = new Set<string>();`:

```ts
	if ('drawers' in persisted && Array.isArray((persisted as PersistedV4).drawers)) {
		for (const ws of (persisted as PersistedV4).drawers) {
			if (Array.isArray(ws?.windows)) allRaws.push(...ws.windows);
		}
	}
```

- [ ] **Step 7: Restore drawers in `loadPersisted`** — in `loadPersisted` (~line 444), after the workspaces restore block (just before the closing `}` of the function, after the `} else if ('windows' in persisted ...)` migration branch ends), add:

```ts
	if ('drawers' in persisted && Array.isArray((persisted as PersistedV4).drawers)) {
		const p4 = persisted as PersistedV4;
		const restoredDrawers: WorkspaceState[] = [];
		for (let i = 0; i < DRAWER_COUNT; i++) {
			const raw = p4.drawers[i];
			if (raw && Array.isArray(raw.windows)) {
				restoredDrawers.push(
					restoreWorkspaceFromPersisted(
						{ windows: raw.windows, geometryByGuid: raw.geometryByGuid, nextZ: raw.nextZ },
						keepGuids
					)
				);
			} else {
				restoredDrawers.push(emptyWorkspace());
			}
		}
		drawers = restoredDrawers;
		if (Array.isArray(p4.drawerWidths)) {
			drawerWidths = Array.from({ length: DRAWER_COUNT }, (_, i) =>
				clampDrawerWidth(p4.drawerWidths[i] ?? DEFAULT_DRAWER_WIDTH)
			);
		}
	}
```

- [ ] **Step 8: Run test to verify it passes** — `cd app && npx vitest run tests/unit/desktop/drawerPersist.test.ts` → PASS. Also re-run the prior two desktop tests to confirm no regression: `cd app && npx vitest run tests/unit/desktop/drawerState.test.ts tests/unit/desktop/moveWindowToSurface.test.ts` → PASS.

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/desktop/session.svelte.ts app/tests/unit/desktop/drawerPersist.test.ts
git commit -m "feat(desktop): 서랍 영속화 v4 + v3 하위호환 로드"
```

---

### Task 4: DrawerOverlay component + render integration + F2/F3

**Goal:** Render two slide-in drawer overlays that host their windows (always mounted → keep-alive), wire surface-aware `active`, add the `surface` prop to NoteWindow so drawer windows resize/pin correctly, bind F2/F3, and add the `--z-drawer` token. After this task drawers open/close and a programmatically-stashed note lives + survives toggling.

**Files:**
- Create: `app/src/lib/desktop/DrawerOverlay.svelte`
- Modify: `app/src/lib/desktop/NoteWindow.svelte`
- Modify: `app/src/lib/desktop/DesktopWorkspace.svelte`
- Modify: `app/src/app.css`

**Acceptance Criteria:**
- [ ] `--z-drawer` token exists in `app/src/app.css` `:root`, below `--z-modal`.
- [ ] NoteWindow accepts an optional `surface?: SurfaceRef`; when set, resize (ResizeHandles + auto-grow), pin, and send-to-back route through `*On(surface, …)`; when unset, the legacy current-workspace calls run (canvas unchanged).
- [ ] F2 toggles the left drawer, F3 the right; `preventDefault`; no modifiers.
- [ ] A canvas note moved into a drawer (via `stashToActiveDrawer` in dev console) renders inside the panel, is draggable + resizable there, and stays mounted (terminal stays connected) when the drawer is toggled closed.
- [ ] Canvas windows are `active=false` while a drawer is open, but remain in the DOM.

**Verify:** `cd app && npm run check` → 0 errors. Manual: `npm run dev`, open `/desktop`, F2/F3 slide the panels in/out from left/right.

**Steps:**

- [ ] **Step 1: Add the z token** — in `app/src/app.css`, in the `:root` block where `--z-*` tokens live, add (place it between `--z-sheet` and `--z-menu`):

```css
	/* Desktop drawers (F2/F3 slide-in overlays). Above the rail/sheets so the
	   panel covers in-canvas chrome; below context menus (which portal to body
	   at --z-menu) and modals/spread (F4) so those still cover the drawer. */
	--z-drawer: 350;
```

- [ ] **Step 2: Add the `surface` prop to NoteWindow** — in `app/src/lib/desktop/NoteWindow.svelte`, import the type. Find the existing session import and add `type SurfaceRef`:

```ts
	import { desktopSession, registerSnapshotSource, type SurfaceRef } from './session.svelte.js';
```

(If the existing import differs, add `type SurfaceRef` to the named imports from `./session.svelte.js`.)

Add to the `Props` interface (after `minimized?: boolean;`, ~line 118):

```ts
		/** When set, this window lives on a drawer surface; resize/pin/send-to-back
		 *  route through the surface-aware session ops instead of the current
		 *  workspace. Unset (canvas) keeps the legacy current-workspace calls. */
		surface?: SurfaceRef;
```

Add to the destructure (after `minimized = false,`, ~line 138):

```ts
		surface = undefined,
```

- [ ] **Step 3: Route NoteWindow self-calls through the surface** — add three helpers in the `<script>` (near the other handlers, e.g. after the `let { … } = $props();` block):

```ts
	function applyGeometry(g: { x: number; y: number; width: number; height: number }) {
		if (surface) desktopSession.updateGeometryOn(surface, guid, g);
		else desktopSession.updateGeometry(guid, g);
	}
	function pinToggleOnSurface() {
		if (surface) desktopSession.togglePinOn(surface, guid);
		else desktopSession.togglePin(guid);
	}
	function sendBackOnSurface() {
		if (surface) desktopSession.sendToBackOn(surface, guid);
		else desktopSession.sendToBack(guid);
	}
```

Then replace the three direct call sites:
- ~line 571 `desktopSession.updateGeometry(guid, { x, y, width: newWidth, height });` → `applyGeometry({ x, y, width: newWidth, height });`
- ~line 887 `desktopSession.togglePin(guid);` (inside `handlePinToggle`) → `pinToggleOnSurface();`
- ~line 893 `desktopSession.sendToBack(guid);` → `sendBackOnSurface();`
- ~line 1354 `onresize={(g) => desktopSession.updateGeometry(guid, g)}` → `onresize={(g) => applyGeometry(g)}`

> Note: `openHistory` (~line 1049) is intentionally left as-is — it targets the current workspace and silently no-ops for a drawer window (history is a rarely-used menu action; documented limitation).

- [ ] **Step 4: Create `DrawerOverlay.svelte`** — `app/src/lib/desktop/DrawerOverlay.svelte`:

```svelte
<script lang="ts">
	import NoteWindow from './NoteWindow.svelte';
	import { desktopSession, DESKTOP_PINNED_Z } from './session.svelte.js';
	import { startPointerDrag } from './dragResize.js';

	interface Props {
		index: number;
		side: 'left' | 'right';
	}
	let { index, side }: Props = $props();

	const open = $derived(desktopSession.isDrawerOpen(index));
	const width = $derived(desktopSession.getDrawerWidth(index));
	const windows = $derived(desktopSession.drawerWindows(index));
	const surface = $derived({ kind: 'drawer' as const, index });

	function startWidthDrag(e: PointerEvent) {
		const base = width;
		// Left drawer grows when its right-edge grip moves right (+dx); right
		// drawer grows when its left-edge grip moves left (−dx).
		startPointerDrag(e, {
			onMove: (dx) => {
				const next = side === 'left' ? base + dx : base - dx;
				desktopSession.setDrawerWidth(index, next);
			}
		});
	}
</script>

<!-- Always mounted so drawer notes (terminal WS, editors) stay alive when the
     panel is tucked off-screen. Hidden via transform (NOT display:none) so the
     layout/size persists — terminals keep their geometry. -->
<div class="drawer" class:open data-side={side} style="--drawer-width: {width}px;" aria-hidden={!open}>
	<div class="drawer-windows">
		{#each windows as win (win.guid)}
			<NoteWindow
				guid={win.guid}
				x={win.x}
				y={win.y}
				width={win.width}
				height={win.height}
				z={(win.pinned ? DESKTOP_PINNED_Z : 0) + win.z}
				pinned={win.pinned}
				active={open}
				minimized={win.minimized}
				{surface}
				onfocus={(g) => desktopSession.focusWindowOn(surface, g)}
				onclose={(g) => void desktopSession.closeWindowOn(surface, g)}
				onmove={(g, x, y) => desktopSession.moveWindowOn(surface, g, x, y)}
				onresize={(g, w, h) =>
					desktopSession.updateGeometryOn(surface, g, {
						x: win.x,
						y: win.y,
						width: w,
						height: h
					})}
				onopenlink={(t) => void desktopSession.openByTitle(t)}
			/>
		{/each}
	</div>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="width-grip" data-side={side} onpointerdown={startWidthDrag} title="서랍 폭 조절"></div>
</div>

<style>
	.drawer {
		position: fixed;
		top: 0;
		bottom: 0;
		width: var(--drawer-width, 480px);
		background: rgba(18, 18, 18, 0.96);
		box-shadow: 0 0 24px rgba(0, 0, 0, 0.5);
		z-index: var(--z-drawer);
		transition: transform 0.18s ease;
		overflow: hidden;
	}
	/* Left drawer sits just right of the rail; right drawer hugs the viewport
	   right edge. Both tuck off-screen when closed. */
	.drawer[data-side='left'] {
		left: var(--rail-width, 80px);
		transform: translateX(-110%);
	}
	.drawer[data-side='right'] {
		right: 0;
		transform: translateX(110%);
	}
	.drawer.open {
		transform: translateX(0);
	}
	.drawer-windows {
		position: absolute;
		inset: 0;
	}
	.width-grip {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: ew-resize;
		z-index: 2;
	}
	.width-grip[data-side='left'] {
		right: 0;
	}
	.width-grip[data-side='right'] {
		left: 0;
	}
</style>
```

> NoteWindow's `onresize` prop is dead for real resizing (resize flows through `applyGeometry`→`updateGeometryOn` via the `surface` prop and ResizeHandles). The `onresize` wiring above is a harmless passthrough kept for prop completeness.

- [ ] **Step 5: Render the drawers + generalize `active`** — in `DesktopWorkspace.svelte`:

Import the component (after the `SpreadOverlay` import, ~line 19):

```ts
	import DrawerOverlay from './DrawerOverlay.svelte';
```

In the canvas `{#each}` (~line 343), change the `active` derivation so an open drawer makes the canvas inactive. Replace:

```svelte
				{@const active = item.workspaceIndex === desktopSession.currentWorkspace}
```

with:

```svelte
				{@const active = item.workspaceIndex === desktopSession.currentWorkspace && desktopSession.activeDrawer === null}
```

Add the two overlays right after `{#if spreadView.isOpen}…{/if}` (~line 425), still inside `.desktop-root`:

```svelte
	<DrawerOverlay index={0} side="left" />
	<DrawerOverlay index={1} side="right" />
```

- [ ] **Step 6: Bind F2/F3** — in `DesktopWorkspace.svelte`'s `onKey`, add a handler at the top of the function (right after the F4 block, ~line 191):

```ts
		// F2 / F3 — toggle the left / right drawer (ddterm-style). No modifiers.
		if (
			(e.key === 'F2' || e.key === 'F3') &&
			!e.ctrlKey &&
			!e.altKey &&
			!e.metaKey &&
			!e.shiftKey
		) {
			e.preventDefault();
			desktopSession.toggleDrawer(e.key === 'F2' ? 0 : 1);
			return;
		}
```

- [ ] **Step 7: Verify types + manual** — `cd app && npm run check` → 0 errors. Then `npm run dev`, open `/desktop`:
  - F2 slides a panel in from the left, F3 from the right; pressing again slides it out.
  - In the dev console run `window.__ds = (await import('/src/lib/desktop/session.svelte.ts')).desktopSession` is not needed — instead open a note, then with a drawer open, temporarily test the move by adding a throwaway button OR proceed to Task 5 (arrow) for the real entry path. (Keep-alive is verified end-to-end in Task 5.)

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/desktop/DrawerOverlay.svelte app/src/lib/desktop/DesktopWorkspace.svelte app/src/lib/desktop/NoteWindow.svelte app/src/app.css
git commit -m "feat(desktop): 서랍 오버레이 렌더 + F2/F3 토글 + 표면 인지 NoteWindow"
```

---

### Task 5: Close button → directional stash arrow

**Goal:** While a drawer is open, every canvas note window's close (✕) button becomes a directional arrow (← for the left/F2 drawer, → for the right/F3 drawer). Clicking it MOVES that note into the open drawer.

**Files:**
- Modify: `app/src/lib/desktop/NoteWindow.svelte`
- Modify: `app/src/lib/desktop/DesktopWorkspace.svelte`

**Acceptance Criteria:**
- [ ] When no drawer is open, the close button is unchanged (✕ → close).
- [ ] When a drawer is open, canvas note windows show ← (drawer 0) or → (drawer 1); clicking moves the note into the open drawer (it leaves the canvas, appears in the panel, alive).
- [ ] Drawer windows themselves keep the plain ✕ (close = remove from drawer).
- [ ] The arrow is suppressed for the drawer's own windows (a window can't stash into the drawer it's already in).

**Verify:** `cd app && npm run check` → 0 errors. Manual: open a terminal note on canvas, press F3, the ✕ becomes →, click it — the note slides into the right drawer and the SSH session stays connected; toggle F3 off/on and the terminal is still live.

**Steps:**

- [ ] **Step 1: Add stash props to NoteWindow** — in `NoteWindow.svelte` `Props` (after the `surface?: SurfaceRef;` added in Task 4):

```ts
		/** When a drawer is open AND this is a canvas window, the close button
		 *  becomes a stash arrow pointing at the drawer: 'left' → ←, 'right' → →.
		 *  null → normal close (✕). */
		stashArrow?: 'left' | 'right' | null;
		/** Invoked when the stash arrow is clicked (move this note into the drawer). */
		onstash?: (guid: string) => void;
```

Destructure defaults:

```ts
		stashArrow = null,
		onstash = undefined,
```

- [ ] **Step 2: Render the arrow variant** — in `NoteWindow.svelte`, replace the close button block (~lines 1151-1157):

```svelte
		{#if stashArrow && onstash}
			<button
				type="button"
				class="close-btn stash-btn"
				onclick={() => onstash?.(guid)}
				aria-label="서랍으로 넣기"
				title="서랍으로 넣기"
				data-no-drag
			>{stashArrow === 'left' ? '←' : '→'}</button>
		{:else}
			<button
				type="button"
				class="close-btn"
				onclick={handleClose}
				aria-label="창 닫기"
				data-no-drag
			>✕</button>
		{/if}
```

- [ ] **Step 3: Compute the arrow per canvas window + wire stash** — in `DesktopWorkspace.svelte`, add a handler near the other `handle*` functions (~line 105):

```ts
	function handleStash(guid: string) {
		void desktopSession.stashToActiveDrawer(guid);
	}

	// 'left' when drawer 0 (F2) open, 'right' when drawer 1 (F3) open, else null.
	const stashArrowDir = $derived(
		desktopSession.activeDrawer === 0
			? 'left'
			: desktopSession.activeDrawer === 1
				? 'right'
				: null
	);
```

In the canvas `{#each}`'s `NoteWindow` (the `{:else}` branch, ~line 388), add the two props (only canvas windows get them):

```svelte
						stashArrow={active ? null : stashArrowDir}
						onstash={handleStash}
```

> `active` is `false` for canvas windows exactly when a drawer is open, so `active ? null : stashArrowDir` yields the arrow only while a drawer is open and only on canvas windows. Drawer windows (rendered by `DrawerOverlay`) never receive `stashArrow`, so they keep ✕.

- [ ] **Step 4: (optional styling) distinguish the arrow** — add to NoteWindow `<style>` (near `.close-btn`):

```css
	.stash-btn {
		font-weight: 700;
	}
```

- [ ] **Step 5: Verify types + manual** — `cd app && npm run check` → 0 errors. `npm run dev` → exercise the Verify scenario above (terminal note, F3, → click, keep-alive across toggle).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/desktop/NoteWindow.svelte app/src/lib/desktop/DesktopWorkspace.svelte
git commit -m "feat(desktop): 서랍 열림 시 닫기버튼→방향 화살표(노트를 서랍으로 이동)"
```

---

### Task 6: Drag a canvas window into the open drawer

**Goal:** Add the alternate entry gesture — dragging a canvas note window by its title bar so it ends over the open drawer panel moves it into that drawer at the drop point.

**Files:**
- Modify: `app/src/lib/desktop/dragResize.ts`
- Modify: `app/src/lib/desktop/NoteWindow.svelte`
- Modify: `app/src/lib/desktop/DesktopWorkspace.svelte`

**Acceptance Criteria:**
- [ ] `startPointerDrag`'s `onEnd` receives the final pointer position.
- [ ] Dragging a canvas window so the pointer is released inside the open drawer panel moves the note into that drawer at the drop location (drawer-local coords).
- [ ] Releasing outside the drawer behaves exactly as before (normal move within the canvas).
- [ ] No effect when no drawer is open.

**Verify:** `cd app && npm run check` → 0 errors. Manual: with a drawer open, drag a canvas note into the panel — it docks there; drag one inside the canvas (no drawer) — unchanged.

**Steps:**

- [ ] **Step 1: Pass the final pointer to `onEnd`** — in `dragResize.ts`, change the `DragCallbacks` type and `handleUp`:

```ts
export interface DragCallbacks {
	onMove: (dx: number, dy: number) => void;
	onEnd?: (pointer: { x: number; y: number }) => void;
}
```

In `handleUp` (~line 91), pass the pointer:

```ts
	const handleUp = (ev: PointerEvent) => {
		try {
			target.releasePointerCapture(ev.pointerId);
		} catch {
			/* noop */
		}
		target.removeEventListener('pointermove', handleMove);
		target.removeEventListener('pointerup', handleUp);
		target.removeEventListener('pointercancel', handleUp);
		onEnd?.({ x: ev.clientX, y: ev.clientY });
	};
```

> Existing `onEnd?.()` callers (if any) still type-check — the parameter is optional at the call site. (Confirm with `npm run check`.)

- [ ] **Step 2: Add an `ondropsurface`-style callback to NoteWindow** — the title-bar drag lives in NoteWindow's `startDrag` (~line 844, the `onmove(guid, origX + dx, origY + dy)` site). Add a prop:

```ts
		/** Canvas-only: called at drag-end with the viewport pointer so the host
		 *  can move the window into an open drawer if released over it. */
		ondragend?: (guid: string, pointer: { x: number; y: number }) => void;
```

Destructure default `ondragend = undefined,`. Then in the title-bar `startDrag` handler, locate the `startPointerDrag(e, { onMove: … })` call used for the title bar (~line 843) and add an `onEnd`:

```ts
		startPointerDrag(e, {
			onMove: (dx, dy) => {
				onmove(guid, origX + dx, origY + dy);
			},
			onEnd: (pointer) => ondragend?.(guid, pointer)
		});
```

(Apply only to the title-bar drag — the one that begins the window move. Leave the NoteDragHandle / other `startPointerDrag` calls untouched.)

- [ ] **Step 3: Handle the drop in DesktopWorkspace** — add a handler (~line 110):

```ts
	// If a canvas window is dropped over the open drawer panel, move it in.
	function handleCanvasDragEnd(guid: string, pointer: { x: number; y: number }) {
		const i = desktopSession.activeDrawer;
		if (i === null) return;
		const panel = document.querySelector<HTMLElement>(`.drawer[data-side='${i === 0 ? 'left' : 'right'}'].open`);
		if (!panel) return;
		const rect = panel.getBoundingClientRect();
		if (
			pointer.x < rect.left ||
			pointer.x > rect.right ||
			pointer.y < rect.top ||
			pointer.y > rect.bottom
		) {
			return; // released outside the drawer → normal canvas move (already applied)
		}
		void desktopSession.moveWindowToSurface(
			{ kind: 'workspace', index: desktopSession.currentWorkspace },
			{ kind: 'drawer', index: i },
			guid,
			{ x: pointer.x - rect.left, y: pointer.y - rect.top }
		);
	}
```

Pass it to the canvas `NoteWindow` (the `{:else}` branch):

```svelte
						ondragend={handleCanvasDragEnd}
```

- [ ] **Step 4: Verify types + manual** — `cd app && npm run check` → 0 errors. `npm run dev` → drag a canvas window into an open drawer (docks at drop point); drag within canvas with no drawer (unchanged).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/desktop/dragResize.ts app/src/lib/desktop/NoteWindow.svelte app/src/lib/desktop/DesktopWorkspace.svelte
git commit -m "feat(desktop): 캔버스 창을 열린 서랍으로 드래그하여 이동"
```

---

### Task 7: Guide card + full verification

**Goal:** Document the F2/F3 drawer feature in 설정 → 가이드 (project invariant), then run the full type + test suite.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte`
- Test: full vitest run + svelte-check

**Acceptance Criteria:**
- [ ] A `<details class="guide-card">` describing F2/F3 drawers is added to the `env` guide sub-tab (desktop-only env feature), matching the existing card pattern.
- [ ] `npm run check` passes with 0 errors.
- [ ] `npm run test` (full vitest) passes.

**Verify:** `cd app && npm run check && npm run test` → 0 type errors, all tests pass.

**Steps:**

- [ ] **Step 1: Find the env sub-tab card list** — in `app/src/routes/settings/+page.svelte`, locate the `guideSubTab === 'env'` section (search for `guideSubTab` and an existing `guide-card` under it, e.g. the PWA/Firefox cards). Copy the structure of an adjacent card.

- [ ] **Step 2: Add the drawer guide card** — insert a new card inside the `env` sub-tab block, mirroring the existing pattern (summary + info-text + snippet + guide-list):

```svelte
				<details class="guide-card">
					<summary>데스크탑 서랍 (F2 / F3)</summary>
					<p class="info-text">
						데스크탑 화면에서 <strong>F2</strong>(왼쪽) / <strong>F3</strong>(오른쪽)을 누르면
						서랍이 슬라이드로 열립니다. 작업공간(2×2)과 무관한 별도의 공간으로, 자주 쓰는
						노트 — 특히 터미널 접속 노트 — 를 넣어두면 서랍이 닫혀 있어도 연결이 유지됩니다.
					</p>
					<ul class="guide-list">
						<li>서랍이 열린 상태에서 캔버스 노트의 <strong>✕ 버튼이 방향 화살표</strong>로 바뀌며,
							누르면 그 노트가 서랍으로 들어갑니다. 창을 서랍 패널로 끌어다 놓아도 됩니다.</li>
						<li>서랍 안 노트는 자유롭게 위치/크기를 조절할 수 있고, 그 배치는 서랍이
							<strong>독자적으로</strong> 기억합니다(다른 곳에서 연 같은 노트에 영향 없음).</li>
						<li>서랍 패널의 안쪽 가장자리를 끌어 <strong>폭</strong>을 조절할 수 있습니다.</li>
						<li>F2와 F3은 서로 다른 공간이며, 같은 노트를 양쪽에 둘 수 있습니다(각각 별도 인스턴스).</li>
						<li>한 번에 한 서랍만 열립니다. 닫아도 노트는 계속 살아 있습니다(백그라운드 유지).</li>
					</ul>
				</details>
```

- [ ] **Step 3: Run full verification** — `cd app && npm run check` → 0 errors; then `cd app && npm run test` → all pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(desktop): 설정 가이드에 서랍(F2/F3) 카드 추가"
```

---

## Self-Review

**Spec coverage:**
- Global drawers independent of workspaces → Task 1 (`drawers` separate from `workspaces`, `activeDrawer`).
- F2 left / F3 right slide-in overlay, toggle, one at a time → Task 1 (`toggleDrawer`) + Task 4 (DrawerOverlay sides, F2/F3 keys).
- Free placement + per-window resize + panel-width resize → Task 2 (`updateGeometryOn`/`moveWindowOn`) + Task 4 (DrawerOverlay width grip, NoteWindow `surface`).
- Keep-alive while hidden → Task 4 (union render, `transform` hide, generalized `active`).
- Per-surface independent geometry → Task 2 (per-surface `geometryByGuid`, isolation test).
- Close → directional arrow stash (MOVE) → Task 5.
- Drag canvas window into drawer → Task 6.
- Same note in multiple surfaces → Task 2 (independent mounts; documented re-open flow).
- Persistence → Task 3 (v4 + v3 back-compat).
- Guide doc invariant → Task 7.

**Placeholder scan:** No TBD/TODO; every code step shows full code. Manual-verify steps name the exact scenario.

**Type consistency:** `SurfaceRef` defined in Task 2, imported by NoteWindow (Task 4) and used by DrawerOverlay (Task 4) + DesktopWorkspace (Task 6). `*On(ref, …)` method names consistent across Tasks 2/4/6. `stashToActiveDrawer`/`moveWindowToSurface`/`toggleDrawer`/`getDrawerWidth`/`setDrawerWidth`/`drawerWindows`/`activeDrawer` used identically wherever referenced. `VERSION = 4` and `PersistedV4` consistent in Task 3.

**Known limitation captured:** `openHistory` no-ops for drawer windows (Task 4 note); double-SSH on multi-surface terminal note (spec). Both intentional for v1.
