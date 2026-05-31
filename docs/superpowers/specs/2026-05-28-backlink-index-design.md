# Backlink Index — Design

**Date**: 2026-05-28
**Status**: draft

## Motivation

Renaming a note title currently triggers `rewriteBacklinksForRename` (`app/src/lib/core/noteManager.ts:172-198`), which:

1. Reads **every** note from IDB (`getAllNotesIncludingTemplates`).
2. Synchronously scans each note's `xmlContent` twice (`<link:internal>` + `<link:broken>`) via `replaceAllLiteral`.
3. For every affected note, writes back through `putNote` **sequentially** (`for...of` + `await`).
4. Pings `notifyNoteSaved` for each affected guid (Firebase push debounce).

Cost per rename = **O(N × L)** read + scan, **O(M)** sequential writes (N = total notes, L = avg xml size, M = notes actually holding the link). The dominant cost is the unconditional full read + scan, which blocks the main thread long enough to be visible as input lag.

It also opens a **correctness race**: if the user pauses ≥1.5s after partial typing (say, backspacing `ABCD → ABC`) so a save fires, then resumes (`ABC → AB`) before that sweep finishes, the next save's debounce expires while the first sweep is in flight. `flushSave` has no re-entrancy guard, so two sweeps run concurrently over overlapping note sets. Per-note `putNote` calls clobber each other based on read-snapshot timing — some backlinks can end up stranded at the intermediate title (`ABC`) while the note's own title is the final `AB`.

## Goals

1. Reduce rename sweep cost from O(N × L) to O(M) by replacing the full scan with a precomputed index lookup.
2. Eliminate the concurrent-sweep race window.
3. Provide a manual recovery action so an operator can force-rebuild the index if it ever diverges from data (e.g., from a future bug or schema migration).

## Non-goals

- **Auto-promoting plain-text title occurrences to links on rename.** That cascade is intentionally lazy today (auto-link plugin scans per-note on open). Out of scope for this spec.
- **Promoting `<link:broken>` to `<link:internal>` when a target appears, or demoting on disappearance.** Also lazy today; would require its own design.
- **Persisting the index to IDB.** In-memory only, rebuilt each session (see Architecture).
- **Generic body-text word/trigram index.** This spec covers link-mark targets only.

## Architecture

### New module: `app/src/lib/core/backlinkIndex.ts`

Two coupled in-memory maps, kept as mutual inverses:

```ts
// Forward: source note → set of titles it links to.
// Lets us diff "previous targets vs new targets" on putNote without an
// extra IDB read.
const forwardLinks: Map<string /* sourceGuid */, Set<string /* targetTitle */>>;

// Backward: title → set of source notes containing a mark targeting it.
// This is the query side used by the rename sweep.
const backwardLinks: Map<string /* targetTitle */, Set<string /* sourceGuid */>>;
```

Invariant: `forwardLinks.get(g).has(t)` ⇔ `backwardLinks.get(t).has(g)`. All mutations go through `updateNote` which preserves this invariant.

### Public API

```ts
// Build (or rebuild) the index from a complete note snapshot.
// O(N × L) one-time work.
export function initFromAllNotes(notes: NoteData[]): void;

// Returns a promise that resolves once init is complete. Callers that need
// the index ready (rename sweep, settings rebuild) await this.
export function ensureBacklinkIndexReady(): Promise<void>;

// Apply a single note's current state to the index. Idempotent.
// Called from noteStore.putNote and noteStore.deleteNote.
export function updateNote(guid: string, xml: string, deleted: boolean): void;

// Returns the set of source guids whose xmlContent contains a link mark
// targeting `title`. Returns undefined when the title has no backlinks.
// Caller MUST treat the returned set as read-only and snapshot it before
// mutating concurrently (e.g. spread into an array).
export function getSourcesFor(title: string): ReadonlySet<string> | undefined;

// Drops all in-memory state. Used by the settings "재구성" action before
// initFromAllNotes is re-run.
export function clear(): void;
```

### Link-target extraction

Single regex, anchored to Tomboy's mark serialization:

```ts
function extractLinkTargets(xml: string): Set<string> {
  const targets = new Set<string>();
  const re = /<link:(?:internal|broken)>([^<]*)<\/link:(?:internal|broken)>/g;
  for (const m of xml.matchAll(re)) {
    targets.add(xmlUnescape(m[1]));
  }
  return targets;
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
```

`xmlUnescape` reverses `xmlEscapeTitle` from `titleRewrite.ts:17-22`. Order matters: `&amp;` must come last so we don't double-unescape `&amp;lt;`.

### `updateNote` body

```ts
function updateNote(guid: string, xml: string, deleted: boolean): void {
  const oldTargets = forwardLinks.get(guid) ?? EMPTY_SET;
  const newTargets = deleted ? EMPTY_SET : extractLinkTargets(xml);

  for (const t of oldTargets) {
    if (newTargets.has(t)) continue;
    const set = backwardLinks.get(t);
    if (!set) continue;
    set.delete(guid);
    if (set.size === 0) backwardLinks.delete(t);
  }
  for (const t of newTargets) {
    if (oldTargets.has(t)) continue;
    let set = backwardLinks.get(t);
    if (!set) backwardLinks.set(t, (set = new Set()));
    set.add(guid);
  }

  if (newTargets.size === 0) forwardLinks.delete(guid);
  else forwardLinks.set(guid, newTargets);
}
```

No IDB read. Cost = O(|oldTargets| + |newTargets|), typically 0–20 per note.

### Init timing

`installRealNoteSync()` in root `+layout.svelte` already runs at app shell mount. We add a sibling `installBacklinkIndex()`:

```ts
let initPromise: Promise<void> | null = null;
export function installBacklinkIndex(): void {
  initPromise = (async () => {
    const all = await noteStore.getAllNotesIncludingTemplates();
    for (const note of all) {
      if (note.deleted) continue;
      updateNote(note.guid, note.xmlContent, false);
    }
  })();
}
export function ensureBacklinkIndexReady(): Promise<void> {
  return initPromise ?? Promise.resolve();
}
```

The first rename after app boot awaits the init promise; subsequent sweeps are immediate. Init blocks no UI — it runs alongside the app shell mount.

### Wire-in: `noteStore.putNote` / `deleteNote`

```ts
// app/src/lib/storage/noteStore.ts
export async function putNote(note: NoteData): Promise<void> {
  // ... existing IDB write
  backlinkIndex.updateNote(note.guid, note.xmlContent, !!note.deleted);
}

export async function deleteNote(guid: string): Promise<void> {
  // ... existing soft-delete write
  backlinkIndex.updateNote(guid, '', true);
}
```

This single chokepoint covers every data-entry path: `updateNoteFromEditor`, `importNoteXml`, sync-pull (`applyIncomingRemoteNote`), Firebase incremental apply, admin rollback, slip-note chain ops. No caller-side change required.

### Rewritten `rewriteBacklinksForRename`

```ts
async function rewriteBacklinksForRename(
  oldTitle: string,
  newTitle: string,
  selfGuid: string
): Promise<string[]> {
  if (oldTitle === newTitle) return [];
  await ensureBacklinkIndexReady();
  const sources = backlinkIndex.getSourcesFor(oldTitle);
  if (!sources || sources.size === 0) return [];

  // Snapshot — sources may mutate as putNote updates the index mid-iteration.
  const targets = [...sources].filter((g) => g !== selfGuid);
  const now = formatTomboyDate(new Date());

  const results = await Promise.all(
    targets.map(async (g) => {
      const other = await noteStore.getNote(g);
      if (!other || other.deleted) return null;
      const { xml, changed } = rewriteInternalLinkRefsInXml(
        other.xmlContent,
        oldTitle,
        newTitle
      );
      if (!changed) return null;
      other.xmlContent = xml;
      other.changeDate = now;
      other.metadataChangeDate = now;
      await noteStore.putNote(other);
      notifyNoteSaved(other.guid);
      return other.guid;
    })
  );

  return results.filter((g): g is string => g !== null);
}
```

The `if (!changed) return null` is a defensive guard: if the index were ever stale (it shouldn't be) and points at a note that doesn't actually contain the mark, we skip rather than spuriously bump `changeDate`.

### `flushSave` serialization

Update `routes/note/[id]/+page.svelte` and `lib/desktop/NoteWindow.svelte`:

```ts
let flushChain: Promise<void> = Promise.resolve();

function flushSave(): Promise<void> {
  flushChain = flushChain.then(async () => {
    // existing body (no-op gate + updateNoteFromEditor)
  }).catch((err) => {
    console.error('[flushSave]', err);
  });
  return flushChain;
}
```

This makes a queued `flushSave` always wait for the previous save (and its sweep) to fully resolve. The race window from the earlier discussion collapses regardless of index state — belt-and-suspenders for the rare large-backlink rename.

### Settings: rebuild action

New section in `/admin/tools` (route `app/src/routes/admin/tools/+page.svelte`):

```svelte
<button onclick={rebuildBacklinkIndex} disabled={rebuilding}>
  백링크 인덱스 재구성
</button>
```

Handler:

```ts
async function rebuildBacklinkIndex() {
  rebuilding = true;
  try {
    backlinkIndex.clear();
    const all = await noteStore.getAllNotesIncludingTemplates();
    for (const note of all) {
      if (note.deleted) continue;
      backlinkIndex.updateNote(note.guid, note.xmlContent, false);
    }
    pushToast(`백링크 인덱스를 다시 구성했습니다 (${all.length}개 노트 스캔).`, {
      kind: 'info'
    });
  } finally {
    rebuilding = false;
  }
}
```

No note content is modified. Safe to invoke at any time. Lives under `/admin` because the concept is internal — general users don't need to know the index exists.

## Data flow summary

```
                   ┌──────────────────────────────────────┐
   note write  ──▶ │  noteStore.putNote / deleteNote      │
                   │  ─ writes IDB                        │
                   │  ─ calls backlinkIndex.updateNote()  │
                   └────────────┬─────────────────────────┘
                                │
                                ▼
                   ┌──────────────────────────────────────┐
                   │  backlinkIndex (in-memory)           │
                   │   forwardLinks:  guid → Set<title>   │
                   │   backwardLinks: title → Set<guid>   │
                   └────────────┬─────────────────────────┘
                                │ getSourcesFor(oldTitle)
                                ▼
   rename ─────────────▶ rewriteBacklinksForRename
                              │
                              │ Promise.all over M sources
                              ▼
                         (per-note rewrite + putNote)
                              │
                              │ each putNote feeds back
                              ▼
                         backlinkIndex.updateNote
```

## Edge cases

- **Title with XML-special characters** (`foo & bar`, `1 < 2`). Stored escaped in the mark (`<link:internal>foo &amp; bar</link:internal>`). `extractLinkTargets` unescapes before storing as map key. `getSourcesFor` is called with the *unescaped* title (matching `note.title`), so lookups align.
- **Soft-deleted notes.** Treated as having empty target set. `putNote` on a `deleted=true` note removes its forward entry and all its backward entries. A subsequent undelete (does not exist in current UI but conceivable) would re-add via `updateNote`.
- **Templates.** `getAllNotesIncludingTemplates` includes them, matching the current sweep's behavior. They participate in the index.
- **Concurrent sweeps within a single Promise.all.** Each per-note callback awaits its own `getNote` → `putNote`. The Map mutations from each `updateNote` are synchronous and interleave between microtasks safely.
- **Init not yet finished when first sweep fires.** `ensureBacklinkIndexReady()` awaits the init promise. Rename simply waits ~1× full scan cost (same as today's first rename), then is fast forever.
- **`<link:broken>` rewrites.** `rewriteInternalLinkRefsInXml` already rewrites both internal and broken marks. The index is keyed by *target title* regardless of mark kind, so both contribute to (and are rewritten via) the same `backwardLinks` entry.

## Testing

New unit tests in `app/tests/unit/core/`:

- `backlinkIndex.test.ts`
  - `extractLinkTargets` handles `<link:internal>`, `<link:broken>`, escaped chars, repeated marks, no marks.
  - `updateNote` add-only, remove-only, mixed diff.
  - `updateNote` with `deleted=true` purges all entries.
  - Forward/backward invariant assertion helper (`assertSymmetric()`) called after each mutation in tests.
  - `initFromAllNotes` builds correctly from a fixture corpus.
  - `clear()` empties both maps.

- `rewriteBacklinksForRename.test.ts` (extend existing or new)
  - Rename hits only notes returned by the index (mock `noteStore`).
  - Index is updated post-sweep: `oldTitle` entry gone, `newTitle` entry has the same source set.
  - `selfGuid` excluded from the sweep.
  - Soft-deleted source skipped (no putNote call).

- `flushSave` serialization test in `routes/note/[id]/+page.test.ts` (or component test) using fake timers — second `flushSave` does not start until first resolves.

## Rollout

- Feature is internal; no user-facing flag.
- Index initializes on first app shell mount after deploy. First rename per session pays a small init wait; same cost as today's first rename, just shifted.
- Admin rebuild button provides escape hatch if a bug ever causes divergence.
- No data migration; no schema change; rollback is just reverting code.

## Known limitations

- **Cross-editor concurrent renames.** If two desktop windows rename two *different* notes at the same instant, and a third note links to both old titles, the two sweeps can still race on that third note (same risk as today — this spec does not regress it, but does not fix it either). `flushSave` serialization is per-editor. A global rename queue would address this; out of scope here because it would also require coordinating across `lib/desktop/session` and is independent of the index work.

## Out-of-scope follow-ups (mentioned for posterity)

- Plain-text title → `<link:internal>` auto-promotion across all notes (would need Aho-Corasick over the title set to be tractable).
- `<link:broken>` ↔ `<link:internal>` self-healing on title appearance/disappearance.
- Persisting the index to IDB to skip startup scan (only worth it if startup scan becomes measurable at very large N).
- Global rename queue addressing the cross-editor race noted above.
