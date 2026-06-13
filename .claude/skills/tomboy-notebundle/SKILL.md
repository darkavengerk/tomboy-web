---
name: tomboy-notebundle
description: Use when working on the 탭/묶음 (note bundle) feature — TWO in-editor file-cabinets sharing one parser/plugin but with different UIs, chosen by keyword. `[prefix:][체크박스]탭:N` (kind 'tab', legacy `노트 탭`) renders the **browser-tab recursive** cabinet (NoteBundleStack: top strip = active+upcoming, body, bottom strip = passed; indented children recurse as category tabs) — for going back and forth between notes. `[prefix:][체크박스]묶음:N` (kind 'bundle', legacy `노트 묶음`) renders the **5-bar title-window** cabinet (NoteBundleCabinet: one expanded note + collapsed title bars above/below with the active note fixed at the 3rd slot, nested children flattened with a category label left of the title) — for digging through documents to find one. Both: every link per list item counts (comma/space, multi-per-line); fully-editable embedded TomboyEditor clamped to N% height; same editor-in-editor barrier, per-note keep-alive EditorSession map, browse/edit modes, capture-phase wheel preemption, caret-escape guard, host-shell wiring (terminal 접속 / music bar / scroll-bottom). Covers the shared parser (atom-aware PMNode walk, keyword/checkbox/list adjacency, `kind` discrimination, tree for tab + flat entries for bundle), the plugin (hide-list decoration gated on `hasContent`, cached widget per ordinal, kind-change destroy+remount, spec-as-full-replacement StackController), stackMath (tab: firstNavPath/repairPath/stepPath/pickPath + tabWindow) and cabinetMath (bundle: windowWidth/centeredWindow, WINDOW_SIZE=5, ACTIVE_SLOT=2 fixed 3rd slot), and both Svelte components — `activePath`/`k` are component-local (NOT persisted; reopening shows the first note).
---

# 탭 / 묶음 (note bundle — two in-editor file cabinets)

**Two cabinets, one parser/plugin, chosen by keyword.** Both are a top-level
keyword paragraph + an immediately-following bulletList of internal links;
checking the checkbox hides the list and renders the cabinet in its place.

| Keyword | `kind` | Component | UI | Use for |
|---|---|---|---|---|
| `[ ]탭:N` (legacy `노트 탭:`) | `'tab'` | `NoteBundleStack.svelte` | browser-tab **recursive** (top=active+upcoming / body / bottom=passed; indented children recurse as category tabs) | **오가며 작업** — going back and forth between notes |
| `[ ]묶음:N` (legacy `노트 묶음:`) | `'bundle'` | `NoteBundleCabinet.svelte` | **5-bar title window** (one expanded note + collapsed title bars above/below, active fixed at 3rd slot; nested children flattened, parent title shown left of the title as category) | **뒤져서 찾기** — digging through documents |

```
[prefix:][체크박스]탭:N          [prefix:][체크박스]묶음:N
• [[대상 노트 1]]                 • [[대상 노트 1]]
• [[대상 노트 2]], [[대상 노트 3]]  • [[대상 노트 2]], [[대상 노트 3]]
• 카테고리 제목                    • 카테고리 제목
	• [[하위 노트]]                  • [[하위 노트]]
```

— an `inlineCheckbox` atom whose preceding text is empty or ends with `:`,
followed by literal `탭:`/`묶음:` (legacy `노트 ` prefix still matched) and an
optional height number `N`, **immediately followed by a bulletList** of
internal-link list items. The active note in either cabinet is a real embedded
`TomboyEditor`, clamped to N% of the screen height.

Most of this skill documents the **tab** cabinet (`NoteBundleStack`, the richer
recursive one). The **bundle** cabinet (`NoteBundleCabinet`) is the resurrected
window-5 file-cabinet — see its dedicated section below; it shares the barrier /
sessions / modes / host-shell wiring but navigates a **flat entry list with a
5-bar window** instead of a recursive tree.

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
| `lib/editor/noteBundle/parser.ts` | Pure `parseNoteBundles(doc): BundleSpec[]`. Atom-aware PMNode walk; **both keywords** (`탭:`→kind 'tab', `묶음:`→kind 'bundle'). Per kind it fills **either** `tree: BundleNode{label,link,children}` (tab, recursive — `parseTree`) **or** `entries: BundleEntry{title,category}` (bundle, flat — `parseEntries`); the other field stays `[]`. No IDB, no title index. |
| `lib/editor/noteBundle/noteBundlePlugin.ts` | ProseMirror plugin, **kind-agnostic**. Hide-list node decoration gated on `hasContent` (`tree.length \|\| entries.length`) + cached widget container per ordinal + `StackController` lifecycle. **Kind-change (탭↔묶음) on a live ordinal = destroy + remount** (`controllerKind` map). Exports `writeBundleHeightPct` only. **No list mutation.** |
| `lib/editor/noteBundle/stackMath.ts` | **Tab** tree-navigation — `firstNavPath`, `drillFrom`, `repairPath`, `stepPath` (bubbles to parent at level ends), `pickPath`, `nodesAtDepth`, `clampIndex`, `topItems`/`bottomItems` (range-safe), `tabWindow`/`TAB_CAP`. |
| `lib/editor/noteBundle/cabinetMath.ts` | **Bundle** title-window algebra — `WINDOW_SIZE=5`, `ACTIVE_SLOT=2`, `windowWidth`, `centeredWindow` (active fixed at slot 3 / index 2 regardless of scroll direction, end-pinned), `firstValidIndex`/`nextValidIndex` (broken-skip). |
| `lib/editor/noteBundle/NoteBundleStack.svelte` | **Tab** UI (kind 'tab'). `activePath` + recursive `tabLevel` snippet + keep-alive `EditorSession` map + barrier + browse/edit + host-shell wiring. |
| `lib/editor/noteBundle/NoteBundleCabinet.svelte` | **Bundle** UI (kind 'bundle'). Flat `resolved` entries + `k`(active)/`winStart`(5-bar window) + flex-grow drawer + same barrier / sessions / modes / host-shell wiring. |
| `lib/editor/noteBundle/index.ts` | Barrel (exports `BundleSpec`, `BundleNode`, `BundleEntry`, `BundleKind`). |
| `lib/editor/TomboyEditor.svelte` | Wires the plugin (`enableNoteBundle`, default `true`). `mountStack` **branches on `spec.kind`** → mounts `NoteBundleCabinet` (bundle) or `NoteBundleStack` (tab), both with `EditorComponent: TomboyEditorSelf` + `$state` props. |
| `routes/settings/+page.svelte` (가이드 → notes 탭) | **Two** guide cards: "탭 — 오가며 작업하는 노트 탭" + "묶음 — 뒤져서 찾는 노트 서류함". |
| `tests/unit/editor/noteBundle/{parser,noteBundlePlugin,stackMath,cabinetMath}.test.ts` | Unit tests (parser kind/tree/entries, plugin decorations + kind-change remount, tab tree-nav + tabWindow, bundle window-5 algebra). |

There is **no Svelte component test** — both UIs are verified manually via
`npm run dev` and the headless probe scripts under `/tmp/nb-verify/`
(playwright-core over CDP against a fake-host dev server).

## Note format & parser (`parser.ts`)

Two regexes matched against the paragraph text **after** the checkbox atom (the
`노트 ` prefix is optional, legacy):
`TAB_RE = /^\s*(?:노트\s*)?탭:(\d+)?\s*$/` → `kind:'tab'`,
`BUNDLE_RE = /^\s*(?:노트\s*)?묶음:(\d+)?\s*$/` → `kind:'bundle'`.
`keywordAfterCheckbox` tries TAB first; the matched kind is stamped on the spec.

- **Keyword paragraph** (`parseKeywordParagraph`): first `inlineCheckbox` whose
  preceding text (`prefix`) is empty or, after trim, ends with `:` (so
  `Done:[ ]탭:` / `Done:[ ]묶음:` works). The number after `:` becomes `heightPct`
  (20–90, def 50).
- **Adjacency is strict.** A pending keyword only binds to a bulletList that is
  the **immediately next block**; any intervening block (even an empty paragraph)
  flushes it empty. Double-Enter between keyword and list = empty stack.
- **`index === 0` (title line) is never a keyword.**
- **Kind decides the shape.** `flush` fills `tree` only for `'tab'`
  (`parseTree`) and `entries` only for `'bundle'` (`parseEntries`); the other is
  `[]`. Both share `collectLinks` (every `tomboyInternalLink` target in order;
  adjacent same-target = one link) and `paragraphText` (trimmed text-node concat).
- **Tab tree** (`parseTree`, recursive → `BundleNode[]`): a list item **with a
  nested list** is a **category node** (`label = paragraphText`, `link = null`,
  `children = [own links as leaves…, …parseTree(nested)]` — own link(s) become the
  first child tab(s)); **without** a nested list → one **leaf** per link
  (`{label,link,children:[]}`). Leaf ⇔ `link !== null && children.length === 0`.
- **Bundle entries** (`parseEntries` → flat `BundleEntry[]`): walks recursively
  carrying a `category` string; each item's links push `{title, category}`, and a
  nested list inherits this item's `paragraphText` as its children's category
  (empty title → parent category passes through). So nesting **flattens** with the
  parent title shown as a category label left of the title — no recursive drill-down.
- **Atoms, not text.** Checkboxes are atoms; the parser walks the live PMNode
  tree. Leftover `inlineRadio` atoms from older bundles are skipped (not links).
- **`ordinal`** = index in `BundleSpec[]` (document order, renumbers on delete →
  full-replacement contract below).

`BundleSpec` carries `kind`, `checkboxPos`, `digitsFrom/To`, `keywordEnd`,
`listPos/End` (for the height write-back + hide decoration), `tree:
BundleNode[]` (tab), and `entries: BundleEntry[]` (bundle). **Nodes/entries carry
no positions** — selection is local state, never written back.

## Plugin (`noteBundlePlugin.ts`)

Kind-agnostic. State rebuilt on every `docChanged` (`buildState`). For each
**checked** bundle with `hasContent(b)` (`tree.length || entries.length` — works
for both kinds):

1. `Decoration.node(listPos, listEnd, {class:'tomboy-note-bundle-hidden'})` hides
   the raw list (nested lists included — the whole top-level list range).
2. `Decoration.widget(listEnd ?? keywordEnd, …, {key:'note-bundle-<ordinal>',
   side:1})` whose `toDOM` returns a **container cached by ordinal** so the
   mounted Svelte component survives re-renders.

`view().update` runs `syncControllers`: `update(spec)` an existing controller
**of the same kind**, else (no controller, or **kind changed**) `mountStack` when
the container `isConnected`; destroy + drop controllers for ordinals no longer
checked. An initial `queueMicrotask` sync covers already-checked notes.

**Kind-change remount (load-bearing).** A `controllerKind: Map<ordinal, kind>`
tracks what each controller was mounted as. Editing a keyword `탭:`↔`묶음:` (or an
ordinal renumber that lands a different-kind bundle on the same slot) means
`update` can't swap the component — so `syncControllers` `destroy()`s the old
controller and `mountStack`s the new kind into the **same cached container** in
the same pass. The `mountStack` callback (in `TomboyEditor`) picks the component
from `spec.kind` at mount time, so the remount gets the right UI.

**`StackController.update(spec)` is a full replacement, not a diff** (ordinals
renumber → a controller can receive a *different* bundle's spec of the **same
kind**; derive all component state from the current spec).

**No list mutation.** No radio insert, no selection write-back. The only
write-back is the height: `writeBundleHeightPct(view, ordinal, pct)` re-looks-up
the bundle by ordinal and `insertText`s the clamped number into
`[digitsFrom, digitsTo]` (the keyword line, not the list). No-op if unchanged.
Kind-agnostic (touches only the `:N` digits).

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
  sibling (skip non-navigable), drilling into a sibling category. When the deepest
  level is blocked in `dir`, it **bubbles to the parent** and steps there (so
  scrolling out of a category's last child tosses to the parent's next sibling
  instead of dead-ending — the "scroll toss-to-parent" the user expects). Only the
  root edge clamps.
- `pickPath(tree, path, depth, idx)` — select tab `idx` at `depth` (+drill).
- `clampIndex(len, idx)` / `topItems(nodes, activeIdx)` / `bottomItems(nodes, activeIdx)`
  — strip builders. **Clamp `activeIdx` into range** so an out-of-range index never
  yields an `undefined` node (see the recursion crash note below). `bottomItems`
  is reversed (most-recent leftmost).
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

**Per-level `activeIdx` must be local, not the global path (load-bearing).** Because
the recursion renders **every** branch, `tabLevel(nodes, depth, onPath)` takes an
`onPath` flag: the active index is `activePath[depth]` **only when this level is on
the active path** (`onPath && i === activeIdx` flows down); off-path sibling
categories default to index `0`. It's then `clampIndex`-ed to `nodes.length`. Without
this, a **non-active sibling category with fewer children than the active branch's
selected index** would render its strip with an out-of-range `activeIdx` →
`topItems`/`bottomItems` produced a `{node: undefined}` entry → `it.node.key` /
`node.guid` threw (`can't access property … undefined`). This only surfaced with
**asymmetric nesting depth**, which is why it read as "깊이가 있어서". `clampIndex` in
the strip builders is the second line of defence; the unit tests
(`stackMath.test.ts`) reproduce the out-of-range case deterministically.

### Tab-transition animation

Restored after the tab redesign initially dropped all motion. Two independent axes,
both must keep working with keep-alive (no unmount):

- **Body slide (CSS transform, horizontal).** `.node-body` is `position:absolute;
  inset:0` inside a `position:relative; overflow:hidden` `.level-body`. The slide is
  **horizontal** to match the tabs sliding right→left: each body's resting transform
  encodes its relation to the active index — **active** = `translateX(0)` +
  `opacity:1`; **upcoming** (`i > activeIdx`, default) = `translateX(100%)` (waits to
  the **right**); **before** (`i < activeIdx`, the `.before` class) =
  `translateX(-100%)` (exits **left**). A `transform` transition makes a forward step
  look like the active note **sliding out left** while the next note **enters from the
  right** to fill — same direction as the tabs' shift. Direction is implicit in the
  index relation, so backward steps reverse automatically with no direction state.
  `prefers-reduced-motion` zeroes it. (Earlier it was vertical translateY; switched to
  X because the horizontal tab shift made a vertical body slide feel disjoint.)
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
  capture) → `mode='edit'` **only** (no focus/keyboard — see two-tap below); a
  `≥30px` vertical swipe steps.
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

**Mobile edit-entry focus suppression (two-tap) — BOTH components.** Entering edit
must not raise the keyboard (the entering touch isn't necessarily to type). A
**capture-phase** `mousedown` + `touchstart` (`passive:false`) listener on `rootEl`
`preventDefault`s the focus default for any target inside `.bundle-body` **unless**
`mode==='edit'` AND that body is the active one (`.bundle-body.open` for the
cabinet; `.node-body.active .bundle-body` for the tab). So: first browse tap →
mode switch only (no caret, no keyboard); second tap in edit → PM focuses →
keyboard. Scoped to `.bundle-body` only so bars/tabs keep their native `click`
(mobile tab switching survives — do **not** widen the scope). Tapping a title
bar/tab to exit never focuses the editor and `exitEdit` blurs, so exiting never
raises the keyboard either.

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

## `NoteBundleCabinet.svelte` (kind 'bundle' — the window-5 cabinet)

The resurrected file-cabinet, mounted for `묶음:` notes. It **shares verbatim**
the tab component's editor-in-editor barrier, `direct` action, per-note
`EditorSession` keep-alive map (load/save/reload/flush bus, Firebase
attach/detach), browse/edit two-mode machine, capture-phase wheel preemption,
caret-escape guard, desktop-vs-mobile height basis, and host-shell wiring
(terminal 접속 / music bar / scroll-bottom). What differs is **navigation +
layout** — it has no recursion:

- **Flat `resolved` entries.** `spec.entries` (`{title, category}`) resolved to
  `{title, category, guid, broken, srcIndex}` via `lookupGuidByTitle`
  (self-reference dropped). `srcIndex` keys the `#each` (dup-link stable).
- **`k` = active index, `winStart` = 5-bar window top** — both component-local,
  never persisted. `cabinetMath.centeredWindow(k, n)` drives the window with a
  single formula: active stays **fixed at slot 3** (`ACTIVE_SLOT=2` → `winStart =
  clamp(k-2, 0, n-W)`), so scrolling keeps 2 bars above + 2 below regardless of
  direction; only the ends pin (top → slots 1/2, bottom → last). No more
  direction-aware eager slide / `pendingDir` — the window effect is one line.
  `firstValidIndex`/`nextValidIndex` skip `broken`.
- **Layout = one expanded note + collapsed bars above/below.** Every resolved
  entry is a `.bundle-bar` + its own `.bundle-body` in DOM order; only `idx===k`
  gets `.open` (`flex-grow:1`) → the **flex-grow drawer** animates the swap with no
  manual FLIP. Bars outside `[winStart, winStart+W)` get `.off` (max-height 0 +
  `translateX(48px)` + opacity 0) so they look sucked into the `+N` badge.
- **Category as a label, not a level.** A nested child's parent title shows
  **left of the title** on its bar (`.bar-category`, dimmed + thin `::after`
  divider) — moved off the right so it doesn't tangle with the `+N` badge. The
  cabinet never drills into a category (that's the tab cabinet's job); it just
  lists everything flat.
- **Wheel direction is the *old* one (down = previous).** `flipWheel` maps
  `deltaY>0` → `step(-1)`. (The tab cabinet inverted this to down=next for its
  layout — the two intentionally differ.) Mobile swipe-up = next in both.
- **Bar interactions** are judged in `pointerup` (pointer-capture retargets click):
  tap = `moveTo`, double-tap = `oninternallink` (open standalone), `≥30px` swipe =
  `step`. Active-body tap (no capture) = enter edit (mode only — see focus suppression).

`cabinetMath` is the window-5 algebra resurrected from before the tab redesign,
but its windowing was **changed to fixed slot-3 centering** (`centeredWindow`)
per the bundle use case — the old `clampWindow`/`stepWindow`/`initialWindow`
band + eager-slide are gone. It is independent of `stackMath` (tab tree-nav).

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
- **~~Vertical title-bar window stack~~ — RESURRECTED as the bundle cabinet.**
  This was once a dead-end (the pre-tab interim design, briefly window-3).
  It is now the **`묶음:`** cabinet (`NoteBundleCabinet` + `cabinetMath`,
  window **5**), kept deliberately alongside the tab model for the "dig through
  documents" use case. So: do **not** delete it as legacy, and do **not** merge
  the two — `탭:`/`묶음:` are two products. The note math lives in `cabinetMath.ts`
  (window-5), separate from `stackMath.ts` (tab tree-nav).
- **Active-branch-only rendering.** Rendering just the active path unmounts the
  other visited leaf editors → loses keep-alive (cursor/undo). Render the full
  tree and hide off-path branches.
- **Rendering child components as `<TerminalView/>` / `<MusicPlayerBar/>`.** Their
  onclick is delegated to the document root, which the barrier blocks. Independent
  `mount()` is the only working path.
- **Pointer-capturing body taps.** Retargets the click; PM loses focus and the
  mobile keyboard won't open. Track body gestures without capture.

## Testing

- `parser.test.ts` — **both kinds**: `탭:` → kind 'tab' + tree (multi-link,
  nested category, self-link-first, 3-level recursion, legacy `노트 탭`);
  `묶음:` → kind 'bundle' + flat entries with category (legacy `노트 묶음`);
  the unused field stays `[]`; mixed-keyword doc; prefix/checkbox/adjacency;
  height clamp.
- `noteBundlePlugin.test.ts` — hide-list + widget decorations (both kinds via
  `hasContent`), **no** radio insert (list unmutated), `writeBundleHeightPct`,
  ordinal renumber (`tree[0].label`, tab keyword), and **kind-change remount**
  (`탭:`→`묶음:` ⇒ destroy + remount with `mountedSpecs[1].kind==='bundle'`).
- `stackMath.test.ts` (tab) — `tabWindow` overflow + `firstNavPath`/`drillFrom`/
  `repairPath`/`stepPath`/`pickPath` over leaf/category/broken trees, **stepPath
  parent-bubble** (level-end toss), and **`clampIndex`/`topItems`/`bottomItems`
  range-safety** (the out-of-range → `undefined`-node crash repro).
- `cabinetMath.test.ts` (bundle) — **window-5** algebra: `windowWidth` min(5,N),
  `centeredWindow` fixed slot-3 (`start = clamp(active-2, 0, n-W)`): mid-stack
  centering, end-pinning (top slots 1/2, bottom last), direction-independence
  (same map scrolling up or down), broken-skip multi-jump, `firstValidIndex`/
  `nextValidIndex`.
- No component test. Drive the UIs with `npm run dev` (host note with a checked
  `탭:`/`묶음:` + link list, including a nested category) or the `/tmp/nb-verify/`
  headless probes. The `npm run test` flake "document is not defined" (DOMObserver
  teardown) is the known tigress `ff9f04f` issue, unrelated.

  ⚠️ **Headless probe gotcha — deep-nesting fixtures don't autolink.** The
  `/tmp/nb-verify` probes build fixtures by typing titles and waiting for the
  deferred autolink idle scan. A **flat** list of `잎A`-style titles links reliably
  (`s31-tabs.js`), but a fixture whose **first list item is a category with
  indented children** (needed to reproduce the asymmetric-depth crash) leaves the
  leaves unlinked — the leaves stay `broken` and the stack shows "펼칠 수 있는 노트
  없음", so the crash path can't be exercised live. Tried: Hangul vs Latin
  suffixes, `Shift+Tab` vs empty-item double-Enter outdent, leaf-first ordering,
  reload-rescan — none link the nested leaves. The crash is instead pinned by the
  deterministic `stackMath.test.ts` cases. If you need live deep-nesting, author the
  note by hand in `npm run dev` rather than via the typing probe.
