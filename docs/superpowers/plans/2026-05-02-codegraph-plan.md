# `/desktop/codegraph` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a desktop-only 3D code knowledge graph viewer at `/desktop/codegraph` that renders graphify's `graph.json` using shared 3D-force-graph machinery extracted from the existing note graph route.

**Architecture:** First refactor `/desktop/graph`'s inline helpers (label LOD, selection pickers, halos, reticle, FpsControls) into a new `lib/desktop/graphCommon/` shared module — each extraction is its own commit and is manually verified against the live note graph before the next extraction starts. Only after all four extractions land does the new `/desktop/codegraph` route get built on top of the shared modules, plus a small dev-only data sync script.

**Tech Stack:** SvelteKit (Svelte 5 runes), TypeScript, Three.js, 3d-force-graph, three-spritetext, vitest. Source of data is `graphify-out/graph.json` (graphify CLI), copied dev-only into `app/static/`.

---

## Plan-time clarifications needed

These items were found while writing the plan — surface them but **do not** silently fix in code:

1. **`GRAPH_REPORT.md` community-header regex mismatch.** The spec (line 117) says `sync-codegraph.mjs` extracts community labels via regex `^### Community (\d+): (.+)$` (colon separator). The actual file at `graphify-out/GRAPH_REPORT.md` uses dash-with-quotes — e.g. `### Community 0 - "Home Note & Misc Utils"`. The plan therefore implements the regex as `^### Community (\d+) - "(.+)"$` (with optional outer-quote stripping) and a unit test that pins both forms — but the implementer SHOULD ask the spec author to confirm before writing code. If the report layout changes again, only `sync-codegraph.mjs` needs updating.

## Spec ambiguities resolved by conservative interpretation

- **Where unit tests for `sync-codegraph.mjs` live.** The spec lists only `app/tests/unit/codegraph/` and `app/tests/unit/desktop/graphCommon/`. The script lives at `app/scripts/sync-codegraph.mjs`; tests for the pure helpers it exports (e.g. `normalizeRepoUrl`, `parseCommunityLabels`) are placed under `app/tests/unit/scripts/sync-codegraph.test.ts` mirroring the source path.
- **Hub threshold for the codegraph.** Spec says `size >= 1.6` for hub-tier (selective links + always-on labels). Same value used by the note graph; reused verbatim.
- **`labelLod.ts` signature.** Spec line 98 names parameters `(entries, cameraPos, baseDistance, scratch)`. The note graph's inline implementation does not use a scratch object — it uses local primitives and reads `camera.position.{x,y,z}`. The plan implements `updateLabelOpacity(entries, camX, camY, camZ, baseDistance)` (no allocations) and treats "scratch" in the spec as describing the absence of allocation rather than a passed-in object.
- **`createSelectionHalo()` and `createHoverHalo()` factory shape.** The spec lists colors and opacities but not constructor arity. The plan exports zero-arg factories returning `{ mesh: THREE.Mesh, dispose(): void }`, matching how the note graph already handles disposal.

---

## Task graph overview

```
Task 1 (mv FpsControls)  ──┐
Task 2 (labelLod)        ──┤
Task 3 (selectionPickers)──┤
Task 4 (haloFactory + ReticleOverlay) ──┤
                                        ├──→ Task 5 (codegraphTypes + loadCodegraphData)
                                        ├──→ Task 6 (nodeColor)
                                        ├──→ Task 7 (edgeStyle)
                                        ├──→ Task 8 (githubLink)
                                        ├──→ Task 9 (sync-codegraph.mjs + npm script + .gitignore)
                                        └──→ Task 10 (CodeNodePanel.svelte)
                                                                              │
                                                  Tasks 5-10 ─────────────────┘
                                                                              ↓
                                                Task 11 (/desktop/codegraph/+page.svelte)
                                                                              ↓
                                                Task 12 (SidePanel launcher button)
```

Tasks 1-4 must complete IN ORDER (each verified manually against `/desktop/graph` before the next). Tasks 5-10 may run in parallel after Task 4 lands. Task 11 depends on all of 1-10. Task 12 only needs Task 11.

---

## Task 1: Move `FpsControls.ts` into `graphCommon/`

**Goal:** Identity move of `FpsControls.ts` from `lib/graph/` to the new `lib/desktop/graphCommon/`, fix the one import in the note graph route, verify no behavior change.

**Files:**
- Create: `app/src/lib/desktop/graphCommon/FpsControls.ts` (verbatim copy of current file)
- Delete: `app/src/lib/graph/FpsControls.ts`
- Modify: `app/src/routes/desktop/graph/+page.svelte:7` (update import path)

**Acceptance Criteria:**
- [ ] `app/src/lib/graph/FpsControls.ts` no longer exists.
- [ ] `app/src/lib/desktop/graphCommon/FpsControls.ts` exists with identical content.
- [ ] `npm run check` passes (no broken imports).
- [ ] Manual: `/desktop/graph` loads, click → pointer locks, WASD moves, Shift sprints, ESC releases.

**Verify:** `cd app && npm run check` → 0 errors

**Steps:**

- [ ] **Step 1: Create the new directory and move the file**

```bash
mkdir -p app/src/lib/desktop/graphCommon
git mv app/src/lib/graph/FpsControls.ts app/src/lib/desktop/graphCommon/FpsControls.ts
```

- [ ] **Step 2: Update the only import**

In `app/src/routes/desktop/graph/+page.svelte`, change line 7:

```svelte
// before
import { FpsControls } from '$lib/graph/FpsControls.js';

// after
import { FpsControls } from '$lib/desktop/graphCommon/FpsControls.js';
```

- [ ] **Step 3: Verify no other file imports the old path**

```bash
cd app && grep -rn "lib/graph/FpsControls" src tests
```

Expected: no output.

- [ ] **Step 4: Type check**

```bash
cd app && npm run check
```

Expected: 0 errors, 0 warnings related to FpsControls.

- [ ] **Step 5: Manual verification (REQUIRED before commit)**

Run dev server, open `/desktop/graph`, click the canvas, press W/A/S/D, hold Shift, press ESC. Confirm identical behavior to before the move.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/desktop/graphCommon/FpsControls.ts app/src/routes/desktop/graph/+page.svelte
git commit -m "FpsControls를 lib/desktop/graphCommon/으로 이동 (코드 그래프와 공유)"
```

---

## Task 2: Extract label LOD into `graphCommon/labelLod.ts`

**Goal:** Pull the inline `updateLabelVisibility` from `routes/desktop/graph/+page.svelte` into a pure helper, replace the inline call site, add unit tests.

**Files:**
- Create: `app/src/lib/desktop/graphCommon/labelLod.ts`
- Create: `app/tests/unit/desktop/graphCommon/labelLod.test.ts`
- Modify: `app/src/routes/desktop/graph/+page.svelte` (lines ~159-170 type defs, ~478-510 function body, ~670 call site)

**Acceptance Criteria:**
- [ ] `LabelEntry` type and `updateLabelOpacity()` exported from `labelLod.ts`.
- [ ] `routes/desktop/graph/+page.svelte` no longer contains the inline LabelEntry / `updateLabelVisibility` definition; it imports + calls the helper instead.
- [ ] Hub labels (added with `visible = true` and not pushed to `labelEntries`) are still always-on.
- [ ] Unit tests cover: hubs untouched, `d ≤ base` → opacity 1, `d ≥ 2*base` → hidden, fade band linear, `n.x === undefined` skipped.
- [ ] Manual: label fade-with-distance behavior on `/desktop/graph` is visually identical.

**Verify:** `cd app && npm run check && npm run test -- labelLod` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test first**

Create `app/tests/unit/desktop/graphCommon/labelLod.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { updateLabelOpacity, type LabelEntry } from '$lib/desktop/graphCommon/labelLod.js';

function makeEntry(x: number, y = 0, z = 0): LabelEntry {
	return {
		node: { x, y, z },
		label: {
			visible: false,
			material: { opacity: 0, transparent: true }
		}
	};
}

describe('updateLabelOpacity', () => {
	it('opacity 1 at distance ≤ base', () => {
		const e = makeEntry(50);
		updateLabelOpacity([e], 0, 0, 0, 100);
		expect(e.label.visible).toBe(true);
		expect(e.label.material.opacity).toBe(1);
	});

	it('hidden at distance ≥ 2*base', () => {
		const e = makeEntry(250);
		updateLabelOpacity([e], 0, 0, 0, 100);
		expect(e.label.visible).toBe(false);
	});

	it('linear fade in (base, 2*base)', () => {
		const e = makeEntry(150); // 1.5x base, expect 0.5 opacity
		updateLabelOpacity([e], 0, 0, 0, 100);
		expect(e.label.visible).toBe(true);
		expect(e.label.material.opacity).toBeCloseTo(0.5, 3);
	});

	it('skips entries with undefined node.x', () => {
		const e: LabelEntry = {
			node: { x: undefined, y: 0, z: 0 },
			label: { visible: true, material: { opacity: 1, transparent: true } }
		};
		updateLabelOpacity([e], 0, 0, 0, 100);
		// untouched
		expect(e.label.visible).toBe(true);
		expect(e.label.material.opacity).toBe(1);
	});
});
```

- [ ] **Step 2: Run test, watch it fail with "module not found"**

```bash
cd app && npm run test -- labelLod
```

Expected: FAIL — Cannot find module `$lib/desktop/graphCommon/labelLod.js`.

- [ ] **Step 3: Implement the helper**

Create `app/src/lib/desktop/graphCommon/labelLod.ts`:

```ts
/**
 * Distance-based label LOD for sprite labels in a 3d-force-graph scene.
 *
 * Distance d from camera to node:
 *   d ≤ base          → opacity 1
 *   base < d < 2·base → linear fade
 *   d ≥ 2·base        → hidden
 *
 * Hubs are NOT passed to this function — they're set `visible = true` once
 * at node-build time and never registered as a `LabelEntry`.
 */
export type LabelEntry = {
	node: { x?: number; y?: number; z?: number };
	label: {
		visible: boolean;
		material: { opacity: number; transparent: boolean };
	};
};

export function updateLabelOpacity(
	entries: LabelEntry[],
	camX: number,
	camY: number,
	camZ: number,
	baseDistance: number
): void {
	const baseSq = baseDistance * baseDistance;
	const fadeEndSq = 4 * baseSq; // (2 × base)²
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const n = entry.node;
		if (n.x === undefined) continue;
		const dx = camX - n.x;
		const dy = camY - (n.y ?? 0);
		const dz = camZ - (n.z ?? 0);
		const d2 = dx * dx + dy * dy + dz * dz;
		const mat = entry.label.material;
		if (d2 >= fadeEndSq) {
			if (entry.label.visible) entry.label.visible = false;
			continue;
		}
		if (!entry.label.visible) entry.label.visible = true;
		if (d2 <= baseSq) {
			if (mat.opacity !== 1) mat.opacity = 1;
		} else {
			const d = Math.sqrt(d2);
			mat.opacity = (2 * baseDistance - d) / baseDistance;
		}
	}
}
```

- [ ] **Step 4: Run test again, watch it pass**

```bash
cd app && npm run test -- labelLod
```

Expected: all 4 tests pass.

- [ ] **Step 5: Replace the inline implementation in the note graph**

In `app/src/routes/desktop/graph/+page.svelte`:

1. Remove the inline `type LabelEntry = { ... };` block (around lines 159-166).
2. Remove the inline `function updateLabelVisibility() { ... }` block (around lines 478-510).
3. Add at the top of `<script>` alongside other imports:
   ```ts
   import { updateLabelOpacity, type LabelEntry } from '$lib/desktop/graphCommon/labelLod.js';
   ```
4. Inside the RAF loop (around line 670), replace `updateLabelVisibility();` with:
   ```ts
   updateLabelOpacity(labelEntries, camera.position.x, camera.position.y, camera.position.z, labelBaseDistance);
   ```

- [ ] **Step 6: Type check**

```bash
cd app && npm run check
```

Expected: 0 errors.

- [ ] **Step 7: Manual verification (REQUIRED)**

Run dev server, open `/desktop/graph`, fly close to a non-hub note (label appears), fly away (label fades, then disappears). Tweak the "라벨 거리" input — the threshold updates live. Hub labels stay on at any distance.

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/desktop/graphCommon/labelLod.ts \
        app/tests/unit/desktop/graphCommon/labelLod.test.ts \
        app/src/routes/desktop/graph/+page.svelte
git commit -m "라벨 LOD를 graphCommon/labelLod로 추출 (코드 그래프와 공유)"
```

---

## Task 3: Extract selection pickers into `graphCommon/selectionPickers.ts`

**Goal:** Move `findCenterNode` (50px screen-space pick) and `findAimedNode` (frustum-nearest to aim point) out of the note graph route into a pure module that takes a `filter` option, replacing both inline implementations.

**Files:**
- Create: `app/src/lib/desktop/graphCommon/selectionPickers.ts`
- Create: `app/tests/unit/desktop/graphCommon/selectionPickers.test.ts`
- Modify: `app/src/routes/desktop/graph/+page.svelte` (lines ~404-443 findCenterNode, ~600-638 findAimedNode, call sites)

**Acceptance Criteria:**
- [ ] `findCenterNode(args)` and `findAimedNode(args)` exported, both accept an optional `filter: (n) => boolean`.
- [ ] Note graph route passes `filter: n => !n.isCategory` to both, restoring the existing "categories not selectable" behavior.
- [ ] Codegraph-future call sites can omit the option (default: pass-through filter).
- [ ] Unit tests cover: filter respected, empty nodes → null, `n.x === undefined` skipped, out-of-frustum nodes excluded by `findAimedNode`, 50px tie broken by screen-space distance in `findCenterNode`.
- [ ] Manual: aim and center-pick behavior on `/desktop/graph` unchanged; clicking a category node still does nothing.

**Verify:** `cd app && npm run check && npm run test -- selectionPickers` → all pass

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `app/tests/unit/desktop/graphCommon/selectionPickers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	findCenterNode,
	findAimedNode,
	type PickerNode
} from '$lib/desktop/graphCommon/selectionPickers.js';

function makeCamera(): THREE.PerspectiveCamera {
	const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 10000);
	cam.position.set(0, 0, 100);
	cam.lookAt(0, 0, 0);
	cam.updateMatrixWorld();
	return cam;
}

describe('findCenterNode', () => {
	it('returns null for empty node list', () => {
		expect(
			findCenterNode({ nodes: [], camera: makeCamera(), width: 800, height: 600 })
		).toBe(null);
	});

	it('skips nodes filtered out', () => {
		const cam = makeCamera();
		const nodes: PickerNode[] = [{ id: 'a', x: 0, y: 0, z: 0 }];
		const got = findCenterNode({
			nodes,
			camera: cam,
			width: 800,
			height: 600,
			filter: () => false
		});
		expect(got).toBe(null);
	});

	it('picks the node closest to the screen center within radius', () => {
		const cam = makeCamera();
		const nodes: PickerNode[] = [
			{ id: 'center', x: 0, y: 0, z: 0 }, // dead-on reticle
			{ id: 'far', x: 50, y: 50, z: 0 }
		];
		const got = findCenterNode({ nodes, camera: cam, width: 800, height: 600 });
		expect(got).toBe('center');
	});

	it('skips nodes with undefined x', () => {
		const cam = makeCamera();
		const nodes: PickerNode[] = [{ id: 'a', x: undefined, y: 0, z: 0 }];
		const got = findCenterNode({ nodes, camera: cam, width: 800, height: 600 });
		expect(got).toBe(null);
	});
});

describe('findAimedNode', () => {
	it('returns null for empty nodes', () => {
		expect(findAimedNode({ nodes: [], camera: makeCamera() })).toBe(null);
	});

	it('respects filter option', () => {
		const cam = makeCamera();
		const nodes: PickerNode[] = [{ id: 'a', x: 0, y: 0, z: 0 }];
		expect(
			findAimedNode({ nodes, camera: cam, filter: () => false })
		).toBe(null);
	});

	it('excludes out-of-frustum nodes', () => {
		const cam = makeCamera();
		// Node behind the camera: camera at z=100 looking toward z=0,
		// node at z=200 is behind -> outside frustum.
		const nodes: PickerNode[] = [{ id: 'behind', x: 0, y: 0, z: 200 }];
		const got = findAimedNode({ nodes, camera: cam });
		expect(got).toBe(null);
	});
});
```

- [ ] **Step 2: Run tests, see them fail with "module not found"**

```bash
cd app && npm run test -- selectionPickers
```

Expected: module not found.

- [ ] **Step 3: Implement the module**

Create `app/src/lib/desktop/graphCommon/selectionPickers.ts`:

```ts
import * as THREE from 'three';

/**
 * Minimal node shape understood by the pickers. Real callers pass
 * full graph nodes; only x/y/z (graphify-mutated coords) and id are read.
 */
export type PickerNode = {
	id: string;
	x?: number;
	y?: number;
	z?: number;
};

const AIM_OFFSET = 40;
const CENTER_PICK_RADIUS_PX = 50;

// Module-scoped scratch — these helpers are called once per RAF tick from a
// single graph instance, so reusing the math objects avoids per-frame churn.
const tmpNdc = new THREE.Vector3();
const tmpForward = new THREE.Vector3();
const tmpFrustum = new THREE.Frustum();
const tmpProj = new THREE.Matrix4();
const tmpPoint = new THREE.Vector3();

export interface FindCenterArgs<N extends PickerNode = PickerNode> {
	nodes: N[];
	camera: THREE.Camera;
	width: number;
	height: number;
	filter?: (n: N) => boolean;
}

export function findCenterNode<N extends PickerNode>(
	args: FindCenterArgs<N>
): string | null {
	const { nodes, camera, width, height, filter } = args;
	camera.updateMatrixWorld();
	const halfW = width / 2;
	const halfH = height / 2;
	const threshSq = CENTER_PICK_RADIUS_PX * CENTER_PICK_RADIUS_PX;

	let bestId: string | null = null;
	let bestDistSq = Infinity;
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		if (filter && !filter(n)) continue;
		if (n.x === undefined) continue;
		tmpNdc.set(n.x, n.y ?? 0, n.z ?? 0);
		tmpNdc.project(camera);
		if (tmpNdc.z < -1 || tmpNdc.z > 1) continue;
		const px = tmpNdc.x * halfW;
		const py = tmpNdc.y * halfH;
		const dSq = px * px + py * py;
		if (dSq <= threshSq && dSq < bestDistSq) {
			bestDistSq = dSq;
			bestId = n.id;
		}
	}
	return bestId;
}

export interface FindAimedArgs<N extends PickerNode = PickerNode> {
	nodes: N[];
	camera: THREE.Camera;
	filter?: (n: N) => boolean;
}

export function findAimedNode<N extends PickerNode>(
	args: FindAimedArgs<N>
): string | null {
	const { nodes, camera, filter } = args;
	camera.updateMatrixWorld();
	tmpProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
	tmpFrustum.setFromProjectionMatrix(tmpProj);

	camera.getWorldDirection(tmpForward);
	const ax = camera.position.x + tmpForward.x * AIM_OFFSET;
	const ay = camera.position.y + tmpForward.y * AIM_OFFSET;
	const az = camera.position.z + tmpForward.z * AIM_OFFSET;

	let bestId: string | null = null;
	let bestD2 = Infinity;
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		if (filter && !filter(n)) continue;
		if (n.x === undefined) continue;
		tmpPoint.set(n.x, n.y ?? 0, n.z ?? 0);
		if (!tmpFrustum.containsPoint(tmpPoint)) continue;
		const dx = ax - tmpPoint.x;
		const dy = ay - tmpPoint.y;
		const dz = az - tmpPoint.z;
		const d2 = dx * dx + dy * dy + dz * dz;
		if (d2 < bestD2) {
			bestD2 = d2;
			bestId = n.id;
		}
	}
	return bestId;
}
```

- [ ] **Step 4: Run tests again, watch them pass**

```bash
cd app && npm run test -- selectionPickers
```

Expected: 7 tests passing.

- [ ] **Step 5: Replace inline call sites in the note graph**

In `app/src/routes/desktop/graph/+page.svelte`:

1. Remove inline `function findCenterNode(): string | null { ... }` (around lines 416-443) and `function findAimedNode(): string | null { ... }` (around lines 611-638).
2. Remove the now-unused module-local scratches: `ndcCenter`, `forwardVec`, `frustum`, `projMatrix`, `tmpPoint` (the new module owns its own scratches), and the `AIM_OFFSET`, `CENTER_PICK_RADIUS_PX` constants if they were declared locally.
3. Add to imports:
   ```ts
   import {
       findCenterNode,
       findAimedNode
   } from '$lib/desktop/graphCommon/selectionPickers.js';
   ```
4. Replace the call site in `handleCanvasClick`:
   ```ts
   const id = findCenterNode({
       nodes: liveNodes,
       camera,
       width: graph.width(),
       height: graph.height(),
       filter: (n) => !n.isCategory
   });
   ```
5. Replace the call site in `updateHoverHalo`:
   ```ts
   const id = findCenterNode({
       nodes: liveNodes,
       camera,
       width: graph.width(),
       height: graph.height(),
       filter: (n) => !n.isCategory
   });
   ```
6. Replace the call inside `updateNearest`:
   ```ts
   const bestId =
       selectionMode === 'center'
           ? findCenterNode({
                 nodes: liveNodes,
                 camera,
                 width: graph.width(),
                 height: graph.height(),
                 filter: (n) => !n.isCategory
             })
           : findAimedNode({
                 nodes: liveNodes,
                 camera,
                 filter: (n) => !n.isCategory
             });
   ```

- [ ] **Step 6: Type check**

```bash
cd app && npm run check
```

Expected: 0 errors.

- [ ] **Step 7: Manual verification (REQUIRED)**

On `/desktop/graph`:
1. Toggle "카테고리 표시" on. Fly toward a category cube — confirm it never auto-selects (no panel opens) and clicking it does nothing.
2. Aim/center selection still works on regular nodes; click flips to center mode; movement key flips back to aim mode.

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/desktop/graphCommon/selectionPickers.ts \
        app/tests/unit/desktop/graphCommon/selectionPickers.test.ts \
        app/src/routes/desktop/graph/+page.svelte
git commit -m "선택 피커(findCenterNode/findAimedNode)를 graphCommon으로 추출"
```

---

## Task 4: Extract halos and reticle into `graphCommon/`

**Goal:** Move halo `Mesh` builders and pulse helper into `haloFactory.ts`, and the centered reticle SVG markup into a shared `ReticleOverlay.svelte` component. Replace both in the note graph route.

**Files:**
- Create: `app/src/lib/desktop/graphCommon/haloFactory.ts`
- Create: `app/src/lib/desktop/graphCommon/ReticleOverlay.svelte`
- Modify: `app/src/routes/desktop/graph/+page.svelte` (halo creation around lines 357-383, reticle markup around lines 953-963 and reticle styles around lines 1248-1264)

**Acceptance Criteria:**
- [ ] `createSelectionHalo()` returns `{ mesh, dispose }` — cyan ring, opacity 0.55, renderOrder 999.
- [ ] `createHoverHalo()` returns `{ mesh, dispose }` — white ring, opacity 0.22, renderOrder 998.
- [ ] `applyPulse(halo, t01)` — multiplies the mesh `scale` by `1 + t01 * 0.45`. Caller is responsible for the time-curve.
- [ ] `<ReticleOverlay />` renders the same SVG cross/circle, `pointer-events: none`, `mix-blend-mode: screen`, centered.
- [ ] Note graph route uses both, no inline halo `Mesh` creation, no inline reticle SVG.
- [ ] Manual: halo color/size/pulse and reticle look identical to before.

**Verify:** `cd app && npm run check` → 0 errors

**Steps:**

- [ ] **Step 1: Implement `haloFactory.ts`**

Create `app/src/lib/desktop/graphCommon/haloFactory.ts`:

```ts
import * as THREE from 'three';

/**
 * Halo factory. Both halos are RingGeometry billboards that the caller
 * positions, scales, and orients each frame. Selection halo is brighter
 * (cyan, 0.55) and renders above hover halo (white, 0.22).
 */
export interface Halo {
	mesh: THREE.Mesh;
	dispose: () => void;
}

function buildHalo(
	color: number,
	opacity: number,
	segments: number,
	renderOrder: number
): Halo {
	const geometry = new THREE.RingGeometry(1, 1.08, segments);
	const material = new THREE.MeshBasicMaterial({
		color,
		side: THREE.DoubleSide,
		transparent: true,
		opacity,
		depthWrite: false
	});
	const mesh = new THREE.Mesh(geometry, material);
	mesh.visible = false;
	mesh.renderOrder = renderOrder;
	return {
		mesh,
		dispose: () => {
			geometry.dispose();
			material.dispose();
		}
	};
}

export function createSelectionHalo(): Halo {
	return buildHalo(0x5ad6ff, 0.55, 64, 999);
}

export function createHoverHalo(): Halo {
	return buildHalo(0xffffff, 0.22, 48, 998);
}

/**
 * Multiplicative scale-up for the selection halo. Caller passes a [0, 1]
 * value where 1 = peak pulse and 0 = no pulse. The mesh's scale is set
 * each call (assumed: caller has already set baseRadius via setScalar).
 *
 * Use as:
 *   const baseRadius = haloRadiusFor(node.size);
 *   halo.mesh.scale.setScalar(baseRadius * (1 + t01 * 0.45));
 *
 * `applyPulse` provides the canonical multiplier so callers don't drift.
 */
export function pulseScalar(t01: number): number {
	return 1 + t01 * 0.45;
}
```

- [ ] **Step 2: Implement `ReticleOverlay.svelte`**

Create `app/src/lib/desktop/graphCommon/ReticleOverlay.svelte`:

```svelte
<!--
  Centered reticle marking the aim point used by the FPS camera. Pure HUD —
  no pointer events, no JS state. Both `/desktop/graph` and `/desktop/codegraph`
  render this once at the top of the canvas overlay.
-->
<div class="hud" aria-hidden="true">
	<svg class="reticle" viewBox="-20 -20 40 40">
		<circle cx="0" cy="0" r="7" />
		<circle cx="0" cy="0" r="1.2" />
		<line x1="-16" y1="0" x2="-10" y2="0" />
		<line x1="10" y1="0" x2="16" y2="0" />
		<line x1="0" y1="-16" x2="0" y2="-10" />
		<line x1="0" y1="10" x2="0" y2="16" />
	</svg>
</div>

<style>
	.hud {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 15;
	}

	.reticle {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 40px;
		height: 40px;
		transform: translate(-50%, -50%);
		stroke: rgba(230, 237, 243, 0.55);
		stroke-width: 1.2;
		fill: none;
		mix-blend-mode: screen;
	}

	.reticle circle:nth-child(2) {
		fill: rgba(230, 237, 243, 0.75);
		stroke: none;
	}
</style>
```

- [ ] **Step 3: Replace inline halo creation in note graph**

In `app/src/routes/desktop/graph/+page.svelte`:

1. Add import:
   ```ts
   import { createSelectionHalo, createHoverHalo, pulseScalar } from '$lib/desktop/graphCommon/haloFactory.js';
   import ReticleOverlay from '$lib/desktop/graphCommon/ReticleOverlay.svelte';
   ```
2. Replace the inline `const halo = new THREE.Mesh(...)` block (lines ~357-369) with:
   ```ts
   const sel = createSelectionHalo();
   const halo = sel.mesh;
   graph.scene().add(halo);
   ```
3. Replace the inline `const hoverHalo = new THREE.Mesh(...)` block (lines ~371-383) with:
   ```ts
   const hov = createHoverHalo();
   const hoverHalo = hov.mesh;
   graph.scene().add(hoverHalo);
   ```
4. Inside `updateHalo`, replace the inline pulse formula with `pulseScalar`:
   ```ts
   let pulse = 1;
   if (t < pulseUntil) {
       const remaining = (pulseUntil - t) / PULSE_DURATION_MS; // 1 → 0
       pulse = pulseScalar(remaining);
   }
   halo.scale.setScalar(baseRadius * pulse);
   ```
5. In the cleanup return inside `init()`, replace the inline `halo.geometry.dispose()` / `halo.material.dispose()` / `hoverHalo.geometry.dispose()` / `hoverHalo.material.dispose()` calls with:
   ```ts
   sel.dispose();
   hov.dispose();
   ```

- [ ] **Step 4: Replace reticle markup**

In `app/src/routes/desktop/graph/+page.svelte`:
1. Replace the inline `<div class="hud" aria-hidden="true"> ... </div>` block (lines ~953-964) with `<ReticleOverlay />`.
2. Remove the now-unused `.hud`, `.reticle`, and `.reticle circle:nth-child(2)` rules from the route's `<style>` block (lines ~1240-1264).

- [ ] **Step 5: Type check**

```bash
cd app && npm run check
```

Expected: 0 errors.

- [ ] **Step 6: Manual verification (REQUIRED)**

On `/desktop/graph`:
1. Reticle appears centered, blends with bright clusters.
2. Selecting a note draws cyan halo, click pulses it briefly.
3. Hovering the reticle over another node draws translucent white halo.
4. Halos disappear cleanly when navigating away (no leaked geometry; check DevTools memory if uncertain).

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/desktop/graphCommon/haloFactory.ts \
        app/src/lib/desktop/graphCommon/ReticleOverlay.svelte \
        app/src/routes/desktop/graph/+page.svelte
git commit -m "헤일로/레티클을 graphCommon으로 추출 (코드 그래프와 공유)"
```

---

## Task 5: Codegraph types + `loadCodegraphData` loader

**Goal:** Define the discriminated `LoadResult` union and implement the fetch + degree/size computation pipeline. Out: data the codegraph page consumes.

**Blocked by:** Task 4 (the route depends on graphCommon being settled, but the loader itself is independent — listed here for plan-graph clarity; can technically run in parallel with Tasks 1-4).

**Files:**
- Create: `app/src/lib/codegraph/codegraphTypes.ts`
- Create: `app/src/lib/codegraph/loadCodegraphData.ts`
- Create: `app/tests/unit/codegraph/loadCodegraphData.test.ts`

**Acceptance Criteria:**
- [ ] All types from spec lines 153-191 exported from `codegraphTypes.ts`.
- [ ] `loadCodegraphData()` fetches `/codegraph.json`, `/codegraph-meta.json`, `/codegraph-communities.json` in parallel.
- [ ] Required: `codegraph.json` and `codegraph-meta.json`. 404 of either → `{ ok: false, reason: 'missing' }`.
- [ ] Optional: `codegraph-communities.json`. 404 → empty `communityLabels` map.
- [ ] Computes `degreeMap` (in+out, undirected), `maxDegree`, `size = 1 + log1p(deg)/log1p(maxDegree)` (or `1.0` if `maxDegree === 0`).
- [ ] Strips graphify-internal fields `_src`, `_tgt`, `weight`, `source_file`, `source_location` (latter two on links only — keep on nodes).
- [ ] Drops `hyperedges` entirely.
- [ ] Skips links missing `source` or `target` (continues loading).
- [ ] Coerces unknown `confidence` → `'INFERRED'`.
- [ ] Malformed JSON → `{ ok: false, reason: 'malformed', detail }`.
- [ ] Network failure → `{ ok: false, reason: 'network', detail }`.

**Verify:** `cd app && npm run check && npm run test -- loadCodegraphData` → all pass

**Steps:**

- [ ] **Step 1: Write the types file**

Create `app/src/lib/codegraph/codegraphTypes.ts`:

```ts
export interface CodegraphNode {
	id: string;
	title: string; // graphify "label"
	community: number;
	fileType: 'code' | 'document' | 'paper' | 'image';
	sourceFile: string;
	sourceLocation: string | null;
	degree: number;
	size: number; // 1..2 log-scaled
}

export interface CodegraphLink {
	source: string;
	target: string;
	relation: string;
	confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
	confidenceScore: number;
}

export interface CodegraphMeta {
	repoUrl: string;
	branch: string;
	syncedAt: string;
	nodeCount: number;
	linkCount: number;
}

export interface CodegraphData {
	nodes: CodegraphNode[];
	links: CodegraphLink[];
	meta: CodegraphMeta;
	/** "{community_id}" -> label. Missing → caller should fall back to `Community {id}`. */
	communityLabels: Record<string, string>;
}

export type LoadResult =
	| { ok: true; data: CodegraphData }
	| {
			ok: false;
			reason: 'missing' | 'malformed' | 'network';
			detail?: string;
	  };
```

- [ ] **Step 2: Write failing tests**

Create `app/tests/unit/codegraph/loadCodegraphData.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadCodegraphData } from '$lib/codegraph/loadCodegraphData.js';

function ok(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}
function notFound() {
	return new Response('not found', { status: 404 });
}

const MIN_GRAPH = {
	nodes: [
		{ id: 'a', label: 'A', community: 0, file_type: 'code', source_file: 'a.ts', source_location: 'L1' },
		{ id: 'b', label: 'B', community: 1, file_type: 'code', source_file: 'b.ts', source_location: null },
		{ id: 'c', label: 'C', community: 0, file_type: 'document', source_file: 'c.md', source_location: null }
	],
	links: [
		{ source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED', confidence_score: 1.0 },
		{ source: 'b', target: 'c', relation: 'references', confidence: 'INFERRED', confidence_score: 0.5 }
	],
	hyperedges: [{ id: 'hyper', members: ['a', 'b', 'c'] }]
};

const MIN_META = {
	repoUrl: 'https://github.com/x/y',
	branch: 'main',
	syncedAt: '2026-05-02T00:00:00Z',
	nodeCount: 3,
	linkCount: 2
};

describe('loadCodegraphData', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('returns ok with computed degree/size', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
			const u = String(url);
			if (u.endsWith('codegraph.json')) return Promise.resolve(ok(MIN_GRAPH));
			if (u.endsWith('codegraph-meta.json')) return Promise.resolve(ok(MIN_META));
			if (u.endsWith('codegraph-communities.json'))
				return Promise.resolve(ok({ '0': 'Group A', '1': 'Group B' }));
			return Promise.reject(new Error('unexpected'));
		});
		const res = await loadCodegraphData();
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.data.nodes).toHaveLength(3);
		// b has degree 2 (one in, one out); a and c each have degree 1
		const b = res.data.nodes.find((n) => n.id === 'b')!;
		expect(b.degree).toBe(2);
		// size = 1 + log1p(2)/log1p(2) = 2
		expect(b.size).toBeCloseTo(2, 5);
		const a = res.data.nodes.find((n) => n.id === 'a')!;
		// size = 1 + log1p(1)/log1p(2)
		expect(a.size).toBeCloseTo(1 + Math.log1p(1) / Math.log1p(2), 5);
		// hyperedges dropped
		expect((res.data as unknown as { hyperedges?: unknown }).hyperedges).toBeUndefined();
		expect(res.data.communityLabels['0']).toBe('Group A');
	});

	it('size = 1.0 fallback when maxDegree === 0', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
			const u = String(url);
			if (u.endsWith('codegraph.json'))
				return Promise.resolve(ok({ nodes: [{ id: 'lonely', label: 'X', community: 0, file_type: 'code', source_file: 'x.ts' }], links: [] }));
			if (u.endsWith('codegraph-meta.json')) return Promise.resolve(ok(MIN_META));
			if (u.endsWith('codegraph-communities.json')) return Promise.resolve(ok({}));
			return Promise.reject(new Error('unexpected'));
		});
		const res = await loadCodegraphData();
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.data.nodes[0].size).toBe(1);
	});

	it('returns missing when codegraph.json is 404', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
			const u = String(url);
			if (u.endsWith('codegraph.json')) return Promise.resolve(notFound());
			if (u.endsWith('codegraph-meta.json')) return Promise.resolve(ok(MIN_META));
			if (u.endsWith('codegraph-communities.json')) return Promise.resolve(ok({}));
			return Promise.reject(new Error('unexpected'));
		});
		const res = await loadCodegraphData();
		expect(res).toEqual({ ok: false, reason: 'missing', detail: expect.any(String) });
	});

	it('treats missing communities file as empty map', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
			const u = String(url);
			if (u.endsWith('codegraph.json')) return Promise.resolve(ok(MIN_GRAPH));
			if (u.endsWith('codegraph-meta.json')) return Promise.resolve(ok(MIN_META));
			if (u.endsWith('codegraph-communities.json')) return Promise.resolve(notFound());
			return Promise.reject(new Error('unexpected'));
		});
		const res = await loadCodegraphData();
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.data.communityLabels).toEqual({});
	});

	it('returns malformed when JSON parse fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
			const u = String(url);
			if (u.endsWith('codegraph.json'))
				return Promise.resolve(new Response('not json', { status: 200 }));
			if (u.endsWith('codegraph-meta.json')) return Promise.resolve(ok(MIN_META));
			if (u.endsWith('codegraph-communities.json')) return Promise.resolve(ok({}));
			return Promise.reject(new Error('unexpected'));
		});
		const res = await loadCodegraphData();
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe('malformed');
	});

	it('skips links with missing source/target', async () => {
		const broken = {
			...MIN_GRAPH,
			links: [
				{ source: 'a', target: '', relation: 'calls', confidence: 'EXTRACTED', confidence_score: 1 },
				{ source: '', target: 'b', relation: 'calls', confidence: 'EXTRACTED', confidence_score: 1 },
				{ source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED', confidence_score: 1 }
			]
		};
		vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
			const u = String(url);
			if (u.endsWith('codegraph.json')) return Promise.resolve(ok(broken));
			if (u.endsWith('codegraph-meta.json')) return Promise.resolve(ok(MIN_META));
			if (u.endsWith('codegraph-communities.json')) return Promise.resolve(ok({}));
			return Promise.reject(new Error('unexpected'));
		});
		const res = await loadCodegraphData();
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.data.links).toHaveLength(1);
	});

	it('coerces unknown confidence to INFERRED', async () => {
		const weird = {
			...MIN_GRAPH,
			links: [{ source: 'a', target: 'b', relation: 'calls', confidence: 'GIBBERISH', confidence_score: 0.4 }]
		};
		vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
			const u = String(url);
			if (u.endsWith('codegraph.json')) return Promise.resolve(ok(weird));
			if (u.endsWith('codegraph-meta.json')) return Promise.resolve(ok(MIN_META));
			if (u.endsWith('codegraph-communities.json')) return Promise.resolve(ok({}));
			return Promise.reject(new Error('unexpected'));
		});
		const res = await loadCodegraphData();
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.data.links[0].confidence).toBe('INFERRED');
	});

	it('returns network on fetch rejection', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
		const res = await loadCodegraphData();
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe('network');
	});
});
```

- [ ] **Step 3: Run tests, see them fail**

```bash
cd app && npm run test -- loadCodegraphData
```

Expected: module-not-found.

- [ ] **Step 4: Implement the loader**

Create `app/src/lib/codegraph/loadCodegraphData.ts`:

```ts
import type {
	CodegraphData,
	CodegraphLink,
	CodegraphNode,
	LoadResult
} from './codegraphTypes.js';

interface RawNode {
	id: string;
	label: string;
	community: number;
	file_type?: 'code' | 'document' | 'paper' | 'image';
	source_file?: string;
	source_location?: string | null;
	[k: string]: unknown;
}

interface RawLink {
	source: string;
	target: string;
	relation?: string;
	confidence?: string;
	confidence_score?: number;
	[k: string]: unknown;
}

interface RawGraph {
	nodes: RawNode[];
	links: RawLink[];
	hyperedges?: unknown[];
}

const VALID_CONFIDENCE = new Set(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);
const VALID_FILE_TYPE = new Set(['code', 'document', 'paper', 'image']);

async function fetchJson(url: string): Promise<{ status: number; data: unknown; raw: string }> {
	const r = await fetch(url);
	const raw = await r.text();
	if (r.status >= 400) {
		return { status: r.status, data: null, raw };
	}
	try {
		return { status: r.status, data: JSON.parse(raw), raw };
	} catch (err) {
		throw new Error(`malformed JSON from ${url}: ${(err as Error).message}`);
	}
}

export async function loadCodegraphData(): Promise<LoadResult> {
	let graphRes, metaRes, commRes;
	try {
		[graphRes, metaRes, commRes] = await Promise.all([
			fetchJson('/codegraph.json'),
			fetchJson('/codegraph-meta.json'),
			fetchJson('/codegraph-communities.json')
		]);
	} catch (err) {
		const msg = (err as Error).message;
		if (msg.startsWith('malformed JSON')) {
			return { ok: false, reason: 'malformed', detail: msg };
		}
		return { ok: false, reason: 'network', detail: msg };
	}

	if (graphRes.status === 404 || metaRes.status === 404) {
		return {
			ok: false,
			reason: 'missing',
			detail: 'codegraph.json or codegraph-meta.json not found in /static'
		};
	}

	const rawGraph = graphRes.data as RawGraph;
	const rawMeta = metaRes.data as CodegraphData['meta'];
	const rawComm = (commRes.status === 404 ? {} : commRes.data ?? {}) as Record<string, string>;

	// Build degree map: undirected, in+out.
	const degreeMap = new Map<string, number>();
	for (const l of rawGraph.links ?? []) {
		if (!l || !l.source || !l.target) continue;
		degreeMap.set(l.source, (degreeMap.get(l.source) ?? 0) + 1);
		degreeMap.set(l.target, (degreeMap.get(l.target) ?? 0) + 1);
	}
	let maxDegree = 0;
	for (const d of degreeMap.values()) if (d > maxDegree) maxDegree = d;
	const logMax = Math.log1p(maxDegree);

	const nodes: CodegraphNode[] = (rawGraph.nodes ?? []).map((n) => {
		const deg = degreeMap.get(n.id) ?? 0;
		const size = logMax === 0 ? 1 : 1 + Math.log1p(deg) / logMax;
		const fileType =
			n.file_type && VALID_FILE_TYPE.has(n.file_type) ? n.file_type : 'code';
		return {
			id: n.id,
			title: n.label ?? n.id,
			community: typeof n.community === 'number' ? n.community : 0,
			fileType,
			sourceFile: n.source_file ?? '',
			sourceLocation: n.source_location ?? null,
			degree: deg,
			size
		};
	});

	const links: CodegraphLink[] = [];
	for (const l of rawGraph.links ?? []) {
		if (!l || !l.source || !l.target) continue;
		const conf = l.confidence && VALID_CONFIDENCE.has(l.confidence)
			? (l.confidence as CodegraphLink['confidence'])
			: 'INFERRED';
		links.push({
			source: l.source,
			target: l.target,
			relation: l.relation ?? 'unknown',
			confidence: conf,
			confidenceScore: typeof l.confidence_score === 'number' ? l.confidence_score : 0.5
		});
	}

	const data: CodegraphData = {
		nodes,
		links,
		meta: rawMeta,
		communityLabels: rawComm
	};
	return { ok: true, data };
}
```

- [ ] **Step 5: Run tests again**

```bash
cd app && npm run test -- loadCodegraphData
```

Expected: all tests pass.

- [ ] **Step 6: Type check**

```bash
cd app && npm run check
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/codegraph/codegraphTypes.ts \
        app/src/lib/codegraph/loadCodegraphData.ts \
        app/tests/unit/codegraph/loadCodegraphData.test.ts
git commit -m "코드 그래프 데이터 로더 추가 (degree/size 계산, 손상 입력 방어)"
```

---

## Task 6: `nodeColor.ts` (golden-angle hue per community)

**Goal:** Pure helper that maps a community ID to an HSL color string.

**Files:**
- Create: `app/src/lib/codegraph/nodeColor.ts`
- Create: `app/tests/unit/codegraph/nodeColor.test.ts`

**Acceptance Criteria:**
- [ ] `nodeColor(community: number): string` returns `hsl((community * 137.5) % 360, 60%, 55%)`.
- [ ] Determinism: same input → same output (literally, by string equality).
- [ ] Communities 0 and 1 produce hues ≥ 30° apart (sanity check that the golden-angle spread works).

**Verify:** `cd app && npm run test -- nodeColor` → all pass

**Steps:**

- [ ] **Step 1: Write failing test**

Create `app/tests/unit/codegraph/nodeColor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { nodeColor } from '$lib/codegraph/nodeColor.js';

function hueOf(s: string): number {
	const m = s.match(/hsl\(([\d.]+)/);
	if (!m) throw new Error(`bad color: ${s}`);
	return parseFloat(m[1]);
}

describe('nodeColor', () => {
	it('is deterministic', () => {
		expect(nodeColor(7)).toBe(nodeColor(7));
	});
	it('uses 60% saturation, 55% lightness', () => {
		expect(nodeColor(0)).toMatch(/60%/);
		expect(nodeColor(0)).toMatch(/55%/);
	});
	it('hue spread between community 0 and 1 is ≥ 30°', () => {
		const h0 = hueOf(nodeColor(0));
		const h1 = hueOf(nodeColor(1));
		const diff = Math.abs(h1 - h0);
		const wrapped = Math.min(diff, 360 - diff);
		expect(wrapped).toBeGreaterThanOrEqual(30);
	});
});
```

- [ ] **Step 2: Implement**

Create `app/src/lib/codegraph/nodeColor.ts`:

```ts
const GOLDEN_ANGLE = 137.5;

/**
 * Map a community id to an HSL color. Golden-angle hue rotation gives
 * adjacent communities a consistent, perceptually-distinct spread without
 * clustering similar hues.
 */
export function nodeColor(community: number): string {
	const hue = (((community * GOLDEN_ANGLE) % 360) + 360) % 360;
	return `hsl(${hue.toFixed(2)}, 60%, 55%)`;
}
```

- [ ] **Step 3: Run tests, type-check**

```bash
cd app && npm run test -- nodeColor && npm run check
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/codegraph/nodeColor.ts \
        app/tests/unit/codegraph/nodeColor.test.ts
git commit -m "코드 그래프 노드 색상 (커뮤니티 황금각 색상환)"
```

---

## Task 7: `edgeStyle.ts` (relation-keyed RGBA + confidence alpha)

**Goal:** Pure helper that returns `{ r, g, b, a }` per (relation, confidence). Implements the table from spec lines 230-247.

**Files:**
- Create: `app/src/lib/codegraph/edgeStyle.ts`
- Create: `app/tests/unit/codegraph/edgeStyle.test.ts`

**Acceptance Criteria:**
- [ ] `edgeStyle(relation: string, confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'): { r, g, b, a }`.
- [ ] Per-relation base RGBA matches spec table exactly.
- [ ] Confidence multiplies alpha: EXTRACTED ×1.0, INFERRED ×0.55, AMBIGUOUS ×0.30.
- [ ] AMBIGUOUS additionally adds +20 R, -10 G, -10 B (warm shift).
- [ ] All channels clamped to `[0, 255]`.
- [ ] Unknown relation → gray fallback `(120, 120, 120)` with base alpha `0.30`.

**Verify:** `cd app && npm run test -- edgeStyle` → all pass

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `app/tests/unit/codegraph/edgeStyle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { edgeStyle } from '$lib/codegraph/edgeStyle.js';

describe('edgeStyle', () => {
	it('returns base RGBA for known relation', () => {
		const c = edgeStyle('calls', 'EXTRACTED');
		expect(c).toEqual({ r: 220, g: 220, b: 220, a: 0.65 });
	});
	it('INFERRED multiplies alpha by 0.55', () => {
		const c = edgeStyle('calls', 'INFERRED');
		expect(c.r).toBe(220);
		expect(c.a).toBeCloseTo(0.65 * 0.55, 5);
	});
	it('AMBIGUOUS reduces alpha and warms color', () => {
		const c = edgeStyle('calls', 'AMBIGUOUS');
		expect(c.r).toBe(220 + 20);
		expect(c.g).toBe(220 - 10);
		expect(c.b).toBe(220 - 10);
		expect(c.a).toBeCloseTo(0.65 * 0.30, 5);
	});
	it('AMBIGUOUS alpha is strictly less than EXTRACTED alpha for same relation', () => {
		const ext = edgeStyle('references', 'EXTRACTED');
		const amb = edgeStyle('references', 'AMBIGUOUS');
		expect(amb.a).toBeLessThan(ext.a);
	});
	it('unknown relation falls back to gray', () => {
		const c = edgeStyle('uknown_relation_xyz', 'EXTRACTED');
		expect(c).toEqual({ r: 120, g: 120, b: 120, a: 0.30 });
	});
	it('clamps channels to [0, 255]', () => {
		const c = edgeStyle('contains', 'AMBIGUOUS'); // 120 + 20, 120 - 10, 120 - 10
		expect(c.r).toBeLessThanOrEqual(255);
		expect(c.g).toBeGreaterThanOrEqual(0);
		expect(c.b).toBeGreaterThanOrEqual(0);
	});
});
```

- [ ] **Step 2: Implement**

Create `app/src/lib/codegraph/edgeStyle.ts`:

```ts
type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
type Rgba = { r: number; g: number; b: number; a: number };

const BASE: Record<string, Rgba> = {
	contains:                 { r: 120, g: 120, b: 120, a: 0.35 },
	calls:                    { r: 220, g: 220, b: 220, a: 0.65 },
	references:               { r: 120, g: 200, b: 200, a: 0.55 },
	cites:                    { r: 220, g: 190, b: 130, a: 0.55 },
	semantically_similar_to:  { r: 220, g: 150, b: 220, a: 0.45 },
	conceptually_related_to:  { r: 180, g: 180, b: 180, a: 0.40 },
	shares_data_with:         { r: 180, g: 180, b: 180, a: 0.40 },
	rationale_for:            { r: 180, g: 180, b: 180, a: 0.40 },
	implements:               { r: 180, g: 180, b: 180, a: 0.40 }
};
const FALLBACK: Rgba = { r: 120, g: 120, b: 120, a: 0.30 };

const ALPHA_MUL: Record<Confidence, number> = {
	EXTRACTED: 1.0,
	INFERRED: 0.55,
	AMBIGUOUS: 0.30
};

function clamp(v: number): number {
	return v < 0 ? 0 : v > 255 ? 255 : v;
}

export function edgeStyle(relation: string, confidence: Confidence): Rgba {
	const base = BASE[relation] ?? FALLBACK;
	let r = base.r;
	let g = base.g;
	let b = base.b;
	if (confidence === 'AMBIGUOUS') {
		r = clamp(r + 20);
		g = clamp(g - 10);
		b = clamp(b - 10);
	}
	const a = base.a * ALPHA_MUL[confidence];
	return { r, g, b, a };
}
```

- [ ] **Step 3: Run tests, type-check**

```bash
cd app && npm run test -- edgeStyle && npm run check
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/codegraph/edgeStyle.ts \
        app/tests/unit/codegraph/edgeStyle.test.ts
git commit -m "코드 그래프 엣지 스타일 (relation × confidence → RGBA)"
```

---

## Task 8: `githubLink.ts` (build blob URL with line hash)

**Goal:** Compose `<repoUrl>/blob/<branch>/<path>#L<line>` from a meta + sourceFile + sourceLocation.

**Files:**
- Create: `app/src/lib/codegraph/githubLink.ts`
- Create: `app/tests/unit/codegraph/githubLink.test.ts`

**Acceptance Criteria:**
- [ ] `githubLink(meta, sourceFile, sourceLocation): string | null` — null when `sourceFile` is empty/missing.
- [ ] Strips trailing `.git` from repo URL.
- [ ] Converts `git@github.com:owner/repo` SSH form to `https://github.com/owner/repo`.
- [ ] `sourceLocation = 'L15'` → URL ends with `#L15`. `sourceLocation = null` → no `#L`.
- [ ] Trims any leading `app/` from `sourceFile` if `meta.repoUrl` already implies the project root (we leave the path verbatim per spec — that detail is NOT done; just pass `sourceFile` through).

**Verify:** `cd app && npm run test -- githubLink` → all pass

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `app/tests/unit/codegraph/githubLink.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { githubLink, normalizeRepoUrl } from '$lib/codegraph/githubLink.js';

const META = (repoUrl: string) => ({
	repoUrl,
	branch: 'main',
	syncedAt: '2026-05-02',
	nodeCount: 0,
	linkCount: 0
});

describe('normalizeRepoUrl', () => {
	it('strips .git from https URL', () => {
		expect(normalizeRepoUrl('https://github.com/owner/repo.git')).toBe('https://github.com/owner/repo');
	});
	it('converts SSH form', () => {
		expect(normalizeRepoUrl('git@github.com:owner/repo.git')).toBe('https://github.com/owner/repo');
	});
	it('passes already-clean https URL through', () => {
		expect(normalizeRepoUrl('https://github.com/owner/repo')).toBe('https://github.com/owner/repo');
	});
});

describe('githubLink', () => {
	it('returns null when sourceFile missing', () => {
		expect(githubLink(META('https://github.com/x/y'), '', 'L1')).toBeNull();
	});
	it('builds URL with line hash', () => {
		const url = githubLink(META('https://github.com/owner/repo'), 'app/src/lib/foo.ts', 'L15');
		expect(url).toBe('https://github.com/owner/repo/blob/main/app/src/lib/foo.ts#L15');
	});
	it('omits hash when sourceLocation is null', () => {
		const url = githubLink(META('https://github.com/owner/repo'), 'app/src/lib/foo.ts', null);
		expect(url).toBe('https://github.com/owner/repo/blob/main/app/src/lib/foo.ts');
	});
});
```

- [ ] **Step 2: Implement**

Create `app/src/lib/codegraph/githubLink.ts`:

```ts
import type { CodegraphMeta } from './codegraphTypes.js';

/**
 * Normalize a remote.origin.url to https://github.com/<owner>/<repo>.
 * Handles both SSH (git@github.com:owner/repo[.git]) and HTTPS forms.
 * Returns the input unchanged if it's not recognizably GitHub — codegraph
 * still renders, GitHub jump silently no-ops.
 */
export function normalizeRepoUrl(raw: string): string {
	let url = (raw ?? '').trim();
	const sshMatch = url.match(/^git@github\.com:([^/]+)\/(.+?)(\.git)?$/i);
	if (sshMatch) {
		url = `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
	} else if (url.endsWith('.git')) {
		url = url.slice(0, -4);
	}
	return url;
}

export function githubLink(
	meta: CodegraphMeta,
	sourceFile: string,
	sourceLocation: string | null
): string | null {
	if (!sourceFile || !sourceFile.trim()) return null;
	const base = normalizeRepoUrl(meta.repoUrl);
	const branch = meta.branch || 'main';
	const path = sourceFile.replace(/^\/+/, '');
	let url = `${base}/blob/${branch}/${path}`;
	if (sourceLocation) {
		const hash = sourceLocation.startsWith('#') ? sourceLocation.slice(1) : sourceLocation;
		url += `#${hash}`;
	}
	return url;
}
```

- [ ] **Step 3: Run tests, type-check**

```bash
cd app && npm run test -- githubLink && npm run check
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/codegraph/githubLink.ts \
        app/tests/unit/codegraph/githubLink.test.ts
git commit -m "코드 그래프 GitHub 점프 URL 빌더"
```

---

## Task 9: `sync-codegraph.mjs` script + npm entry + .gitignore

**Goal:** Dev-only Node script that copies graphify output into `static/`, derives the repo URL + branch + meta + community labels, and emits three JSON files.

**Files:**
- Create: `app/scripts/sync-codegraph.mjs`
- Create: `app/tests/unit/scripts/sync-codegraph.test.ts` (tests for `parseCommunityLabels`, `normalizeRepoUrl` exported as helpers from the script)
- Modify: `app/package.json` (add `"codegraph:sync"` script under `"scripts"`)
- Modify: `.gitignore` at repo root (append the 3 patterns from spec line 144-149)

**Acceptance Criteria:**
- [ ] `npm run codegraph:sync` from inside `app/` succeeds when `../graphify-out/graph.json` exists.
- [ ] Friendly error and non-zero exit when `graphify-out/graph.json` missing: message starts with "graphify가 아직 실행되지 않았습니다 — '/graphify app/src'를 먼저 돌려주세요".
- [ ] Writes `static/codegraph.json` (verbatim copy), `static/codegraph-meta.json`, `static/codegraph-communities.json`.
- [ ] `static/codegraph-meta.json` fields: `repoUrl`, `branch`, `syncedAt` (ISO 8601), `nodeCount`, `linkCount`.
- [ ] `repoUrl` normalized identically to Task 8's `normalizeRepoUrl` (test: SSH form `git@github.com:owner/repo.git` → `https://github.com/owner/repo`).
- [ ] Detached HEAD → `branch = 'main'`.
- [ ] Community labels parsed from `graphify-out/GRAPH_REPORT.md`. **NOTE: spec says regex `^### Community (\d+): (.+)$` (colon) but the actual file uses `^### Community (\d+) - "(.+)"$` (dash + quotes). Implement the dash form, strip outer quotes if present, and add a comment pointing the reader at the "Plan-time clarifications needed" section above.**
- [ ] `.gitignore` (repo root) gains the 3 patterns from spec line 144-149.
- [ ] `package.json` `"scripts"` block gains `"codegraph:sync": "node scripts/sync-codegraph.mjs"`.
- [ ] Unit test for `normalizeRepoUrl` (SSH + HTTPS) and `parseCommunityLabels` against a fixture string.

**Verify:** `cd app && npm run test -- sync-codegraph && npm run codegraph:sync` (the latter only after a real graphify run) → success

**Steps:**

- [ ] **Step 1: Write the failing helpers test first**

Create `app/tests/unit/scripts/sync-codegraph.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	normalizeRepoUrl,
	parseCommunityLabels
} from '../../../scripts/sync-codegraph.mjs';

describe('normalizeRepoUrl (sync-codegraph)', () => {
	it('strips .git', () => {
		expect(normalizeRepoUrl('https://github.com/x/y.git')).toBe('https://github.com/x/y');
	});
	it('converts SSH', () => {
		expect(normalizeRepoUrl('git@github.com:x/y.git')).toBe('https://github.com/x/y');
	});
});

describe('parseCommunityLabels', () => {
	// NOTE: Spec says ^### Community (\d+): (.+)$ but actual GRAPH_REPORT.md
	// uses dash + quoted label. We pin both forms to avoid silent regression
	// if graphify ever changes its formatter.
	it('parses dash-with-quotes form (current graphify)', () => {
		const md = [
			'# Report',
			'',
			'## Communities',
			'### Community 0 - "Home Note & Misc Utils"',
			'### Community 1 - "Schedule Note & Dropbox Config"'
		].join('\n');
		expect(parseCommunityLabels(md)).toEqual({
			'0': 'Home Note & Misc Utils',
			'1': 'Schedule Note & Dropbox Config'
		});
	});

	it('parses colon-without-quotes form (spec form)', () => {
		const md = '### Community 11: Note List & Generic Helpers';
		expect(parseCommunityLabels(md)).toEqual({
			'11': 'Note List & Generic Helpers'
		});
	});

	it('returns empty object when no headers match', () => {
		expect(parseCommunityLabels('# nothing here')).toEqual({});
	});
});
```

- [ ] **Step 2: Run test, see it fail**

```bash
cd app && npm run test -- sync-codegraph
```

Expected: module not found.

- [ ] **Step 3: Implement the script**

Create `app/scripts/sync-codegraph.mjs`:

```js
#!/usr/bin/env node
// app/scripts/sync-codegraph.mjs
//
// Dev-only: copies the output of `/graphify app/src` into app/static/ as three
// JSON files consumed by /desktop/codegraph. Run from inside app/:
//
//   npm run codegraph:sync
//
// This is gitignored on purpose (see .gitignore at repo root). The route at
// /desktop/codegraph degrades gracefully when the files are absent.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..');
const GRAPHIFY_OUT = path.join(REPO_ROOT, 'graphify-out');
const GRAPH_JSON = path.join(GRAPHIFY_OUT, 'graph.json');
const REPORT_MD = path.join(GRAPHIFY_OUT, 'GRAPH_REPORT.md');
const STATIC_DIR = path.join(APP_DIR, 'static');

export function normalizeRepoUrl(raw) {
	let url = (raw ?? '').trim();
	const sshMatch = url.match(/^git@github\.com:([^/]+)\/(.+?)(\.git)?$/i);
	if (sshMatch) {
		url = `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
	} else if (url.endsWith('.git')) {
		url = url.slice(0, -4);
	}
	return url;
}

// Community section headers in GRAPH_REPORT.md. The spec specified
// `^### Community (\d+): (.+)$` but the live file uses dash + quoted form
// (`### Community 0 - "Home Note & Misc Utils"`). We accept both. See
// docs/superpowers/plans/2026-05-02-codegraph-plan.md "Plan-time clarifications
// needed" for the discrepancy.
export function parseCommunityLabels(md) {
	const out = {};
	const reDash = /^### Community (\d+)\s*-\s*"([^"]+)"\s*$/gm;
	const reColon = /^### Community (\d+):\s*(.+?)\s*$/gm;
	let m;
	while ((m = reDash.exec(md)) !== null) out[m[1]] = m[2];
	while ((m = reColon.exec(md)) !== null) {
		if (!(m[1] in out)) out[m[1]] = m[2].replace(/^"|"$/g, '');
	}
	return out;
}

async function main() {
	// 1) Refuse early if graphify hasn't run.
	try {
		await fs.access(GRAPH_JSON);
	} catch {
		console.error("graphify가 아직 실행되지 않았습니다 — '/graphify app/src'를 먼저 돌려주세요");
		process.exit(1);
	}

	// 2) Copy graph.json verbatim.
	await fs.mkdir(STATIC_DIR, { recursive: true });
	const graphRaw = await fs.readFile(GRAPH_JSON, 'utf8');
	const graph = JSON.parse(graphRaw);
	await fs.writeFile(path.join(STATIC_DIR, 'codegraph.json'), graphRaw);

	// 3) Derive repo URL and branch.
	let originRaw = '';
	try {
		originRaw = execSync('git config --get remote.origin.url', { cwd: REPO_ROOT }).toString().trim();
	} catch {
		originRaw = '';
	}
	const repoUrl = normalizeRepoUrl(originRaw);
	let branch = 'main';
	try {
		const cur = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT }).toString().trim();
		if (cur && cur !== 'HEAD') branch = cur;
	} catch {
		// detached / no git — keep default.
	}

	// 4) Community labels (best-effort).
	let communityLabels = {};
	try {
		const md = await fs.readFile(REPORT_MD, 'utf8');
		communityLabels = parseCommunityLabels(md);
	} catch {
		// no report — empty map; UI falls back to "Community {id}".
	}
	await fs.writeFile(
		path.join(STATIC_DIR, 'codegraph-communities.json'),
		JSON.stringify(communityLabels, null, 2)
	);

	// 5) Meta.
	const meta = {
		repoUrl,
		branch,
		syncedAt: new Date().toISOString(),
		nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
		linkCount: Array.isArray(graph.links) ? graph.links.length : 0
	};
	await fs.writeFile(
		path.join(STATIC_DIR, 'codegraph-meta.json'),
		JSON.stringify(meta, null, 2)
	);

	console.log(
		`synced: ${meta.nodeCount} nodes / ${meta.linkCount} links · branch=${branch} · ${meta.syncedAt}`
	);
}

// Only run main() when invoked directly, so the test file can import the
// helpers without triggering the script body.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
```

- [ ] **Step 4: Add the npm script**

In `app/package.json`, add `"codegraph:sync"` under `"scripts"` so the block reads:

```json
"scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "prepare": "svelte-kit sync || echo ''",
    "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
    "check:watch": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "codegraph:sync": "node scripts/sync-codegraph.mjs"
},
```

- [ ] **Step 5: Append three patterns to repo-root `.gitignore`**

Append to `/var/home/umayloveme/workspace/tomboy-web/.gitignore`:

```
# Codegraph: dev-only graphify output, regenerated via `npm run codegraph:sync`
app/static/codegraph.json
app/static/codegraph-meta.json
app/static/codegraph-communities.json
```

- [ ] **Step 6: Run tests**

```bash
cd app && npm run test -- sync-codegraph
```

Expected: all 4 tests pass.

- [ ] **Step 7: Smoke-test the script end-to-end**

```bash
cd app && npm run codegraph:sync
ls -la static/codegraph*.json
cat static/codegraph-meta.json
```

Expected: 3 files written; meta has `repoUrl: https://github.com/darkavengerk/tomboy-web`, `branch: main`, current ISO time, and matching nodeCount/linkCount.

- [ ] **Step 8: Confirm gitignore actually hides the new files**

```bash
git status --porcelain | grep -E 'codegraph(-meta|-communities)?\.json' || echo "ignored — good"
```

Expected: `ignored — good`.

- [ ] **Step 9: Commit (script + test + package.json + .gitignore)**

```bash
git add app/scripts/sync-codegraph.mjs \
        app/tests/unit/scripts/sync-codegraph.test.ts \
        app/package.json \
        .gitignore
git commit -m "코드 그래프 동기화 스크립트 추가 (graphify 출력을 static으로 복사)"
```

---

## Task 10: `CodeNodePanel.svelte` (right-side detail panel)

**Goal:** Implement the 420×60vh panel from spec lines 270-286. Pure presentation: receives selected node + neighbors + meta as props; emits `onneighborclick`, `onclose`.

**Files:**
- Create: `app/src/lib/desktop/components/CodeNodePanel.svelte`

**Acceptance Criteria:**
- [ ] Fixed positioning: `width: 420px; height: 60vh; bottom: 24px; right: 24px`.
- [ ] Header: title (large), `sourceFile · sourceLocation` (gray), community chip (color = `nodeColor(community)`, text = `community {id} ({label || 'Community {id}'})`), degree/file-type chip, GitHub button (disabled when no link), close button.
- [ ] Body: outbound neighbors first (`→ {relation}`), then inbound (`← called by` etc.), each section grouped + sorted EXTRACTED → INFERRED → AMBIGUOUS → label A→Z.
- [ ] Each item: arrow, neighbor title, `sourceFile · sourceLocation`, confidence dot+label (green/yellow/red).
- [ ] Click neighbor → `onneighborclick(neighborId)`.
- [ ] Click GitHub → `window.open(githubLink(...), '_blank')`. Disabled if `sourceFile` is empty.
- [ ] Click × → `onclose()`.
- [ ] All UI strings in Korean.

**Verify:** `cd app && npm run check` → 0 errors

**Steps:**

- [ ] **Step 1: Define the props interface and write the component**

Create `app/src/lib/desktop/components/CodeNodePanel.svelte`:

```svelte
<script lang="ts">
	import type { CodegraphNode, CodegraphLink, CodegraphMeta } from '$lib/codegraph/codegraphTypes.js';
	import { nodeColor } from '$lib/codegraph/nodeColor.js';
	import { githubLink } from '$lib/codegraph/githubLink.js';

	interface Neighbor {
		node: CodegraphNode;
		link: CodegraphLink;
		direction: 'out' | 'in'; // out: source === selected, in: target === selected
	}

	interface Props {
		node: CodegraphNode;
		neighbors: Neighbor[];
		meta: CodegraphMeta;
		communityLabels: Record<string, string>;
		onneighborclick: (id: string) => void;
		onclose: () => void;
	}

	let { node, neighbors, meta, communityLabels, onneighborclick, onclose }: Props = $props();

	const ghUrl = $derived(githubLink(meta, node.sourceFile, node.sourceLocation));

	const communityLabel = $derived(
		communityLabels[String(node.community)] ?? `Community ${node.community}`
	);
	const communityChipColor = $derived(nodeColor(node.community));

	// Confidence ordering for sort within a relation group.
	const CONF_ORDER: Record<CodegraphLink['confidence'], number> = {
		EXTRACTED: 0,
		INFERRED: 1,
		AMBIGUOUS: 2
	};

	type Group = { relation: string; items: Neighbor[] };

	function groupAndSort(direction: 'out' | 'in'): Group[] {
		const subset = neighbors.filter((n) => n.direction === direction);
		const map = new Map<string, Neighbor[]>();
		for (const n of subset) {
			const arr = map.get(n.link.relation) ?? [];
			arr.push(n);
			map.set(n.link.relation, arr);
		}
		const groups: Group[] = [];
		for (const [rel, items] of map) {
			items.sort((a, b) => {
				const c = CONF_ORDER[a.link.confidence] - CONF_ORDER[b.link.confidence];
				if (c !== 0) return c;
				return a.node.title.localeCompare(b.node.title);
			});
			groups.push({ relation: rel, items });
		}
		groups.sort((a, b) => a.relation.localeCompare(b.relation));
		return groups;
	}

	const outboundGroups = $derived(groupAndSort('out'));
	const inboundGroups = $derived(groupAndSort('in'));

	function confDotClass(c: CodegraphLink['confidence']): string {
		return c === 'EXTRACTED' ? 'green' : c === 'INFERRED' ? 'yellow' : 'red';
	}
	function confLabel(c: CodegraphLink['confidence']): string {
		return c === 'EXTRACTED' ? '확정' : c === 'INFERRED' ? '추정' : '모호';
	}
</script>

<aside class="code-panel" aria-label="코드 노드 상세">
	<header>
		<div class="title">{node.title}</div>
		<div class="loc">
			{node.sourceFile}{node.sourceLocation ? ` · ${node.sourceLocation}` : ''}
		</div>
		<div class="chips">
			<span class="chip community" style="background: {communityChipColor};">
				community {node.community} ({communityLabel})
			</span>
			<span class="chip muted">degree {node.degree} · {node.fileType}</span>
		</div>
		<div class="actions">
			<button
				type="button"
				class="gh"
				disabled={!ghUrl}
				onclick={() => ghUrl && window.open(ghUrl, '_blank', 'noopener')}
				title="GitHub에서 열기"
			>↗ GitHub</button>
			<button
				type="button"
				class="close"
				onclick={onclose}
				aria-label="닫기"
			>×</button>
		</div>
	</header>

	<div class="body">
		{#if outboundGroups.length > 0}
			<section>
				<h2>나가는 링크</h2>
				{#each outboundGroups as g (g.relation)}
					<div class="group">
						<div class="group-head">→ {g.relation} ({g.items.length})</div>
						<ul>
							{#each g.items as n (n.node.id)}
								<li>
									<button type="button" onclick={() => onneighborclick(n.node.id)}>
										<span class="arrow">→</span>
										<span class="n-title">{n.node.title}</span>
										<span class="n-loc">
											{n.node.sourceFile}{n.node.sourceLocation ? ` · ${n.node.sourceLocation}` : ''}
										</span>
										<span class="conf">
											<span class="dot {confDotClass(n.link.confidence)}"></span>
											{confLabel(n.link.confidence)}
										</span>
									</button>
								</li>
							{/each}
						</ul>
					</div>
				{/each}
			</section>
		{/if}

		{#if inboundGroups.length > 0}
			<section>
				<h2>들어오는 링크</h2>
				{#each inboundGroups as g (g.relation)}
					<div class="group">
						<div class="group-head">← {g.relation} ({g.items.length})</div>
						<ul>
							{#each g.items as n (n.node.id)}
								<li>
									<button type="button" onclick={() => onneighborclick(n.node.id)}>
										<span class="arrow">←</span>
										<span class="n-title">{n.node.title}</span>
										<span class="n-loc">
											{n.node.sourceFile}{n.node.sourceLocation ? ` · ${n.node.sourceLocation}` : ''}
										</span>
										<span class="conf">
											<span class="dot {confDotClass(n.link.confidence)}"></span>
											{confLabel(n.link.confidence)}
										</span>
									</button>
								</li>
							{/each}
						</ul>
					</div>
				{/each}
			</section>
		{/if}

		{#if outboundGroups.length === 0 && inboundGroups.length === 0}
			<div class="empty">연결된 노드가 없습니다.</div>
		{/if}
	</div>
</aside>

<style>
	.code-panel {
		position: fixed;
		bottom: 24px;
		right: 24px;
		width: 420px;
		height: 60vh;
		max-height: calc(100vh - 48px);
		display: flex;
		flex-direction: column;
		background: rgba(20, 24, 34, 0.92);
		border: 1px solid #2a3040;
		border-radius: 6px;
		color: #e6edf3;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
		z-index: 10;
		overflow: hidden;
	}

	header {
		flex-shrink: 0;
		padding: 12px 14px;
		border-bottom: 1px solid #2a3040;
		display: flex;
		flex-direction: column;
		gap: 6px;
		position: relative;
	}

	header .title {
		font-size: 1rem;
		font-weight: 600;
		word-break: break-word;
	}

	header .loc {
		font-size: 0.75rem;
		color: #8a94a6;
		word-break: break-word;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.chip {
		font-size: 0.7rem;
		padding: 2px 6px;
		border-radius: 3px;
		color: #08101a;
		font-weight: 500;
	}

	.chip.muted {
		background: #2a3040;
		color: #cfd8e3;
		font-weight: 400;
	}

	.actions {
		display: flex;
		gap: 6px;
		justify-content: flex-end;
	}

	.gh {
		padding: 4px 10px;
		border-radius: 4px;
		border: 1px solid #3a5a7a;
		background: #1f2a3a;
		color: #cfd8e8;
		cursor: pointer;
		font-size: 0.78rem;
	}
	.gh:hover:not(:disabled) {
		background: #2d3d50;
	}
	.gh:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.close {
		padding: 0 8px;
		border-radius: 4px;
		border: 1px solid #2a3040;
		background: transparent;
		color: #8a94a6;
		cursor: pointer;
		font-size: 1.1rem;
		line-height: 1;
	}
	.close:hover {
		color: #fff;
	}

	.body {
		flex: 1;
		overflow-y: auto;
		padding: 8px 4px 14px;
	}

	section {
		padding: 6px 10px;
	}

	section h2 {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #8a94a6;
		margin: 4px 0 6px;
	}

	.group-head {
		font-size: 0.78rem;
		color: #cfd8e3;
		margin: 6px 0 2px;
	}

	ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	li button {
		display: grid;
		grid-template-columns: 14px 1fr auto;
		grid-template-rows: auto auto;
		column-gap: 6px;
		row-gap: 1px;
		align-items: baseline;
		width: 100%;
		text-align: left;
		padding: 4px 6px;
		border: none;
		background: transparent;
		color: inherit;
		cursor: pointer;
		border-radius: 3px;
	}
	li button:hover {
		background: rgba(90, 153, 255, 0.1);
	}

	.arrow {
		grid-row: 1;
		color: #8a94a6;
	}
	.n-title {
		grid-row: 1;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.conf {
		grid-row: 1;
		font-size: 0.72rem;
		color: #cfd8e3;
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.n-loc {
		grid-column: 2 / span 2;
		grid-row: 2;
		font-size: 0.7rem;
		color: #8a94a6;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}
	.dot.green { background: #5ab378; }
	.dot.yellow { background: #d8b04a; }
	.dot.red { background: #c8624a; }

	.empty {
		padding: 24px 12px;
		text-align: center;
		color: #8a94a6;
		font-size: 0.85rem;
	}
</style>
```

- [ ] **Step 2: Type-check**

```bash
cd app && npm run check
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/desktop/components/CodeNodePanel.svelte
git commit -m "코드 노드 상세 패널 컴포넌트 추가"
```

---

## Task 11: `/desktop/codegraph/+page.svelte` (the route)

**Goal:** Wire the data loader, the shared graphCommon modules, and CodeNodePanel into a working desktop-only 3D viewer with the state machine and error UI from the spec.

**Blocked by:** Tasks 1-10.

**Files:**
- Create: `app/src/routes/desktop/codegraph/+page.svelte`

**Acceptance Criteria:**
- [ ] On mount: `loadCodegraphData()` runs; loading shows `"그래프 로딩 중…"`; failure shows the spec's error cards (`'missing'` shows the install command card, `'malformed'`, `'network'` show their own messages); `nodes.length === 0` shows empty card.
- [ ] On success: builds a 3d-force-graph with `controlType: 'orbit'`, navigation controls disabled, camera switched to `FpsControls`.
- [ ] Nodes: `SphereGeometry(3 * size, 24, 16)`, `MeshLambertMaterial(color: nodeColor(community), opacity: 0.9)`. Labels: `SpriteText` like the note graph, hubs (size ≥ 1.6) always visible, others fade via `updateLabelOpacity(...)`.
- [ ] Edges: 3d-force-graph's `linkColor` callback wraps `edgeStyle(link.relation, link.confidence)` into `rgba(...)`. `linkWidth(0.3)`. `linkDirectionalArrowLength(0)`.
- [ ] Selective links via inline RAF tick (same pattern as note graph), gated on hub/selected/centered endpoints; toggled by "링크 표시" checkbox.
- [ ] Halo + hover halo + reticle from graphCommon.
- [ ] Selection state machine matches spec lines 290-306: aim mode default, click flips to center+pulse, movement key flips back to aim, neighbor click flies camera + flips to aim, panel × halts auto-select, "자동 선택 다시 켜기" chip restores it.
- [ ] Top bar: 라벨 거리 (default 400, step 50, min 50), 노드 간격 (default 500, step 5, min 5, charge `-value`), 이동 속도 (default 60, step 20, min 20), 링크 표시 checkbox (default on), `synced ...` read-only line. NO "카테고리 표시" checkbox.
- [ ] CodeNodePanel renders when `selectedId !== null` and `panelOpen === true`. Panel × halts auto-select (chip appears). Neighbor click fires camera fly + selectMode='aim'.
- [ ] `onDestroy`: cancelAnimationFrame, fps.dispose(), halo dispose calls, scene/renderer disposal via `graph._destructor?.()`, removeEventListener for wheel + resize.
- [ ] WebGL init failure → friendly card.

**Verify:** `cd app && npm run check && npm run dev` → manual smoke test on `/desktop/codegraph`

**Steps:**

- [ ] **Step 1: Scaffold the page**

Create `app/src/routes/desktop/codegraph/+page.svelte`:

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { FpsControls } from '$lib/desktop/graphCommon/FpsControls.js';
	import {
		updateLabelOpacity,
		type LabelEntry
	} from '$lib/desktop/graphCommon/labelLod.js';
	import {
		findCenterNode,
		findAimedNode
	} from '$lib/desktop/graphCommon/selectionPickers.js';
	import {
		createSelectionHalo,
		createHoverHalo,
		pulseScalar
	} from '$lib/desktop/graphCommon/haloFactory.js';
	import ReticleOverlay from '$lib/desktop/graphCommon/ReticleOverlay.svelte';
	import { loadCodegraphData } from '$lib/codegraph/loadCodegraphData.js';
	import { nodeColor } from '$lib/codegraph/nodeColor.js';
	import { edgeStyle } from '$lib/codegraph/edgeStyle.js';
	import CodeNodePanel from '$lib/desktop/components/CodeNodePanel.svelte';
	import type {
		CodegraphData,
		CodegraphLink,
		CodegraphNode,
		LoadResult
	} from '$lib/codegraph/codegraphTypes.js';
	import type { ForceGraph3DInstance } from '3d-force-graph';

	const SWITCH_DEBOUNCE_MS = 350;
	const PULSE_DURATION_MS = 420;
	const HUB_SIZE = 1.6;

	let container: HTMLDivElement;
	let loadResult = $state<LoadResult | null>(null);
	let fpsLocked = $state(false);

	// Top-bar inputs.
	let labelBaseDistance = $state(400);
	let nodeSpacing = $state(500);
	let moveSpeed = $state(60);
	let showLinks = $state(true);

	// Selection state.
	let selectedId = $state<string | null>(null);
	let panelOpen = $state(true);
	let selectMode: 'aim' | 'center' = $state('aim');

	let fg: ForceGraph3DInstance | null = null;
	let fpsRef: FpsControls | null = null;
	let webglError = $state<string | null>(null);
	let disposed = false;

	type LiveNode = CodegraphNode & { x?: number; y?: number; z?: number };
	let liveNodes: LiveNode[] = [];
	let liveNodesById = new Map<string, LiveNode>();

	const selectedNode = $derived(
		selectedId ? liveNodesById.get(selectedId) ?? null : null
	);

	// Pre-built neighbor index (computed once on data load).
	let neighborsBySelected: Map<string, Array<{
		node: LiveNode;
		link: CodegraphLink;
		direction: 'out' | 'in';
	}>> = new Map();

	const selectedNeighbors = $derived(
		selectedId ? neighborsBySelected.get(selectedId) ?? [] : []
	);

	onMount(() => {
		let cleanup: (() => void) | null = null;
		(async () => {
			try {
				const result = await init();
				if (disposed) return;
				cleanup = result;
			} catch (err) {
				console.error('[codegraph] init failed', err);
				webglError = (err as Error).message ?? String(err);
			}
		})();
		return () => {
			disposed = true;
			cleanup?.();
		};
	});

	async function init(): Promise<() => void> {
		// Always run the loader first — error states render without ever
		// instantiating ForceGraph3D, so no GPU cost on missing/failed data.
		const res = await loadCodegraphData();
		loadResult = res;
		if (!res.ok) return () => {};
		const data = res.data;
		if (data.nodes.length === 0) return () => {};

		const [{ default: ForceGraph3D }, THREE, { default: SpriteText }] = await Promise.all([
			import('3d-force-graph'),
			import('three'),
			import('three-spritetext')
		]);

		// Build neighbor index.
		const neighborMap = new Map<string, Array<{
			node: LiveNode;
			link: CodegraphLink;
			direction: 'out' | 'in';
		}>>();
		const nodesById = new Map<string, CodegraphNode>(data.nodes.map((n) => [n.id, n]));
		for (const l of data.links) {
			const sNode = nodesById.get(l.source);
			const tNode = nodesById.get(l.target);
			if (!sNode || !tNode) continue;
			const outArr = neighborMap.get(l.source) ?? [];
			outArr.push({ node: tNode as LiveNode, link: l, direction: 'out' });
			neighborMap.set(l.source, outArr);
			const inArr = neighborMap.get(l.target) ?? [];
			inArr.push({ node: sNode as LiveNode, link: l, direction: 'in' });
			neighborMap.set(l.target, inArr);
		}
		neighborsBySelected = neighborMap;

		const labelEntries: LabelEntry[] = [];
		function isHubLabel(size: number): boolean {
			return size >= HUB_SIZE;
		}

		// Try-catch around ForceGraph3D construction so a WebGL init failure
		// surfaces as a friendly card rather than a console crash.
		let graph: ForceGraph3DInstance;
		try {
			graph = new ForceGraph3D(container, { controlType: 'orbit' })
				.enableNavigationControls(false)
				.backgroundColor('#05060a')
				.nodeRelSize(4)
				.nodeLabel((n) => (n as CodegraphNode).title)
				.linkColor((l) => {
					const link = l as CodegraphLink;
					const { r, g, b, a } = edgeStyle(link.relation, link.confidence);
					return `rgba(${r}, ${g}, ${b}, ${a})`;
				})
				.linkDirectionalArrowLength(0)
				.linkWidth(0.3)
				.cooldownTicks(200)
				.warmupTicks(40)
				.d3AlphaDecay(0.05)
				.d3VelocityDecay(0.3)
				.nodeThreeObject((raw) => {
					const node = raw as CodegraphNode;
					const group = new THREE.Group();
					const radius = 3 * node.size;
					const sphere = new THREE.Mesh(
						new THREE.SphereGeometry(radius, 24, 16),
						new THREE.MeshLambertMaterial({
							color: nodeColor(node.community),
							transparent: true,
							opacity: 0.9
						})
					);
					group.add(sphere);
					const label = new SpriteText(node.title);
					label.color = '#ffffff';
					label.textHeight = 4 * node.size;
					label.backgroundColor = 'rgba(0,0,0,0.45)';
					label.padding = 1;
					label.position.set(0, radius + 2 + label.textHeight / 2, 0);
					group.add(label);
					if (isHubLabel(node.size)) {
						label.visible = true;
					} else {
						label.material.transparent = true;
						label.material.opacity = 0;
						label.visible = false;
						labelEntries.push({
							node: node as LabelEntry['node'],
							label: label as LabelEntry['label']
						});
					}
					return group;
				})
				.nodeThreeObjectExtend(false)
				.graphData({ nodes: data.nodes, links: data.links });
		} catch (err) {
			webglError = `WebGL을 초기화할 수 없습니다 — ${(err as Error).message ?? '브라우저/GPU 설정을 확인하세요'}`;
			return () => {};
		}

		fg = graph;

		liveNodes = graph.graphData().nodes as LiveNode[];
		liveNodesById = new Map();
		for (const n of liveNodes) liveNodesById.set(n.id, n);

		// FPS camera.
		const camera = graph.camera();
		const renderer = graph.renderer();
		const fps = new FpsControls(camera, renderer.domElement);
		fps.speed = moveSpeed;
		fpsRef = fps;
		fps.onLockChange = (locked) => {
			fpsLocked = locked;
		};

		// Halos.
		const sel = createSelectionHalo();
		const hov = createHoverHalo();
		graph.scene().add(sel.mesh);
		graph.scene().add(hov.mesh);

		const canvasEl = renderer.domElement;
		const handleCanvasClick = () => {
			if (!fps.locked) {
				fps.lock();
				return;
			}
			const id = findCenterNode({
				nodes: liveNodes,
				camera,
				width: graph.width(),
				height: graph.height()
			});
			if (id) {
				panelOpen = true;
				selectMode = 'center';
				candidateId = id;
				candidateSince = performance.now();
				selectedId = id;
				triggerClickPulse();
			}
		};
		canvasEl.addEventListener('click', handleCanvasClick);

		const MOVE_KEYS = new Set(['keyw', 'keya', 'keys', 'keyd', 'space', 'keyc']);
		const onMovementKey = (e: KeyboardEvent) => {
			const code = e.code.toLowerCase();
			if (!MOVE_KEYS.has(code)) return;
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === 'INPUT' ||
					target.tagName === 'TEXTAREA' ||
					target.isContentEditable)
			) {
				return;
			}
			selectMode = 'aim';
			if (!fps.locked) fps.lock();
		};
		window.addEventListener('keydown', onMovementKey);

		let pulseUntil = 0;
		function triggerClickPulse() {
			pulseUntil = performance.now() + PULSE_DURATION_MS;
		}

		let candidateId: string | null = null;
		let candidateSince = 0;

		let currentCenterId: string | null = null;

		function haloRadiusFor(size: number) {
			return 3 * size;
		}

		function updateHalo(t: number) {
			if (!selectedId) {
				sel.mesh.visible = false;
				return;
			}
			const n = liveNodesById.get(selectedId);
			if (!n || n.x === undefined) {
				sel.mesh.visible = false;
				return;
			}
			sel.mesh.visible = true;
			sel.mesh.position.set(n.x, n.y ?? 0, n.z ?? 0);
			sel.mesh.lookAt(camera.position);
			const baseRadius = haloRadiusFor(n.size);
			let pulse = 1;
			if (t < pulseUntil) {
				const remaining = (pulseUntil - t) / PULSE_DURATION_MS; // 1 → 0
				pulse = pulseScalar(remaining);
			}
			sel.mesh.scale.setScalar(baseRadius * pulse);
			sel.mesh.rotateZ(0.008);
		}

		function updateHoverHalo() {
			const id = findCenterNode({
				nodes: liveNodes,
				camera,
				width: graph.width(),
				height: graph.height()
			});
			currentCenterId = id;
			if (!id || id === selectedId) {
				hov.mesh.visible = false;
				return;
			}
			const n = liveNodesById.get(id);
			if (!n || n.x === undefined) {
				hov.mesh.visible = false;
				return;
			}
			hov.mesh.visible = true;
			hov.mesh.position.set(n.x, n.y ?? 0, n.z ?? 0);
			hov.mesh.lookAt(camera.position);
			hov.mesh.scale.setScalar(haloRadiusFor(n.size));
		}

		// Selective link visibility — same pattern as note graph.
		type LinkObj = {
			source: string | { id?: string };
			target: string | { id?: string };
			__lineObj?: { visible: boolean };
			__arrowObj?: { visible: boolean };
		};
		function linkEndpointId(v: LinkObj['source']): string {
			return typeof v === 'string' ? v : v?.id ?? '';
		}
		function updateLinkVisibility() {
			const data = graph.graphData().links as unknown as LinkObj[];
			const show = showLinks;
			const sId = selectedId;
			const hId = currentCenterId;
			for (let i = 0; i < data.length; i++) {
				const l = data[i];
				let visible = false;
				if (show) {
					const a = linkEndpointId(l.source);
					const b = linkEndpointId(l.target);
					if (a === sId || b === sId || a === hId || b === hId) {
						visible = true;
					} else {
						const an = liveNodesById.get(a);
						const bn = liveNodesById.get(b);
						if ((an && an.size >= HUB_SIZE) || (bn && bn.size >= HUB_SIZE)) {
							visible = true;
						}
					}
				}
				if (l.__lineObj && l.__lineObj.visible !== visible) {
					l.__lineObj.visible = visible;
				}
				if (l.__arrowObj && l.__arrowObj.visible !== visible) {
					l.__arrowObj.visible = visible;
				}
			}
		}

		let lastHaloedId: string | null = null;
		function maybePulseOnSelectionChange() {
			if (selectedId !== lastHaloedId) {
				lastHaloedId = selectedId;
				if (selectedId) triggerClickPulse();
			}
		}

		function updateNearest(now: number) {
			if (!panelOpen) return;
			const bestId =
				selectMode === 'center'
					? findCenterNode({
						nodes: liveNodes,
						camera,
						width: graph.width(),
						height: graph.height()
					})
					: findAimedNode({ nodes: liveNodes, camera });
			if (bestId === null) return;
			if (bestId !== candidateId) {
				candidateId = bestId;
				candidateSince = now;
			} else if (
				bestId !== selectedId &&
				now - candidateSince >= SWITCH_DEBOUNCE_MS
			) {
				selectedId = bestId;
			}
		}

		let lastTime = performance.now();
		let rafId = 0;
		const loop = (t: number) => {
			const dt = Math.min(0.1, (t - lastTime) / 1000);
			lastTime = t;
			fps.update(dt);
			updateNearest(t);
			maybePulseOnSelectionChange();
			updateHalo(t);
			updateHoverHalo();
			updateLinkVisibility();
			updateLabelOpacity(
				labelEntries,
				camera.position.x,
				camera.position.y,
				camera.position.z,
				labelBaseDistance
			);
			rafId = requestAnimationFrame(loop);
		};
		rafId = requestAnimationFrame(loop);

		// Wheel forwarder is unnecessary here — the panel scrolls itself
		// (no embedded note editor). Keeping a no-op slot for symmetry would
		// be over-engineering; we just don't add one.

		return () => {
			cancelAnimationFrame(rafId);
			window.removeEventListener('keydown', onMovementKey);
			canvasEl.removeEventListener('click', handleCanvasClick);
			sel.dispose();
			hov.dispose();
			fps.dispose();
			fpsRef = null;
			(graph as unknown as { _destructor?: () => void })._destructor?.();
		};
	}

	function applyNodeSpacing(graph: ForceGraph3DInstance, magnitude: number) {
		const charge = graph.d3Force('charge') as
			| { strength?: (v: number) => unknown }
			| null
			| undefined;
		if (!charge || typeof charge.strength !== 'function') return;
		charge.strength(-magnitude);
		try {
			const reheat = (graph as unknown as { d3ReheatSimulation?: () => void })
				.d3ReheatSimulation;
			if (typeof reheat === 'function') reheat.call(graph);
		} catch {
			// Layout not ready — next tick picks up the new strength.
		}
	}

	function focusNode(id: string) {
		if (!fg) return;
		const target = liveNodesById.get(id);
		if (!target || target.x === undefined) return;
		const distance = 80;
		const distRatio = 1 + distance / Math.hypot(target.x, target.y ?? 0, target.z ?? 1);
		fg.cameraPosition(
			{ x: target.x * distRatio, y: (target.y ?? 0) * distRatio, z: (target.z ?? 0) * distRatio },
			{ x: target.x, y: target.y ?? 0, z: target.z ?? 0 },
			1000
		);
	}

	function handleNeighborClick(id: string) {
		panelOpen = true;
		selectMode = 'aim';
		selectedId = id;
		focusNode(id);
	}

	function closePanel() {
		panelOpen = false;
		selectMode = 'aim';
	}

	function reenableAutoSelect() {
		panelOpen = true;
		selectMode = 'aim';
	}

	$effect(() => {
		const s = nodeSpacing;
		if (!fg) return;
		applyNodeSpacing(fg, s);
	});

	$effect(() => {
		const v = moveSpeed;
		if (fpsRef) fpsRef.speed = v;
	});

	$effect(() => {
		if (!fg || !container) return;
		const instance = fg;
		const el = container;
		const resize = () => {
			instance.width(el.clientWidth).height(el.clientHeight);
		};
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(el);
		return () => ro.disconnect();
	});

	function fmtSyncedAt(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}
</script>

<svelte:head>
	<title>코드 그래프 — Tomboy Web</title>
</svelte:head>

<div class="graph-root">
	<div class="canvas" bind:this={container}></div>

	{#if !loadResult}
		<div class="status">
			<div class="status-msg">그래프 로딩 중…</div>
		</div>
	{:else if !loadResult.ok && loadResult.reason === 'missing'}
		<div class="status">
			<div class="card">
				<h1>graphify가 아직 실행되지 않았습니다</h1>
				<p>아래 명령을 차례로 실행한 뒤 새로고침하세요.</p>
				<pre>/graphify app/src
cd app && npm run codegraph:sync</pre>
				<p class="muted">코드 그래프는 dev 환경 전용입니다.</p>
			</div>
		</div>
	{:else if !loadResult.ok && loadResult.reason === 'malformed'}
		<div class="status">
			<div class="card">
				<h1>데이터를 읽을 수 없습니다</h1>
				<p class="muted">{(loadResult.detail ?? '').slice(0, 200)}</p>
			</div>
		</div>
	{:else if !loadResult.ok && loadResult.reason === 'network'}
		<div class="status">
			<div class="card">
				<h1>네트워크 오류</h1>
				<p class="muted">{loadResult.detail ?? ''}</p>
			</div>
		</div>
	{:else if loadResult.ok && loadResult.data.nodes.length === 0}
		<div class="status">
			<div class="card">
				<h1>그래프가 비어있습니다 — graphify 실행 결과를 확인하세요</h1>
			</div>
		</div>
	{:else if webglError}
		<div class="status">
			<div class="card">
				<h1>WebGL을 초기화할 수 없습니다</h1>
				<p class="muted">{webglError}</p>
			</div>
		</div>
	{:else if loadResult.ok}
		<div class="top-bar">
			<a class="back" href="/desktop" title="데스크톱으로 돌아가기">← 데스크톱</a>
			<label class="lod-input" title="허브 외 라벨이 이 거리 이내면 선명, 2배 범위까지 흐릿.">
				라벨 거리
				<input type="number" bind:value={labelBaseDistance} min="50" step="50" />
			</label>
			<label class="lod-input" title="노드 간 반발력. 클수록 넓게 퍼짐.">
				노드 간격
				<input type="number" bind:value={nodeSpacing} min="5" step="5" />
			</label>
			<label class="lod-input" title="WASD 이동 속도 (초당 월드 유닛). Shift 3배 부스트.">
				이동 속도
				<input type="number" bind:value={moveSpeed} min="20" step="20" />
			</label>
			<label class="category-toggle" title="허브/선택/레티클 노드의 링크만 표시. 끄면 전부 숨김.">
				<input type="checkbox" bind:checked={showLinks} />
				링크 표시
			</label>
			<div class="synced">
				synced {fmtSyncedAt(loadResult.data.meta.syncedAt)} ·
				{loadResult.data.meta.nodeCount.toLocaleString()} nodes /
				{loadResult.data.meta.linkCount.toLocaleString()} edges
			</div>
			{#if !panelOpen}
				<button type="button" class="auto-btn" onclick={reenableAutoSelect}>
					자동 선택 다시 켜기
				</button>
			{/if}
		</div>

		<ReticleOverlay />

		<div class="fps-hint" class:paused={!fpsLocked}>
			{#if fpsLocked}
				WASD: 이동 · Space/C: 상/하 · Shift: 빠르게 · ESC: 정지
			{:else}
				클릭 또는 WASD 로 이동 시작
			{/if}
		</div>

		{#if selectedNode && panelOpen}
			<CodeNodePanel
				node={selectedNode}
				neighbors={selectedNeighbors}
				meta={loadResult.data.meta}
				communityLabels={loadResult.data.communityLabels}
				onneighborclick={handleNeighborClick}
				onclose={closePanel}
			/>
		{/if}
	{/if}
</div>

<style>
	.graph-root {
		position: fixed;
		inset: 0;
		background: #05060a;
		color: #e6edf3;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		overflow: hidden;
	}

	.canvas {
		position: absolute;
		inset: 0;
	}

	.top-bar {
		position: absolute;
		top: 12px;
		left: 12px;
		right: 12px;
		display: flex;
		align-items: center;
		gap: 12px;
		z-index: 10;
		pointer-events: none;
		flex-wrap: wrap;
	}
	.top-bar > * { pointer-events: auto; }

	.back {
		color: #cfd8e3;
		text-decoration: none;
		padding: 6px 10px;
		border-radius: 4px;
		background: rgba(20, 24, 34, 0.75);
		border: 1px solid #2a3040;
		font-size: 0.85rem;
	}
	.back:hover { background: rgba(40, 50, 70, 0.85); }

	.lod-input,
	.category-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border-radius: 4px;
		border: 1px solid #2a3040;
		background: rgba(20, 24, 34, 0.75);
		color: #cfd8e3;
		font-size: 0.78rem;
	}
	.lod-input input {
		width: 64px;
		padding: 2px 4px;
		border-radius: 3px;
		border: 1px solid #2a3040;
		background: #0d1018;
		color: #e6edf3;
		font-size: 0.78rem;
		text-align: right;
	}
	.lod-input input:focus { outline: none; border-color: #5a9; }
	.category-toggle input { accent-color: #4fd1c5; cursor: pointer; }

	.synced {
		color: #8a94a6;
		font-size: 0.78rem;
		background: rgba(20, 24, 34, 0.6);
		padding: 5px 10px;
		border-radius: 4px;
	}

	.auto-btn {
		margin-left: auto;
		padding: 6px 12px;
		border-radius: 4px;
		border: 1px solid #3a5a7a;
		background: #1f2a3a;
		color: #cfd8e8;
		cursor: pointer;
		font-size: 0.85rem;
	}
	.auto-btn:hover { background: #2d3d50; }

	.status {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 20;
	}
	.status-msg {
		color: #8a94a6;
		font-size: 0.9rem;
	}
	.card {
		max-width: 540px;
		padding: 24px 28px;
		background: #14182a;
		border: 1px solid #2a3040;
		border-radius: 8px;
	}
	.card h1 {
		font-size: 1rem;
		margin: 0 0 10px;
	}
	.card p { margin: 6px 0; font-size: 0.85rem; color: #cfd8e3; }
	.card .muted { color: #8a94a6; font-size: 0.78rem; }
	.card pre {
		background: #0d1018;
		border: 1px solid #2a3040;
		border-radius: 4px;
		padding: 10px 12px;
		font-size: 0.78rem;
		color: #cfd8e3;
		overflow-x: auto;
	}

	.fps-hint {
		position: absolute;
		top: 54px;
		left: 50%;
		transform: translateX(-50%);
		padding: 6px 12px;
		background: rgba(20, 24, 34, 0.85);
		border: 1px solid #2a3040;
		border-radius: 4px;
		font-size: 0.78rem;
		color: #cfd8e3;
		z-index: 10;
		pointer-events: none;
	}
	.fps-hint.paused {
		border-color: #5ab378;
		color: #cfe8d8;
		background: rgba(20, 46, 30, 0.85);
		animation: hint-pulse 1.8s ease-in-out infinite;
	}
	@keyframes hint-pulse {
		0%, 100% { box-shadow: 0 0 0 0 rgba(90, 179, 120, 0.0); }
		50% { box-shadow: 0 0 18px 2px rgba(90, 179, 120, 0.35); }
	}
</style>
```

- [ ] **Step 2: Type-check**

```bash
cd app && npm run check
```

Expected: 0 errors.

- [ ] **Step 3: Smoke-test (REQUIRED)**

In one terminal:
```bash
cd app && npm run codegraph:sync
```
In another:
```bash
cd app && npm run dev
```

Open `http://localhost:5173/desktop/codegraph` and verify each of the spec's invariants from Migration order step 5:
1. Mount + render visible.
2. Click a sphere → panel opens with title + sourceFile · sourceLocation, community chip color, GitHub button.
3. Click GitHub button → opens `<repoUrl>/blob/<branch>/<sourceFile>#L<line>` in a new tab.
4. Click a neighbor in the panel → camera flies, selection follows.
5. Toggle 링크 표시 off — all edges hidden next tick.
6. Tweak 라벨 거리 / 노드 간격 / 이동 속도 — graph responds live.
7. Move static/codegraph.json out of the way and reload → "graphify가 아직 실행되지 않았습니다" card.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/desktop/codegraph/+page.svelte
git commit -m "/desktop/codegraph 라우트 추가 (3D 코드 그래프 뷰어)"
```

---

## Task 12: Add codegraph launcher button to `SidePanel.svelte`

**Goal:** One new "코드 그래프" button in the rail, next to the existing "그래프" launcher. Opens `/desktop/codegraph` in a new tab.

**Blocked by:** Task 11.

**Files:**
- Modify: `app/src/lib/desktop/SidePanel.svelte` (around lines 226-232)

**Acceptance Criteria:**
- [ ] A `<a>` element with class `rail-settings rail-graph rail-codegraph`, `href="/desktop/codegraph"`, `target="_blank"`, `rel="noopener"`, label `코드 그래프`, sits directly below the existing 그래프 link.
- [ ] No regressions to the existing 그래프 / 설정 buttons.

**Verify:** `cd app && npm run check` → 0 errors

**Steps:**

- [ ] **Step 1: Edit SidePanel**

In `app/src/lib/desktop/SidePanel.svelte`, after the existing 그래프 anchor (around line 232), insert:

```svelte
<a
    class="rail-settings rail-graph"
    href="/desktop/codegraph"
    target="_blank"
    rel="noopener"
    title="코드 그래프 (새 탭, dev 전용)"
    aria-label="코드 그래프"
>코드 그래프</a>
```

It uses the same `rail-settings rail-graph` classes as the 그래프 anchor so styling stacks identically.

- [ ] **Step 2: Type-check**

```bash
cd app && npm run check
```

Expected: 0 errors.

- [ ] **Step 3: Smoke-test**

Open the desktop workspace, look at the rail. Confirm the "코드 그래프" link sits between "그래프" and "설정", clicks open `/desktop/codegraph` in a new tab.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/desktop/SidePanel.svelte
git commit -m "사이드 레일에 코드 그래프 런처 버튼 추가"
```

---

## Verification: end-to-end checklist

After all 12 tasks land:

- [ ] `cd app && npm run check` — 0 errors.
- [ ] `cd app && npm run test` — all unit tests pass (note graph + new codegraph + graphCommon).
- [ ] `/desktop/graph` regression-free (label fade, halos, reticle, aim/center pick, category exclusion).
- [ ] `/desktop/codegraph` end-to-end: spheres render, panel works, GitHub button jumps to the right line, missing-data card shows when `static/codegraph.json` is absent.
- [ ] Three new files in `app/static/codegraph*.json` are gitignored and never committed.
- [ ] No documentation files were created in this plan — `CLAUDE.md` and the `tomboy-codegraph` skill update are deferred to a follow-up commit per the spec's "Documentation" section.

