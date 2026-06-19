# 노트 드래그 → 묶음 리스트에 추가 (notebundle drag-drop)

**Date:** 2026-06-19
**Status:** Approved — ready for implementation plan
**Scope:** Desktop multi-window. Integrates the existing "note drag handle" feature with the 묶음 (bundle) cabinet only.

## Problem

The desktop multi-window UI already lets you drag a note's left-side icon
(`NoteDragHandle`) and drop it onto another note's editor; the drop inserts the
dragged note's **title** as plain text, which the deferred auto-link plugin later
marks as an internal link.

We want this drag to also target a **묶음 cabinet** (`NoteBundleCabinet`, the
window-5 file-cabinet for `kind:'bundle'`). Dragging a note over a 묶음 should make
the cabinet *react* (visual feedback); dropping should add the dragged note to the
**matching position inside the cabinet's link list**. This is bundle-only — the
tab cabinet (`NoteBundleStack`) is explicitly excluded.

## Existing mechanics (unchanged source)

- **Source:** `lib/components/NoteDragHandle.svelte` — a `draggable` button in the
  `NoteWindow` title bar (left of the title). On `dragstart` it sets
  `dataTransfer`:
  - MIME `application/x-tomboy-note-title` (constant `NOTE_TITLE_DND_MIME`) = note
    **title**
  - `text/plain` = title (fallback)
  - `effectAllowed = 'copy'`
- **Existing drop:** `lib/editor/noteTitleDrop/noteTitleDropPlugin.ts` — a
  ProseMirror plugin on the outer `TomboyEditor`. Inserts the title as plain text
  at the drop coordinates.
- **No shared drag-state module** — pure native HTML5 DnD via `dataTransfer`.

The source needs **no change**. We add a new drop target (the cabinet) that reads
the same MIME.

## Key facts that shape the design

1. **Cabinet barrier already protects us.** `NoteBundleCabinet`'s
   editor-in-editor barrier lists `dragover`/`drop` in `ISOLATED_EVENTS` and
   `stopPropagation`s them at **bubble** phase (no capture, no `preventDefault`).
   So:
   - The outer editor's `noteTitleDropPlugin` never sees a drop that lands on the
     cabinet — the cabinet owns those drops.
   - Our own listeners, attached on descendant **bar** elements via the existing
     `direct` action, fire *before* the barrier's bubble-phase stop, so they work.
   - The barrier only `stopPropagation`s; it does **not** `preventDefault`, so it
     doesn't suppress the browser's drop default — our `dragover` handler must call
     `preventDefault()` itself to enable dropping.
2. **The cabinet flattens.** `spec.entries` (`BundleEntry{title, category}`) are a
   flattened view: categories and multi-link-per-line items mean **bars do not map
   1:1 to top-level list items**. To insert "at a matching position" we must map a
   hovered bar to a **top-level structural boundary**.
3. **Internal link shape.** The internal-link mark is `tomboyInternalLink` with
   attr `target` = the destination title (`lib/editor/extensions/TomboyInternalLink.ts`).
   `parser.ts:collectLinks` reads `mark.attrs.target`. Inserting an **explicit
   marked** link (rather than plain text) makes the new bar resolve immediately on
   reparse — no wait for the deferred auto-link idle scan.
4. **Two host shapes.** Both dedicated hosts (`routes/note/[id]/+page.svelte`,
   `lib/desktop/NoteWindow.svelte`) hold the note body as `editorContent`
   (JSONContent) and persist via `updateNoteFromEditor(guid, doc, token)`. The
   in-body 묶음 instead has a live ProseMirror `view`.

## Decisions (from brainstorming)

- **Surfaces:** both the in-body `[ ]묶음:N` widget **and** the dedicated `묶음::`
  note. (Tab excluded; backlink overlay excluded — no host note to write to.)
- **Position:** insert as a **new top-level list item at the hovered bar
  boundary** (snap to the nearest top-level boundary; never insert inside a
  category / multi-link line).
- **Dup/self:** dropping a title already in the list, or the host note itself, is
  **silently skipped** (with a toast). No duplicate entries, no self-reference.
- **Insert result:** explicit `tomboyInternalLink` mark (immediate bar).
- **Body drops excluded:** dropping on the expanded body (the embedded editor)
  keeps the embedded editor's normal drop behavior (inserts into that note's
  text). The 묶음 list-insert drop zone is **bars + inter-bar gaps only**.

## Architecture

### Data flow

```
NoteDragHandle (window A)
  └─ dragstart: dataTransfer[application/x-tomboy-note-title] = title
        │
        ▼
NoteBundleCabinet bar-strip (window B / in-body host)
  ├─ dragover : MIME present → preventDefault, dropEffect='copy',
  │             dropActive=true, dropBoundary = top-level index from pointer-Y
  │             → cabinet highlight + insertion line
  ├─ dragleave/dragend → clear dropActive/dropBoundary
  └─ drop     : guard (skip self/dup) → insert
                 ├─ in-body  : insertBundleListItemLink(view, ordinal, boundary, title)
                 │             → view.dispatch(tr.insert(pos, listItem))
                 └─ dedicated: oninsertentry(boundary, title)
                               → host splices editorContent JSON + updateNoteFromEditor
        │
        ▼
docChanged (in-body) / editorContent change (dedicated)
  → reparse spec → new bar appears
```

### Component 1 — Parser: `srcTop` on entries (`lib/editor/noteBundle/parser.ts`)

`BundleEntry` gains `srcTop: number` — the index of the **top-level** structural
unit the entry descends from. This is the only mapping from a flattened bar back
to an insertion boundary.

- In-body `parseListInto(list, category, entries, topIndex?)`: thread a
  `topIndex` parameter. At the top-level call (from `parseEntries`), each
  `listItem`'s own `forEach` index is its `srcTop`; recursion into nested lists
  **inherits** the parent's `topIndex`. Every pushed entry carries
  `srcTop: topIndex`.
- Dedicated `parseDedicatedEntries(doc, start=1)` and its `parseListIntoJson`:
  `srcTop` = the **top-level body block index** (the block in `doc.content`,
  counting from the title line at 0). Nested lists inherit it.
- `buildSyntheticBundleSpec` (backlink overlay): entries get `srcTop: -1` — never a
  drop target (and the overlay won't pass an insert callback anyway).

Categories and multi-link lines therefore share a single `srcTop`, so the drop
indicator snaps to that line's top or bottom boundary.

### Component 2 — In-body insert: `insertBundleListItemLink` (`noteBundlePlugin.ts`)

New export, mirroring `writeBundleHeightPct`'s ordinal-relookup pattern:

```
insertBundleListItemLink(view, ordinal, boundary, title): boolean
```

- Re-look-up the bundle by `ordinal` on the **current** state (full-replacement
  contract — ordinals renumber).
- Walk the top-level bulletList at `[listPos, listEnd]`. Compute the document
  position for `boundary`:
  - `boundary < childCount` → start position of the `boundary`-th top-level
    `listItem`.
  - `boundary === childCount` → just after the last top-level item (append).
- Build the node from `view.state.schema`:
  `listItem(paragraph(text(title, [tomboyInternalLink{target: title}])))`.
- `view.dispatch(tr.insert(pos, listItem))`. `docChanged` reparses; the new bar
  appears immediately because the link is explicitly marked.
- Returns `false` (no-op) if the bundle/ordinal can't be resolved.

The dup/self guard lives in the cabinet (it has the resolved entry titles and
`hostGuid`), not in the plugin.

### Component 3 — Cabinet drop target + feedback (`NoteBundleCabinet.svelte`)

- New `$state`: `dropActive: boolean`, `dropBoundary: number | null`.
- Attach `dragenter`/`dragover`/`dragleave`/`drop` to each **bar** element through
  the existing `direct` action (delegation is barrier-blocked).
- `dragover`: if `dataTransfer.types.includes(NOTE_TITLE_DND_MIME)` →
  `e.preventDefault()`, `dt.dropEffect = 'copy'`, set `dropActive = true`, and
  compute `dropBoundary` from pointer-Y against the visible (`:not(.off)`) bar
  rects: pointer in a bar's top half → `bar.srcTop`; bottom half → `bar.srcTop + 1`.
- Visual feedback ("묶음이 반응"): a highlight class on the cabinet root +
  a thin insertion-line element rendered at `dropBoundary` (between the
  appropriate bars).
- `dragleave` (when leaving the cabinet root), `dragend`, and `drop` clear
  `dropActive`/`dropBoundary`.
- `drop`: read `title = dt.getData(NOTE_TITLE_DND_MIME)`; bail if empty.
  Shared guard:
  - resolve `lookupGuidByTitle(title)`; if `=== hostGuid` → **self**, toast +
    skip.
  - if `title` already in the resolved entry titles → **dup**, toast + skip.
  - else dispatch the insert by surface:
    - in-body (`view` present): `insertBundleListItemLink(view, spec.ordinal,
      dropBoundary, title)`.
    - dedicated (`view == null`): `oninsertentry?.(dropBoundary, title)`.

Drop zone is the bars only. The expanded body is **not** a list-insert target —
its embedded editor keeps its own drop behavior. In title-only mode (all bars, no
body) the whole cabinet is droppable.

### Component 4 — Dedicated host insert (`routes/note/[id]/+page.svelte`, `lib/desktop/NoteWindow.svelte`)

Both hosts add an `oninsertentry(boundary, title)` handler passed to the dedicated
`NoteBundleCabinet`:

- Build the new link node JSON:
  `{type:'listItem', content:[{type:'paragraph', content:[{type:'text', text:title,
   marks:[{type:'tomboyInternalLink', attrs:{target:title}}]}]}]}`.
- Splice `editorContent.content` at `boundary` (a top-level body block index,
  counting from the title line at 0):
  - If the block adjacent to the boundary is a `bulletList`, push the new
    `listItem` into it (avoid fragmenting into many one-item lists).
  - Else insert a new `{type:'bulletList', content:[listItem]}` at the boundary.
- Set `editorContent = newJson` (so `dedicatedSpec` reparses) and persist with
  `updateNoteFromEditor(note.guid, newJson, reloadToken)`. The note's title is
  unchanged, so there is no rename cascade.

`NoteWindow` passes `oninsertentry` only on its dedicated `NoteBundleCabinet`
branch (alongside `onwindowdrag`). The route passes it on its dedicated cabinet
branch too. The dup/self guard already ran in the cabinet before the callback
fires.

## Invariant change

`noteBundle` has been strictly **view-layer — list never mutated** until now. This
feature introduces the **first deliberate list mutation**, and it is narrow:
> The only write to the underlying note structure is the drag-drop insert, which
> **appends a single internal-link list item** at a top-level boundary. No
> reorder, no delete, no edit of existing items. All other state (active index,
> window, mode, sessions) remains ephemeral and never written back.

Both `CLAUDE.md`'s notebundle row/invariants and the `tomboy-notebundle` skill
body must be amended to record this.

## Documentation (required)

Per `CLAUDE.md`, a new user-facing capability must appear in 설정 → 가이드. Add a
`<details class="guide-card">` under the **editor** sub-tab in
`routes/settings/+page.svelte`: short `<summary>`, one `<p class="info-text">`
intro ("데스크탑에서 노트 왼쪽 아이콘을 묶음 위로 드래그하면 리스트에 추가됨"), and a
`<ul class="guide-list">` covering the constraints (desktop-only, 묶음 전용 — 탭
제외, 바 위에만 드롭, 중복/자기 자신은 무시, 인-바디 묶음 + 전용 묶음:: 노트 둘 다).

## Testing

- `parser.test.ts` — `srcTop` correctness: top-level leaves, nested category
  children inheriting the parent's `srcTop`, multi-link line sharing one `srcTop`,
  dedicated body-block index, `buildSyntheticBundleSpec` `srcTop:-1`.
- `noteBundlePlugin.test.ts` — `insertBundleListItemLink`: insert at a middle
  boundary, append at `childCount`, the new item carries a `tomboyInternalLink`
  with the right `target`, ordinal re-lookup after renumber, no-op on bad ordinal.
- No component test (consistent with the rest of noteBundle). Manual verification
  via `npm run dev`: a `묶음:` host note in a `NoteWindow`, drag another window's
  handle over the bars (highlight + insertion line), drop (new bar at the boundary);
  repeat for a `묶음::` dedicated note; confirm dup/self are skipped; confirm
  dropping on the expanded body still edits that note (not the list).

## Out of scope

- Tab cabinet (`NoteBundleStack`).
- Backlink temporary overlay.
- Reordering / deleting existing bars via drag.
- Mobile drag source (the handle is desktop-only; cabinet listeners are harmless
  no-ops on mobile).
- Dropping onto the expanded body inserting into the list (stays embedded-editor
  drop).
