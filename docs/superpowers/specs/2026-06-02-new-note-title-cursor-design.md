# New-note title selection vs. body cursor

**Date:** 2026-06-02
**Status:** Approved

## Problem

When creating a new note, the title slot is unhelpful by default:

- A note with **no title** gets an auto-generated `yyyy-mm-dd HH:mm` title. The user
  almost always wants to type their own title, so they must first delete the whole
  auto-date — a chore.
- A note created with a **title already chosen** (extract-to-note, go-to-today,
  link-creation) drops the cursor nowhere useful; the user wants to start writing the
  body.

## Goal

On note **creation** only (never on reopen):

- **Auto-generated date title** → select the entire title so one keystroke replaces it.
- **Explicit (pre-set) title** → place the cursor at the start of line 3 (the line after
  the line-2 placeholder) so the user starts writing the body.

Applies to both the mobile single-note route (`/note/[id]`) and the desktop
`NoteWindow`.

## Distinguishing signal

The two cases map **exactly** to whether `initialTitle` was passed to
`createNote()` (`lib/core/noteManager.ts`):

- `createNote()` (no arg) → auto date title → `selectTitle`
- `createNote(title)` → explicit title → `bodyCursor`

So `createNote` itself classifies the intent — no caller changes.

## Mechanism — transient intent map (chosen over query-param / heuristic)

New module `lib/core/newNoteIntent.ts`:

```ts
export type NewNoteIntent = 'selectTitle' | 'bodyCursor';
const pending = new Map<string, NewNoteIntent>();
export function setNewNoteIntent(guid: string, intent: NewNoteIntent): void;
export function consumeNewNoteIntent(guid: string): NewNoteIntent | undefined; // delete-on-read
```

- `createNote` records the intent keyed by the new guid.
- The editor consumes it once, keyed by guid, when the note first loads.
- Not persisted: a hard page reload is not a fresh creation, so dropping the entry is
  correct. Reopening an existing note has no entry → no-op → current "no auto-focus"
  behavior preserved.

Rejected alternatives: **query param** (`?new=…`) pollutes the URL, collides with
`?from=`, and doesn't reach the desktop `NoteWindow` (no route); **content heuristic**
(detect date-shaped title) misfires on user-created date-titled notes.

## Editor hook — one place covers both surfaces

Both surfaces render the shared `TomboyEditor.svelte`. Its content-sync `$effect`
(currently ~line 907) already runs once per note-load, in two branches:

1. first-run seed branch (editor initialised with the note already), and
2. the `setContent` branch (navigating between notes in a reused editor).

Add `applyNewNoteIntent(editor, guid)` to **both** branches. It:

1. `consumeNewNoteIntent(guid)`; return if none.
2. Defer one rAF/microtask so the PM view has settled (avoids a mobile focus/layout
   race), then:
   - `selectTitle`: select the whole first top-level block (`from = 1`,
     `to = 1 + doc.firstChild.content.size`), then `focus()`.
   - `bodyCursor`: cursor at the start of the 3rd top-level block (index 2 — the line
     after the line-2 placeholder), then `focus()`. If the doc has fewer than 3 blocks,
     clamp to end of doc.

Auto-focus on creation is intentional (pops the mobile keyboard immediately so the user
can type at once).

## Files

1. **New** `app/src/lib/core/newNoteIntent.ts`
2. `app/src/lib/core/noteManager.ts` — `createNote` sets the intent
3. `app/src/lib/editor/TomboyEditor.svelte` — `applyNewNoteIntent` + calls in both branches
4. `app/src/routes/settings/+page.svelte` — 가이드 → editor sub-tab `<details class="guide-card">`

## Tests

- `app/tests/unit/lib/core/newNoteIntent.test.ts` — set/consume, delete-on-read, missing key.
- Extend `noteManager` test — `createNote()` records `selectTitle`; `createNote('X')`
  records `bodyCursor`.
