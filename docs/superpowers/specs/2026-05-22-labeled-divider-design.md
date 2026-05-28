# Labeled Divider — Design

**Date:** 2026-05-22
**Status:** Approved

## Summary

A new editor plugin that renders a labeled horizontal divider — a divider
line with text embedded in it. It is the text-bearing sibling of the existing
`---` horizontal rule. Two layouts:

- **Centered** — `-- 회의록 --` → label drawn in the middle of the line.
- **Left** — `회의록 ---` → label near the left, with a short line stub
  before it and a long line after.

```
centered:  ──────────────  회의록  ──────────────
left:      ──  회의록  ─────────────────────────────
```

## Background

The Tomboy editor has no real `horizontal_rule` node. An HR is a plain
top-level paragraph whose entire trimmed text is 3+ dashes (`isDashParagraph`
in `hrSplitPlugin.ts`). `hrSplitPlugin` decorates such paragraphs with the
`tomboy-hr-marker` class; CSS (`TomboyEditor.svelte:1301`) hides the literal
`---` text and paints a thin grey line via a `::before` pseudo-element. The
literal markup stays in the paragraph, so it round-trips through Tomboy XML,
Firebase sync, and Dropbox sync with zero special handling.

The labeled divider follows the same philosophy exactly: a plain paragraph
storing literal markup, rendered via decorations. No schema change, no new
node, no serialization work.

## Goals

- Type `-- text --` → centered labeled divider; type `text ---` → left
  labeled divider. Transformation is live, the moment the pattern matches
  (same as `---`).
- Visually consistent with the existing `tomboy-hr-marker` line.
- Coexists cleanly with `hrSplit` (a labeled divider is a normal block, not
  an HR marker — see Non-Goals).

## Non-Goals

- A labeled divider is **not** Ctrl+click-toggleable into an `hrSplit`
  column divider. `isDashParagraph` returns false for it (its text is not
  pure dashes), so `hrSplit` already classifies it as a normal `block` —
  the two features coexist with no extra code.
- The label is plain text only — no inline marks (bold, links) inside it.
- No right-aligned variant.
- No mobile/desktop gate; the divider renders everywhere.

## Architecture

Two files under `app/src/lib/editor/labeledDivider/`, plus CSS + plugin
registration in `TomboyEditor.svelte`.

### `parseLabeledDivider.ts` — pure parser

A pure, unit-testable function. No ProseMirror dependency.

```ts
interface LabeledDivider {
  align: 'center' | 'left';
  label: string;          // trimmed label text
  // Character ranges within the input string (half-open [start, end)).
  // Used by the plugin to map onto doc positions for inline decorations.
  leadMark: [number, number] | null;  // leading dash run + trailing space
  trailMark: [number, number];        // leading space + trailing dash run
  labelRange: [number, number];       // the visible label
}

function parseLabeledDivider(text: string): LabeledDivider | null;
```

Matching rules (operating on the **untrimmed** paragraph text so offsets are
exact; outer whitespace is folded into the adjacent mark range):

1. **Centered** — matches `^\s*-{2,}\s*(.+?)\s*-{2,}\s*$`. Checked first.
2. **Left** — matches `^\s*(.+?)\s*-{3,}\s*$`, and the captured label must
   **not** start with a dash. Checked second.
3. The captured label must contain at least one non-dash, non-whitespace
   character. This rejects a pure `------` HR (whose inner capture would be
   all dashes) so HRs are never mis-parsed.
4. No match → return `null`.

Centered requires 2+ dashes on each side; left requires 3+ trailing dashes —
matching the syntax the user specified.

### `labeledDividerPlugin.ts` — ProseMirror plugin

A decoration-only plugin (`props.decorations`), structured like
`hrSplitPlugin`. On each state, it walks the **top-level children** of the
doc:

- Skip indices 0 and 1 (title + subtitle/date lines), consistent with
  `hrSplit`'s `HEADER_COUNT`.
- For each remaining paragraph, run `parseLabeledDivider(node.textContent)`.
- On a match, emit decorations (positions derived from the paragraph's
  content start = `paragraphPos + 1`):
  - **Node decoration** — class `tomboy-labeled-divider` plus
    `tomboy-labeled-divider--center` or `--left`.
  - **Inline decoration** on `leadMark` (if present) and `trailMark` —
    class `tomboy-labeled-divider-mark` (collapses the dashes to zero width).
  - **Inline decoration** on `labelRange` — class
    `tomboy-labeled-divider-label` (the visible, styled label).

Registered as its own `Extension.create({ name: 'tomboyLabeledDivider',
addProseMirrorPlugins() { ... } })` in the editor's extension list, next to
`tomboyHrSplit`.

### CSS (in `TomboyEditor.svelte`, beside the `tomboy-hr-marker` rules)

- `.tomboy-labeled-divider` — `position: relative`; a full-width `::before`
  pseudo-element draws the thin grey line, reusing the exact gradient and
  `#b0b0b0` colour of `tomboy-hr-marker::before`.
- `.tomboy-labeled-divider--center` — label centered (`text-align: center`).
- `.tomboy-labeled-divider--left` — label left, with a small `padding-left`
  so a short line stub shows before it.
- `.tomboy-labeled-divider-mark` — `font-size: 0` so the dash runs occupy
  zero width (a long trailing run must not shift layout). Caret still
  steppable.
- `.tomboy-labeled-divider-label` — `position: relative`; muted grey text,
  slightly smaller, small horizontal padding, and an **opaque background
  matching the editor background** so the label punches a gap through the
  line drawn behind it.

## Data Flow

```
user types "-- 회의록 --"
   → paragraph.textContent becomes "-- 회의록 --"
   → labeledDividerPlugin re-runs on the new state
   → parseLabeledDivider returns { align:'center', label:'회의록', ranges }
   → plugin emits node + inline decorations
   → CSS renders line + centered label; literal markup stays hidden
```

The literal `-- 회의록 --` text is the persisted form. It is saved, synced,
and reloaded as ordinary paragraph text — identical to how `---` is handled
today.

## Editing Behavior

- The dash markup stays hidden (zero width) even while editing, matching the
  `hrSplit` model where `---` is always hidden.
- The label is directly editable — it is just visible text; the user clicks
  in and types.
- If edits break the pattern (e.g. the label is emptied, or trailing dashes
  are removed), the match simply fails on the next state and the paragraph
  reverts to a plain paragraph (or to an HR if it becomes pure dashes). All
  live, no conversion step.
- *Possible future enhancement (out of scope):* reveal the raw dash markup
  while the caret is inside the paragraph.

## Error / Edge Cases

| Input | Result |
|---|---|
| `------` (pure dashes) | Not a labeled divider — inner capture is all dashes, rejected by rule 3. Stays an HR. |
| `-- text` (no trailing dashes) | No match. Plain paragraph. |
| `text --` (only 2 trailing dashes) | No match (left needs 3+). Plain paragraph. |
| `-- text ---------` | Centered (dashes on both sides; centered checked first). |
| Title / subtitle line matching the pattern | Ignored — indices 0–1 are skipped. |
| Label is only whitespace/dashes | Rejected by rule 3. |

## Testing

- **Unit tests** for `parseLabeledDivider` covering: centered match, left
  match, the precedence between them, all edge-case rows above, and exact
  range offsets (the offsets feed inline decorations, so they must be exact).
- **Manual editor verification**: type both forms in a note, confirm live
  rendering, confirm the label is editable, confirm a long trailing dash run
  does not shift layout, confirm coexistence with a real `---` HR and with
  `hrSplit` column splitting in the same note, confirm round-trip after a
  save/reload.

## Files

- **Create:** `app/src/lib/editor/labeledDivider/parseLabeledDivider.ts`
- **Create:** `app/src/lib/editor/labeledDivider/labeledDividerPlugin.ts`
- **Create:** `app/tests/unit/editor/parseLabeledDivider.test.ts` (vitest;
  matches the existing `tests/unit/editor/*.test.ts` convention)
- **Modify:** `app/src/lib/editor/TomboyEditor.svelte` — register the plugin
  and add the CSS rules
