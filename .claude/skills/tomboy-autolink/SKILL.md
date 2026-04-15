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
  consistently. Longest title wins on overlap. Case-insensitive match with the
  original casing preserved on the resulting `target`. Titles are treated as
  literal strings (regex special chars are escaped), so titles like `C++` work.
- `titleProvider.ts` — subscribes to `noteListCache.onInvalidate` so the title
  list stays current when notes are created / renamed / deleted elsewhere. Per
  editor it can be configured with an `excludeGuid` so the current note never
  auto-links to itself.
- `autoLinkPlugin.ts` — ProseMirror plugin installed by `TomboyInternalLink`.
  Its `appendTransaction` scans only changed block ranges, reconciles
  `tomboyInternalLink` marks to match the desired set, and uses a meta flag
  (`autoLinkPluginKey` + `{skip:true}`) to prevent infinite loops. Text inside
  `tomboyUrlLink` or `tomboyMonospace` marks is deliberately skipped.
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
