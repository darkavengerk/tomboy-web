---
name: tomboy-autolink
description: Use when working on the editor's auto internal-link detection (app/src/lib/editor/autoLink/). Covers findTitleMatches text rules, titleProvider invalidation, autoLinkPlugin reconciliation, self-link suppression, and known scope limitations.
---

# Auto-link detection

Like the original Tomboy desktop app, text typed in the editor is automatically
turned into an internal link whenever it matches the title of another existing
note. The feature lives under `app/src/lib/editor/autoLink/`:

- `findTitleMatches.ts` — pure, exhaustively tested text-matching utility.
  Unicode-aware word boundaries (`\p{L}\p{N}_`) so ASCII and CJK behave
  consistently. Longest title wins on overlap. Case-sensitive (trimmed exact
  match) with the original casing preserved on the resulting `target`. Titles
  are treated as literal strings (regex special chars are escaped), so titles
  like `C++` work. The `excludeGuid` option still keeps the excluded title in
  the candidate pool so it claims its matched region (preventing a shorter
  overlapping title from linking inside the current note's own title); only
  the emit step is suppressed. On duplicate titles that violate the global
  uniqueness invariant, the non-excluded entry wins.
- `titleProvider.ts` — subscribes to `noteListCache.onInvalidate` so the title
  list stays current when notes are created / renamed / deleted elsewhere.
  Returns the full title list; current-note filtering lives inside
  `findTitleMatches` via its `excludeGuid` option.
- `autoLinkPlugin.ts` — ProseMirror plugin installed by `TomboyInternalLink`.
  Its `appendTransaction` scans only changed block ranges (or the whole doc
  on `{refresh, full}` meta), reconciles `tomboyInternalLink` marks, and uses
  a `{skip:true}` meta flag to prevent infinite loops. Text inside
  `tomboyUrlLink` / `tomboyMonospace` / `code` marks is skipped.
  **Reconciliation policy (length-priority greedy)**: for each text run,
  three candidate-span sources go into one pool:
  (a) autolink matches against the title list (kindRank 0, target = title);
  (b) valid existing `tomboyInternalLink` spans — span text still equals the
  mark's `target` AND that target is a known title when titles are loaded
  (kindRank 1); (c) self-title "claim" regions obtained by matching only the
  current note's own title entries (kindRank 2, target = null). The pool is
  sorted by length desc, ties broken by kindRank asc, and greedily assigned.
  Any span overlapping an already-assigned char is dropped. Result: a longer
  autolink match replaces a shorter manually-linked span, a longer existing
  link survives a shorter new autolink, and the current note's own title
  blocks any shorter link inside it. Stale existing spans (text diverged
  from target, or target unknown once titles are loaded) are omitted from
  the pool and their marks get stripped by the emit loop.
- `TomboyEditor.svelte` accepts a `currentGuid?` prop; `routes/note/[id]/+page.svelte`
  passes it through so self-linking is suppressed. The provider dispatches a
  `{refresh:true}` meta transaction via `autoLinkPluginKey` whenever the note
  list changes.

Scope notes:

- Only the *currently open* note is updated live. If a note is renamed while
  another note is not open, that other note's stored body is not rewritten —
  its links reconcile on the next edit. (Out of scope for this pass; mirrors
  Tomboy's `NoteRenameWatcher` only partially.)
- `<link:broken>` serialization still comes from the archiver; the plugin does
  not currently flip `broken:true` based on missing targets while editing.

Tests for this feature live in `app/tests/unit/editor/`:
`findTitleMatches.test.ts`, `titleProvider.test.ts`, `autoLinkPlugin.test.ts`,
and `autoLinkRoundtrip.test.ts`.
