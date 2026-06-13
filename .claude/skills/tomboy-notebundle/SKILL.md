---
name: tomboy-notebundle
description: Use when working on the 묶음 (note bundle) feature — a `[prefix:][체크박스]묶음:N` keyword paragraph (legacy `노트 묶음` still accepted) immediately followed by a bulletList of internal links renders an in-editor **browser-tab-style** recursive file-cabinet of the linked notes (top strip = active+upcoming, body, bottom strip = passed; one fully-editable embedded TomboyEditor). Every link in each list item counts (comma/space-separated, multi-per-line); indented child items become a nested category whose tabs recurse. Covers the parser (atom-aware PMNode walk, keyword/checkbox/list adjacency rules, multi-link + recursive **tree** of `BundleNode{label,link,children}`), the ProseMirror plugin (hide-list decoration + cached widget container per ordinal + spec-as-full-replacement StackController contract — no list mutation), stackMath (pure tree navigation: firstNavPath/repairPath/stepPath/pickPath + tabWindow overflow), and the NoteBundleStack.svelte component — `activePath` is component-local state (NOT persisted; reopening shows the first note), the recursive `tabLevel` snippet, full-tree render with keep-alive (visited leaf editors stay mounted, hidden when off-path), the editor-in-editor event barrier (ISOLATED_EVENTS stopPropagation that kills Svelte delegated events → `direct` action + independent `mount()` for child components), the caret-escape guard (Ctrl+Home/End + arrow/Page snapshot-restore), per-note lazy EditorSession map (persist + flushSave + reload/flush bus + Firebase attach/detach), the browse/edit two-mode state machine with capture-phase wheel preemption (xterm scroll-leak fix, wheel direction restored to forward=down for the tab layout), the desktop-vs-mobile height basis (mobile = viewport height, avoids the content-feedback infinite-growth bug), and host-shell wiring (TerminalView 접속 branch, MusicPlayerBar sticky wrapper, scroll-bottom).
---

# 묶음 (note bundle — in-editor browser-tab file cabinet)

A top-level paragraph of the form

```
[prefix:][체크박스]묶음:N
• [[대상 노트 1]]
• [[대상 노트 2]], [[대상 노트 3]]
• 카테고리 제목
	• [[하위 노트]]
```

— an `inlineCheckbox` atom whose preceding text is empty or ends with `:`,
followed by literal `묶음:` (legacy `노트 묶음:` still matched) and an optional
height number `N`, **immediately followed by a bulletList** of internal-link
list items — renders an in-editor **browser-tab file cabinet**. When the
checkbox is checked the link list is hidden and a tab widget appears: a **top
tab strip** (active note leftmost, then upcoming), the active note's body, and a
**bottom tab strip** (notes scrolled past, reversed — oldest rightmost). The
active note is a real embedded `TomboyEditor`, clamped to N% of the screen height.

**Every internal link in a list item is its own tab** (comma/space-separated,
multiple per line allowed) — the bundle includes *all* links regardless of item
count. **Indented child items form a recursive category**: when a category tab
is active, its body grows its **own** top/bottom tab strips for the children
(recursion all the way down). A parent that also carries a link puts that link
as the first child tab (loads itself first).

Pure **view layer over a regular note** — the `.note` XML is unchanged
(geoMap/chartBlock pattern). The only persisted state lives in the note text
itself: the checkbox `checked` attr and the `:N` height digits. **Which tab is
open is NOT persisted** — `activePath` is component-local, so reopening (or
remounting) always shows the first note. Tomboy desktop and Dropbox/Firebase
sync see a normal checkbox + bullet list; the bundle never mutates the list.

## File map

| File | Role |
|------|------|
| `lib/editor/noteBundle/parser.ts` | Pure `parseNoteBundles(doc): BundleSpec[]`. Atom-aware PMNode walk — finds keyword paragraphs + their following bulletList, recursively parses a **tree** of `BundleNode{label, link, children}` (all links per item, nested lists → category nodes). No IDB, no title index. |
| `lib/editor/noteBundle/noteBundlePlugin.ts` | ProseMirror plugin. Hide-list node decoration (gated on `tree.length`) + cached widget container per ordinal + `StackController` lifecycle (`mountStack`/`update`/`destroy`). Exports `writeBundleHeightPct` only. **No list mutation.** |
| `lib/editor/noteBundle/stackMath.ts` | Pure tree-navigation helpers — `firstNavPath`, `drillFrom`, `repairPath`, `stepPath`, `pickPath`, `nodesAtDepth`, and `tabWindow`/`TAB_CAP` (overflow math). Heavily tested. |
| `lib/editor/noteBundle/NoteBundleStack.svelte` | The tab UI. Mounted inside the plugin's widget container. `activePath` state + recursive `tabLevel` snippet + per-note `EditorSession` keep-alive map + event barrier + browse/edit modes + host-shell wiring. |
| `lib/editor/noteBundle/index.ts` | Barrel. |
| `lib/editor/TomboyEditor.svelte` | Wires the plugin (`enableNoteBundle` prop, default `true`). `mountStack` mounts `NoteBundleStack` with **`EditorComponent: TomboyEditorSelf`** (self-import — embedded editor is TomboyEditor itself) and `$state` props so spec updates reflect without remount. |
| `routes/settings/+page.svelte` (가이드 → notes 탭) | Guide card "묶음 — 연관 노트 서류함". |
| `tests/unit/editor/noteBundle/{parser,noteBundlePlugin,stackMath}.test.ts` | Unit tests (tree parser incl. multi-link + nested category, plugin decorations/height write-back, tree-nav + tabWindow). |

There is **no Svelte component test** — the tab UI is verified manually via
`npm run dev` and the headless probe scripts under `/tmp/nb-verify/`
(playwright-core over CDP against a fake-host dev server).

## Note format & parser (`parser.ts`)

`KEYWORD_RE = /^\s*(?:노트\s*)?묶음:(\d+)?\s*$/` matched against the paragraph
text **after** the checkbox atom. The `노트 ` prefix is optional (legacy support).

- **Keyword paragraph** (`parseKeywordParagraph`): first `inlineCheckbox` whose
  preceding text (`prefix`) is empty or, after trim, ends with `:` (so
  `Done:[ ]묶음:` works). The number after `:` becomes `heightPct` (20–90, def 50).
- **Adjacency is strict.** A pending keyword only binds to a bulletList that is
  the **immediately next block**; any intervening block (even an empty paragraph)
  flushes it with an empty tree. Double-Enter between keyword and list = empty stack.
- **`index === 0` (title line) is never a keyword.**
- **Tree** (`parseList`, recursive): output is `BundleNode[]`.
  - `collectLinks(para)` emits **every** `tomboyInternalLink` target in order
    (adjacent text nodes with the same target = one link; non-link node or
    different target = new link). So `[[A]], [[B]] [[C]]` → three sibling leaves.
  - A list item **with a nested list** is a **category node**: `label =
    paragraphText` (text nodes only, trimmed, includes link display text),
    `link = null`, `children = [the item's own links as leaves…, …parseList(nested)]`.
    So the category's own link(s) become the first child tab(s).
  - A list item **without** a nested list contributes one **leaf** per link
    (`{label: target, link: target, children: []}`); items with no link → nothing.
- **Leaf vs category:** leaf ⇔ `link !== null && children.length === 0`.
  Categories always have `link === null` (self-links are pushed into children).
- **Atoms, not text.** Checkboxes are atoms; the parser walks the live PMNode
  tree. Leftover `inlineRadio` atoms from older bundles are skipped (not links).
- **`ordinal`** = index in `BundleSpec[]` (document order, renumbers on delete →
  full-replacement contract below).

`BundleSpec` carries `checkboxPos`, `digitsFrom/To`, `keywordEnd`, `listPos/End`
(for the height write-back + hide decoration) and `tree: BundleNode[]`. **Tree
nodes carry no positions** — selection is local state, never written back.

## Plugin (`noteBundlePlugin.ts`)

State rebuilt on every `docChanged` (`buildState`). For each **checked** bundle
with `tree.length > 0`:

1. `Decoration.node(listPos, listEnd, {class:'tomboy-note-bundle-hidden'})` hides
   the raw list (nested lists included — the whole top-level list range).
2. `Decoration.widget(listEnd ?? keywordEnd, …, {key:'note-bundle-<ordinal>',
   side:1})` whose `toDOM` returns a **container cached by ordinal** so the
   mounted Svelte component survives re-renders.

`view().update` runs `syncControllers`: `update(spec)` an existing controller or
`mountStack` when its container `isConnected`; destroy + drop controllers for
ordinals no longer checked. An initial `queueMicrotask` sync covers already-checked notes.

**`StackController.update(spec)` is a full replacement, not a diff** (ordinals
renumber → a controller can receive a *different* bundle's spec; derive all
component state from the current spec).

**No list mutation.** No radio insert, no selection write-back. The only
write-back is the height: `writeBundleHeightPct(view, ordinal, pct)` re-looks-up
the bundle by ordinal and `insertText`s the clamped number into
`[digitsFrom, digitsTo]` (the keyword line, not the list). No-op if unchanged.

## Tree navigation (`stackMath.ts`)

Pure functions over a minimal `NavNode {navigable, isLeaf, children}` shape
(`ResolvedNode` satisfies it). A **path** is an array of indices, one per level,
always ending at a **navigable leaf** (categories never end a path — `drill`
descends into their first navigable leaf).

- `firstNavPath(nodes)` — index path to the first navigable leaf (skips `broken`
  leaves and all-broken categories). `null` if none.
- `drillFrom(nodes, idx)` — `[idx, …]` drilling to a leaf, or `null` if not navigable.
- `repairPath(tree, path)` — keep `path` if it still ends at a navigable leaf,
  else `firstNavPath` (or `[]`).
- `stepPath(tree, path, dir)` — move the **deepest** level to its next navigable
  sibling (skip non-navigable), drilling into a sibling category. Clamps at ends.
- `pickPath(tree, path, depth, idx)` — select tab `idx` at `depth` (+drill).
- `nodesAtDepth(tree, path, depth)` — the sibling list at a depth.
- `tabWindow(total)` — overflow: `total ≤ TAB_CAP(=4)` → all shown; else
  `{shown: 3, plus: total-3}`. **`TAB_CAP=4`** because the min tab width is ¼.

`activePath` (and the per-level windowing) is **component-local, never persisted**.

## `NoteBundleStack.svelte`

Mounted inside the plugin widget (a `contenteditable=false` island). The header
doc comment is the canonical orientation — keep it current.

### Recursive tab model

`tree` = `spec.tree` resolved to `ResolvedNode {key, label, link, guid, broken,
isLeaf, navigable, children}` (keyed by tree-position path; self-references —
`guid === hostGuid` — dropped). `activePath = $state<number[]>` drives everything;
an `$effect` keyed on `tree` calls `repairPath` (read/write under `untrack`).

The `tabLevel(nodes, depth)` **snippet recurses**:
- **top strip** = `topItems` (indices `activeIdx..end`, active leftmost),
- **level-body** = every node's `.node-body`, all rendered and **transform-stacked**
  (`position:absolute; inset:0`) so only `activeIdx` is on-screen — see the
  animation section; a leaf renders `leafBody`, a category recurses `tabLevel`,
- **bottom strip** = `bottomItems` (indices `activeIdx-1..0`, reversed).

Each strip applies `tabWindow`: ≤4 tabs share equally (`flex:1 1 0`, ≥¼ each,
ellipsis); >4 shows 3 + a small `+N` tab. Active tab highlighted green; a
category tab carries a `▤` glyph. Tab **click** = `pickPath` (navigate/drill);
manual **double**-click on a leaf = `oninternallink` (open standalone).

The active **leaf** (deepest node on `activePath`) is the visible note;
`activeLeafGuid` drives session loading.

### Full-tree render + keep-alive

The recursion renders the **entire tree** (every branch). Off-path branches are
**transformed off-screen** (not `display:none` — see the animation section so the
slide can play). A leaf's editor mounts **lazily** — `leafBody` only renders the
`EditorComponent` once `sessions.get(guid)` exists, and sessions load only when a
leaf becomes the active leaf. Once mounted, the editor **stays mounted** (off-path
= `opacity:0; pointer-events:none`, transformed aside) → tab switches are instant
and **cursor/undo are preserved per note** (keep-alive). Sessions are torn down
only when a guid leaves the tree (or on destroy).

### Tab-transition animation

Restored after the tab redesign initially dropped all motion. Two independent axes,
both must keep working with keep-alive (no unmount):

- **Body slide (CSS transform).** `.node-body` is `position:absolute; inset:0`
  inside a `position:relative; overflow:hidden` `.level-body`. Each body's resting
  transform encodes its relation to the active index: **active** = `translateY(0)`
  + `opacity:1`; **upcoming** (`i > activeIdx`, default) = `translateY(-100%)` (waits
  above); **before** (`i < activeIdx`, the `.before` class) = `translateY(100%)`
  (below). A `transform` transition makes a forward step look like the active note
  **falling down** while the next note **descends from the top** to fill — the motion
  the user asked for. Direction is implicit in the index relation, so backward steps
  reverse automatically with no direction state. `prefers-reduced-motion` zeroes it.
- **Tab shift (`animate:flip` + `fade`).** Strip tabs are keyed by `node.key`;
  `animate:flip` animates the left/right shift when the active index moves (the
  persisting tabs slide to their new slots). Cross-strip enter/exit (a tab leaving
  the top strip / appearing in the bottom strip) uses `in/out:fade` — they're
  separate `{#each}` blocks so a tab can't fly continuously across the body; the
  fade + the body slide together read as the motion.
- **Initial-flash guard.** A `ready` flag (`onMount`) keeps all transition/flip
  durations at `0` until after mount, so the first render doesn't play every tab's
  intro at once.

This is **not** the old single-body FLIP dead-end (see below): bodies are
per-note and persistent, so the slide animates real mounted elements, not a
shared body re-loaded mid-flight.

### Editor-in-editor event barrier (load-bearing)

The root `stopPropagation`s a fixed `ISOLATED_EVENTS` set (keydown, input,
composition, clipboard, pointer/mouse/touch down, click, drag/drop) so the
**outer** PM never sees the embedded editor's events. Two consequences:

1. **Svelte 5 delegates `click`/`pointer*` at the document root** — the barrier
   blocks delegated handlers. So the stack's interactions use the **`direct`
   action** (`node.addEventListener`), never `onclick=` props. `direct` has an
   `update` method so per-render closures (tab click handlers capturing the
   current `ResolvedNode`) stay fresh — without it, a stale `node.navigable`
   from before the title index loaded would be used.
2. **Child Svelte components** (`TerminalView`, `MusicPlayerBar`) are mounted
   with an **independent `mount()`** into a div inside the barrier, so their
   delegation root is inside and their onclick works.

### Caret-escape guard

`stopPropagation` can't stop the browser moving the caret out of a nested host:
- **Ctrl/Cmd+Home/End** — `preventDefault`'d (Chrome jumps the caret to the outer
  editor, corrupting the host note).
- **Arrow/Page keys** — `guardCaretEscape` snapshots the selection and, if the
  anchor left the stack next tick, refocuses the embedded `.ProseMirror` and
  restores the range (bails if the snapshot container was detached).

### Per-note EditorSession map (lazy, persistent)

`sessions = new SvelteMap<guid, EditorSession>()`. `loadSession` reads IDB,
`attachOpenNote` (Firebase), subscribes `noteReloadBus` + flush bus, stores
`{content, createDate, pendingDoc, saveTimer, offReload, offFlush, termSpec,
termConnect, scrollBottom, isMusic}`.

- **Save** — `handleEmbeddedChange` debounces 1500 ms → `flushSession` →
  `updateNoteFromEditor`. `subscribeNoteFlush` forces a flush.
- **Reload** — `subscribeNoteReload` (rename sweep) drops `pendingDoc`, re-reads
  IDB, recomputes `termSpec`/`isMusic`.
- **Signature recompute on edit** — only `sessions.set` when `isMusic`/`!!term`/
  `term?.target` actually changed (avoids a SvelteMap write per keystroke;
  `content` ref is preserved so the editor isn't reset).
- **Teardown** — `teardownSession` flushes, `detachOpenNote`, unsubscribes;
  driven by an `$effect` that diffs `collectGuids(tree)` against `sessions`.

### Browse / edit two-mode state machine

`mode = $state<'browse'|'edit'>` (default `browse`).

- **browse** — wheel/swipe anywhere flips tabs (`flipWheel`/`step`); active body
  grayed (`#ecebe6`) + `touch-action:none`. A tap on the active body (`<8px`, no
  capture) → `mode='edit'`; a `≥30px` vertical swipe steps.
- **edit** — a plain wheel over `.bundle-body` scrolls the note; white body bg.
- **Exits to browse**: `Esc` (skipped inside `.bundle-term` for vim/TUI), tab
  click, or any bundle scroll. `step`/`flipWheel` call `exitEdit` first.

**Capture-phase wheel preemption (terminal scroll-leak fix).** A capture-phase
`wheel` listener on `rootEl` runs `flipWheel` (which `stopPropagation`s) whenever
`mode==='browse'` or ctrl/⌘ — so xterm/embedded-PM never scroll their buffer in
browse. In edit, a plain wheel passes capture untouched and the note scrolls.

**Wheel direction (restored to forward=down).** In the tab layout the structure
is inverted vs the old vertical stack, so `flipWheel` maps **down**
(`deltaY>0`) → `step(1)` (next/upcoming) and up → `step(-1)`. (Mobile swipe is
the pointer path: drag-up = next.)

**No pointer capture for body gestures** — `setPointerCapture` would retarget the
tap and break PM focus (mobile keyboard). Body tap/swipe is tracked on the root
without capture; tab clicks are each their own `direct` click listener.

### Host-shell wiring (per session, inside `leafBody`)

- **Terminal note** — when `termSpec` resolves and not connected, the body top
  shows a "접속" button (`.bar-term-btn`, `direct` click → `setTermConnect` +
  `mode='edit'`). Connecting renders `TerminalView` via `mountTerminal` (own
  `{#key termSpec}` div); its edit button → `setTermConnect(guid,false)`.
- **Music note** — `isMusic` (title starts `음악::`) renders `MusicPlayerBar` via
  `mountMusicBar` at body top; `.bundle-music` carries `position:sticky` (inner
  `.music-bar` forced `static`). `mountMusicBar` rAF-retries `editorRefs[guid]
  .getEditor()`. Play controls are excluded from edit-mode entry / swipe
  (`handlePointerDown` ignores `.bundle-music`).
- **Scroll-bottom ("하단이 최신")** — `scrollBottomInit` action; rAF×2 sets
  `node.scrollTop = node.scrollHeight` on the leaf `.bundle-body` first mount.

### Height basis — desktop vs mobile

`stackH = dragPx ?? max(140, round(basisH * heightPct/100))`. In a desktop
multi-window (`view.dom.closest('.note-window')`) `basisH` = host
`.tomboy-editor` `clientHeight` (bounded by the window, ResizeObserver). On the
mobile route the editor is body-level scroll whose height grows with content —
and the bundle is *inside* it, so measuring `clientHeight` creates a measure→grow
feedback loop (infinite growth). Mobile uses `window.innerHeight` (layout
viewport, content-independent; `resize` listener catches rotation).
`writeBundleHeightPct` divides the drag delta by `basisH`.

## Invariants

- **View layer only — `.note` XML never restructured, list never mutated.**
  Persisted state = checkbox `checked` + `:N` digits. `activePath`, mode,
  sessions are ephemeral; reopening shows the first note.
- **`ordinal` is the identity, and it renumbers.** Re-look-up by ordinal before
  the height write-back. `StackController.update` is a full spec replacement.
- **Titles resolve to guids via `lookupGuidByTitle`** (exact-case trimmed).
  Unresolved → `broken` leaf (gray tab, not navigable); `ensureTitleIndexReady` +
  `titleEpoch` bump re-resolve. **Self-reference excluded** (`guid === hostGuid`).
- **Path always ends at a navigable leaf** — `repairPath` after every tree change,
  `drill` after every step/pick. A category never directly opens a note.
- **1-level note-nesting only.** The embedded `EditorComponent` gets
  `enableNoteBundle={false}` + `hrSplitEnabled={false}` (a bundle inside a bundled
  note is a plain list). This is distinct from the *category* tree depth, which is
  unbounded within one bundle.
- **heightPct clamped 20–90, default 50.** Drag the bottom edge; persisted on pointer-up.
- **Widget container cached per ordinal** — never recreate it or the Svelte stack is lost.
- **Full-tree render is required for keep-alive** — visited leaf editors must stay
  mounted (transformed off-screen, not `display:none`) across tab switches; don't
  switch to active-branch-only render.
- **Child components MUST be independently `mount()`'d** inside the barrier; the
  stack's own handlers use the `direct` action (with its `update` method), never `onclick=`.

## Known dead ends — do not retry

- **Persisting the active note via an inline `(o)`/`( )` radio per item.** The
  original design auto-inserted `inlineRadio` atoms and wrote selection back to
  XML. It conflicted with multi-link-per-item and with the list-radio `(( ))`
  feature (`listBox boxKind='radio'`). Resolved by dropping selection persistence
  entirely — the active path is local state, the list is read-only.
- **Vertical title-bar stack with a 3-wide centered window + flex-grow drawer.**
  The interim (pre-tab) design stacked title bars vertically with a sliding
  window. Replaced by the browser-tab model (top=upcoming / bottom=passed,
  recursive per category). Don't reintroduce the vertical window math.
- **Active-branch-only rendering.** Rendering just the active path unmounts the
  other visited leaf editors → loses keep-alive (cursor/undo). Render the full
  tree and hide off-path branches.
- **Rendering child components as `<TerminalView/>` / `<MusicPlayerBar/>`.** Their
  onclick is delegated to the document root, which the barrier blocks. Independent
  `mount()` is the only working path.
- **Pointer-capturing body taps.** Retargets the click; PM loses focus and the
  mobile keyboard won't open. Track body gestures without capture.

## Testing

- `parser.test.ts` — keyword/checkbox/prefix (incl. legacy `노트 묶음`), adjacency
  flush, multi-link per item, **nested category tree** (incl. self-link-first and
  3-level recursion), radios ignored, ordinal numbering, height clamp.
- `noteBundlePlugin.test.ts` — hide-list + widget decorations, **no** radio insert
  (list unmutated), `writeBundleHeightPct`, ordinal renumber (`tree[0].label`).
- `stackMath.test.ts` — `tabWindow` overflow + `firstNavPath`/`drillFrom`/
  `repairPath`/`stepPath`/`pickPath` over leaf/category/broken trees.
- No component test. Drive the tabs with `npm run dev` (host note with a checked
  `묶음:` + link list, including a nested category) or the `/tmp/nb-verify/`
  headless probes. The `npm run test` flake "document is not defined" (DOMObserver
  teardown) is the known tigress `ff9f04f` issue, unrelated.
