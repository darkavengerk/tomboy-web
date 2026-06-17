# 노트 최소화 (desktop-only) — design

**Date:** 2026-06-17
**Scope:** Desktop multi-window workspace (`app/src/lib/desktop/`). Mobile single-note flow untouched.

## Problem

Desktop workspace stacks note windows on the canvas. No way to get a note out of
the way without closing it (losing its window pose / live editor focus context) or
dragging it off-screen. Want a **minimize**: hide the window but keep it alive in
the workspace, parked in a list, one click to bring back.

## Requirements (from user)

1. Minimize button on a note window. Click → window hides ("사라진다").
2. Minimized note lands at the **top of the left taskbar's expanded area** (확장
   영역 = SidePanel `.main`, the hover-revealed column).
3. The note still **exists in that workspace** — F4 (펼쳐보기 / spread view) must
   still include it.
4. The minimized-note list is **managed per workspace** (each of the 4 workspaces
   has its own).
5. (Decided in brainstorm) Clicking a minimized entry **restores + focuses** the
   window. F4 spread click on a minimized card also restores.

## Approach

**Flag + CSS hide.** Add a `minimized` boolean to the existing per-workspace
`DesktopWindowState`. Hide the window with `display:none` — exactly the mechanism
already used for inactive-workspace windows (`.note-window.hidden`), which keeps
the TipTap editor, terminal WS, Firebase attach, and the spread-snapshot source
all mounted and live. Because the window stays in `WorkspaceState.windows[]`:

- per-workspace isolation is automatic (windows are already per-workspace),
- persistence is automatic (additive optional field in `PersistedV3`, like
  `pinned` — no `VERSION` bump),
- F4 spread keeps working for free (it reads `desktopSession.windows` + the
  snapshot source, which is gated on `active` = workspace, not on visibility).

Rejected alternative: moving minimized notes into a separate array. More invasive,
breaks F4 spread + persistence, no benefit.

## Components

### 1. `session.svelte.ts` — data model + API

- `DesktopWindowState.minimized?: boolean` (optional, defaults false).
- `restoreWorkspaceFromPersisted` reads `minimized: w.minimized ?? false` (mirror
  the `pinned ?? false` line). Persisted V3 window shape gains optional
  `minimized?: boolean`. No `VERSION` bump (backward-compatible additive field).
- `minimizeWindow(guid)`: set `win.minimized = true`. If it was the focused note,
  chain `focusRequest` to the next topmost **non-minimized** note (mirror the
  focus-chaining in `closeWindow`). `schedulePersist()`. No flush hook needed —
  the editor stays mounted, nothing is torn down.
- `restoreWindow(guid)`: clear `win.minimized`; `bumpZ` + set `focusRequest` +
  `recentOpens.record(guid)`; `schedulePersist()`. Superset of `focusWindow`, so
  it also serves the F4-spread-click path (no-op-ish for a non-minimized note:
  just raises + focuses).
- getter `minimizedWindows`: current workspace, `kind === 'note'`, `minimized`,
  **sorted by `z` descending**. Rationale: clicking the minimize button fires
  `handleWindowPointerDown → onfocus(guid)` first, bumping the window to the
  highest `z` among notes, so z-desc ordering = minimize-recency → the
  just-minimized note appears at the very top ("제일 상단"). No extra timestamp
  field required.

### 2. `NoteWindow.svelte`

- New prop `minimized = false`; new event prop `onminimize(guid)`.
- `class:minimized={minimized}` on `.note-window`; CSS folds it into the existing
  `.note-window.hidden { display: none; }` rule (`.note-window.hidden,
  .note-window.minimized`).
- Minimize button `🗕` (U+1F5D5) in the title bar, immediately left of the pin
  button. `data-no-drag`, `aria-label="최소화"`, `title="최소화"`. onclick →
  `onminimize(guid)`.
- Snapshot source registration stays gated on `active` (workspace) only — no
  visibility gate — so a minimized note (active workspace, hidden) keeps feeding
  F4 spread. **No change** to that effect.
- `focusRequest` effect already grabs focus one rAF after the window is laid out;
  on restore the window flips from `display:none` to visible and the new
  `focusRequest` (set by `restoreWindow`) focuses the now-visible editor + flashes
  the border. No change needed.

**Known limitation (documented, out of scope for v1):** dedicated 파일철 노트
(`탭::` / `묶음::` title) hide the window title bar entirely
(`{#if !(dedicatedKind && !showRawBundle)}`), so they have no minimize button.

### 3. `SidePanel.svelte`

- New props `minimizedGuids: string[]` and `onrestore(guid: string) => void`.
- New `최소화됨` section rendered as the **first child of `.main`, above the
  `.header`** (search box) — the requested 제일 상단. Rendered only when
  `minimizedGuids.length > 0`.
- Titles resolved from the component's existing `allNotes` (guid → title map),
  fallback `제목 없음`.
- Each entry is a button row (styled like `.note-item`) with a restore glyph;
  click → `onrestore(guid)`.

### 4. `DesktopWorkspace.svelte`

- Pass `minimized={win.minimized}` and `onminimize={handleMinimize}` to
  `NoteWindow` (`handleMinimize(g) => desktopSession.minimizeWindow(g)`).
- Derive `minimizedGuids` from `desktopSession.minimizedWindows`, pass to
  `SidePanel` with `onrestore={(g) => desktopSession.restoreWindow(g)}`.
- `hasNoteWindows` is unchanged (minimized notes are still in `windows[]`), so if
  every note is minimized, F4 still opens the spread and shows them.

### 5. `SpreadOverlay.svelte`

- `jumpTo(guid)` calls `desktopSession.restoreWindow(guid)` instead of
  `focusWindow(guid)` so clicking a minimized card un-minimizes it. Minimized
  cards already render from the live snapshot source (window stays mounted).

## Data flow

```
minimize:  NoteWindow 🗕 → onminimize → desktopSession.minimizeWindow(guid)
             → win.minimized = true, focus chains to next note, persist
             → DesktopWorkspace re-renders: NoteWindow gets minimized=true → display:none
             → minimizedWindows getter updates → SidePanel "최소화됨" list shows it

restore:   SidePanel row click → onrestore → desktopSession.restoreWindow(guid)
       or  SpreadOverlay card click → jumpTo → desktopSession.restoreWindow(guid)
             → win.minimized = false, bumpZ, focusRequest, persist
             → NoteWindow visible again, focusRequest effect focuses + flashes
```

## Error / edge handling

- Minimize a non-existent / wrong-kind guid: getter find returns undefined → no-op.
- Restore a guid not currently minimized: harmless (just raises + focuses).
- All notes minimized: F4 still works (windows still present).
- Persistence sanitisation already strips `history` windows; `minimized` is a plain
  boolean, structured-clone-safe via `$state.snapshot`.
- Minimized window in a non-active workspace: double-hidden (`.hidden` from
  `active=false` + `.minimized`), both resolve to `display:none`; harmless.

## Testing

`app/tests/unit/desktop/minimizeWindow.test.ts` (fake-indexeddb, `_reset()`):

- `minimizeWindow` sets `minimized=true`; window stays in `windows[]`.
- Per-workspace isolation: minimizing in ws 0 does not affect ws 1.
- `restoreWindow` clears the flag, bumps z, fires a fresh `focusRequest`.
- `minimizedWindows` returns only current-workspace minimized notes, z-desc.
- Persistence round-trip preserves `minimized` (persist → `_reset` → reload).

## Guide

Append a `<details class="guide-card">` to 설정 → 가이드 (desktop / env area)
describing 최소화: the 🗕 button, where minimized notes go, restore by click, F4
still includes them, per-workspace lists. (CLAUDE.md: user-facing features must be
documented in the guide tab.)
