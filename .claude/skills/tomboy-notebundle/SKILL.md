---
name: tomboy-notebundle
description: Use when working on the 노트 묶음 (note bundle) feature — a `[prefix:][체크박스]노트 묶음:N` keyword paragraph immediately followed by a bulletList of internal links renders an in-editor stacked file-cabinet of the linked notes (5 title bars + one expanded, fully-editable embedded TomboyEditor). Covers the parser (atom-aware PMNode walk, keyword/checkbox/list adjacency rules), the ProseMirror plugin (hide-list decoration + cached widget container per ordinal + idempotent radio auto-insert + spec-as-full-replacement StackController contract), stackMath (5-wide title window with eager-slide + clamp invariants), and the NoteBundleStack.svelte component — the editor-in-editor event barrier (ISOLATED_EVENTS stopPropagation that kills Svelte delegated events → `direct` action + independent `mount()` for child components), the caret-escape guard (Ctrl+Home/End + arrow/Page snapshot-restore), per-note lazy EditorSession map (persist + flushSave + reload/flush bus + Firebase attach/detach), the flex-grow drawer animation that replaced the old single-body structure, the browse/edit two-mode state machine with capture-phase wheel preemption (xterm scroll-leak fix), and host-shell wiring (TerminalView 접속 branch, MusicPlayerBar sticky wrapper, scroll-bottom).
---

# 노트 묶음 (note bundle — in-editor file cabinet)

A top-level paragraph of the form

```
[prefix:][체크박스]노트 묶음:N
• [[대상 노트 1]]
• [[대상 노트 2]]
• [[대상 노트 3]]
```

— an `inlineCheckbox` atom whose preceding text is empty or ends with `:`,
followed by literal `노트 묶음:` and an optional height number `N`,
**immediately followed by a bulletList** of internal-link list items —
renders an in-editor stacked file-cabinet. When the checkbox is checked the
link list is hidden and a stack widget appears in its place: up to 5 title
bars plus one **expanded** note rendered in a real embedded `TomboyEditor`,
fully editable inline and clamped to N% of the host note's height.

Pure **view layer over a regular note** — the `.note` XML is unchanged
(geoMap/chartBlock pattern). The only persisted state lives in the note text
itself: the checkbox `checked` attr, the `:N` height digits, and the per-item
radio `(o)`/`( )` that records which note is expanded. Tomboy desktop and
Dropbox/Firebase sync see a normal checkbox + bullet list.

## File map

| File | Role |
|------|------|
| `lib/editor/noteBundle/parser.ts` | Pure `parseNoteBundles(doc): BundleSpec[]`. Atom-aware PMNode walk — finds keyword paragraphs + their following bulletList, extracts entries (title / radio pos / selected). No IDB, no title index. |
| `lib/editor/noteBundle/noteBundlePlugin.ts` | ProseMirror plugin. Hide-list node decoration + cached widget container per ordinal + idempotent radio auto-insert + `StackController` lifecycle (`mountStack`/`update`/`destroy`). Exports `selectBundleEntry`, `writeBundleHeightPct`. |
| `lib/editor/noteBundle/stackMath.ts` | Pure 5-wide title-window math — `windowWidth`, `clampWindow`, `stepWindow`, `initialWindow`, `nextValidIndex`, `firstValidIndex`. Heavily tested. |
| `lib/editor/noteBundle/NoteBundleStack.svelte` | The stack UI. Mounted inside the plugin's widget container. Title window + per-note `EditorSession` map + event barrier + browse/edit modes + host-shell wiring. |
| `lib/editor/noteBundle/index.ts` | Barrel. |
| `lib/editor/TomboyEditor.svelte` | Wires the plugin (`enableNoteBundle` prop, default `true`). `mountStack` mounts `NoteBundleStack` with **`EditorComponent: TomboyEditorSelf`** (self-import — embedded editor is TomboyEditor itself) and `$state` props so spec updates reflect without remount. |
| `routes/settings/+page.svelte` (가이드 → notes 탭) | Guide card "노트 묶음 — 연관 노트 서류함". |
| `tests/unit/editor/noteBundle/{parser,noteBundlePlugin,stackMath}.test.ts` | Unit tests (pure parser, plugin decorations/radio-insert, window math). |

There is **no Svelte component test** — the stack is verified manually via
`npm run dev` and the headless probe scripts under `/tmp/nb-verify/`
(playwright-core over CDP against a fake-host dev server).

## Note format & parser (`parser.ts`)

`KEYWORD_RE = /^\s*노트\s*묶음:(\d+)?\s*$/` matched against the paragraph
text **after** the checkbox atom.

- **Keyword paragraph** (`parseKeywordParagraph`): scans children for the
  first `inlineCheckbox` whose preceding text (`prefix`) is empty or, after
  trim, ends with `:`. So `Done:[ ]노트 묶음:` (a TODO/Process prefix) is
  allowed; atoms before the checkbox don't contribute to `prefix`. The
  number after `:` becomes `heightPct` (clamped 20–90, default 50).
- **Adjacency is strict.** `parseNoteBundles` walks `doc.forEach`; a pending
  keyword is only attached to a bulletList that is the **immediately next
  block**. Any intervening block (even an empty paragraph) flushes the
  keyword with **zero entries**. Authoring gotcha: a double-Enter between
  keyword and list leaves an empty paragraph → empty stack.
- **`index === 0` (title line) is never a keyword** — the note title can't
  start a bundle.
- **Entries** (`parseListEntries`): per `listItem`'s first paragraph, the
  first `inlineRadio` atom gives `radioPos` + `selected`; the first text run
  carrying a `tomboyInternalLink` mark gives `title` (= **destination note
  title**, the link identity). Items without an internal-link mark are
  skipped.
- **Atoms, not text.** Checkboxes and radios are atom nodes — invisible to a
  plain-JSON text scan. The parser walks the live PMNode tree. (Same class of
  gotcha as `inlineCheckbox` body markers — see the project memory.)
- **`ordinal`** = index in the returned `BundleSpec[]` (0-based, document
  order). It is the identity key everywhere downstream. Deleting an earlier
  bundle **renumbers** later ordinals — hence the full-replacement contract
  below.

`BundleSpec` carries absolute positions (`checkboxPos`, `digitsFrom/To`,
`keywordEnd`, `listPos/End`) so the plugin can write back without re-parsing.

## Plugin (`noteBundlePlugin.ts`)

State is rebuilt from the doc on every `docChanged` (`buildState`). For each
**checked** bundle with a non-empty list:

1. `Decoration.node(listPos, listEnd, {class:'tomboy-note-bundle-hidden'})`
   hides the raw list.
2. `Decoration.widget(listEnd ?? keywordEnd, …, {key:'note-bundle-<ordinal>',
   side:1})` whose `toDOM` returns a **container cached by ordinal** in a
   `Map<number, HTMLElement>`. PM may call `toDOM` repeatedly; returning the
   same element keeps the mounted Svelte component alive across re-renders.

`view().update` runs `syncControllers`: for each checked bundle, `update(spec)`
an existing `StackController` or `mountStack` a new one when its container
`isConnected`; destroy + drop controllers/containers for ordinals no longer
checked. An initial `queueMicrotask` sync covers notes that load already-checked.

**`StackController.update(spec)` is a full replacement, not a diff.** Because
ordinals renumber, the same controller can receive a *different bundle's* spec.
`NoteBundleStack` must derive **all** state from the current `spec` — never
diff against a previous one.

**Radio auto-insert** (`scheduleRadioInsert`): if any checked bundle has an
entry with `radioPos === null`, a single `queueMicrotask` (dispatch is illegal
inside `view.update`) inserts `inlineRadio` atoms — back-to-front so earlier
positions don't shift — selecting the first entry when nothing is selected
yet. Idempotent: after insertion there are no missing radios. `insertScheduled`
guards against pile-up; the microtask recomputes from fresh state so concurrent
edits can't use stale positions.

**Write-back helpers** re-look-up the bundle by `ordinal` from fresh plugin
state (positions may be stale):
- `selectBundleEntry(view, ordinal, index)` — sets the chosen entry's radio
  `selected=true` and clears the rest (mutual exclusion); dispatches only if
  something changed.
- `writeBundleHeightPct(view, ordinal, pct)` — `insertText` the clamped number
  into `[digitsFrom, digitsTo]`. No-op if unchanged.

## Title window (`stackMath.ts`)

5 bars visible (`WINDOW_SIZE = 5`, or all if fewer notes). `winStart` is the
top visible index; bars outside `[winStart, winStart+W)` collapse to `.off`.

- `clampWindow(start, active, n)` — minimal move so the active note's prev/next
  stay visible: in-window position ∈ `[1, W-2]`, with the ends `[0, n-W]`
  pinned. Used for jumps (bar tap / external radio change / count change).
- `stepWindow(start, nextActive, dir, n)` — eager slide by `dir` then clamp.
  Going down → steady-state 1-above/3-below; up → 3-above/1-below, so the
  direction of travel is previewed.
- `initialWindow(active, n)` — active with 1 above on first mount.
- `nextValidIndex` / `firstValidIndex` — skip `broken` (unresolved-title)
  entries.

`winStart` is **component-local, never persisted** — only the radio (= active)
lives in the XML.

## `NoteBundleStack.svelte`

Mounted inside the plugin widget (a `contenteditable=false` island in the host
editor). The header doc comment is the canonical orientation — keep it current.

### Editor-in-editor event barrier (load-bearing)

The root `stopPropagation`s a fixed `ISOLATED_EVENTS` set (keydown, input,
composition, clipboard, pointer/mouse/touch down, click, drag/drop) so the
**outer** PM never sees the embedded editor's events.

Two consequences and their fixes:

1. **Svelte 5 delegates `click`/`pointer*` at the document root.** The barrier's
   `stopPropagation` blocks delegated handlers from ever firing for anything
   inside the stack. So the stack's own interactions use the **`direct` action**
   (`node.addEventListener` directly), never `onclick=` props.
2. **Child Svelte components mounted in the tree** (their delegated onclick)
   would die at the barrier too — the delegation root is the widget container
   *outside* the barrier. Fix: mount them with an **independent `mount()`**
   (`mountTerminal`, `mountMusicBar`) into a div *inside* the barrier, so the
   delegation root becomes that div and events work. This is why `TerminalView`
   and `MusicPlayerBar` are `mount()`'d, not rendered as `<Component>`.

### Caret-escape guard

`stopPropagation` can't stop the browser moving the caret out of a nested
editing host:
- **Ctrl/Cmd+Home/End** — Chrome treats the *outer* editor as the host and
  jumps the caret out; subsequent typing corrupts the host note. These two are
  `preventDefault`'d.
- **Arrow/Page keys** (`NAV_KEYS`) — needed for in-line movement, so not blanket
  blocked. `guardCaretEscape` snapshots the selection, and on the next tick if
  the anchor left the stack it refocuses the embedded `.ProseMirror` and
  restores the saved range. Bails silently if the snapshot container was
  detached by a concurrent PM transaction (avoids leaving a no-selection state).

### Per-note EditorSession map (lazy, persistent)

`sessions = new SvelteMap<guid, EditorSession>()`. First time a note is
expanded, `loadSession` reads it from IDB, `attachOpenNote` (Firebase realtime),
subscribes to `noteReloadBus` (reload) and flush bus, and stores
`{content, createDate, pendingDoc, saveTimer, offReload, offFlush, termSpec,
termConnect, scrollBottom, isMusic}`. **Sessions are never unmounted while the
stack lives** (only torn down when the note leaves the spec, or on destroy).

- **Save** — `handleEmbeddedChange` debounces 1500 ms → `flushSession` →
  `updateNoteFromEditor`. `subscribeNoteFlush` lets external code force a flush.
- **Reload** — `subscribeNoteReload` (rename sweep etc.) drops `pendingDoc`,
  re-reads IDB, recomputes `termSpec`/`isMusic`. Mirrors the host-shell
  `noteReloadBus` contract so the rename cascade works inside bundles too.
- **Signature recompute on edit** — `handleEmbeddedChange` recomputes
  `isMusic`/`termSpec` but only `sessions.set` when a value actually changed
  (compare `isMusic`, `!!term`, `term?.target`) — avoids a SvelteMap write per
  keystroke.
- **Teardown** — `teardownSession` flushes, `detachOpenNote`, unsubscribes.

This per-note structure **replaced an earlier single shared body** (see Dead
ends). It removes the step-by-step load/save flushSave race, preserves
per-note cursor/undo, and lets the transition animate between already-mounted
bodies.

### Flex-grow drawer animation

Every resolved entry is laid out as a **bar + its own body** in DOM order;
only the active body has `flex-grow:1`. Switching notes animates `flex-grow`
via CSS transition — the old body folds shut and the new one opens like a
drawer, and the bars follow the layout every frame, so **no manual FLIP**.
Off-window bars collapse via `.off` (max-height 0 + `translateX(48px)` +
opacity 0) so they appear sucked into the `+N` badge. The previous single-body
structure painted the body over the bars (hiding the motion) and couldn't
animate a body that didn't exist yet (IDB async) — both gone.

### Browse / edit two-mode state machine

`mode = $state<'browse'|'edit'>` (default `browse`).

- **browse** — wheel/swipe anywhere flips notes (`flipWheel`/`step`); active
  body is grayed (`#ecebe6`) + `cursor:pointer` + `touch-action:none`. Tap on
  the open body (`<8px`, no capture) → `mode='edit'`; a `≥30px` swipe steps.
- **edit** — a plain wheel over `.bundle-body` scrolls the note; active bar is
  brighter (`#3f8657`); white body bg.
- **Exits to browse**: `Esc` (skipped when the target is inside `.bundle-term`
  so vim/TUI keeps it), tap on a title bar, or any bundle scroll (bar-wheel /
  ctrl+wheel / swipe). `step()` and `flipWheel()` call `exitEdit()` at the top;
  `exitEdit` also blurs any focused element still inside the stack.

**Capture-phase wheel preemption (the terminal scroll-leak fix).** xterm.js
attaches its own `wheel` listener directly on its DOM at *target* depth and
scrolls its buffer programmatically; a bubble-phase `preventDefault` can't undo
that (embedded PM scroll is the same class of problem). So a **capture-phase**
wheel listener on `rootEl` runs `flipWheel` (which `stopPropagation`s, cutting
the descent) whenever `mode==='browse'` or ctrl/⌘ is held — xterm/PM never see
the event. In edit mode, a plain wheel passes capture untouched so the note
scrolls.

**No pointer capture for body gestures.** `setPointerCapture` would retarget
the click to the container and break PM focus (mobile keyboard won't open on
tap-to-edit). Body gestures in browse are tracked *without* capture; bar
gestures do use capture (tap/double-tap judged in `pointerup`). Double-tap a
bar → `oninternallink(title)` (open the note standalone). `touch-action:none`
on bars/open-body routes native scroll into the swipe handler.

### Host-shell wiring

These mirror what the mobile route / NoteWindow do for standalone notes, wired
per-session here:

- **Terminal note** — when `termSpec` resolves and not connected, the active
  bar shows a "접속" span (`.bar-term-btn`, `direct` click → `setTermConnect`
  + `mode='edit'`). Connecting renders `TerminalView` via `mountTerminal` (its
  own `{#key termSpec}` div); the view's edit button calls `onedit` →
  `setTermConnect(guid,false)` back to the editor.
- **Music note** — `isMusic` (`isMusicNoteDoc`, checks the note's **title**
  starts `음악::`) renders `MusicPlayerBar` via `mountMusicBar` at the body top.
  The wrapper `.bundle-music` carries `position:sticky` (the bar's own sticky is
  trapped by the wrapper box, so the inner `.music-bar` is forced
  `position:static` and its `--topnav-height` offset is 0 here). `mountMusicBar`
  rAF-retries `editorRefs[guid].getEditor()` because the `bind:this` instance
  exists before its internal editor (onMount). Play controls are **excluded
  from edit-mode entry** (`handleListPointerDown` ignores `.bundle-music`) so
  they're usable directly in browse.
- **Scroll-bottom ("하단이 최신")** — `scrollBottomInit` action; on a session's
  first mount, rAF×2 sets `node.scrollTop = node.scrollHeight` (the bundle's
  scroll container is `.bundle-body`, not `window`).

## Invariants

- **View layer only — `.note` XML never restructured.** Decorations +
  text/attr write-backs only. Persisted state = checkbox `checked`, `:N`
  digits, per-item radio. Everything else (winStart, mode, sessions) is ephemeral.
- **`ordinal` is the identity, and it renumbers.** Always re-look-up by ordinal
  from fresh plugin state before a write-back. `StackController.update` is a
  full spec replacement; derive all component state from the current spec.
- **Titles resolve to guids via `lookupGuidByTitle`** (autolink titleProvider,
  exact-case trimmed). Unresolved title → `broken` (gray bar, never expands).
  `ensureTitleIndexReady` + a `titleEpoch` bump re-resolves after the index
  loads. **Self-reference excluded** (an entry whose guid === `hostGuid` is
  dropped) so a bundle can't embed its own host note.
- **1-level nesting only.** The embedded `EditorComponent` is passed
  `enableNoteBundle={false}` (and `hrSplitEnabled={false}`) — a bundle inside a
  bundled note shows as a plain list, not a nested stack.
- **heightPct clamped 20–90, default 50.** Drag the bottom edge to resize;
  `writeBundleHeightPct` persists the % into the `:N` text on pointer-up.
- **Widget container cached per ordinal** — never recreate it on re-render or
  the mounted Svelte stack is lost.
- **Child components (`TerminalView`, `MusicPlayerBar`) MUST be independently
  `mount()`'d** inside the barrier, not rendered as `<Component>`, or their
  delegated events die at the barrier. The stack's own handlers use the
  `direct` action, never `onclick=` props.

## Known dead ends — do not retry

- **Single shared body + manual FLIP/flyOutRight.** The original design kept
  one `.bundle-body` and re-loaded the expanded note into it on every step,
  animating bars with hand-rolled FLIP. The body painted over the bars (hiding
  the motion) and the incoming body didn't exist at step time (IDB async), so
  the swap itself couldn't be animated, and the load/save interleave produced a
  flushSave race. Replaced by per-note persistent sessions + flex-grow drawer
  (commit `cb3a1a9`). Don't reintroduce a shared body.
- **Rendering child components as `<TerminalView/>` / `<MusicPlayerBar/>`
  inside the stack.** Their onclick is delegated to the document root, which
  the barrier blocks — buttons silently do nothing. Independent `mount()` is
  the only working path.
- **Pointer-capturing body taps.** Retargets the click to the container; PM
  loses focus and the mobile keyboard won't open. Track body gestures without
  capture.

## Testing

- `parser.test.ts` — keyword/checkbox/prefix matching, adjacency flush,
  atom-aware entry extraction, ordinal numbering, height clamp.
- `noteBundlePlugin.test.ts` — hide-list + widget decorations, idempotent radio
  auto-insert, `selectBundleEntry`/`writeBundleHeightPct`.
- `stackMath.test.ts` — window invariants (eager slide, clamp, broken-skip).
- No component test. Drive the stack with `npm run dev` (host note with a
  checked `노트 묶음:` + link list) or the `/tmp/nb-verify/` headless probes:
  fake-host mode (localStorage dropbox tokens), fixtures recreated per run
  (`flatpak kill` doesn't flush IDB), probe browse/edit modes, terminal/music
  wiring, scroll-bottom. Note the `npm run test` flake "document is not defined"
  (DOMObserver teardown) is the known tigress `ff9f04f` issue, unrelated.
