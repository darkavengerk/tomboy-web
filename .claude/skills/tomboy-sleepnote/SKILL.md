---
name: tomboy-sleepnote
description: Use when working on slip-note (sleepnote) features — the `[0] Slip-Box` linked-list of notes rooted at the fixed index note. Covers the strict slip-note format, index-note traversal via 이론/실용/기록 sections, the validator module (`lib/sleepnote/validator.ts`), and the `/admin/sleepnote` tab.
---

# Slip-Note (슬립노트) linked-list

"Slip-notes" are the notes that live in the **`[0] Slip-Box`** notebook and
form a set of linked-list chains rooted at a fixed index note. The linked-list
structure is what lets future automation (splicing, bulk renames, reorders,
move-to-chain) manipulate the chain mechanically — so the format is enforced
by `lib/sleepnote/validator.ts` and a UI at `/admin/sleepnote`.

The `/sleepnote` mobile route and this feature are related but not the same
thing: `/sleepnote` is the single-note landing page that redirects to the
index note. The slip-note *feature* is the linked-list / graph of notes that
the index note points into.

## The index note

Fixed GUID: **`1c97d161-1489-4c32-93d9-d8c383330b9c`**
(same GUID used by the `/sleepnote` route). The index note's body is *not* in
slip-note format — it is a free-form hub with three section headings:

- `이론`
- `실용`
- `기록`

Immediately after each heading is a `<list>` whose items contain
`<link:internal>` anchors pointing to the HEAD of a topic chain. A topic can
have zero or more HEADs; each HEAD is the first note in a `이전`/`다음`
chain.

A HEAD's target note does **not** have to live in `[0] Slip-Box` — real
chains start from date-titled notes too (e.g. `2025-10-31 11:08 메타인지`).
The linked-list format is what matters, not notebook membership.

**Slip-note title filter.** The index also contains internal links that are
*not* slip-note HEADs — they're regular notes that happen to be mentioned for
context (e.g. `File-Box::start-here`, `자작글 모음`, `글감`). The checker
only walks links whose title matches one of two patterns:

- `Slip-Box::...` — the historical numbered chain prefix.
- `yyyy-mm-dd HH:mm ...` — date-time titled notes (e.g. `2025-10-31 11:08 메타인지`).

`isSlipNoteTitle(title)` in the validator is the authoritative predicate.
Chain traversal also stops silently when a `다음:` link crosses into a
non-slip-note title (so linking out to a free-form reference note is not
treated as a chain break).

## Slip-note format

Every note reachable from a HEAD (and, by convention, every note in `[0]
Slip-Box`) must have this block structure:

```
제목
(공백)
이전: 없음 | <link:internal>prev title</link:internal>
다음: 없음 | <link:internal>next title</link:internal>
(공백)
본문 ...
```

Rules:

- **Block 0**: title paragraph, text must equal `note.title`.
- **Block 1**: empty paragraph.
- **Block 2**: paragraph starting with `이전:` (optional whitespace around
  the colon). The value is either empty, the literal `없음`, or a single
  `tomboyInternalLink` inline. Nothing else allowed on the line.
- **Block 3**: same rules with `다음:`.
- **Block 4**: empty paragraph.
- **Block 5+**: free-form body.

HEAD-specific: `이전` must be `none` (empty or `없음`). TAIL-specific:
`다음` must be `none`. Middle notes have `이전` = link to the previous, and
`다음` = link to the next. The whole chain is reached by following `다음`
until it becomes `none`.

## Validator module

`app/src/lib/sleepnote/validator.ts`. Pure TypeScript, uses
`deserializeContent` from `core/noteContentArchiver` to parse a note's
`xmlContent` into TipTap blocks.

Public API:

- `SLIPBOX_NOTEBOOK = '[0] Slip-Box'` — notebook tag value.
- `INDEX_NOTE_GUID` — fixed index note GUID.
- `SECTION_HEADINGS = ['이론', '실용', '기록']`.
- `isSlipNoteTitle(title)` — `/^Slip-Box::/` or `/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/`.
- `validateSlipNoteFormat(note)` — block-layout check on one note. Returns
  `{ issues, prev, next }`. Does NOT touch chain integrity — no DB reads.
- `extractHeadsFromIndex(xml)` — walks the three sections' bullet lists and
  collects every `tomboyInternalLink` target as a HEAD. Deduped on
  `(section, title)`.
- `validateSlipBox()` — end-to-end: loads notes from IDB, extracts heads,
  walks each chain by title lookup, validates each visited note, and
  reports Slip-Box notes that no chain reached.

Issue codes returned by `validateSlipNoteFormat`:
`TOO_SHORT`, `TITLE_NOT_PARAGRAPH`, `TITLE_MISMATCH`,
`MISSING_BLANK_AFTER_TITLE`, `PREV_INVALID`, `NEXT_INVALID`,
`MISSING_BLANK_BEFORE_BODY`. `validateSlipBox` adds `HEAD_HAS_PREV_LINK`
for nodes that are a chain's first-visited but whose `이전` is a link.

Title lookup in `validateSlipBox` is **case-insensitive on trimmed title**,
against *all* notes (not just `[0] Slip-Box`), because HEADs can point to
date-titled notes. First-write-wins on duplicate titles; `getAllNotes`
sorts by `changeDate` desc, so the freshest wins.

Loop detection is per-chain (`chainVisited`). Cross-chain revisits are
reported as "다른 체인에서 이미 방문됨" but the chain keeps walking so the
format of the remaining notes is still validated.

## Admin UI

`/admin/sleepnote` — one of the tabs under the admin layout, between
`파일 탐색` and `도구`. The page has a single "형식 검사" button that calls
`validateSlipBox()` and renders — **problem-focused** — in three stacked
blocks when issues exist:

1. **체인 구조 문제** — chain-level failures (broken `다음` link, loops,
   HEAD note not found). One line per issue with its section + HEAD context.
2. **형식 오류 노트** — a single flat table of every node (across all chains)
   whose format check failed. Columns: 섹션, HEAD, 제목, 이전, 다음, 문제.
   HEAD / TAIL tags appear inline next to the title.
3. **도달 불가 노트** — Slip-Box notes no chain reached. Shown even when
   they have no format issues (being unreachable *is* the issue).

Clean notes are not rendered at all — if everything is valid the page just
shows the "모든 슬립노트가 형식에 맞습니다" notice. Every note title links
to `/note/{guid}`.

The existing admin "mobile-first / `clamp(...)` does not apply" rule
(documented in `tomboy-admin`) applies here too — this page targets desktop.

## Tests

`app/tests/unit/sleepnote/validator.test.ts` — pure tests for
`validateSlipNoteFormat` and `extractHeadsFromIndex`. No IDB setup needed
since those two functions are pure.

## Future automation (not yet implemented)

The validator is the groundwork for upcoming mechanical operations:

- Insert a new note between two existing notes (rewrite prev/next on both
  neighbors and on the inserted note).
- Move a note to a different chain (detach from old neighbors, attach at
  the new position).
- Bulk rename: update all `이전:` / `다음:` links that point to the
  renamed note.
- Reorder within a chain.

Any such feature should refuse to operate on a chain that currently fails
validation — otherwise an already-broken chain can drift into
unrecoverable states.
