---
name: tomboy-notebundle
description: Use when working on the 탭/묶음 (note bundle) feature — TWO in-editor file-cabinets sharing one parser/plugin but with different UIs, chosen by keyword. `[prefix:][체크박스]탭:N` (kind 'tab', legacy `노트 탭`) renders the **browser-tab recursive** cabinet (NoteBundleStack: single top strip with an active-centred 3-window + `[+N]` edge badges, body slides horizontally; indented children recurse as category tabs) — for going back and forth between notes. `[prefix:][체크박스]묶음:N` (kind 'bundle', legacy `노트 묶음`) renders the **5-bar title-window** cabinet (NoteBundleCabinet: one expanded note + collapsed title bars above/below with the active note fixed at the 3rd slot, nested children flattened with a category label left of the title) — for digging through documents to find one. Both: every link per list item counts (comma/space, multi-per-line); fully-editable embedded TomboyEditor clamped to N% height; same editor-in-editor barrier, per-note keep-alive EditorSession map, caret-escape guard, host-shell wiring (terminal 접속 / music bar / scroll-bottom). **The tab is now always-edit** (no browse mode — strip always visible, active leaf always editable); only the 묶음 cabinet keeps the browse/edit two-mode machine + capture-phase wheel preemption. Covers the shared parser (atom-aware PMNode walk, keyword/checkbox/list adjacency, `kind` discrimination, tree for tab + flat entries for bundle), the plugin (hide-list decoration gated on `hasContent`, cached widget per ordinal, kind-change destroy+remount, spec-as-full-replacement StackController), stackMath (tab: firstNavPath/repairPath/stepPath/pickPath + tabView/visibleTabs active-centred window) and cabinetMath (bundle: windowWidth/centeredWindow, WINDOW_SIZE=5, ACTIVE_SLOT=2 fixed 3rd slot), and both Svelte components — `activePath`/`k` are component-local (NOT persisted; reopening shows the first note). Also covers the 역참조 temporary bundle (`BacklinkBundleOverlay` + `buildSyntheticBundleSpec`): the note action menu's 🔗 역참조 opens the notes linking *to* this note as a throwaway full-screen 묶음 cabinet — synthetic spec, no real note, no index mutation, no `onraw`/편집.
---

# 탭 / 묶음 (note bundle — two in-editor file cabinets)

**Two cabinets, one parser/plugin, chosen by keyword.** Both are a top-level
keyword paragraph + an immediately-following bulletList of internal links;
checking the checkbox hides the list and renders the cabinet in its place.

| Keyword | `kind` | Component | UI | Use for |
|---|---|---|---|---|
| `[ ]탭:N` (legacy `노트 탭:`) | `'tab'` | `NoteBundleStack.svelte` | browser-tab **recursive** (single top strip, active-centred 3-window + `[+N]` edge badges, body slides horizontally; indented children recurse as category tabs) | **오가며 작업** — going back and forth between notes |
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
(recursion all the way down). **A node with children is a *pure* category — its
own link (if any) is ignored.** (Was: own link loaded as the first child tab; the
implicit links it pulled in were unwanted, so children-bearing items are now
category-only.)

Pure **view layer over a regular note** — the `.note` XML is unchanged
(geoMap/chartBlock pattern). The only persisted state lives in the note text
itself: the checkbox `checked` attr and the `:N` height digits. **Which tab is
open is NOT persisted** — `activePath` is component-local, so reopening (or
remounting) always shows the first note. Tomboy desktop and Dropbox/Firebase
sync see a normal checkbox + bullet list; the bundle never mutates the list.

## File map

| File | Role |
|------|------|
| `lib/editor/noteBundle/parser.ts` | Pure `parseNoteBundles(doc): BundleSpec[]`. Atom-aware PMNode walk; **both keywords** (`탭:`→kind 'tab', `묶음:`→kind 'bundle'). Per kind it fills **either** `tree: BundleNode{label,link,children}` (tab, recursive — `parseTree`) **or** `entries: BundleEntry{title,category}` (bundle, flat — `parseEntries`); the other field stays `[]`. No IDB, no title index. **Also** the dedicated-note path: `dedicatedBundleKind(title)` (`탭::`/`묶음::` 접두 → kind, else null) + `parseDedicatedBundle(jsonDoc, kind): BundleSpec` (synthetic spec from the **whole body** — JSON-based twin of the PMNode walk; see 전용 노트 section). **And** `buildSyntheticBundleSpec(titles, kind): BundleSpec` — a flat synthetic spec straight from a title list (no doc), used by the 역참조 temporary bundle; same -1/null write-back convention as `parseDedicatedBundle`. |
| `lib/editor/noteBundle/noteBundlePlugin.ts` | ProseMirror plugin, **kind-agnostic**. Hide-list node decoration gated on `hasContent` (`tree.length \|\| entries.length`) + cached widget container per ordinal + `StackController` lifecycle. **Kind-change (탭↔묶음) on a live ordinal = destroy + remount** (`controllerKind` map). Checked → hides declaration line (`keywordPos..keywordEnd`) **and** list. Exports `writeBundleHeightPct` + `setBundleChecked` (Ctrl 편집 버튼 → 체크 해제). **No list mutation** (only the checkbox attr / `:N` digits). |
| `lib/editor/noteBundle/stackMath.ts` | **Tab** tree-navigation — `firstNavPath`, `drillFrom`, `repairPath`, `stepPath` (bubbles to parent at level ends), `pickPath`, `nodesAtDepth`, `clampIndex`, `visibleTabs` (range-safe), `tabView`/`TAB_FIT_MAX`/`TAB_WINDOW` (active-centred window + `[+N]` badges). |
| `lib/editor/noteBundle/cabinetMath.ts` | **Bundle** title-window algebra — `WINDOW_SIZE=5` (default), `windowWidth(n, max=5)`, `activeSlot(w)=floor(w/2)` (`ACTIVE_SLOT=activeSlot(5)=2`, back-compat const), `centeredWindow(active, n, max=5)` (active fixed at the **center slot** regardless of scroll direction, end-pinned), `firstValidIndex`/`nextValidIndex` (broken-skip). The `max` arg = `maxCount` (display count `:M`); `100` → caller passes `n` so the window = all. |
| `lib/editor/noteBundle/NoteBundleStack.svelte` | **Tab** UI (kind 'tab'). `activePath` + recursive `tabLevel` snippet + keep-alive `EditorSession` map + barrier + **always-edit** (no browse/edit mode — strip always shown, active leaf always editable) + host-shell wiring. `variant='dedicated'` + nullable `view` + `onclose`/`onraw` for the full-note path. |
| `lib/editor/noteBundle/NoteBundleCabinet.svelte` | **Bundle** UI (kind 'bundle'). Flat `resolved` entries + `k`(active)/`winStart`(5-bar window) + flex-grow drawer + same barrier / sessions / modes / host-shell wiring. Same `variant='dedicated'` extras. |
| `lib/editor/noteBundle/index.ts` | Barrel (exports `BundleSpec`, `BundleNode`, `BundleEntry`, `BundleKind`, `dedicatedBundleKind`, `parseDedicatedBundle`, `buildSyntheticBundleSpec`). |
| `lib/editor/noteBundle/BacklinkBundleOverlay.svelte` | **역참조 임시 묶음** — full-screen portal overlay (`--z-modal`). Gathers backlinkers (`getAllNotes` + link-mark scan, read-only) → `buildSyntheticBundleSpec(titles,'bundle')` → renders `NoteBundleCabinet variant="dedicated" view={null}` **without `onraw`**. Header `「제목」 역참조 N개` + ✕. `oninternallink` = host navigate(꺼내기). No persistence, no index touch. See 역참조 section. |
| `lib/editor/TomboyEditor.svelte` | Wires the plugin (`enableNoteBundle`, default `true`). `mountStack` **branches on `spec.kind`** → mounts `NoteBundleCabinet` (bundle) or `NoteBundleStack` (tab), both with `EditorComponent: TomboyEditorSelf` + `$state` props (inline `variant`). |
| `routes/note/[id]/+page.svelte` + `lib/desktop/NoteWindow.svelte` | **Dedicated-note hosts** — branch on `dedicatedBundleKind(note.title)`; render `NoteBundleStack`/`NoteBundleCabinet` `variant="dedicated"` `view={null}` (+ `onclose=handleClose` on NoteWindow only) when `!showRawBundle`; else the normal `TomboyEditor` + a Ctrl-gated `↩ 묶음` back button. **Also** mount `BacklinkBundleOverlay` on `backlinkBundleOpen` (set from the sheet/menu 역참조 trigger). |
| `lib/editor/NoteActionSheet.svelte` (mobile) + `lib/editor/NoteContextMenu.svelte` (desktop) | **역참조 triggers** — the 🔗 역참조 button now just `onclose()` + `onbacklinks?()` (host opens the overlay). The old inline backlink list (its own `'backlinks'` view + `getAllNotes` scan + `ongoto`) was **removed** from both. |
| `routes/settings/+page.svelte` (가이드 → editor 탭) | **Four** guide cards: "탭 …" + "묶음 …" + "전용 탭/묶음 노트 …" + "역참조를 묶음으로 보기 …". |
| `tests/unit/editor/noteBundle/{parser,noteBundlePlugin,stackMath,cabinetMath,dedicatedParser}.test.ts` | Unit tests (parser kind/tree/entries, plugin decorations + kind-change remount, tab tree-nav + tabView/visibleTabs, bundle window-5 algebra, **dedicated** title-sig + body→tree/entries, **`buildSyntheticBundleSpec`** flat-entry/leaf + trim/empty in `dedicatedParser.test.ts`). |

There is **no Svelte component test** — both UIs are verified manually via
`npm run dev` and the headless probe scripts under `/tmp/nb-verify/`
(playwright-core over CDP against a fake-host dev server).

## Note format & parser (`parser.ts`)

Two regexes matched against the paragraph text **after** the checkbox atom (the
`노트 ` prefix is optional, legacy):
`TAB_RE = /^\s*(?:노트\s*)?탭:(\d+)?(?::(\d+))?\s*$/` → `kind:'tab'`,
`BUNDLE_RE = /^\s*(?:노트\s*)?묶음:(\d+)?(?::(\d+))?\s*$/` → `kind:'bundle'`.
`keywordAfterCheckbox` tries TAB first; the matched kind is stamped on the spec.
The form is `탭/묶음:N[:M]` — **N = height%** (group 1), **M = display count**
(group 2, 묶음-only; the tab ignores M). `묶음::100` (empty N + M) is valid:
N omitted (default), M=100.

- **Keyword paragraph** (`parseKeywordParagraph`): first `inlineCheckbox` whose
  preceding text (`prefix`) is empty or, after trim, ends with `:` (so
  `Done:[ ]탭:` / `Done:[ ]묶음:` works). N → `heightPct`, M → `maxCount`.
- **`heightPct` (`clampHeightPct`):** `0` = **title-only** (묶음 only — bars only,
  bodies never loaded → no IDB read, no editor mount; memory saving), `100` =
  **fit** — **both kinds** fill from the bundle's top down to the **bottom of the
  host note's editor viewport** (NOT the embedded note's content height — host-
  relative; "다음 내용 없다고 가정"). `stackH = max(140, basisH − fitTopOffset −
  bottomReserve)` where `fitTopOffset` = the bundle's top within the host editor
  content (`rootEl.top − hostEl.top + hostEl.scrollTop`, scroll-invariant) and
  `bottomReserve` = the height the floating bottom toolbar covers (desktop:
  `getComputedStyle(view.dom).paddingBottom` = `--toolbar-h` 30px; mobile:
  `--toolbar-height` off `<html>`). Without `bottomReserve` fit either hid under
  the toolbar (묶음) or painted over it (탭). Both measured by a `ResizeObserver`
  on `hostEl` + `view.dom` (content above the bundle changing height re-shifts the
  offset; the bundle's own height does not, so it converges — no feedback loop).
  The embedded editor still scrolls **internally** (fit is just a taller fixed-
  height drawer). Else clamped **20–90**. Default 50. The bottom drag-handle writes
  back into the **N digits only** (`digitsFrom..digitsTo` sits between the first
  `:` and the second), never touching M; the handle is hidden in title-only/fit.
- **`maxCount` (`clampMaxCount`, 묶음 only):** title-window width. `1–100`,
  default **5** (= `WINDOW_SIZE`). **`100` = show ALL bars AND (when heightPct<100)
  title-only** (`묶음::100` ≡ `묶음:N:100`). **`묶음:100:100` = fit + all bars**:
  fixed fill-to-note-end height with the full title index scrolling **inside** the
  list (`titleOnly` and `fit` now coexist — `autoHeight = titleOnly && !fit` is the
  only `height:auto` case; fit always uses `stackH`). Tab stores M but ignores it.
- **Adjacency is strict.** A pending keyword only binds to a bulletList that is
  the **immediately next block**; any intervening block (even an empty paragraph)
  flushes it empty. Double-Enter between keyword and list = empty stack.
- **`index === 0` (title line) is never a keyword.**
- **Kind decides the shape.** `flush` fills `tree` only for `'tab'`
  (`parseTree`) and `entries` only for `'bundle'` (`parseEntries`); the other is
  `[]`. Both share `collectLinks` (every `tomboyInternalLink` target in order;
  adjacent same-target = one link) and `paragraphText` (trimmed text-node concat).
- **Tab tree** (`parseTree`, recursive → `BundleNode[]`): a list item **with a
  nested list** is a **pure category node** (`label = paragraphText`, `link = null`,
  `children = parseTree(nested)` only — **its own link(s), if any, are ignored**);
  **without** a nested list → one **leaf** per link (`{label,link,children:[]}`).
  Leaf ⇔ `link !== null && children.length === 0`.
- **Bundle entries** (`parseEntries` → flat `BundleEntry[]`): walks recursively
  carrying a `category` string. A **leaf item (no nested list)** pushes
  `{title, category}` for each of its links; a **category item (has nested list)**
  pushes **nothing of its own** — it just passes its `paragraphText` down as the
  children's category (empty title → parent category passes through). So nesting
  **flattens** with the parent title shown as a category label left of the title —
  no recursive drill-down.
- **Children-bearing = pure category (both kinds, both PMNode + JSON twins).** If
  an item/textblock has a nested list, its own link is dropped — only the structural
  category survives. Rationale: incidental links on a heading-ish parent were
  silently pulled into the cabinet; treating any parent as category-only keeps the
  set to what the user explicitly listed as leaves.
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

0. `Decoration.node(keywordPos, keywordEnd, {class:'tomboy-note-bundle-hidden'})`
   hides the **declaration line** (checkbox + keyword paragraph) to save space —
   added even when there is no list. `keywordPos` is the keyword paragraph's node
   start (always a top-level paragraph; the bundle parser only recognizes those).
1. `Decoration.node(listPos, listEnd, {class:'tomboy-note-bundle-hidden'})` hides
   the raw list (nested lists included — the whole top-level list range).
2. `Decoration.widget(listEnd ?? keywordEnd, …, {key:'note-bundle-<ordinal>',
   side:1})` whose `toDOM` returns a **container cached by ordinal** so the
   mounted Svelte component survives re-renders.

Re-edit path: with the declaration hidden there's no visible checkbox to
un-toggle, so both components show a Ctrl-only **"✎ 편집" button** (top-right,
`{#if modKeys.ctrl}`, `use:direct` click) → `setBundleChecked(view, ordinal,
false)` re-looks-up by ordinal and `setNodeAttribute(checkboxPos, 'checked',
false)`. Unchecking drops all three decorations (declaration + list reappear) and
`syncControllers` destroys the widget. No-op if already that value.

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
- `clampIndex(len, idx)` / `visibleTabs(nodes, activeIdx)` — the (single, top) strip
  builder. **Clamp `activeIdx` into range** so an out-of-range index never yields an
  `undefined` node (see the recursion crash note below). Returns
  `{items:[{node,idx}…], leftPlus, rightPlus}` — the windowed tabs plus hidden-count
  badges on each side.
- `nodesAtDepth(tree, path, depth)` — the sibling list at a depth.
- `tabView(total, active)` — **active-centred window**. `total ≤ TAB_FIT_MAX(=4)` →
  all shown, fixed (no badges; scrolling only moves the highlight). `total ≥ 5` →
  `TAB_WINDOW(=3)` visible with the active in the **middle (2nd) slot**
  (`start = clamp(active-1, 0, total-3)`); first/last tabs are the only exceptions
  (active at the left/right end). `leftPlus = start`, `rightPlus = total-(start+3)`
  feed the `[+N]` edge badges. Min tab width is ¼ → at most 4 ever fit.

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
- **strip (top only)** = `visibleTabs(nodes, activeIdx)` — the active-centred
  window. No bottom strip (removed — tabs always live at the top),
- **level-body** = every node's `.node-body`, all rendered and **transform-stacked**
  (`position:absolute; inset:0`) so only `activeIdx` is on-screen — see the
  animation section; a leaf renders `leafBody`, a category recurses `tabLevel`.

The strip lays out `[+leftPlus]? tab… [+rightPlus]?`. Tabs are **content-sized**
(`flex:0 1 auto`) with `min-width:25%` and ellipsis — they grow to show the title
but never go below ¼; ≤4 tabs all show fixed, ≥5 shows the 3-window + edge badges.
Active tab highlighted green (centred when possible); a category tab carries a `▤`
glyph; `[+N]` badges are non-interactive indicators. Tab **click** = `pickPath`
(navigate/drill); manual **double**-click on a leaf = `oninternallink` (open
standalone). **No browse gestures** — the tab is always-edit, so wheel/scroll just
scrolls the active note natively and there is no swipe-to-flip; switch tabs by
clicking the strip.

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
`visibleTabs` produced a `{node: undefined}` entry → `it.node.key` /
`node.guid` threw (`can't access property … undefined`). This only surfaced with
**asymmetric nesting depth**, which is why it read as "깊이가 있어서". `clampIndex` in
`visibleTabs`/`tabView` is the second line of defence; the unit tests
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
  **Slide suppressed when the window doesn't move.** A transition where the visible
  3-window stays put (≥5 tabs: active 0↔1 or (n-2)↔(n-1); all ≤4-tab switches; tree
  repair) is an instant cut — the tabs are physically in place, so a slide reads as
  noise. `setActive(next)` sets `suppressAnim = !windowMoved(activePath, next)`, and
  `windowMoved` compares `tabView(n, idx).start` at the **shallowest changed depth**
  (parents above it are shared, so the sibling list is well-defined). `suppressAnim`
  toggles a `.no-anim` class that zeroes only the `.node-body` transition. The tab
  `flip` already self-gates (no position change → no flip), so only the body needs it.
- **Tab shift (`animate:flip` + `fade`).** Strip tabs are keyed by `node.key`;
  `animate:flip` animates the left/right shift when the active index moves (the
  persisting tabs slide to their new window slots). Tabs scrolling into/out of the
  3-window use `in/out:fade`; the fade + the body slide together read as the motion.
- **Initial-flash guard.** A `ready` flag (`onMount`) keeps all transition/flip
  durations at `0` until after mount, so the first render doesn't play every tab's
  intro at once.

`탭:100` (`fit`) does **not** touch the body positioning — it only computes a taller
`stackH` (fill to host viewport bottom, see Height basis); the absolute slide stays.

This is **not** the old single-body FLIP dead-end (see below): bodies are
per-note and persistent, so the slide animates real mounted elements, not a
shared body re-loaded mid-flight.

### Editor-in-editor event barrier (load-bearing)

The root `stopPropagation`s a fixed `ISOLATED_EVENTS` set (keydown, input,
composition, clipboard, pointer/mouse/touch down, click, drag/drop) so the
**outer** PM never sees the embedded editor's events. Three consequences:

1. **Svelte 5 delegates `click`/`pointer*` at the document root** — the barrier
   blocks delegated handlers. So the stack's interactions use the **`direct`
   action** (`node.addEventListener`), never `onclick=` props. `direct` has an
   `update` method so per-render closures (tab click handlers capturing the
   current `ResolvedNode`) stay fresh — without it, a stale `node.navigable`
   from before the title index loaded would be used.
2. **Child Svelte components** (`TerminalView`, `MusicPlayerBar`) are mounted
   with an **independent `mount()`** into a div inside the barrier, so their
   delegation root is inside and their onclick works.
3. **The barrier stops `keydown`/`keyup` from reaching `window`** — so the
   global `modKeys` store (`lib/desktop/modKeys.svelte.ts`) would never see a
   Ctrl/Alt press while an embedded editor is focused, leaving `modKeys.ctrl`
   stuck `false` in edit mode (browse mode worked because focus was outside the
   barrier). Fix lives in `modKeys`, not here: its `window` keydown/keyup
   listeners are **capture phase**, which runs before any descendant can
   `stopPropagation`. Don't re-add a per-bundle Ctrl forwarder — physical
   modifier state is global and must stay barrier-immune.

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

### Modes — **tab is always-edit; the two-mode machine is cabinet-only**

**Tab (`NoteBundleStack`) has no `mode` at all (per user request).** The tab
strip is **always visible** and the active leaf is **always the live editable
editor** — every other title stays on screen while you edit. Navigation is tab
click (double-click / dedicated `↗ 꺼내기` = open standalone); plain wheel/scroll
just scrolls the active note natively. **Removed from the tab component:** `mode`/
`exitEdit`, `flipWheel`/`step`/`scrollActiveBody` and the **capture-phase wheel
listener** (no ctrl-peek — wheel passes straight through to native scroll),
`handlePointer*` swipe + the root pointer `use:direct`, `suppressEditorFocus` (so
a tap focuses the editor immediately), the `.edit-header` (← back / ↗ eject
single-note view), and the `.browse`/`.edit` CSS (no body graying, no
`.tab-strip{display:none}`). `.tab.active` is the bright green always. Everything
below describes the **묶음 cabinet (`NoteBundleCabinet`) only.**

`mode = $state<'browse'|'edit'>` (default `browse`) — **NoteBundleCabinet only.**

- **browse** — wheel/swipe anywhere flips notes (`flipWheel`/`step`); active body
  grayed (`#ecebe6`) + `touch-action:none`. A `≥30px` vertical swipe steps. Body
  tap (`<8px`, no capture) → `mode='edit'` **only** (no focus/keyboard — see
  two-tap below). (Plain tap no longer opens standalone — that's the explicit
  eject icon; title-bar **double**-tap still opens standalone.)
- **edit (single-note view)** — a plain wheel over `.bundle-body` scrolls the note;
  white body bg. **All bars hidden** (`.bundle-stack.edit .bundle-bar{display:none}`)
  so only the active note shows. An **edit header** (`.edit-header`, green) tops
  the view: `←` (`handleEditBack` → `exitEdit`) left of the `.edit-title`, `↗`
  (`handleEject` → `oninternallink(activeTitle)`, **꺼내기**) at the right. Both
  buttons `use:direct` (barrier) + `pointerdown/mousedown` `stopEvt`.
- **Exits to browse**: `Esc` (skipped inside `.bundle-term`), the `←` back button,
  title bar click, or any flip scroll. `step`/`flipWheel` call `exitEdit` first.

**Capture-phase wheel preemption (terminal scroll-leak fix) — cabinet only.** A
capture-phase `wheel` listener on `rootEl`:
- **ctrl/⌘+wheel → `scrollActiveBody`** — `preventDefault` + `stopPropagation`,
  manual `scrollTop += deltaY` on the active body (`.bundle-body.open`). Reads
  content WITHOUT entering edit. Mode-agnostic.
- **browse (no ctrl) → `flipWheel`** (`stopPropagation`s) — xterm/embedded-PM never
  scroll their buffer in browse.
- **edit (no ctrl) → passthrough** — note scrolls natively.

(The **tab** has no capture-phase wheel listener at all — its wheel always passes
through to the active note's native scroll.)

**Wheel direction (cabinet).** `flipWheel` maps `deltaY>0` (down) → `step(-1)`
(previous). Mobile swipe-up = next.

**No pointer capture for body gestures (cabinet)** — `setPointerCapture` would
retarget the tap and break PM focus (mobile keyboard). The cabinet tracks body
tap/swipe on the root without capture. (The tab has no body-gesture tracking; its
tab clicks are each their own `direct` click listener.)

**Mobile edit-entry focus suppression (two-tap) — cabinet only.** Entering edit
must not raise the keyboard (the entering touch isn't necessarily to type). A
**capture-phase** `mousedown` + `touchstart` (`passive:false`) listener on `rootEl`
`preventDefault`s the focus default for any target inside `.bundle-body` **unless**
`mode==='edit'` AND that body is the active one (`.bundle-body.open`). So entering
edit never focuses (no keyboard): first browse tap → `mode='edit'` only. Then a
tap in edit → PM focuses → keyboard.
Scoped to `.bundle-body` only so bars keep their native `click` (mobile bar
switching survives — do **not** widen the scope). Tapping a title bar to exit
never focuses the editor and `exitEdit` blurs, so exiting never raises the
keyboard either. (The **tab** dropped this listener — a body tap focuses the
editor right away since the tab is always in edit.)

### Host-shell wiring (per session, inside `leafBody`)

- **Terminal note** — when `termSpec` resolves and not connected, the body top
  shows a "접속" button (`.bar-term-btn`, `direct` click → `setTermConnect`; the
  tab is always-edit so it flips no mode, the cabinet additionally sets
  `mode='edit'`). Connecting renders `TerminalView` via `mountTerminal` (own
  `{#key termSpec}` div); its edit button → `setTermConnect(guid,false)`.
- **Music note** — `isMusic` (title starts `음악::`) renders `MusicPlayerBar` via
  `mountMusicBar` at body top; `.bundle-music` carries `position:sticky` (inner
  `.music-bar` forced `static`). `mountMusicBar` rAF-retries `editorRefs[guid]
  .getEditor()`. In the cabinet, play controls are excluded from edit-mode entry /
  swipe (`handlePointerDown` ignores `.bundle-music`); the tab has no such gesture
  handler.
- **Scroll-bottom ("하단이 최신")** — `scrollBottomInit` action; rAF×2 sets
  `node.scrollTop = node.scrollHeight` on the leaf `.bundle-body` first mount.
- **일정 노트 / 보내기 (schedule)** — each `EditorComponent` is passed
  `isScheduleNote={session.guid === scheduleNoteGuid}` (auto-weekday `(요일)`
  fill, resolved once via `getScheduleNoteGuid()` in `onMount`) and
  `sendListItemActive={shouldSendListBeActive({ guid: session.guid, sourceGuid:
  SEND_SOURCE_GUID, ctrlHeld: modKeys.ctrl, focusedGuid: null, ignoreFocus:
  true })}` (the floating "보내기" button on each list item of the source note,
  shown while Ctrl is held — `ignoreFocus` like the mobile route, no
  multi-window focus inside a bundle). The transfer itself is self-contained in
  `TomboyEditor` (`createSendListItemPlugin.onSend → transferListItem`); the
  bundle just flips the two props. Both depend on the capture-phase `modKeys`
  fix above so Ctrl is detected in edit mode. See `tomboy-schedule`.

### Height basis — desktop vs mobile

`stackH = dragPx ?? (fit ? max(140, basisH − fitTopOffset − bottomReserve) :
max(140, round(basisH * heightPct/100)))` (`autoHeight = titleOnly && !fit` sets
`height:auto` instead — see the cabinet modes above; **fit** fills to the host
viewport bottom **above the floating toolbar**, see heightPct). In a desktop
multi-window (`view.dom.closest('.note-window')`) `basisH` = host
`.tomboy-editor` `clientHeight` (bounded by the window, ResizeObserver). On the
mobile route the editor is body-level scroll whose height grows with content —
and the bundle is *inside* it, so measuring `clientHeight` creates a measure→grow
feedback loop (infinite growth). Mobile uses `window.innerHeight` (layout
viewport, content-independent; `resize` listener catches rotation).
`writeBundleHeightPct` divides the drag delta by `basisH`.

## `NoteBundleCabinet.svelte` (kind 'bundle' — the window-5 cabinet)

The resurrected file-cabinet, mounted for `묶음:` notes. It **shares** the tab
component's editor-in-editor barrier, `direct` action, per-note `EditorSession`
keep-alive map (load/save/reload/flush bus, Firebase attach/detach), caret-escape
guard, desktop-vs-mobile height basis, and host-shell wiring (terminal 접속 /
music bar / scroll-bottom). It also **keeps the browse/edit two-mode machine +
capture-phase wheel preemption that the tab dropped** (the tab is now always-edit
— see Modes above). What differs is **navigation + layout** — it has no recursion:

- **Flat `resolved` entries.** `spec.entries` (`{title, category}`) resolved to
  `{title, category, guid, broken, srcIndex}` via `lookupGuidByTitle`
  (self-reference dropped). `srcIndex` keys the `#each` (dup-link stable).
- **`k` = active index, `winStart` = window top** — both component-local,
  never persisted. `cabinetMath.centeredWindow(k, n, maxBars)` drives the window
  with a single formula: active stays **fixed at the center slot**
  (`activeSlot(W)=floor(W/2)` → `winStart = clamp(k-activeSlot, 0, n-W)`), so
  scrolling keeps the active centered regardless of direction; only the ends pin.
  `W = windowWidth(n, maxBars)` where `maxBars = spec.maxCount` (`100` → `n`, all).
  No direction-aware eager slide / `pendingDir`. `firstValidIndex`/`nextValidIndex`
  skip `broken`.
- **Title-only / fit / count modes** (`묶음` extras, all derived from spec):
  `titleOnly = heightPct<=0 || maxCount>=100`, `fit = !dedicated &&
  heightPct>=100`, `autoHeight = titleOnly && !fit`. **title-only** skips the
  session-load effect entirely (and tears down any live sessions) → bars only, no
  IDB read / editor mount; bodies `{#if}`-suppressed. **fit** is a taller
  **fixed-height** drawer — `stackH = basisH − fitTopOffset − bottomReserve` (fill
  to host viewport bottom, above the floating toolbar; see Height basis); the
  embedded editor scrolls internally as usual. No "grow-to-embedded-content" CSS
  (that was a wrong attempt — the user wants host-relative fill).
  **`titleOnly` and `fit` now coexist** — `묶음:100:100` is fit (fixed fill height)
  **with** the full title index, the list (`flex:1; min-height:0;
  overflow-y:auto`) scrolling inside; `autoHeight` (`height:auto`, list grows) is
  the only non-fixed case (e.g. `묶음:0`). `.bundle-stack.fit` also squares the
  bottom corners (rounded looked clipped flush against the note end).
  `wheelBrowse = !(titleOnly && W>=n)` — a title-only list showing **all** bars
  (count 100, incl. `묶음:100:100`) can exceed its box, so there wheel/swipe
  interception + pointer capture are **disabled** (`.free-scroll` →
  `touch-action:pan-y` on bars) and it scrolls natively (the page for `auto`, the
  list for fit). Windowed/body modes stay bounded so they keep intercepting
  (note-switch via wheel/swipe/bar-click). The drag-resize handle is hidden in
  title-only & fit.
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

`cabinetMath` is the window algebra resurrected from before the tab redesign,
but its windowing was **changed to center-slot centering** (`centeredWindow`,
default 5-wide but `maxCount`-variable) per the bundle use case — the old
`clampWindow`/`stepWindow`/`initialWindow` band + eager-slide are gone. It is
independent of `stackMath` (tab tree-nav).

## 전용 노트 (dedicated note — the whole note IS the cabinet)

A note whose **title** starts `탭::` or `묶음::` opens not as an in-body widget
but as a **full-note takeover view** (terminal/music-note pattern) — the entire
body is the cabinet. No checkbox / keyword needed; just list links in the body.

**Parser (`parser.ts`, JSON-based).** The host is `note/[id]` / `NoteWindow`,
which hold `editorContent` (JSONContent), not a live PMNode — so the dedicated
parser is a **JSON twin** of the PMNode walk (own `collectLinksJson` /
`paragraphTextJson` / `parseTreeJson` / `parseListIntoJson`), NOT a reuse of the
PMNode helpers.

- `dedicatedBundleKind(title)` → `'tab'` / `'bundle'` / `null` (trimStart, then
  `탭::` / `묶음::` prefix; single-colon `탭:` does NOT match).
- `parseDedicatedBundle(jsonDoc, kind): BundleSpec` — synthetic spec from the
  **whole body**. `checked=true`, write-back fields `-1`/`null`
  (no checkbox/list/digits to persist). `tree` for tab, `entries` for bundle.
- **Options line (`parseDedicatedOptions`).** Body block **1** (note's 2nd line,
  the subtitle slot) matching `/^\s*:(\d+)?(?::(\d+))?\s*$/` with ≥1 digit group
  → consumed as `:height:count` (same meaning as inline `묶음:N:M`): `heightPct`
  (omitted → dedicated default **100**), `maxCount` (omitted → `DEFAULT_MAX_COUNT`
  5). Consumed line is **excluded** from the link list via `bodyStart` (1 → 2)
  passed to `parseDedicatedTree`/`parseDedicatedEntries`. No match (link/text/lone
  `:`) → `heightPct=100, maxCount=5, bodyStart=1` (block 1 stays a list item).
  Tab ignores `maxCount` (no count-window) but the line is still consumed.
- **Placeholder hint.** `subtitleSlot.suppressesSubtitle` excludes `탭::`/`묶음::`
  (their 2nd line is this structured options slot, not a `::` log slot), so
  `TomboySubtitlePlaceholder` shows the `:높이:개수  예) :50:10` hint there
  (`TomboyEditor.subtitlePlaceholderText` branches on `dedicatedBundleKind`).

**Depth model — body is the "depth-1 list".** Walk top-level body blocks,
**skipping block 0 (the title line)**:

- A top-level **textblock** (paragraph/heading) with links → **depth-1**
  leaves/entries (one per link).
- A textblock **immediately followed by a list** → that textblock is a **pure
  category** (its text = label), the list its children (**depth-2**). This is
  the old "listItem + nested bulletList" relation lifted one level up — that's
  why "리스트는 깊이2로 시작". **The textblock's own links are ignored** (same
  children-bearing = pure category rule as in-body) — they neither become first
  children (tab) nor get pushed as entries (bundle).
- A list with **no preceding textblock** (first block, or list-after-list) →
  its items fall in at **depth-1** directly (fallback, no category).
- Nested lists recurse exactly as in-body (`parseTreeJson`/`parseListIntoJson`).
- 묶음 keeps `category` too (parent textblock title) — depth is NOT flat-only.

**Component reuse via `variant`.** `NoteBundleStack`/`NoteBundleCabinet` gained
`variant: 'inline' | 'dedicated'` (default inline), nullable `view`, and
`onclose?` / `onraw?`:

- `dedicated` → root `flex:1` (fills `.editor-area`/`.body`), no inline height,
  the `onMount` height-basis block + resize handle are skipped, `view` is null
  so `writeBundleHeightPct`/`setBundleChecked` are guarded out.
- Top-right **dedicated chrome**: `[✎ 편집 (Ctrl)] [↗ 꺼내기] [✕ 닫기]`. **닫기
  only when `onclose` is provided** (NoteWindow → `handleClose`; the mobile route
  omits it → no 닫기). **Tab (`탭::`): always shown** (the tab is always-edit, no
  mode gate). **Cabinet (`묶음::`): browse-only** — in its edit mode the existing
  `.edit-header` (← 돌아가기 / ↗ 꺼내기) takes over (so 닫기 never shows in cabinet
  edit mode). 꺼내기 = `oninternallink(active title)` standalone-open.
- Ctrl→`✎ 편집` calls `onraw()`. The **host** (route/window) owns a
  `showRawBundle` toggle: true → render the plain `TomboyEditor` on the host note
  (edit the link list) with a Ctrl-gated `↩ 묶음` back button (`exitRawBundle`,
  which pulls the live editor doc into `editorContent` so the re-parsed spec
  reflects unsaved edits). `showRawBundle` resets to false on note change.
- Ctrl gating means the raw toggle is **desktop-only** (same limitation as the
  in-body Ctrl 편집 button); on mobile, escape a dedicated note by editing its
  title (remove the `탭::`/`묶음::` prefix).

The dedicated host editors are **not recursive** — a child note opened inside
the cabinet renders via the embedded `EditorComponent` (route-level title-sig
detection never fires for it), so a child titled `묶음::…` just shows as a normal
note, no nested takeover.

**Host chrome in cabinet view.** When `dedicatedKind && !showRawBundle`, both
hosts **hide the note title-bar AND the bottom `Toolbar`** (`.toolbar-area` /
`.toolbar-slot`): the title is already on the bars, and `getEditor()` is null in
cabinet view (no host editor) so the Toolbar would be inert and overlap the body
(the "목록 하단 가림" bug). Both return in raw/edit mode (`showRawBundle` true) so
it "looks like a normal note". **Desktop NoteWindow also hides its window
title-bar** in cabinet view (user choice) — 📌 pin is lost there, close is via
the dchrome `✕`, and the resize handles still work; the title-bar (and pin)
returns in raw mode.

**Window-drag via the active title (replaces the lost title-bar drag).** Because
the window title-bar is hidden, NoteWindow passes `onwindowdrag?: (e:
PointerEvent) => void` (`handleBundleTitleDrag` → `startPointerDrag` snapshotting
`x`/`y`) into the dedicated Stack/Cabinet. The bundle forwards the **active
note's title** pointerdown so the host moves the window like a normal title-bar.
Contract relies on synchronous dispatch: the bundle calls `onwindowdrag(e)`
inside its own `direct` pointerdown listener, so `e.currentTarget` (= the title
element) is still valid when `startPointerDrag` captures on it. Wiring:
- **Stack (`탭::`)** — `handleTabPointerDown` on the **active tab only** (`it.idx
  === activeIdx`); `↗`/접속 self-`stopEvt` so they don't drag; double-click eject
  still works (drag only `preventDefault`s, click survives). `.tab.draggable`
  cursor.
- **Cabinet (`묶음::`)** — browse: `handleListPointerDown` branches when `barIdx
  === k` (active bar) → `onwindowdrag(e)` + early-return so swipe/tap tracking
  never starts (`swipeY` stays null; `handleListPointerUp` early-returns on null
  to avoid stale-state misfire). Edit: `handleEditHeaderDown` on the `.edit-header`
  (← self-`stopEvt`). `.expanded-bar`/`.edit-header.draggable` grab cursor.
Only provided by NoteWindow (desktop) — the mobile `note/[id]` route omits it, so
mobile keeps the existing tap/swipe gestures untouched.

**Teardown-safety: `bind:this` must key on the stable node, not the session.**
The embedded editor binds `bind:this={editorRefs[node.guid!]}` (Stack) /
`editorRefs[e.guid!]` (Cabinet) — **NOT** `editorRefs[session.guid]`. On the
cabinet→raw transition the component unmounts: `onDestroy`→`teardownSession`
`sessions.delete(guid)` runs, and the editor binding's teardown re-reads its key
expression. If keyed on the deleted `session` (`{@const session=sessions.get(...)}`
→ now `undefined`), `session.guid` throws `Cannot read properties of undefined
(reading 'guid')` **during destroy**, which white-screens the whole route (one
throw per leaf = "몇십 개"). `node.guid`/`e.guid` are stable snippet/#each params,
so the teardown can't crash. (A separate `state_unsafe_mutation` from the embedded
editor's blur-transaction during teardown — `TomboyEditor` `selectionUpdate`/find
handlers — is pre-existing and non-fatal; it also fires during normal typing.)

## 역참조 임시 묶음 (backlinks as a throwaway cabinet)

The note action menu's **🔗 역참조** opens the notes that link *to* this note as
a **temporary 묶음 (bundle) cabinet** — not a real note, not persisted, no
index mutation. This is the third spec source after the in-body parser and the
dedicated-note parser, and it's the simplest: a plain title list, no doc walk.

- **Trigger.** `NoteActionSheet` (mobile) / `NoteContextMenu` (desktop) — the
  역참조 button now just `onclose()` + `onbacklinks?()`. The host
  (`note/[id]/+page.svelte` / `NoteWindow.svelte`) flips `backlinkBundleOpen`
  and renders `BacklinkBundleOverlay`. The old inline backlink-list view (its
  `'backlinks'` sub-view + `getAllNotes` scan + `ongoto`) was **removed** from
  both menus — they're pure triggers now.
- **Gather (read-only).** `BacklinkBundleOverlay.onMount` runs the same scan the
  menus used to: `getAllNotes()` filtered by `xml.includes('>TITLE</link:internal>')`
  or `…</link:broken>` (excluding self by guid), mapped to trimmed non-empty
  titles. No write, no `backlinkIndex` call — `getSourcesFor` is *not* used (it
  returns guids; the cabinet wants titles, and the scan also matches broken
  links). The bundle is built with `buildSyntheticBundleSpec(titles, 'bundle')`.
- **Spec is synthetic and unowned.** `buildSyntheticBundleSpec` mirrors
  `parseDedicatedBundle`'s convention (`checkboxPos/digits/keyword/list` = -1/null,
  `checked=true`, `heightPct=100`, `ordinal=0`) but takes a bare title list
  instead of a doc — flat `entries` (bundle) / leaf `tree` (tab). There is **no
  host note** at all (dedicated notes at least have one); `hostGuid` is the
  *target* note's guid (passed only for self-exclusion symmetry).
- **No `onraw`.** Nothing to edit — there's no underlying list note. The cabinet's
  dedicated `✎ 편집` button is gated on `onraw` being provided (`{#if modKeys.ctrl
  && onraw}`, in BOTH Cabinet and Stack), so it's hidden here. Only `↗ 꺼내기`
  (eject active → `oninternallink` → host opens it standalone) and the overlay's
  own header `✕` remain. `onclose` is **not** passed to the cabinet (the overlay
  owns the close button), so the cabinet's own dchrome `✕` stays hidden.
- **The notes inside are real.** Browsing previews them read-only; if the user
  clicks into one and edits, that's a normal save to that real backlinking note
  (same as opening it). Only the *bundle wrapper* is synthetic — it's never
  written anywhere, so no note is created and the backlink/title indexes are
  untouched. Closing the overlay discards it entirely.
- **Full-screen on both platforms.** `use:portal` to `<body>` at `--z-modal`
  (escapes the desktop `.note-window` stacking context per the z-index gotcha).
  Esc / ✕ closes.

## Invariants

- **View layer only — `.note` XML never restructured, list never mutated.**
  Persisted state = checkbox `checked` + `:N` digits. `activePath`, mode,
  sessions are ephemeral; reopening shows the first note.
- **Checked hides BOTH the declaration line and the list.** The declaration
  (checkbox + keyword paragraph, `keywordPos..keywordEnd`) gets the same
  `tomboy-note-bundle-hidden` node decoration as the list — space-saving, the
  bundle widget is the only visible thing. The checkbox is then off-screen, so
  the **only** un-check path is the Ctrl-held "✎ 편집" button →
  `setBundleChecked(false)`. Don't reintroduce a visible checkbox while checked.
- **`ordinal` is the identity, and it renumbers.** Re-look-up by ordinal before
  the height / checked write-back. `StackController.update` is a full spec
  replacement.
- **Titles resolve to guids via `lookupGuidByTitle`** (exact-case trimmed).
  Unresolved → `broken` leaf (gray tab, not navigable); `ensureTitleIndexReady` +
  `titleEpoch` bump re-resolve. **Self-reference excluded** (`guid === hostGuid`).
- **Path always ends at a navigable leaf** — `repairPath` after every tree change,
  `drill` after every step/pick. A category never directly opens a note.
- **1-level note-nesting only.** The embedded `EditorComponent` gets
  `enableNoteBundle={false}` + `hrSplitEnabled={false}` (a bundle inside a bundled
  note is a plain list). This is distinct from the *category* tree depth, which is
  unbounded within one bundle.
- **Both hide the title line.** The embedded `EditorComponent` (cabinet AND tab)
  gets `hideTitleLine={true}` (`createTitleIsolationPlugin` — display:none on the
  first top-level node + caret clamp out of it). The bar/tab already shows the note
  title, so the body starts from content — matches the standalone note route
  (`note/[id]/+page.svelte` passes the same).
- **heightPct: `0`=title-only(묶음), `100`=fit (fill to host viewport bottom,
  above the floating toolbar — `− bottomReserve`; both kinds), else 20–90, default
  50.** Drag the bottom edge; persisted on pointer-up (writes N digits only, handle
  hidden in 0/fit). `.bundle-stack.fit` squares the bottom corners.
- **maxCount (묶음 `:M`): 1–100, default 5, `100`=all bars.** Window width. With
  `heightPct<100` it forces title-only (`auto` height, grows). **`묶음:100:100` =
  fit + all** — fixed fill-to-note-end height, title index scrolls inside the list
  (`titleOnly` and `fit` coexist; `autoHeight = titleOnly && !fit`).
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
  height clamp (incl. `0`/`100`), `clampMaxCount`, and the size/count options
  (`묶음:0`, `묶음:100`, `묶음:50:10` digits=N only, `묶음::100`, `탭:100:10`).
- `noteBundlePlugin.test.ts` — hide-declaration + hide-list + widget decorations
  (both kinds via `hasContent`; declaration hidden even with no list — node deco
  at `keywordPos..keywordEnd`), **no** radio insert (list unmutated),
  `writeBundleHeightPct`, **`setBundleChecked(false)`** (un-toggle → destroy +
  decos cleared + idempotent), ordinal renumber (`tree[0].label`, tab keyword),
  and **kind-change remount** (`탭:`→`묶음:` ⇒ destroy + remount with
  `mountedSpecs[1].kind==='bundle'`).
- `stackMath.test.ts` (tab) — `tabView` active-centred window (≤4 fixed, ≥5 → 3 +
  edge badges, first/last exceptions, clamp) + `firstNavPath`/`drillFrom`/
  `repairPath`/`stepPath`/`pickPath` over leaf/category/broken trees, **stepPath
  parent-bubble** (level-end toss), and **`clampIndex`/`visibleTabs`
  range-safety** (the out-of-range → `undefined`-node crash repro).
- `cabinetMath.test.ts` (bundle) — window algebra: `windowWidth` min(max,N),
  `centeredWindow` center-slot (`start = clamp(active-activeSlot(W), 0, n-W)`):
  mid-stack centering, end-pinning, direction-independence (same map scrolling up
  or down), broken-skip multi-jump, plus **variable `max` / `activeSlot`** (count
  `:M`, 100=all) and `firstValidIndex`/`nextValidIndex`.
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
