# Process (프로세스) — multi-stage kanban feature

Date: 2026-05-30
Status: Approved design, pre-implementation

## Summary

A note-content feature that turns a region of a note into an ordered, multi-stage
kanban flow. It is the multi-stage generalization of the existing two-stage **TODO**
feature (`app/src/lib/editor/todoRegion/`): instead of exactly `TODO → Done`, a
Process has a `Process:` start stage, any number of user-defined intermediate stages,
and a `Complete:` end stage. Each list item ("card") can advance to the next stage or
move back to the previous stage.

Like TODO, this is **fully content-driven**: no ProseMirror schema changes, no special
note XML. Stages are plain `<paragraph>` headers and items are standard
`<list>/<list-item>` blocks. Round-trip with Tomboy desktop is unaffected.

## Note format — bounded-span model

```
Process: 작업 이름        ← start boundary (stage 1)
- 카드 A
디자인                     ← intermediate stage (user adds freely)
- 카드 B
개발                       ← another intermediate stage
Complete:                 ← end boundary (final stage; list may be empty)
- 카드 C
```

Detection rules:

- A Process block **starts** at a top-level (non-title) paragraph whose trimmed text
  matches `/^Process(?![A-Za-z0-9_])/` and **ends** at the paragraph matching
  `/^Complete(?![A-Za-z0-9_])/` (and that paragraph's following lists).
- Within the span, **every top-level paragraph is a stage** (a kanban column), in
  document order. The list block(s) immediately following a stage paragraph are that
  stage's items.
- **Empty stages are allowed** — a stage paragraph with no following list is a valid,
  empty column.
- The two boundary keywords (`Process`, `Complete`) are English, case-sensitive, with
  a word boundary so `Processing` / `Completed` do **not** match, but `Process: x` /
  `Complete: y` do. They are distinct from TODO's `TODO`/`Done`, so the two features
  never fight over the same headers.
- The terminal `Complete:` is **required**: a `Process:` with no matching `Complete:`
  before end-of-doc (or before the next `Process:`) is **not** detected as a block. This
  keeps a stray `Process:` line in prose from turning every following paragraph into a
  phantom stage. If the user deletes `Complete:`, the kanban buttons disappear until it
  is restored.

### Coexistence

- TODO/Checklist plugins key off different headers (`TODO`/`Done`, checkbox marks), so
  their decorations never land on Process items. No cross-plugin coordination needed.
- A stage literally named `TODO` or `Done` inside a Process is an unsupported edge case
  (would be double-decorated). Acceptable — not a realistic authoring pattern.

## Module layout

New module `app/src/lib/editor/processRegion/`, mirroring `todoRegion/`:

| File | Purpose |
|---|---|
| `regions.ts` | Parse the Process span → ordered `ProcessStage[]`; enumerate items |
| `commands.ts` | `moveProcessItem(editor, liPos, direction)` + `insertProcessBlock(editor)` |
| `plugin.ts` | Widget-decoration plugin rendering `이전`/`다음` buttons per item |
| `index.ts` | `TomboyProcessRegion` extension + re-exports |

### Data model (`regions.ts`)

```ts
export type ProcessMoveDirection = 'next' | 'prev';

export interface ProcessStageList { pos: number; node: PMNode; childIndex: number; }

export interface ProcessStage {
  index: number;              // 0-based position in the ordered stage list
  headerPos: number;
  headerChildIndex: number;
  isFirst: boolean;
  isLast: boolean;
  lists: ProcessStageList[];  // may be empty (empty column)
}

export interface ProcessBlock { stages: ProcessStage[]; }

export interface ProcessItemRef {
  liPos: number;
  liNode: PMNode;
  stage: ProcessStage;
  block: ProcessBlock;
  containingListPos: number;
  containingListNode: PMNode;
}
```

- `findProcessBlocks(doc)` → `ProcessBlock[]` (multiple Process blocks per note allowed).
- `findProcessItems(blocks)` → `ProcessItemRef[]` — depth-1 list items only.
- Helper to resolve a stage's `next`/`prev` neighbor stage (or null at the ends).

**Depth scope:** depth-1 (cards) **and** depth-2 (sub-items under a category), mirroring
TODO. A depth-1 list item that holds a nested list acts as a **category**; its nested
depth-2 items are sub-items. Both depths are enumerated as movable items. Anything
deeper than depth-2 is left untouched. (Updated 2026-05-31 — depth-2 was originally out
of scope; the wrapper-with-internal-TODO model brought it in.)

## Move semantics (`commands.ts`)

`moveProcessItem(editor, liPos, direction)`:

1. Re-parse from the live doc (callbacks may be stale); locate the item and its stage.
2. Resolve target stage = `direction === 'next' ? stage+1 : stage-1`. No-op if out of
   bounds (first stage has no prev, last has no next).
3. **Source removal** — delete the `<list-item>`. If it was the only child of its list,
   delete the now-empty list too, **but keep the stage paragraph** (stages are permanent
   columns — this is the core difference from TODO, which deletes an emptied region).
4. **Target insertion** — if the target stage has list(s), append the item at the last
   list's end. If the target stage has no list, create a new list (same node type as the
   source list; default `bulletList`) immediately after the target stage paragraph and
   insert the item there.
5. Use `tr.mapping.map(...)` for post-deletion position remap, and
   `tr.setMeta(SKIP_TRAILING_NODE, true)` as TODO does.

`insertProcessBlock(editor)` (Alt+P): insert a skeleton after the caret's top-level block
(or replace the current empty paragraph, mirroring `insertTodoBlock`'s gesture):

```
Process: 작업 이름     ← "작업 이름" placeholder is text-selected so first keystroke replaces it
- (empty item)
Complete:              ← empty final stage, no list
```

Selection: a `TextSelection` covering the `작업 이름` placeholder in the header paragraph.

## Buttons & visibility (`plugin.ts`)

- Per depth-1 item: a node decoration `tomboy-process-item` plus up to two widget
  buttons at `liPos + 1`:
  - `다음` (`tomboy-process-next-btn`) — hidden when `stage.isLast`.
  - `이전` (`tomboy-process-prev-btn`) — hidden when `stage.isFirst`.
- Buttons call back into `onMove(liPos, direction)`; the extension wires this to
  `moveProcessItem` in `TomboyEditor.svelte`.
- Visibility reuses the existing `.tomboy-todo-ctrl-hold` gate on the editor root
  (toggled by the shared `modKeys.ctrl` → physical Ctrl/Cmd **and** mobile "Ctrl 고정").
  New CSS rules in `TomboyEditor.svelte` reveal `.tomboy-process-*-btn` on
  `.tomboy-todo-ctrl-hold ... :hover`, plus the touch/Ctrl-lock always-on rule.

## Editor integration (`TomboyEditor.svelte`)

- Import `TomboyProcessRegion`, `moveProcessItem`, `insertProcessBlock` from
  `./processRegion/index.js`.
- Register `TomboyProcessRegion.configure({ onMove: (liPos, dir) => moveProcessItem(ed, liPos, dir) })`
  alongside `TomboyTodoRegion`.
- Add **Alt+P** to the existing Alt-key handler block (next to Alt+J):
  `if (event.key === 'p' || event.key === 'P') { preventDefault(); insertProcessBlock(ed); return true; }`
  (handles CapsLock-uppercased key like Alt+J does).
- Add `.tomboy-process-item` / `.tomboy-process-next-btn` / `.tomboy-process-prev-btn`
  CSS mirroring the TODO button styles (distinct colors for next vs prev).
- (Optional, parity) a mobile Toolbar button — deferred unless requested.

## Serialization

None. Stages serialize as `<paragraph>` headers, items as `<list>/<list-item>`. No
archiver changes.

## Testing

`app/tests/unit/editor/processRegion.test.ts`, following `todoRegion.test.ts`:

- `findProcessBlocks`: bounded-span parsing; intermediate stages with/without lists;
  empty stages; word-boundary rejection (`Processing`, `Completed`); title never a
  stage; missing `Complete:` fallback; multiple Process blocks.
- stage neighbor resolution: `isFirst`/`isLast` flags, next/prev lookup.
- `moveProcessItem`: next & prev moves; out-of-bounds no-ops; **emptied stage keeps its
  header**; list created on demand in a listless target; list-type preservation
  (ordered vs bullet).
- `insertProcessBlock`: skeleton shape + placeholder selection.

## Depth-2 move semantics (added 2026-05-31)

A depth-2 sub-item move mirrors TODO's `buildDepth2Move`, with the target being the
neighbor **stage** (not a paired region):

1. Resolve target stage = `stage ± 1` (same out-of-bounds no-op as depth-1).
2. Match the sub-item's parent category label against the target stage's depth-1 items.
3. Insert plan:
   - matching category with a nested list → append into that nested list;
   - matching category without a nested list → create a nested list inside it;
   - no matching category but stage has a list → append a new category li to the
     stage's last list;
   - listless stage → create a fresh list (after the header) holding the new category.
4. Source removal is local: delete the sub-item, or its enclosing nested list when it was
   the sole child. The **parent category header always survives** (it may become a bare
   category with no sub-items), consistent with stages being permanent columns.

A depth-1 card move is unchanged — the whole card (with any sub-items) moves to the
neighbor stage and is appended verbatim (no category merge), matching TODO's depth-1.

## Out of scope (YAGNI)

- depth-3+ / deeper nesting.
- Drag-and-drop reordering of stages or cards.
- Any migration of existing notes.
