# New-note result panel + whole-corpus link sweep

**Date:** 2026-06-14
**Status:** Approved

## Problem

Creating a new note feels "instant, then janky for a long while." Two distinct issues:

1. **The progress popup lied about completion.** `newNoteFlow` (`lib/stores/newNoteFlow.svelte.ts`)
   closed the popup the instant `onnoteready` fired, but `onnoteready` was emitted one
   `requestAnimationFrame` after `setContent` — before the editor's first paint + plugin
   decoration pass. *(Already fixed: `signalNoteReadyAfterPaint` double-rAF in
   `TomboyEditor.svelte`. This spec does not re-litigate it.)*

2. **The real sustained cost is invisible and unmeasured.** When a note is created, the new
   title changes the global title set, which broadcasts (`titleProvider.onInvalidate` →
   per-editor `scheduleAutoLinkScan({full:true})`) and makes **every currently-open editor**
   re-scan its whole document against ~all titles (`findTitleMatches` is O(D×T)). On a desktop
   multi-window workspace with thousands of notes this is the multi-hundred-ms-to-second stutter
   the user feels, ~1–1.5s *after* the popup is already gone. None of it is shown or timed.

The user's actual request was **not** "make it faster" — it is **"keep the popup open and run/show
the work that accompanies note creation, with per-task timing,"** and to add a deliberate,
informed way to propagate the new title across the corpus.

## Goal

Turn the new-note popup from a fire-and-close progress dialog into a **persistent result panel**:

- After create + index + open complete, the popup **does not auto-close**. It shows the completed
  stages with elapsed times, and a follow-up action. The user dismisses it manually (option **A** —
  always stays open, no toggle).
- Add a **"전체 문서에 이 제목 반영"** action: a whole-corpus sweep that links the new note's title
  into every existing note that mentions it (so those notes resolve as backlinks of the new note).
- The sweep is **two-phase with a confirmation gate**: first count how many notes *would* be
  updated, show **"N개 노트가 업데이트됩니다"**, and only write after the user confirms — so the
  blast radius (and its sync side-effect) is seen before any commit.
- **Eliminate the silent post-creation stutter** by **delta-gating** the automatic per-editor
  rescan: an open editor only re-scans when a newly-added title's text actually appears in its
  document (most don't → skip). This is the fix for the original ~1.5s sustained jank (#4).

Non-goals: sweeping the whole corpus automatically on every creation; corpus sweep for
renames/deletes (creation only); making the autolink *matcher itself* faster (we skip unnecessary
scans, we do not speed up a scan that does run).

## Behavior overview

Inside the result panel, after a note is created:

```
[단계 결과 + ms]              ← 노트 생성 / 인덱스 갱신 / 에디터 열기 (기존 3단계, 이미 측정됨)
[전체 문서에 이 제목 반영]    ← button
   → count (진행률)           ← scan corpus, no writes
   → "N개 노트가 업데이트됩니다"  [적용] [취소]
   → apply (진행률 M/N + ms)  ← write only on 적용
   → "M개 완료 (xxx ms[, K 실패])"
[닫기]                         ← dismiss()
```

`취소` at the gate returns to the result view with nothing written. The sweep is **cancelable**
mid-count and mid-apply.

## Architecture — `newNoteFlow` state machine

Extend `phase` from `'idle' | 'input' | 'creating'` to add **`'result'`**.

- The current `finally { phase = 'idle' }` in `submit()` becomes `phase = 'result'` (success) — the
  flow no longer tears itself down on completion. Failure (stage 0–2 throw) keeps the existing
  catch → toast → `phase = 'idle'`.
- `result` state holds: the completed `stages[]` (with `ms`), plus a `sweep` sub-state:
  `{ status: 'idle' | 'counting' | 'confirm' | 'applying' | 'done', scanned, total, matched, updated, failed, ms, cancelRequested }`.
- New methods on the store:
  - `startSweepCount()` → `flushAll` (see below) then run count, populate `matched`/`total`,
    transition `counting → confirm`.
  - `applySweep()` → run apply over the matched guids, transition `confirm → applying → done`.
  - `cancelSweep()` → sets `cancelRequested`; count discards, apply stops and reports partial.
  - `dismiss()` → `phase = 'idle'`, clear all state (`stages`, `sweep`, `navigateFn`, guids).

The double-rAF `onnoteready` fix stays: it still governs when the "에디터 열기" stage is marked done;
the panel simply persists afterward instead of closing.

## Components (small, single-purpose units)

| Unit | Responsibility | Depends on |
|---|---|---|
| `newNoteFlow.svelte.ts` (extend) | State machine + sweep orchestration; no DOM | `linkSweep`, `noteStore`, `desktopSession`, `noteReloadBus` |
| `NewNoteResultPanel.svelte` (new) | Render result view: stages+ms, sweep button, count/confirm/apply progress, close. Pure view over `newNoteFlow`. | `newNoteFlow`, `portal` |
| `+layout.svelte` (extend) | Add `{:else if newNoteFlow.phase === 'result'}` to the existing phase block (`:374`) → render `NewNoteResultPanel`. | — |
| `lib/core/linkSweep.ts` (new, headless) | `countLinkSweep` / `applyLinkSweep` over the corpus; cancel token; progress callback. No Svelte, no DOM. | `noteStore`, `noteContentArchiver`, `linkifyDocJson` |
| `lib/editor/autoLink/linkifyDocJson.ts` (new) | Pure **additive** linker over plain `JSONContent`: `addInternalLinksForTitle(docJson, title, targetGuid, suppressMarks) → { docJson, changed }`. Walks textblocks, skips the title line + suppressed/code spans + text already inside an internal-link mark, runs `findTitleMatches` for the one title, adds the `tomboyInternalLink` mark on fresh matches. **No PM schema** (operates on JSON, not a PM `Node`); `autoLinkPlugin` is left unmodified. Matching consistency comes from sharing the pure `findTitleMatches`. | `findTitleMatches` |

`NoteTitleDialog.svelte` stays focused on `input` + `creating` only; the result view is its own
component (separation of concerns; the result panel's interaction model is materially different).

## Data flow

1. `[전체 문서에 이 제목 반영]` → `startSweepCount()`:
   - `await desktopSession.flushAll()` first — persist any unsaved edits in open windows so the
     count/apply read the latest content (CLAUDE.md cross-window mutation pattern).
   - `countLinkSweep(title, newGuid, { onProgress, cancelToken })`:
     - List all notes (`noteStore.getAllNotes()` / warm cache).
     - **Cheap prefilter:** skip unless `note.xmlContent.includes(title)` (and not deleted, not
       `newGuid`). A unique new title yields few candidates → most notes never get parsed.
     - For each candidate: `deserializeContent(xml)` → `addInternalLinksForTitle(json, title,
       newGuid, suppress)` → if `changed`, record the guid (count phase discards the new json).
     - Returns `{ matched: guid[], total: candidatesScanned }`. Panel shows "N개".
2. `[취소]` → `cancelSweep()` → back to result, no writes.
3. `[적용]` → `applySweep()`:
   - For each matched guid: load note, `deserializeContent` → `addInternalLinksForTitle` → `serializeContent`
     → `noteStore.putNote` (this also updates the in-memory backlink index per the backlink-index
     contract) → `noteMutated(note)`. Collect `updated` / `failed`, report progress M/N.
   - After (or on cancel, for the subset written): `emitNoteReload(written)` +
     `desktopSession.reloadWindows(written)` so open editors of swept notes drop stale docs and
     reload. Panel shows "M개 완료 (xxx ms)".
4. `[닫기]` → `dismiss()`.

## Matching / link insertion detail

- **Shared matcher (consistency where it matters):** title matching uses the *same pure*
  `findTitleMatches` the editor plugin uses (word boundaries, longest-title-wins, exact case). The
  sweep is **additive only** — it adds internal-link marks for the one new title — so it deliberately
  does NOT replicate `applyInRange`'s full reconcile (stale removal, self-claim regions, existing-mark
  validation). The JSON walker mirrors `applyInRange`'s run-building (concat a textblock's text
  children) and skip rules (title line when the doc has a body; chars under suppressed marks).
- **Idempotent:** before adding, any text span already covered by a `tomboyInternalLink` mark is
  skipped. So a note already linked (e.g. auto-linked while open) yields 0 changes, and re-running the
  sweep adds nothing.
- **No PM schema, plugin untouched:** operates on plain `JSONContent` (the shape
  `serializeContent` / `deserializeContent` already use) — no headless editor schema, no
  `autoLinkPlugin` / `TomboyEditor` refactor.
- **Self / blank skip:** the new note itself (`targetGuid`) and the note's own title line are never
  linked; the `tomboyInternalLink` mark stores the title text (`attrs.target`), matching the editor.

## Error handling

- **Cancelable:** a cancel flag is checked between notes. Count → discard results. Apply → stop,
  `emitNoteReload`/`reloadWindows` for the subset already written, report partial "M / N".
- **Per-note failure** (parse / serialize / write throws): skip that note, increment `failed`,
  continue (no abort). Final line shows "M개 완료, K개 실패".
- **Create failure** (stage 0–2): unchanged — existing catch → toast → `phase = 'idle'`.

## Side effects (surfaced, intentional)

Swept notes become `localDirty` → uploaded on the next manual Dropbox "지금 동기화"; if Firestore
realtime sync is on, each fires a debounced push. The **count + confirm gate** is exactly the
mechanism that shows the user this blast radius (N notes) before any write happens.

## Narrowing the automatic per-editor rescan (delta-gated)

Root cause of the original sustained stutter: creating a note changes the title set, and **every**
open editor runs `scheduleAutoLinkScan({full:true})` (`TomboyEditor.svelte:1147`) — a deferred
(~1–1.5s) O(D×T) whole-doc rescan against ALL ~T titles. With thousands of titles and several open
windows, that batch is the jank, landing well after the popup is gone.

Fix: gate the rescan on a cheap delta precheck so editors that cannot be affected skip entirely,
while keeping a **full, correct** reconcile for the few that can.

1. `titleProvider.doSharedRefresh` already detects whether the set changed (`entriesEquivalent`).
   Extend it to compute the **delta** `{ added: TitleEntry[], removed: TitleEntry[] }` (old
   `sharedEntries` vs `next`) and pass it to listeners. The `onChange(cb)` callback signature becomes
   `(delta?) => void` — backward-compatible (existing consumers — date adjacency, slip set — ignore
   the arg and are unaffected).
2. A pure helper `shouldRescanForDelta(delta, docText) → boolean` (testable in isolation):
   - `delta.removed.length > 0` → **true** (a removed/renamed title may have a stale mark to
     reconcile/unlink — preserve today's correctness).
   - else if `delta.added` non-empty and **none** of the added titles' text occurs in `docText`
     → **false** (skip).
   - else → **true**.
3. `TomboyEditor`'s `titleProvider.onChange` handler calls `shouldRescanForDelta(delta,
   ed.state.doc.textContent)` and only `scheduleAutoLinkScan({full:true})` when true. `textContent`
   is the same text the scanner flattens, so no false negatives.
4. When a scan *does* run it is unchanged (full title set, `applyInRange`) → overlap /
   longest-title-wins / suppressed-mark correctness all preserved. Only the **decision to scan** is
   narrowed.

Effect on a create (pure addition of one unique title): editors whose doc doesn't contain that title
skip → the O(N×D×T) batch collapses to the few editors that actually mention the new title. The new
note's own editor self-excludes its title via `findTitleMatches`' `excludeGuid`.

This composes with the sweep: the automatic path links *open* editors that mention the new title
immediately (cheap); the explicit sweep propagates to the *entire corpus* (incl. closed notes) on
demand. The sweep's `flushAll` + idempotent `addInternalLinksForTitle` mean the two never
double-link even if both touch the same open note.

## Files

1. **New** `app/src/lib/editor/autoLink/linkifyDocJson.ts` — pure additive JSON linker
   `addInternalLinksForTitle(docJson, title, targetGuid, suppressMarks)`, reusing `findTitleMatches`.
   (`autoLinkPlugin.ts` is NOT modified — 1b shares the matcher, not the PM reconcile.)
2. **New** `app/src/lib/core/linkSweep.ts` — `countLinkSweep` / `applyLinkSweep`.
3. `app/src/lib/stores/newNoteFlow.svelte.ts` — add `'result'` phase + sweep orchestration methods.
4. **New** `app/src/lib/components/NewNoteResultPanel.svelte` — result/sweep UI.
5. `app/src/routes/+layout.svelte` — `result` phase branch renders the panel.
6. `app/src/routes/settings/+page.svelte` — 가이드 → `notes` sub-tab
   `<details class="guide-card">` documenting the result panel + 전체 문서 반영 (CLAUDE.md guide rule).
7. `app/src/lib/editor/autoLink/titleProvider.ts` — compute + broadcast `{ added, removed }` delta;
   `onChange` callback signature `(delta?) => void` (backward-compatible).
8. **New** `app/src/lib/editor/autoLink/shouldRescanForDelta.ts` — pure delta-gate predicate.
9. `app/src/lib/editor/TomboyEditor.svelte` — delta-gate the `titleProvider.onChange` rescan via
   `shouldRescanForDelta(delta, ed.state.doc.textContent)`.

## Tests

- `app/tests/unit/.../linkifyDocJson.test.ts` — pure additive linker: adds mark on a whole-word
  match; no-op when no match; **idempotent** when the span already has the mark; skips the title line
  (multi-block doc); skips text under suppressed marks (monospace/url); leaves `attrs.target` = title.
- `app/tests/unit/.../linkSweep.test.ts` (fake-indexeddb) — seed notes (matching / non-matching /
  already-linked / deleted / the new note itself); count returns the correct guid set; apply marks
  only matches; **idempotent** on re-run; new note excluded; backlink index updated; cancel yields a
  valid partial; per-note failure is skipped not fatal.
- `app/tests/unit/.../newNoteFlow.test.ts` (extend) — `submit` → `result` persists (no auto-close);
  `startSweepCount` → `confirm`; `applySweep` → `done`; `cancelSweep`; `dismiss` clears state.
- `app/tests/unit/.../shouldRescanForDelta.test.ts` — removed non-empty → true; added present in
  docText → true; added absent from docText → false; empty added+removed → false.
- `app/tests/unit/.../titleProvider.test.ts` (extend) — `doSharedRefresh` computes correct
  `{added, removed}` on create / rename / delete; broadcasts the delta; no broadcast when unchanged.
