---
name: tomboy-hrsplit
description: Use when working on the editor's three-dash horizontal-rule / vertical-divider split-column feature (app/src/lib/editor/hrSplit/). Covers the placement model in assignColumns, the masonry-based layout invariants, the runtime divider-height sync via --hr-split-divider-height on view.dom, why per-column DOM wrapping is incompatible with ProseMirror, the Firefox-only browser support behind layout.css.grid-template-masonry-value.enabled, and the known dead ends.
---

# HR split layout

A top-level paragraph whose entire trimmed text is `---` (3+ dashes) acts
as a virtual horizontal-rule marker. Markers have a binary state:

- **Inactive** (default): rendered as a thin horizontal line inside its
  column. Ctrl/Cmd+click toggles it active.
- **Active**: the marker becomes a thin **vertical** divider, splitting
  the surrounding content into independent columns. N active markers →
  N+1 content columns, with the N markers as the dividers between them.

The two leading top-level children (title + subtitle/date) are always
treated as headers — they span all columns above the split area and
never participate in column assignment.

The active set is persisted per-note GUID in `localStorage` via
`hrSplitStore.ts`. It is **not** part of the `.note` XML and does not
sync between devices.

## File map

- `app/src/lib/editor/hrSplit/`
  - `assignColumns.ts` — pure column-assignment logic. Maps `BlockKind[]`
    + active set to `Placement[]` (header / block / h-line / v-divider)
    and emits inline `grid-column` styles + a `grid-template-columns`
    string. Heavily tested.
  - `hrSplitPlugin.ts` — ProseMirror plugin. Tracks `activeOrdinals` in
    plugin state, emits node decorations with the styles/classes from
    assignColumns, handles the Ctrl+click toggle, and owns the runtime
    divider-height sync in its `view()` hook.
  - `hrSplitStore.ts` — per-guid localStorage persistence of the active
    set.
- `app/src/lib/editor/TomboyEditor.svelte` — wires the plugin up,
  hosts the CSS for `.tomboy-hr-marker`, `.tomboy-hr-split-active`,
  `.tomboy-hr-split-divider`, and the `--hr-split-divider-height`
  variable binding.
- `app/tests/unit/editor/hrSplitAssignColumns.test.ts` — placement
  algorithm + grid-style output tests.
- `app/tests/unit/editor/hrSplitStore.test.ts` — persistence tests.

## Placement model (`assignColumns`)

Given `kinds: BlockKind[]` (`'hr' | 'block'` per top-level child) and the
set of active HR ordinals, the algorithm produces one `Placement` per
input position:

```
| role       | columns it occupies | notes                          |
|------------|---------------------|--------------------------------|
| header     | full-width spanner  | first `headerCount` children   |
| block      | content column N    | regular paragraph              |
| h-line     | content column N    | inactive HR (still a paragraph)|
| v-divider  | divider track       | active HR (the column boundary)|
```

The walker maintains a single `col` cursor that starts at 1 and advances
by 1 every time an HR is active. So the column number for any non-header
position is determined by how many earlier HRs were active.

HR ordinals are numbered post-header in DOM order (i.e., headers do NOT
shift the ordinal numbering). Out-of-range active ordinals are silently
ignored by both `assignColumns` and the plugin's `reconcileActiveAgainstDoc`.

## Layout: CSS Grid + masonry

The plugin attaches:

- `class="tomboy-hr-split-active"` on the editor root (`view.dom`)
- `style="grid-template-columns:1fr auto 1fr ...;"` on the editor root
  (`1fr` content tracks alternating with `auto` divider tracks)
- `style="grid-column:<track>;"` on every top-level child
  - headers: `1 / -1` (full width)
  - content/h-line in column C: `2C - 1`
  - divider K: `2K + 2`
- `class="tomboy-hr-split-header"` on headers (split-active mode only)
- `class="tomboy-hr-split-divider tomboy-hr-marker-active"` on dividers

The editor root CSS adds:

```css
display: grid;
grid-template-rows: masonry;     /* the key rule */
align-items: start;              /* defense in depth — see below */
column-gap: 12px;
```

**Why masonry?** Standard CSS Grid forces items in the same row to share
that row's height. With explicit per-block `grid-row` (the original
design), a tall image in column 1 made column 2's adjacent block grow to
match, leaving a blank gap on the other side. `grid-template-rows: masonry`
packs each grid column independently along the masonry axis, so columns
are truly independent. Headers with `grid-column: 1 / -1` act as
masonry "breakpoints" per spec — content above packs per column, the
spanner sits across, content below resumes per column.

**No `grid-row` is ever emitted.** Masonry disallows spanning its axis,
so we don't even try.

## Divider height — the runtime sync

Masonry has no defined track height along the masonry axis, so the
divider element only renders at its intrinsic height (~24 px) — a short
stub at the top of its column instead of a full-height line. The plugin's
`view()` hook measures the tallest content column at runtime and exposes
it as a custom property:

```ts
root.style.setProperty('--hr-split-divider-height', `${maxHeight}px`);
```

CSS binds the divider to it:

```css
.tomboy-hr-split-active > .tomboy-hr-split-divider {
  height: var(--hr-split-divider-height, auto);
}
```

The sync runs on every plugin `view().update()` (i.e. every transaction)
and is also triggered by a `ResizeObserver` on `view.dom` (for window /
container width changes). It bails entirely when masonry isn't
supported — see below.

### Why the variable lives on `view.dom`, not the divider

PM's `DOMObserver.registerMutation` (prosemirror-view source, line
~4796):

```js
if (mut.type == "attributes" &&
    (desc == this.view.docView || ... ))
    return null;
```

Attribute mutations whose nearest desc IS the docView (= `view.dom`
itself) are short-circuited and never enter `readDOMChange`. So writing
to `view.dom.style` is invisible to PM. Writing inline style on the
divider paragraph DOM is not — it routes through PM's mutation path,
which can dispatch a selection-only transaction that re-fires the
plugin's `view().update()`, which re-runs the sync, which mutates the
style again — and combined with `ResizeObserver` this produces a
runaway feedback loop on every divider toggle. **Never put the height
on the divider element directly.**

### How content-column heights are measured

```ts
for (const child of root.children) {
  if (child.classList.contains('tomboy-hr-split-divider')) continue;
  if (child.classList.contains('tomboy-hr-split-header'))  continue;
  const track = parseInt(getComputedStyle(child).gridColumnStart, 10);
  heightByTrack.set(track, (heightByTrack.get(track) || 0) + child.offsetHeight);
}
const maxHeight = Math.max(...heightByTrack.values());
```

Why a classList check for headers, not a `cs.gridColumnEnd === '-1'`
check or an inline-style string match? Because:

- Browsers reserialize inline-style strings, so selectors that match
  the raw `grid-column:1 / -1` we wrote can silently miss everything.
- `getComputedStyle(...).gridColumnEnd` in some browsers resolves `-1`
  to the explicit last-line number (e.g. `'4'` in a 3-track grid)
  rather than preserving `'-1'`.

The class is set on headers in `buildLayout` precisely for this purpose
(`tomboy-hr-split-header`, applied only when `totalColumns > 1`).

### Anti-loop guards

- Bail if `!CSS.supports('grid-template-rows', 'masonry')` — see next
  section. Without masonry, the sync would inflate a single shared row
  to the column-total height, which other items in that row would
  match, etc.
- Guard the write: `if (current !== targetStr)` before
  `setProperty(...)`. Re-writing the same value still mutates the style
  attribute and re-fires the `ResizeObserver`, even though PM ignores
  view.dom mutations.
- `align-items: start` on the root is also kept as defense in depth —
  even if a future change tries to size the divider in fallback mode,
  start-alignment prevents the row-stretch feedback that produced the
  original infinite-growth bug.

## Browser support — Firefox-only, behind a pref

As of 2026-Q1, `grid-template-rows: masonry` ships in **Firefox only**,
and Firefox release still hides it behind:

```
about:config → layout.css.grid-template-masonry-value.enabled = true
```

On engines without masonry (Chromium, WebKit, Firefox with the pref
off), the rule is silently ignored. The plugin detects this via
`CSS.supports('grid-template-rows', 'masonry')` and:

1. Skips the divider-height sync entirely (the divider stays at its
   intrinsic height — a short stub at the top of its column).
2. Doesn't install the `ResizeObserver`.

The column split is then visually degraded but stable — items
auto-place into standard grid rows, columns share row heights, the
divider is short. The feature mostly looks broken in this mode, but it
won't grow without bound or crash the editor.

When debugging "split looks weird in my browser", first thing to check
is whether masonry is enabled — the symptoms (column 1 has a huge empty
area at the bottom, divider is short or matches only the first row,
etc.) all stem from the unsupported case.

## Invariants

- **Children of `view.dom` are never wrapped.** A previous attempt
  grouped per-column content into wrapper `<div>`s to get independent
  flex columns; PM's `DocViewDesc.updateChildren` assumes node-desc
  DOMs are direct children of `view.dom`, and `view.dom.removeChild` /
  `insertBefore` on a wrapped child throws `DOMException`. Even
  monkey-patching `updateStateInner` to unwrap-before-render didn't
  fully tame it: PM's `DOMObserver` re-parses ranges that contain our
  wrappers, treating them as unknown blocks and corrupting the doc on
  every keystroke. **Do not reintroduce wrappers.** The masonry-only
  approach (decorate inline styles; never restructure DOM) is the
  only PM-safe path.
- **No `grid-row` decorations.** Masonry disallows spanning its axis.
  Pre-masonry the layout emitted explicit `grid-row` per block to
  control row sharing; with masonry every item in a given grid column
  flows independently and `grid-row` is meaningless / harmful.
- **Divider height never lives on the divider element.** Always
  via the `--hr-split-divider-height` custom property on `view.dom`.
- **Decorations only ever attach attributes, never structural changes.**
  Headers, dividers, and blocks all get inline `grid-column` styles via
  `Decoration.node`. No widget decorations, no NodeViews.
- **Active set persistence is per-guid localStorage, never synced.**
  Sync would carry one device's split preference to another with a
  different screen size, which makes no sense.
- **Ctrl/Cmd-only toggle.** The handler short-circuits on any other
  click. The `tomboy-hr-marker` hover affordance (cursor + line
  thickness) is gated on the `tomboy-todo-ctrl-hold` body class so the
  visual matches.
- **Mobile sets `hrSplitEnabled=false`.** Small screens can't usefully
  show side-by-side columns; the click would just confuse touch users.
  When disabled, `buildLayout` forces `activeOrdinals` to an empty set
  regardless of what's in localStorage, so persisted splits from the
  desktop don't bleed into mobile sessions.

## Known dead ends — do not retry

- **DOM wrapping per column (flexbox columns)** — incompatible with
  PM's mutation observer and child-list assumptions. PR #8 (commit
  `20d6d88`) demonstrated it: typing inserted one character then forced
  a line break because PM re-parsed the wrappers as block boundaries.
  Reverted in `30da583`.
- **Absolute positioning per block with measured `top`** — feasible
  but requires per-block `ResizeObserver`, careful editor-height
  computation, and the same care about not mutating PM-owned DOM. The
  masonry route is strictly simpler when it works.
- **Per-block unique grid rows (give each block its own row, no
  sharing)** — visually staggers the columns (col 2 starts where col 1
  ends instead of at the top). Unusable.
- **CSS `column-rule` from multi-column** — multi-column flows items
  automatically based on content height; can't respect the user's
  explicit divider placement.

## Configuration knobs

- `HEADER_COUNT = 2` in `hrSplitPlugin.ts`. Bump only if the note
  layout grows a third always-full-width row.
- Divider track width is hard-coded to `12px` in CSS (`.tomboy-hr-split-divider`
  width + `column-gap`). Changing it requires updating the gap to match
  or the column tracks won't align with the visual gap.

## Testing

`hrSplitAssignColumns.test.ts` covers the placement algorithm
exhaustively (mixed active/inactive HRs, headers, edge cases like
adjacent dividers / empty first column / out-of-range ordinals) and
verifies the `computeGridStyles` output is **`grid-column` only** (no
`grid-row` leaks into the output strings — that's the invariant the
masonry layout depends on).

No DOM-level test for the divider-height sync because it depends on
real browser layout; verify manually in Firefox with masonry enabled.
