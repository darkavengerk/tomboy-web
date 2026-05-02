# `/desktop/codegraph` — 3D Code Graph Viewer Design

**Status:** Design approved. Awaiting implementation plan.
**Date:** 2026-05-02
**Author:** brainstormed with Claude

## Goal

Build a desktop-only 3D viewer that renders the graphify-extracted code knowledge graph (`graphify-out/graph.json`) using the same `3d-force-graph` + `FpsControls` machinery already powering `/desktop/graph` (the note graph), but with code-node–specific coloring, edge styling, and a side panel that lets the user identify a node and jump to its source on GitHub.

Primary use case: **explore the codebase structure spatially, then jump to source.**

Out of scope for v1:

- Inline source preview (covered by GitHub jump).
- Hyperedges (graphify produces 24, but `3d-force-graph` cannot render them natively).
- Community-isolated sub-views, confidence filters, search input — analytical features that overlap with the `graphify` CLI's `query`/`path`/`explain`.
- Vercel/production deploy support — this is a dev-environment tool.
- Mobile UI (route is under `/desktop/*`, chromeless).

## Confirmed decisions

| Decision | Choice |
|---|---|
| Use case scope | B (explore + code jump) |
| Route | New `/desktop/codegraph`; existing `/desktop/graph` not modified except for shared-module imports |
| Source jump target | GitHub blob URL (`<repoUrl>/blob/<branch>/<path>#L<line>`) |
| `graph.json` distribution | Manual `npm run codegraph:sync`, dev-only, gitignored |
| Vercel | Out of scope; missing fetch shows friendly card |
| Node color | `hsl((community * 137.5°) % 360, 60%, 55%)` (golden-angle hue) |
| Node size | `1 + log1p(degree) / log1p(maxDegree)`, sphere only |
| Edge color/alpha | `relation`-keyed RGBA, `confidence`-scaled alpha |
| Edge dashes | Not used in v1 (alpha modulation only) |
| Selective links | Same as note graph: hub/selected/centered endpoints only |
| Hyperedges | Ignored in v1 |
| Side panel | New `CodeNodePanel.svelte`, fixed 420×60vh, neighbors grouped by relation |

## Architecture

### File layout

```
app/
├── scripts/
│   └── sync-codegraph.mjs                    # NEW
├── package.json                               # +1 script
├── .gitignore                                 # +2 patterns
└── src/
    ├── routes/desktop/
    │   ├── codegraph/+page.svelte             # NEW
    │   └── graph/+page.svelte                 # MODIFIED (imports + LOD/picker call sites)
    └── lib/
        ├── codegraph/                         # NEW
        │   ├── codegraphTypes.ts              # All exported interfaces/types live here
        │   ├── loadCodegraphData.ts           # Imports types; exports loadCodegraphData() only
        │   ├── nodeColor.ts
        │   ├── edgeStyle.ts
        │   └── githubLink.ts
        ├── desktop/
        │   ├── SidePanel.svelte               # MODIFIED (+1 launcher button)
        │   ├── components/
        │   │   └── CodeNodePanel.svelte       # NEW
        │   └── graphCommon/                   # NEW (shared between both routes)
        │       ├── FpsControls.ts             # MV from lib/graph/
        │       ├── labelLod.ts                # EXTRACT from routes/desktop/graph/+page.svelte
        │       ├── selectionPickers.ts        # EXTRACT + genericize
        │       ├── haloFactory.ts             # EXTRACT
        │       └── ReticleOverlay.svelte      # EXTRACT (HTML + scoped CSS)
        └── graph/                             # existing — note-only after FpsControls move
            ├── buildGraph.ts
            ├── extractInternalLinks.ts
            ├── plainText.ts
            └── constants.ts

app/tests/unit/
├── codegraph/                                 # NEW
│   ├── loadCodegraphData.test.ts
│   ├── nodeColor.test.ts
│   ├── edgeStyle.test.ts
│   └── githubLink.test.ts
├── desktop/graphCommon/                       # NEW
│   ├── labelLod.test.ts
│   └── selectionPickers.test.ts
└── graph/                                     # unchanged
```

### Entry point

A new "코드 그래프" launcher button in `lib/desktop/SidePanel.svelte`'s left rail, next to the existing "그래프" button. Both open in new tabs.

### Shared modules (`lib/desktop/graphCommon/`)

Refactor the note graph route to extract reusable assets without changing its behavior. The extraction is a sequence of safe, individually verifiable steps; details in the **Migration order** section below.

| Module | Source | Notes |
|---|---|---|
| `FpsControls.ts` | `mv` from `lib/graph/FpsControls.ts` | Identity move; only import paths change. |
| `labelLod.ts` | Extracted from `routes/desktop/graph/+page.svelte` inline RAF logic | Pure helper: `updateLabelOpacity(entries, cameraPos, baseDistance, scratch)`. Hubs (`isHub=true`) untouched; non-hubs do the squared-distance gate + linear fade. |
| `selectionPickers.ts` | Extracted from inline `findAimedNode` / `findCenterNode` | Generic over `PickerNode`; takes optional `filter` callback. Note graph passes `filter: n => !n.isCategory`; codegraph omits the option. |
| `haloFactory.ts` | Extracted halo `Mesh` builders | `createSelectionHalo()` (cyan, opacity 0.55), `createHoverHalo()` (white, opacity 0.22), `applyPulse(halo, t01)`. Color/material/spin shared by both routes. |
| `ReticleOverlay.svelte` | Extracted center-screen reticle markup + CSS | Single Svelte component; both routes render `<ReticleOverlay {active} />` once. Pointer-events disabled. `mix-blend-mode: screen`. |

`lib/graph/` keeps note-only assets (`buildGraph`, `extractInternalLinks`, `plainText`, `constants`).

## Data pipeline

### `app/scripts/sync-codegraph.mjs`

Run by the user after each `/graphify app/src` execution.

Steps:

1. Read `../graphify-out/graph.json`. If missing, fail with: `"graphify가 아직 실행되지 않았습니다 — '/graphify app/src'를 먼저 돌려주세요"` and a non-zero exit.
2. Copy verbatim to `static/codegraph.json`.
3. Read `git config --get remote.origin.url` and normalize to `https://github.com/<owner>/<repo>` (strip trailing `.git`, convert SSH to HTTPS).
4. Read `git rev-parse --abbrev-ref HEAD`. If `HEAD` (detached), default to `main`.
5. Read `../graphify-out/GRAPH_REPORT.md` and extract community labels via regex matching `^### Community (\d+) - "(.+)"$` (the actual graphify report format: dash separator, label quoted). Emit `static/codegraph-communities.json` (`{ "11": "Note List & Generic Helpers", ... }`).
6. Write `static/codegraph-meta.json`:
   ```json
   {
     "repoUrl": "https://github.com/darkavengerk/tomboy-web",
     "branch": "main",
     "syncedAt": "2026-05-02T11:33:21Z",
     "nodeCount": 1252,
     "linkCount": 1715
   }
   ```

### `app/package.json` (existing file)

Add one entry under `"scripts"`:

```json
"scripts": {
  "codegraph:sync": "node scripts/sync-codegraph.mjs"
}
```

The script is invoked as `npm run codegraph:sync` from inside `app/`.

### `.gitignore` (repo-root, existing file)

Append three patterns:

```
app/static/codegraph.json
app/static/codegraph-meta.json
app/static/codegraph-communities.json
```

### `lib/codegraph/codegraphTypes.ts`

```ts
export interface CodegraphNode {
  id: string;
  title: string;            // graphify "label"
  community: number;
  fileType: 'code' | 'document' | 'paper' | 'image';
  sourceFile: string;
  sourceLocation: string | null;
  degree: number;
  size: number;             // 1..2 log-scaled
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
  communityLabels: Record<string, string>;  // "{community_id}" -> label, fallback to `Community {id}`
}

export type LoadResult =
  | { ok: true; data: CodegraphData }
  | { ok: false; reason: 'missing' | 'malformed' | 'network'; detail?: string };
```

### `lib/codegraph/loadCodegraphData.ts`

Imports the types from `codegraphTypes.ts` and exports a single async function:

```ts
import type { LoadResult } from './codegraphTypes.js';
export async function loadCodegraphData(): Promise<LoadResult>;
```

Behavior:

- Parallel `fetch` of `/codegraph.json`, `/codegraph-meta.json`, `/codegraph-communities.json`. Only `codegraph.json` and `codegraph-meta.json` are required (404 of either → `'missing'`); `codegraph-communities.json` is optional (404 → empty map, panel falls back to `Community {id}`).
- After fetch:
  - Walk `links` once to build `degreeMap` (in+out, undirected).
  - Compute `maxDegree`, `logMax = log1p(maxDegree)`.
  - Map graphify nodes to `CodegraphNode`, computing `size = 1 + log1p(deg)/logMax` (or `1.0` when `logMax === 0`).
  - Strip graphify-internal fields (`_src`, `_tgt`, `weight`, `source_file`, `source_location` on links — keep on nodes).
  - Drop `hyperedges` entirely.
  - Skip links whose `source` or `target` is missing/empty (do not fail the whole load).
  - Coerce unknown `confidence` values to `'INFERRED'`.

### Side panel: community label coupling

`CodeNodePanel.svelte` reads `data.communityLabels[String(node.community)]`. Missing entry → `Community {id}`.

## Visual design

### Nodes

- Geometry: `SphereGeometry(3 * size, 24, 16)`.
- Color: `nodeColor(community)` → `hsl((community * 137.5°) % 360, 60%, 55%)`.
- Hub threshold: `size >= 1.6` (~degree 6+ in this corpus). Hub labels are always visible; non-hub labels fade with distance per `labelLod.ts`.
- Labels: `three-spritetext` with translucent black background, default font size, centered above sphere. Label text = node `title` (e.g. `getDB()`).
- All nodes are spheres in v1 — file_type-based shape variants postponed.

### Edges

`edgeStyle(relation, confidence)` returns `{ r, g, b, a }`:

| `relation` | base RGBA |
|---|---|
| `contains` | `(120, 120, 120, 0.35)` |
| `calls` | `(220, 220, 220, 0.65)` |
| `references` | `(120, 200, 200, 0.55)` |
| `cites` | `(220, 190, 130, 0.55)` |
| `semantically_similar_to` | `(220, 150, 220, 0.45)` |
| `conceptually_related_to` / `shares_data_with` / `rationale_for` / `implements` | `(180, 180, 180, 0.40)` |
| _(unknown)_ | `(120, 120, 120, 0.30)` |

`confidence` multiplies alpha:

- `EXTRACTED`: × 1.0
- `INFERRED`: × 0.55
- `AMBIGUOUS`: × 0.30, plus a +20 R / -10 G / -10 B warm shift to flag uncertainty.

Result clamped to `[0, 255]` per channel.

Selective rendering matches the note graph: each frame, an edge's `__lineObj.visible` (and `__arrowObj.visible`) is set true iff at least one endpoint is a hub, the selected node, or the currently centered node. Toggle "링크 표시" off → all edges hidden next tick.

### HUD

- `<ReticleOverlay />` — shared component.
- Selection halo (cyan ring) and hover halo (translucent white ring) — `haloFactory.ts`. Selection halo pulses +45% for 420ms on selection change.
- Selection modes: `'aim'` (default, frustum-nearest to camera-forward × 40 aim point) and `'center'` (50px screen-space pick from reticle).

### Top bar controls

| Control | Default | Notes |
|---|---|---|
| 라벨 거리 | 400 | step 50, min 50 |
| 노드 간격 | 500 | step 5, min 5 (charge strength = -value) |
| 이동 속도 | 60 | step 20, min 20 |
| 링크 표시 | on | checkbox |
| `synced ...` | (read-only) | small gray text: "synced 2026-05-02 20:33 · 1,252 nodes / 1,715 edges" |

`includeCategories` from the note graph is intentionally absent.

## Side panel (`CodeNodePanel.svelte`)

- Fixed: `width: 420px; height: 60vh; bottom: 24px; right: 24px`.
- Header:
  - Large `node.title`.
  - `node.sourceFile · node.sourceLocation` line (gray, smaller).
  - Community chip (community color background, small text: `community {id} ({label})`).
  - Degree / file-type chip (gray).
  - Right-aligned `[↗ GitHub]` button → opens `githubLink(meta, sourceFile, sourceLocation)` in new tab. Disabled if `sourceFile` missing.
  - Right-aligned `[×]` close → `panelOpen = false`, autoSelect off, "자동 선택 다시 켜기" chip appears.
- Body (scrollable): neighbors grouped by relation, in this section order:
  - Outbound (`source === selectedId`): `→ {relation}` per relation, count in header.
  - Inbound (`target === selectedId`): `← called by` / `← contained by` / etc.
  - Within a section: items sorted EXTRACTED → INFERRED → AMBIGUOUS, then label A→Z.
  - Each item: arrow, neighbor `title`, `sourceFile · sourceLocation`, confidence dot+label (green/yellow/red).
  - Click → camera fly + `selectedId = neighborId` + `selectMode = 'aim'`.
- No footer. No backlinks list (inbound section already covers it). No "open file in IDE" alternative path.

## State machine

```ts
let selectedId = $state<string | null>(null);
let panelOpen  = $state<boolean>(true);
let selectMode = $state<'aim' | 'center'>('aim');
```

Transitions:

| Trigger | Effect |
|---|---|
| Graph node click | `selectedId = id; selectMode = 'center'; panelOpen = true` |
| Auto-select tick (350ms) when `selectMode === 'aim'` | `selectedId = aimedNodeId` if changed |
| Movement key (W/A/S/D/Space/C) | `selectMode = 'aim'` |
| Panel neighbor click | Camera fly to neighbor, `selectedId = neighborId; selectMode = 'aim'` |
| Panel × | `panelOpen = false`, halt auto-select |
| "자동 선택 다시 켜기" chip | `panelOpen = true; selectMode = 'aim'` |

## Error handling

`loadCodegraphData` is the system boundary; everything inside trusts validated data.

| Case | UI |
|---|---|
| `null` (loading) | Black background + small gray "그래프 로딩 중…" text |
| `reason: 'missing'` | Centered card: "graphify가 아직 실행되지 않았습니다" + commands (`/graphify app/src`, `npm run codegraph:sync`) + 1-line description |
| `reason: 'malformed'` | "데이터를 읽을 수 없습니다" + `detail` (truncated) |
| `reason: 'network'` | "네트워크 오류" + `detail` |
| `ok: true && nodes.length === 0` | "그래프가 비어있습니다 — graphify 실행 결과를 확인하세요" |
| `ok: true` | Initialize graph |

WebGL init failure → `"WebGL을 초기화할 수 없습니다 — 브라우저/GPU 설정을 확인하세요"`. Same card style.

In any error/empty state, the ThreeJS / 3d-force-graph instance is **not** created — no GPU/memory cost.

## Lifecycle / cleanup

`onMount`:

- `loadCodegraphData()` (await).
- On success: build `3d-force-graph` instance, FpsControls, halos, reticle, RAF loop, wheel forwarding, resize listener.

`onDestroy`:

- `cancelAnimationFrame(rafId)`.
- `fps.detach()`.
- `graph._destructor?.()` if present, else manual scene/renderer dispose.
- `window.removeEventListener('wheel', ...)`.
- `window.removeEventListener('resize', ...)`.

Svelte 5 `$effect`-registered force/spacing/speed reactions are auto-disposed.

## Migration order

The graphCommon extraction touches the existing note graph route. Order minimizes blast radius:

1. Create empty `lib/desktop/graphCommon/`. `mv lib/graph/FpsControls.ts → lib/desktop/graphCommon/FpsControls.ts`. Update 1 import in `routes/desktop/graph/+page.svelte`. Run `npm run check`. Manually verify `/desktop/graph` (WASD, lock, mouse, sprint).
2. Extract `labelLod.ts`. Replace inline LOD logic in `routes/desktop/graph/+page.svelte` with the helper call. Manually verify label fade unchanged.
3. Extract `selectionPickers.ts` with `filter` option. Note graph passes `filter: n => !n.isCategory`. Verify category nodes are still excluded from auto-select; verify aim/center pick behavior unchanged.
4. Extract `haloFactory.ts` and `ReticleOverlay.svelte`. Verify visual identity.
5. **Only after steps 1-4 pass manual verification**, start `routes/desktop/codegraph/+page.svelte` from scratch using the shared modules.

The plan task graph will encode this ordering.

## Testing strategy

### Unit tests (vitest)

| Module | Tests |
|---|---|
| `loadCodegraphData.ts` | normal input → degree/size correctness; `maxDegree=0` fallback; empty arrays; malformed JSON → `'malformed'`; missing link source/target → that link skipped; unknown confidence → `'INFERRED'` fallback |
| `nodeColor.ts` | determinism (same input → same output); communities 0 and 1 produce hue ≥ 30° apart |
| `edgeStyle.ts` | per-(relation, confidence) RGBA; AMBIGUOUS alpha < EXTRACTED alpha; unknown relation → gray fallback |
| `githubLink.ts` | normalizes `git@github.com:owner/repo.git` and `https://github.com/owner/repo.git`; null `sourceLocation` → no `#L`; `'L15'` → `#L15` |
| `labelLod.ts` | hubs untouched; `d ≤ base` → opacity 1; `d ≥ 2*base` → hidden; fade band linear |
| `selectionPickers.ts` | filter option respected; empty nodes → null; out-of-frustum nodes → null; 50px tie broken by screen-space distance |
| `sync-codegraph.mjs` (export sync helpers) | `repoUrl` normalization for SSH and HTTPS forms |

### Manual verification

- `/desktop/graph` regression after each migration step (see **Migration order** above).
- `/desktop/codegraph` smoke pass: mount, render, click node, panel content matches, GitHub URL is correct (with line hash), neighbor click flies camera, selective links toggle, LOD/spacing/speed inputs respond live, `npm run check` passes, missing data card displays cleanly.

### Out of scope for v1

- Playwright / E2E.
- Visual regression screenshots.
- Performance profiling beyond reusing the note graph's existing knobs.

## Documentation

After merge:

- Add a brief section to `CLAUDE.md` describing `/desktop/codegraph`, its sync command, and that it's dev-only.
- Add a new `tomboy-codegraph` skill at `.claude/skills/tomboy-codegraph/SKILL.md` mirroring the `tomboy-graph` skill's structure, focused on the codegraph route, sync pipeline, edge styling, and panel state machine. Keeping it separate from `tomboy-graph` since the data sources, color semantics, panel content, and update cadence differ entirely.
