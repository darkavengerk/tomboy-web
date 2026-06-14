---
name: tomboy-backlinkindex
description: Use when working on the in-memory backlink index (`app/src/lib/core/backlinkIndex.ts`) or anything that touches the rename cascade. Covers the forward/backward Map pair, the `noteStore` chokepoint that auto-maintains it (`putNote`/`putNoteSynced`/`deleteNote`), the install lifecycle wired from `+layout.svelte`, the rewritten `rewriteBacklinksForRename` (O(M) + Promise.allSettled), the `flushSave` promise-chain serialization on both editor routes that closes the concurrent-sweep race, the `/admin/tools` rebuild escape hatch, and the load-bearing invariants (snapshot Set before iteration, in-memory only, ES module circular import is call-time-safe, plain-text title promotion stays lazy).
---

# Backlink Index

In-memory index of `<link:internal>` and `<link:broken>` mark targets across
all non-deleted notes. Lets `rewriteBacklinksForRename` (`noteManager.ts`)
jump directly to the M notes that actually contain a backlink to the old
title, instead of the previous O(N × L) full-corpus scan + per-byte regex
pass that produced visible input lag on every rename.

The index has no persistence — it's rebuilt from IDB at app shell mount.
Every IDB write path funnels through `noteStore.putNote` /
`putNoteSynced` / `deleteNote` and those three functions update the
index synchronously after the IDB write commits.

Spec: `docs/superpowers/specs/2026-05-28-backlink-index-design.md`
Plan: `docs/superpowers/plans/2026-05-28-backlink-index.md`

## Data structure

Two coupled module-level `Map`s kept as mutual inverses:

```ts
const forwardLinks  = new Map<string /* sourceGuid */,  Set<string /* targetTitle */>>();
const backwardLinks = new Map<string /* targetTitle */, Set<string /* sourceGuid */>>();
```

Invariant: `forwardLinks.get(g).has(t) ⇔ backwardLinks.get(t).has(g)`. Every
mutation goes through `updateNote(guid, xml, deleted)` which diffs the new
target set against the previous (held in `forwardLinks.get(guid)`) and applies
both sides of the change in lockstep. No reverse scan needed on a `putNote` —
the previous targets come from the forward map.

Empty backward entries are pruned eagerly (`backwardLinks.delete(t)` once
`size === 0`). Empty forward entries are also pruned (`forwardLinks.delete(guid)`
when the new target set is empty or `deleted=true`).

## Public API

```ts
extractLinkTargets(xml: string): Set<string>
updateNote(guid: string, xml: string, deleted: boolean): void
getSourcesFor(title: string): ReadonlySet<string> | undefined
clear(): void
installBacklinkIndex(): void
ensureBacklinkIndexReady(): Promise<void>
__test__getForward() / __test__getBackward()   // assertSymmetric helper only
```

- `extractLinkTargets` — pure regex over `<link:(?:internal|broken)>([^<]*)<\/link:…>` with `xmlUnescape` (order: `&lt;` → `&gt;` → `&amp;` last, so `&amp;lt;` doesn't double-unescape).
- `updateNote` — O(|oldTargets| + |newTargets|), no IDB read. Allocates a fresh `Set` for the new side (no shared `EMPTY` sentinel — `ReadonlySet` is a compile-time annotation only and a JS caller could mutate a shared one).
- `getSourcesFor` — returns the LIVE Set. Callers MUST snapshot (`[...sources]`) before any mutation pass (see "Snapshot before iteration" below).
- `installBacklinkIndex` — fire-and-forget async rebuild from `getAllNotesIncludingTemplates()`. Internal `.catch` logs and resolves so downstream `ensureBacklinkIndexReady()` awaits never see an unhandled rejection.
- `ensureBacklinkIndexReady` — awaits the in-flight init promise, or returns `Promise.resolve()` if no install ran (unit tests).

## Wire-in chokepoint (load-bearing)

```ts
// app/src/lib/storage/noteStore.ts
await db.put('notes', ...);
try {
  backlinkIndex.updateNote(note.guid, note.xmlContent, note.deleted);
} catch (err) {
  console.error('[backlinkIndex] updateNote failed for', note.guid, err);
}
```

All three write paths (`putNote`, `putNoteSynced`, `deleteNote`) follow this
shape. **This is the only way the index stays in sync** — there's no
post-hoc validator. Every caller (editor save via `updateNoteFromEditor`,
import via `importNoteXml`, sync-pull via `applyIncomingRemoteNote`,
Firebase incremental apply, admin rollback, slip-note chain ops) flows
through `noteStore` and gets the index update for free. **Do not add a new
write path that bypasses these three functions.**

The `try/catch` is intentional — an index error must never fail a
user-visible save. The next `installBacklinkIndex()` (e.g., page reload)
self-heals from IDB.

## Init lifecycle

`installBacklinkIndex()` is called from `+layout.svelte`'s `onMount`,
**before** the `mode.detectAndSet().then(...)` callback — alongside
`installImageFetchers()`. The index build only reads IDB and doesn't
depend on auth, so it can start as early as possible. Putting it inside
the auth `.then()` would delay the warm state until after Dropbox token
refresh.

The first rename in a session may pay the init cost (single IDB scan,
typically a few hundred ms on large corpora). Subsequent renames see an
empty/populated `backwardLinks.get(oldTitle)` lookup in O(1).

## Rename sweep (the whole point)

`rewriteBacklinksForRename(oldTitle, newTitle, selfGuid)` in
`app/src/lib/core/noteManager.ts`:

```
1. if (oldTitle === newTitle) return []
2. await ensureBacklinkIndexReady()
3. sources = getSourcesFor(oldTitle)
4. if (!sources || sources.size === 0) return []
5. targetGuids = [...sources].filter(g => g !== selfGuid)  ← snapshot!
6. now = formatTomboyDate(new Date())                       ← single tick
7. Promise.allSettled(targetGuids.map(g =>
     getNote → if deleted skip → rewriteInternalLinkRefsInXml →
     if !changed warn+skip → putNote → notifyNoteSaved → return guid
   ))
8. collect fulfilled-non-null values; log rejected reasons
```

Each `putNote` call inside the sweep re-runs through the chokepoint, so
the index migrates `oldTitle → newTitle` automatically without separate
maintenance code.

## Snapshot before iteration (subtle correctness)

`sources` from `getSourcesFor(oldTitle)` is the LIVE backward set. Each
in-callback `putNote` calls `updateNote` which removes that guid from
`backwardLinks.get(oldTitle)` (the rewritten note now targets `newTitle`,
not `oldTitle`). If the sweep iterated `sources` directly, the loop would
skip notes as they got removed. The `[...sources]` array snapshot at step
5 is the only thing preventing this.

## `Promise.allSettled`, not `Promise.all`

Fail-fast (`Promise.all`) on a single IDB hiccup would leave the corpus
partially migrated — some notes rewritten, others not, the renamed note's
own title already persisted. `Promise.allSettled` continues through
failures and we collect successes + log rejections, matching the
old sequential `for...of` semantics ("process what you can") more
faithfully.

## `flushSave` promise-chain serialization

The race that Task 5 closes: user types ABCD → pauses 1.5s → save fires →
sweep starts → user backspaces to ABC → new debounce timer fires while
first sweep is in-flight → without serialization, two sweeps overlap with
different (oldTitle, newTitle) pairs and clobber each other's per-note
`putNote` writes, sometimes leaving notes stranded at the intermediate
title.

Both `app/src/routes/note/[id]/+page.svelte` and
`app/src/lib/desktop/NoteWindow.svelte` declare:

```ts
let flushChain: Promise<void> = Promise.resolve();

function flushSave(): Promise<void> {
  flushChain = flushChain.then(async () => {
    /* existing body: fingerprint gate + updateNoteFromEditor */
  }).catch((err) => {
    console.error('[flushSave]', err);
    saving = false;
  });
  return flushChain;
}
```

A second call awaits the first. Errors are caught and logged; the chain
survives so the next flushSave still runs. Return type `Promise<void>` so
existing `await flushSave()` call sites (handleInternalLink, slip-nav
handlers, onBeforeNavigate, etc.) keep working unchanged.

## Admin escape hatch

`/admin/tools` → "백링크 인덱스 재구성" button calls `clear()` then
re-iterates `getAllNotesIncludingTemplates()` skipping deleted notes,
calling `updateNote(guid, xml, false)` for each. Toast shows note count.
Does not modify note content; safe to run any time. Internal — lives
under `/admin` because general users don't need to know the index exists.

## Cross-cutting invariants worth caching

- **Chokepoint is the only contract.** Adding a new IDB write path that
  doesn't go through `noteStore.putNote/putNoteSynced/deleteNote` breaks
  the index. The wrapped `try/catch` and the index update line must stay
  paired in all three.
- **In-memory only.** No IDB persistence — startup scan is the source of
  truth. If init cost ever becomes measurable at very large N, persist to
  IDB; until then, rebuild is simpler and crash-safe.
- **`getSourcesFor` returns a live Set.** Snapshot before any pass that
  mutates the index (`[...sources]`). The sweep at `rewriteBacklinksForRename`
  is the only current example; new callers must follow the same rule.
- **Deleted notes are never indexed.** `updateNote(g, _, true)` purges
  both forward and backward entries for `g`. A deleted note can still
  sit in IDB with link marks in its `xmlContent`, but `getSourcesFor`
  will never return its guid.
- **ES module circular import** between `noteStore.ts` and `backlinkIndex.ts`
  is intentional and safe. Both modules access each other only at
  call-time (`installBacklinkIndex` body, `noteStore.putNote` body), not
  at module init. Don't refactor it away unless one side grows to need a
  cross-module reference at module load.
- **`xmlUnescape` order is `&lt; → &gt; → &amp;` last.** Reversing this
  would double-unescape `&amp;lt;` into `<`.
- **`!changed` is a divergence signal, not a no-op skip.** Logs via
  `console.warn` so the rare index/data skew is observable. The action
  is still "skip" because writing back with `changeDate` bumped would
  spuriously dirty the note for sync.
- **`Promise.allSettled` not `Promise.all`** in the sweep. Don't "tighten"
  it to `Promise.all` — that re-introduces the partial-write hazard.
- **`installBacklinkIndex()` runs at mount BEFORE the auth `.then()`
  callback**, alongside `installImageFetchers()`. Don't move it back
  inside `mode.detectAndSet().then(...)` — the index doesn't need auth
  and delaying it lengthens the first-rename latency window.

## Known limitations (out of scope)

- **Cross-editor concurrent renames** across multiple desktop windows on
  *different* notes that both link to a third note can still race on that
  third note. `flushSave` serialization is per-editor (per route component
  instance); there's no global rename queue. Same risk as before this
  feature landed — not regressed, not fixed. A global queue in
  `lib/desktop/session` would address it.
- **Plain-text title → `<link:internal>` auto-promotion across all notes
  on rename** is intentionally NOT done. The auto-link plugin handles
  this lazily per-note on open. Promoting eagerly across the whole corpus
  would require an Aho-Corasick over the title set to be tractable, and
  changes a user-observable policy (silently linking previously-unlinked
  text). The admin rebuild only refreshes the *index*, not link marks in
  note bodies.
- **`<link:broken>X</link:broken>` → `<link:internal>X</link:internal>`
  promotion when X is renamed to an existing-target name** is also lazy.
  Same reasoning — auto-link plugin re-evaluates broken marks against
  current titles when the holding note opens.

## The user-facing 역참조 view does NOT use this index

The note action menu's 🔗 역참조 (which opens backlinks as a throwaway
묶음 cabinet — see `tomboy-notebundle` `BacklinkBundleOverlay`) deliberately
runs its **own** `getAllNotes()` + `xml.includes('>TITLE</link:internal>')`
scan rather than `getSourcesFor(title)`. Don't "optimize" it onto this index:
it needs note **titles** (not guids), it must also match `<link:broken>`, and
it's a one-shot read on explicit user action where an O(N) scan is fine. The
index stays a rename-sweep concern; the UI is a separate read path.

## Files

- `app/src/lib/core/backlinkIndex.ts` — module (extract, updateNote, install, ensureReady, getSourcesFor, clear).
- `app/src/lib/storage/noteStore.ts` — chokepoint wire-in (`putNote`, `putNoteSynced`, `deleteNote`).
- `app/src/lib/core/noteManager.ts` — `rewriteBacklinksForRename` (the consumer).
- `app/src/routes/+layout.svelte` — `installBacklinkIndex()` at mount.
- `app/src/routes/note/[id]/+page.svelte`, `app/src/lib/desktop/NoteWindow.svelte` — `flushChain` + chain-based `flushSave`.
- `app/src/routes/admin/tools/+page.svelte` — "백링크 인덱스 재구성" rebuild button.
- `app/tests/unit/core/backlinkIndex.test.ts` — module unit tests with `assertSymmetric` invariant helper.
- `app/tests/unit/core/backlinkIndexStoreIntegration.test.ts` — chokepoint integration through fake-indexeddb.
- `app/tests/unit/core/rewriteBacklinksForRename.test.ts` — end-to-end rename cascade.
- `app/tests/unit/noteManager.renameRewrite.test.ts` — pre-existing test, adapted with `seedStore` + `clearIndex` to keep exercising the sweep through the new code path.
