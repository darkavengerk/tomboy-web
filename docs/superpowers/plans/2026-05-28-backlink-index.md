# Backlink Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the O(N × L) full-note scan in `rewriteBacklinksForRename` with an in-memory backlink index (O(M) lookup), parallelize the per-affected-note writes with `Promise.all`, serialize `flushSave` to close the concurrent-sweep race, and add an `/admin/tools` action to rebuild the index on demand.

**Architecture:** A new module `lib/core/backlinkIndex.ts` keeps two coupled in-memory `Map`s (`forwardLinks: guid→Set<title>` + `backwardLinks: title→Set<guid>`) as mutual inverses. `noteStore.putNote` / `putNoteSynced` / `deleteNote` funnel through `backlinkIndex.updateNote` so every data-entry path (editor save, import, sync-pull, Firebase incremental, admin rollback) auto-maintains the index. App shell calls `installBacklinkIndex()` at mount alongside `installRealNoteSync()`; rename sweep awaits `ensureBacklinkIndexReady()` then runs `Promise.all` over `getSourcesFor(oldTitle)`.

**Tech Stack:** TypeScript, Svelte 5 runes, vitest, `idb` (existing). No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-05-28-backlink-index-design.md`

---

## File Structure

**New:**
- `app/src/lib/core/backlinkIndex.ts` — index module (maps, extract, updateNote, init, ensureReady, getSourcesFor, clear)
- `app/tests/unit/core/backlinkIndex.test.ts` — unit tests for the module
- `app/tests/unit/core/rewriteBacklinksForRename.test.ts` — integration test for the sweep against the index

**Modified:**
- `app/src/lib/storage/noteStore.ts` — call `backlinkIndex.updateNote` from `putNote`, `putNoteSynced`, `deleteNote`
- `app/src/lib/core/noteManager.ts:172-198` — rewrite `rewriteBacklinksForRename` to use the index + `Promise.all`
- `app/src/routes/+layout.svelte:177` — call `installBacklinkIndex()` alongside `installRealNoteSync()`
- `app/src/routes/note/[id]/+page.svelte:349-367` — serialize `flushSave` via a promise chain
- `app/src/lib/desktop/NoteWindow.svelte:381-394` — same `flushSave` serialization
- `app/src/routes/admin/tools/+page.svelte` — add "백링크 인덱스 재구성" button + handler

---

### Task 1: backlinkIndex core API (extract + updateNote + getSourcesFor + clear)

**Goal:** Land the pure in-memory index module — extraction, two-way map updates, lookup, clear — with full unit-test coverage. No IDB integration yet.

**Files:**
- Create: `app/src/lib/core/backlinkIndex.ts`
- Create: `app/tests/unit/core/backlinkIndex.test.ts`

**Acceptance Criteria:**
- [ ] `extractLinkTargets` parses `<link:internal>` and `<link:broken>` marks, XML-unescapes `&amp;`, `&lt;`, `&gt;`.
- [ ] `updateNote(guid, xml, false)` diffs targets against the previous state held in `forwardLinks` and updates both maps in lockstep.
- [ ] `updateNote(guid, xml, true)` (deleted) removes all entries for that guid from both maps.
- [ ] `getSourcesFor(title)` returns `undefined` for never-seen titles and a `ReadonlySet<string>` for known ones.
- [ ] `clear()` empties both maps.
- [ ] Mutual-inverse invariant (`forward.get(g).has(t) ⇔ backward.get(t).has(g)`) holds after every operation in tests (asserted via shared helper).
- [ ] No IDB calls inside the module — module is pure functions over module-level Maps.

**Verify:**
```bash
cd app && npm run test -- backlinkIndex.test.ts
```
Expected: all tests pass.

**Steps:**

- [ ] **Step 1: Write the unit test file (test-first)**

Create `app/tests/unit/core/backlinkIndex.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractLinkTargets,
  updateNote,
  getSourcesFor,
  clear,
  __test__getForward,
  __test__getBackward
} from '$lib/core/backlinkIndex.js';

function assertSymmetric() {
  const fwd = __test__getForward();
  const bwd = __test__getBackward();
  for (const [guid, titles] of fwd) {
    for (const t of titles) {
      expect(bwd.get(t)?.has(guid), `forward ${guid}→${t} missing in backward`).toBe(true);
    }
  }
  for (const [title, guids] of bwd) {
    expect(guids.size, `backward ${title} has empty set — should have been deleted`).toBeGreaterThan(0);
    for (const g of guids) {
      expect(fwd.get(g)?.has(title), `backward ${title}→${g} missing in forward`).toBe(true);
    }
  }
}

function noteContent(...targets: string[]): string {
  const marks = targets
    .map((t) => `<link:internal>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</link:internal>`)
    .join(' ');
  return `<note-content version="0.1">Body ${marks} done</note-content>`;
}

describe('extractLinkTargets', () => {
  it('finds <link:internal> marks', () => {
    expect(extractLinkTargets('<a><link:internal>foo</link:internal></a>')).toEqual(new Set(['foo']));
  });
  it('finds <link:broken> marks', () => {
    expect(extractLinkTargets('<a><link:broken>bar</link:broken></a>')).toEqual(new Set(['bar']));
  });
  it('unescapes &amp; / &lt; / &gt;', () => {
    const xml = '<link:internal>a &amp; b</link:internal> <link:internal>1 &lt; 2</link:internal>';
    expect(extractLinkTargets(xml)).toEqual(new Set(['a & b', '1 < 2']));
  });
  it('dedupes identical targets within one note', () => {
    const xml = '<link:internal>foo</link:internal><link:internal>foo</link:internal>';
    expect(extractLinkTargets(xml)).toEqual(new Set(['foo']));
  });
  it('returns empty set when no marks', () => {
    expect(extractLinkTargets('plain text')).toEqual(new Set());
  });
});

describe('updateNote / getSourcesFor', () => {
  beforeEach(() => clear());

  it('adds entries on first putNote', () => {
    updateNote('g1', noteContent('A', 'B'), false);
    expect(getSourcesFor('A')).toEqual(new Set(['g1']));
    expect(getSourcesFor('B')).toEqual(new Set(['g1']));
    expect(getSourcesFor('C')).toBeUndefined();
    assertSymmetric();
  });

  it('multiple sources share a title', () => {
    updateNote('g1', noteContent('A'), false);
    updateNote('g2', noteContent('A'), false);
    expect(getSourcesFor('A')).toEqual(new Set(['g1', 'g2']));
    assertSymmetric();
  });

  it('removes target when no longer referenced', () => {
    updateNote('g1', noteContent('A', 'B'), false);
    updateNote('g1', noteContent('A'), false);
    expect(getSourcesFor('A')).toEqual(new Set(['g1']));
    expect(getSourcesFor('B')).toBeUndefined();
    assertSymmetric();
  });

  it('add and remove in same call (mixed diff)', () => {
    updateNote('g1', noteContent('A', 'B'), false);
    updateNote('g1', noteContent('B', 'C'), false);
    expect(getSourcesFor('A')).toBeUndefined();
    expect(getSourcesFor('B')).toEqual(new Set(['g1']));
    expect(getSourcesFor('C')).toEqual(new Set(['g1']));
    assertSymmetric();
  });

  it('deleted=true purges all entries for the guid', () => {
    updateNote('g1', noteContent('A', 'B'), false);
    updateNote('g2', noteContent('A'), false);
    updateNote('g1', '<note-content version="0.1">deleted</note-content>', true);
    expect(getSourcesFor('A')).toEqual(new Set(['g2']));
    expect(getSourcesFor('B')).toBeUndefined();
    expect(__test__getForward().has('g1')).toBe(false);
    assertSymmetric();
  });

  it('repeated identical updateNote is a no-op', () => {
    updateNote('g1', noteContent('A'), false);
    const fwdSize = __test__getForward().size;
    const bwdSize = __test__getBackward().size;
    updateNote('g1', noteContent('A'), false);
    expect(__test__getForward().size).toBe(fwdSize);
    expect(__test__getBackward().size).toBe(bwdSize);
    assertSymmetric();
  });

  it('handles xml-escaped titles consistently', () => {
    const xml = '<note-content><link:internal>a &amp; b</link:internal></note-content>';
    updateNote('g1', xml, false);
    expect(getSourcesFor('a & b')).toEqual(new Set(['g1']));
    expect(getSourcesFor('a &amp; b')).toBeUndefined();
    assertSymmetric();
  });
});

describe('clear', () => {
  it('empties both maps', () => {
    updateNote('g1', noteContent('A'), false);
    updateNote('g2', noteContent('B'), false);
    clear();
    expect(__test__getForward().size).toBe(0);
    expect(__test__getBackward().size).toBe(0);
    expect(getSourcesFor('A')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npm run test -- backlinkIndex.test.ts`
Expected: FAIL with "Cannot find module '$lib/core/backlinkIndex.js'".

- [ ] **Step 3: Implement the module**

Create `app/src/lib/core/backlinkIndex.ts`:

```ts
/**
 * In-memory index of link-mark targets. Two coupled maps kept as mutual
 * inverses so the rename sweep can find affected notes in O(1) and the
 * diff-on-write path can compute "previous targets" without an extra IDB
 * read.
 *
 * Invariant: forwardLinks.get(g).has(t) ⇔ backwardLinks.get(t).has(g).
 * Every mutation goes through `updateNote`, which preserves this.
 *
 * Index is in-memory only — rebuilt at app shell mount via
 * `installBacklinkIndex()`. See spec
 * `docs/superpowers/specs/2026-05-28-backlink-index-design.md`.
 */

const forwardLinks = new Map<string, Set<string>>();
const backwardLinks = new Map<string, Set<string>>();

const EMPTY: ReadonlySet<string> = new Set();

const LINK_RE = /<link:(?:internal|broken)>([^<]*)<\/link:(?:internal|broken)>/g;

function xmlUnescape(s: string): string {
  // Order matters: &amp; must come last so we don't double-unescape
  // payloads like "&amp;lt;".
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Scan an xmlContent string for `<link:internal>` and `<link:broken>`
 * marks. Returns a Set of XML-unescaped target titles.
 */
export function extractLinkTargets(xml: string): Set<string> {
  const out = new Set<string>();
  for (const m of xml.matchAll(LINK_RE)) {
    out.add(xmlUnescape(m[1]));
  }
  return out;
}

/**
 * Apply a single note's current state to the index. Idempotent.
 *
 * - If `deleted` is true, the note's contribution is removed.
 * - Otherwise the new target set is diffed against `forwardLinks.get(guid)`;
 *   only the delta touches `backwardLinks`.
 */
export function updateNote(guid: string, xml: string, deleted: boolean): void {
  const oldTargets = forwardLinks.get(guid) ?? EMPTY;
  const newTargets = deleted ? EMPTY : extractLinkTargets(xml);

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
  else forwardLinks.set(guid, newTargets as Set<string>);
}

/**
 * Return the set of source guids whose xmlContent contains a link mark
 * targeting `title`. Returns undefined when there are no backlinks.
 *
 * The returned set is the live internal Set — callers MUST treat it as
 * read-only and snapshot it (e.g. `[...sources]`) before any mutation
 * pass that could reentrantly call `updateNote`.
 */
export function getSourcesFor(title: string): ReadonlySet<string> | undefined {
  return backwardLinks.get(title);
}

/** Drop all in-memory state. Used by the admin "재구성" action before re-init. */
export function clear(): void {
  forwardLinks.clear();
  backwardLinks.clear();
}

// ── Test-only accessors ──────────────────────────────────────────────
// Not part of the public contract; used by unit tests to assert the
// mutual-inverse invariant after each operation. Underscore-prefixed
// so they're obviously internal.
export function __test__getForward(): ReadonlyMap<string, ReadonlySet<string>> {
  return forwardLinks;
}
export function __test__getBackward(): ReadonlyMap<string, ReadonlySet<string>> {
  return backwardLinks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npm run test -- backlinkIndex.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu
git add app/src/lib/core/backlinkIndex.ts app/tests/unit/core/backlinkIndex.test.ts
git commit -m "$(cat <<'EOF'
feat(backlinkIndex): in-memory forward/backward link index module

Pure in-memory index over <link:internal> / <link:broken> mark targets.
Forward (guid → titles) and backward (title → guids) maps kept as mutual
inverses via updateNote; clear() resets both. No IDB integration yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Init lifecycle (`initFromAllNotes` + `ensureBacklinkIndexReady` + install at layout mount)

**Goal:** Expose an `installBacklinkIndex()` that builds the index from the current IDB note set asynchronously, and an `ensureBacklinkIndexReady()` awaitable for downstream callers. Wire it into `+layout.svelte` next to `installRealNoteSync()`.

**Files:**
- Modify: `app/src/lib/core/backlinkIndex.ts` (append init API)
- Modify: `app/tests/unit/core/backlinkIndex.test.ts` (extend with init tests)
- Modify: `app/src/routes/+layout.svelte:177` (install at mount)

**Acceptance Criteria:**
- [ ] `installBacklinkIndex()` schedules an async rebuild from `getAllNotesIncludingTemplates()`, skipping `deleted` notes.
- [ ] `ensureBacklinkIndexReady()` resolves to `void` after the init promise settles; returns an already-resolved promise if init was never started.
- [ ] Repeat `installBacklinkIndex()` calls replace the in-flight promise (the latest install wins).
- [ ] `+layout.svelte` calls `installBacklinkIndex()` inside `onMount`, before the existing `installRealNoteSync()` call (so the index is warm by the time the first save fires).
- [ ] All Task 1 tests still pass.

**Verify:**
```bash
cd app && npm run test -- backlinkIndex.test.ts && npm run check
```
Expected: tests green, svelte-check passes.

**Steps:**

- [ ] **Step 1: Add init tests**

Append to `app/tests/unit/core/backlinkIndex.test.ts`:

```ts
import {
  installBacklinkIndex,
  ensureBacklinkIndexReady
} from '$lib/core/backlinkIndex.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { vi } from 'vitest';

describe('install / ensureReady', () => {
  beforeEach(() => {
    clear();
    vi.restoreAllMocks();
  });

  it('initFromAllNotes scans IDB once, skipping deleted', async () => {
    const notes = [
      { guid: 'g1', xmlContent: noteContent('A'), deleted: false },
      { guid: 'g2', xmlContent: noteContent('A', 'B'), deleted: false },
      { guid: 'g3', xmlContent: noteContent('Z'), deleted: true }
    ] as unknown as Parameters<typeof noteStore.getAllNotesIncludingTemplates>[0] extends never
      ? never
      : never;
    vi.spyOn(noteStore, 'getAllNotesIncludingTemplates').mockResolvedValue(
      notes as never
    );
    installBacklinkIndex();
    await ensureBacklinkIndexReady();
    expect(getSourcesFor('A')).toEqual(new Set(['g1', 'g2']));
    expect(getSourcesFor('B')).toEqual(new Set(['g2']));
    expect(getSourcesFor('Z')).toBeUndefined();
  });

  it('ensureBacklinkIndexReady before install returns resolved promise', async () => {
    await expect(ensureBacklinkIndexReady()).resolves.toBeUndefined();
  });

  it('repeat installBacklinkIndex re-builds', async () => {
    vi.spyOn(noteStore, 'getAllNotesIncludingTemplates').mockResolvedValueOnce(
      [{ guid: 'g1', xmlContent: noteContent('A'), deleted: false }] as never
    );
    installBacklinkIndex();
    await ensureBacklinkIndexReady();
    expect(getSourcesFor('A')).toEqual(new Set(['g1']));

    vi.spyOn(noteStore, 'getAllNotesIncludingTemplates').mockResolvedValueOnce(
      [{ guid: 'g2', xmlContent: noteContent('B'), deleted: false }] as never
    );
    clear();
    installBacklinkIndex();
    await ensureBacklinkIndexReady();
    expect(getSourcesFor('A')).toBeUndefined();
    expect(getSourcesFor('B')).toEqual(new Set(['g2']));
  });
});
```

- [ ] **Step 2: Run tests to verify init tests fail**

Run: `cd app && npm run test -- backlinkIndex.test.ts`
Expected: FAIL — `installBacklinkIndex` and `ensureBacklinkIndexReady` not exported.

- [ ] **Step 3: Implement init API**

Append to `app/src/lib/core/backlinkIndex.ts`:

```ts
import * as noteStore from '$lib/storage/noteStore.js';

let initPromise: Promise<void> | null = null;

/**
 * Kick off a one-shot async rebuild of the index from IDB. Safe to call
 * multiple times — the latest call wins (the previous in-flight promise
 * is replaced). Non-blocking; consumers should await
 * `ensureBacklinkIndexReady()` before any operation that depends on the
 * index being populated.
 */
export function installBacklinkIndex(): void {
  initPromise = (async () => {
    const all = await noteStore.getAllNotesIncludingTemplates();
    for (const note of all) {
      if (note.deleted) continue;
      updateNote(note.guid, note.xmlContent, false);
    }
  })();
}

/**
 * Resolves once the most recent `installBacklinkIndex()` has finished
 * scanning IDB. If install has never been called (e.g. unit tests), this
 * resolves immediately — callers that need a guaranteed snapshot should
 * call install first.
 */
export function ensureBacklinkIndexReady(): Promise<void> {
  return initPromise ?? Promise.resolve();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npm run test -- backlinkIndex.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Wire into root layout**

Edit `app/src/routes/+layout.svelte` — add the import near the existing `installRealNoteSync` import (around line 19):

```ts
import { installBacklinkIndex } from '$lib/core/backlinkIndex.js';
```

Inside `onMount`, immediately before the line `void installRealNoteSync();` at line 177, add:

```ts
installBacklinkIndex();
```

(Synchronous call — it schedules the async init internally. Placement BEFORE `installRealNoteSync` is intentional so the index starts building as early as possible.)

- [ ] **Step 6: Verify type check**

Run: `cd app && npm run check`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu
git add app/src/lib/core/backlinkIndex.ts app/tests/unit/core/backlinkIndex.test.ts app/src/routes/+layout.svelte
git commit -m "$(cat <<'EOF'
feat(backlinkIndex): install at layout mount + ensureReady gate

installBacklinkIndex kicks off an async rebuild from IDB notes;
ensureBacklinkIndexReady awaits the in-flight promise (or resolves
immediately when no install has run). Wired into +layout.svelte
alongside installRealNoteSync so the index is warm by the time the
first save fires.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire `backlinkIndex.updateNote` into `noteStore`

**Goal:** Make every IDB write path automatically maintain the index. Single chokepoint: `putNote`, `putNoteSynced`, `deleteNote` in `noteStore.ts`. No caller-side change required.

**Files:**
- Modify: `app/src/lib/storage/noteStore.ts:36-44` (`putNote`)
- Modify: `app/src/lib/storage/noteStore.ts:51-54` (`putNoteSynced`)
- Modify: `app/src/lib/storage/noteStore.ts:63-74` (`deleteNote`)
- Create: `app/tests/unit/core/backlinkIndexStoreIntegration.test.ts`

**Acceptance Criteria:**
- [ ] After `putNote(note)` the index reflects `note.xmlContent` and `note.deleted`.
- [ ] After `putNoteSynced(note)` the index reflects the new content (same as `putNote`).
- [ ] After `deleteNote(guid)` the index has no entries for `guid`.
- [ ] No caller-side change required — existing call sites (`updateNoteFromEditor`, `importNoteXml`, `applyIncomingRemoteNote`, slip-note ops, admin rollback) still work.
- [ ] All previous tests still pass.

**Verify:**
```bash
cd app && npm run test && npm run check
```
Expected: full suite green.

**Steps:**

- [ ] **Step 1: Write integration test**

Create `app/tests/unit/core/backlinkIndexStoreIntegration.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { putNote, putNoteSynced, deleteNote } from '$lib/storage/noteStore.js';
import {
  getSourcesFor,
  clear as clearIndex,
  __test__getForward
} from '$lib/core/backlinkIndex.js';
import { createEmptyNote } from '$lib/core/note.js';

function noteWithBody(guid: string, body: string) {
  const n = createEmptyNote(guid);
  n.xmlContent = `<note-content version="0.1">${body}</note-content>`;
  return n;
}

describe('noteStore ↔ backlinkIndex integration', () => {
  beforeEach(() => clearIndex());

  it('putNote populates the index', async () => {
    await putNote(noteWithBody('g1', '<link:internal>A</link:internal>'));
    expect(getSourcesFor('A')).toEqual(new Set(['g1']));
  });

  it('putNote with new content swaps target', async () => {
    await putNote(noteWithBody('g1', '<link:internal>A</link:internal>'));
    await putNote(noteWithBody('g1', '<link:internal>B</link:internal>'));
    expect(getSourcesFor('A')).toBeUndefined();
    expect(getSourcesFor('B')).toEqual(new Set(['g1']));
  });

  it('putNoteSynced also updates the index', async () => {
    await putNoteSynced(noteWithBody('g1', '<link:internal>X</link:internal>'));
    expect(getSourcesFor('X')).toEqual(new Set(['g1']));
  });

  it('deleteNote removes all entries for the guid', async () => {
    await putNote(noteWithBody('g1', '<link:internal>A</link:internal><link:internal>B</link:internal>'));
    await deleteNote('g1');
    expect(getSourcesFor('A')).toBeUndefined();
    expect(getSourcesFor('B')).toBeUndefined();
    expect(__test__getForward().has('g1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd app && npm run test -- backlinkIndexStoreIntegration.test.ts`
Expected: FAIL — index entries not present after putNote.

- [ ] **Step 3: Wire `updateNote` into `noteStore.ts`**

Edit `app/src/lib/storage/noteStore.ts`. Add at top of imports (after the existing imports):

```ts
import * as backlinkIndex from '$lib/core/backlinkIndex.js';
```

Modify `putNote`:

```ts
export async function putNote(note: NoteData): Promise<void> {
	const db = await getDB();
	const existing = await db.get('notes', note.guid);
	await db.put('notes', {
		...note,
		localDirty: true,
		syncedXmlContent: existing?.syncedXmlContent ?? note.syncedXmlContent
	});
	backlinkIndex.updateNote(note.guid, note.xmlContent, !!note.deleted);
}
```

Modify `putNoteSynced`:

```ts
export async function putNoteSynced(note: NoteData): Promise<void> {
	const db = await getDB();
	await db.put('notes', { ...note, syncedXmlContent: note.xmlContent });
	backlinkIndex.updateNote(note.guid, note.xmlContent, !!note.deleted);
}
```

Modify `deleteNote` — add the index call after the IDB put:

```ts
export async function deleteNote(guid: string): Promise<void> {
	const db = await getDB();
	const note = await db.get('notes', guid);
	if (note) {
		const now = formatTomboyDate(new Date());
		note.deleted = true;
		note.localDirty = true;
		note.changeDate = now;
		note.metadataChangeDate = now;
		await db.put('notes', note);
		backlinkIndex.updateNote(guid, note.xmlContent, true);
	}
}
```

- [ ] **Step 4: Run integration test**

Run: `cd app && npm run test -- backlinkIndexStoreIntegration.test.ts`
Expected: all pass.

- [ ] **Step 5: Run full test suite + type check**

Run: `cd app && npm run test && npm run check`
Expected: everything green. Watch for any test that previously called `putNote` and now sees an index side-effect — none should break since the index has no consumers yet outside the new tests.

- [ ] **Step 6: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu
git add app/src/lib/storage/noteStore.ts app/tests/unit/core/backlinkIndexStoreIntegration.test.ts
git commit -m "$(cat <<'EOF'
feat(backlinkIndex): maintain index from noteStore write paths

putNote / putNoteSynced / deleteNote now call backlinkIndex.updateNote
after every IDB write. Single chokepoint covers every data-entry path
(editor save, import, sync-pull, Firebase incremental apply, admin
rollback, slip-note chain ops) — no caller-side change needed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Rewrite `rewriteBacklinksForRename` using the index + `Promise.all`

**Goal:** Replace the O(N × L) full-corpus scan with an O(M) indexed sweep that runs per-affected-note read+rewrite+write in parallel via `Promise.all`.

**Files:**
- Modify: `app/src/lib/core/noteManager.ts:172-198`
- Create: `app/tests/unit/core/rewriteBacklinksForRename.test.ts`

**Acceptance Criteria:**
- [ ] `rewriteBacklinksForRename(oldTitle, newTitle, selfGuid)` calls `ensureBacklinkIndexReady()` then `backlinkIndex.getSourcesFor(oldTitle)`.
- [ ] Iterates only over `[...sources].filter(g => g !== selfGuid)`.
- [ ] Per-target work runs concurrently via `Promise.all`.
- [ ] Soft-deleted target notes are skipped (no putNote).
- [ ] Returns only guids that were actually written (i.e. `rewriteInternalLinkRefsInXml` reported `changed`).
- [ ] Post-sweep the index has no `oldTitle` entry, and `newTitle` contains the same source set (since `putNote` updates the index).
- [ ] When `oldTitle === newTitle`, returns `[]` without touching the index.
- [ ] When `backlinkIndex.getSourcesFor(oldTitle)` is `undefined`, returns `[]` without an IDB call.

**Verify:**
```bash
cd app && npm run test -- rewriteBacklinksForRename.test.ts && npm run test
```
Expected: targeted test green; full suite green.

**Steps:**

- [ ] **Step 1: Write the integration test**

Create `app/tests/unit/core/rewriteBacklinksForRename.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { putNote, getNote } from '$lib/storage/noteStore.js';
import { updateNoteFromEditor, createNote } from '$lib/core/noteManager.js';
import {
  getSourcesFor,
  clear as clearIndex,
  installBacklinkIndex,
  ensureBacklinkIndexReady
} from '$lib/core/backlinkIndex.js';
import { createEmptyNote, formatTomboyDate } from '$lib/core/note.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';

function makeNote(guid: string, title: string, body: string) {
  const n = createEmptyNote(guid);
  n.title = title;
  n.xmlContent = `<note-content version="0.1">${title}\n${body}</note-content>`;
  return n;
}

describe('rewriteBacklinksForRename via backlinkIndex', () => {
  beforeEach(async () => {
    clearIndex();
    // Reset fake IDB — easiest is to indirect via the lib's reset hook if one
    // exists; otherwise use indexedDB.deleteDatabase('tomboy-web') and let
    // db.ts re-open on next access. Adjust to match the project's existing
    // test setup pattern (see backlinkIndexStoreIntegration.test.ts).
    indexedDB.deleteDatabase('tomboy-web');
  });

  it('rename hits only indexed sources and rewrites both internal and broken marks', async () => {
    // Seed: noteA "Foo", noteB links to Foo (internal), noteC has broken Foo,
    // noteD is unrelated.
    await putNote(makeNote('a', 'Foo', ''));
    await putNote(
      makeNote('b', 'Linker', '<link:internal>Foo</link:internal>')
    );
    await putNote(
      makeNote('c', 'BrokenLinker', '<link:broken>Foo</link:broken>')
    );
    await putNote(makeNote('d', 'Unrelated', '<p>just text</p>'));

    expect(getSourcesFor('Foo')).toEqual(new Set(['b', 'c']));

    // Rename Foo → Bar via the editor save path: simulate by writing a new
    // doc with title=Bar through updateNoteFromEditor.
    const noteA = await getNote('a');
    expect(noteA).toBeTruthy();
    const docWithBarTitle = deserializeContent(
      `<note-content version="0.1">Bar\n</note-content>`
    );
    await updateNoteFromEditor('a', docWithBarTitle);

    const after_b = await getNote('b');
    const after_c = await getNote('c');
    const after_d = await getNote('d');
    expect(after_b?.xmlContent).toContain('<link:internal>Bar</link:internal>');
    expect(after_b?.xmlContent).not.toContain('Foo');
    expect(after_c?.xmlContent).toContain('<link:broken>Bar</link:broken>');
    expect(after_d?.xmlContent).toBe(makeNote('d', 'Unrelated', '<p>just text</p>').xmlContent);

    expect(getSourcesFor('Foo')).toBeUndefined();
    expect(getSourcesFor('Bar')).toEqual(new Set(['b', 'c']));
  });

  it('soft-deleted source is skipped', async () => {
    await putNote(makeNote('a', 'Foo', ''));
    const b = makeNote('b', 'Linker', '<link:internal>Foo</link:internal>');
    b.deleted = true;
    await putNote(b);

    // Deleted notes are removed from the index by putNote.
    expect(getSourcesFor('Foo')).toBeUndefined();

    const docWithBarTitle = deserializeContent(
      `<note-content version="0.1">Bar\n</note-content>`
    );
    await updateNoteFromEditor('a', docWithBarTitle);

    const after_b = await getNote('b');
    expect(after_b?.deleted).toBe(true);
    expect(after_b?.xmlContent).toContain('Foo'); // untouched
  });

  it('no-op when oldTitle has no backlinks', async () => {
    await putNote(makeNote('a', 'Foo', ''));
    await putNote(makeNote('d', 'Unrelated', '<p>just text</p>'));

    const docWithBarTitle = deserializeContent(
      `<note-content version="0.1">Bar\n</note-content>`
    );
    await updateNoteFromEditor('a', docWithBarTitle);

    const after_d = await getNote('d');
    expect(after_d?.changeDate).toBe(makeNote('d', 'Unrelated', '<p>just text</p>').changeDate);
  });
});
```

(If `indexedDB.deleteDatabase` interacts awkwardly with `fake-indexeddb/auto` in the repo's existing tests, mirror whatever pattern `backlinkIndexStoreIntegration.test.ts` ended up using — both files share the same setup constraint.)

- [ ] **Step 2: Run to confirm it fails**

Run: `cd app && npm run test -- rewriteBacklinksForRename.test.ts`
Expected: FAIL — the current implementation does a full scan and the index isn't consulted, so the post-sweep `getSourcesFor('Bar')` assertion fails because the index entries aren't migrated until the new code lands.

- [ ] **Step 3: Replace `rewriteBacklinksForRename` in `noteManager.ts`**

Edit `app/src/lib/core/noteManager.ts`. Add at the top with the other imports:

```ts
import * as backlinkIndex from './backlinkIndex.js';
```

Replace the entire `async function rewriteBacklinksForRename(...)` body at lines 172-198 with:

```ts
/**
 * Sweep backlinks for a renamed note. Uses the in-memory backlinkIndex
 * to look up affected sources directly (O(M) where M = notes containing
 * a mark targeting `oldTitle`), then rewrites them in parallel via
 * `Promise.all`. Returns the list of affected guids.
 *
 * Each `putNote` call automatically updates the index — by the time
 * Promise.all resolves, the `oldTitle` entry is empty (and pruned) and
 * the same source guids live under `newTitle`.
 */
async function rewriteBacklinksForRename(
	oldTitle: string,
	newTitle: string,
	selfGuid: string
): Promise<string[]> {
	if (oldTitle === newTitle) return [];
	await backlinkIndex.ensureBacklinkIndexReady();
	const sources = backlinkIndex.getSourcesFor(oldTitle);
	if (!sources || sources.size === 0) return [];

	// Snapshot — `sources` is the live Set; putNote mutates it during the
	// sweep, so iterating directly would skip notes.
	const targetGuids = [...sources].filter((g) => g !== selfGuid);
	const now = formatTomboyDate(new Date());

	const results = await Promise.all(
		targetGuids.map(async (g) => {
			const other = await noteStore.getNote(g);
			if (!other || other.deleted) return null;
			const { xml, changed } = rewriteInternalLinkRefsInXml(
				other.xmlContent,
				oldTitle,
				newTitle
			);
			// Defensive: index says this note contains the mark, but
			// rewriteInternalLinkRefsInXml found nothing to replace. Could
			// happen on an index/data divergence (e.g. someone manually mutated
			// IDB). Skip without bumping changeDate so we don't write spurious
			// dirty state.
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

- [ ] **Step 4: Run the targeted test**

Run: `cd app && npm run test -- rewriteBacklinksForRename.test.ts`
Expected: all pass.

- [ ] **Step 5: Run the full suite**

Run: `cd app && npm run test && npm run check`
Expected: every test green, no svelte-check regressions.

- [ ] **Step 6: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu
git add app/src/lib/core/noteManager.ts app/tests/unit/core/rewriteBacklinksForRename.test.ts
git commit -m "$(cat <<'EOF'
perf(rename): use backlinkIndex + Promise.all in rewriteBacklinksForRename

Replaces the O(N × L) full-corpus scan with an O(M) indexed lookup +
parallel per-target read/rewrite/write. The index migrates oldTitle →
newTitle automatically because every putNote call updates it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `flushSave` serialization (both editor routes)

**Goal:** Chain consecutive `flushSave` calls so a second one cannot start until the first (and its rename sweep) resolves. Closes the concurrent-sweep race window described in the spec.

**Files:**
- Modify: `app/src/routes/note/[id]/+page.svelte:349-367`
- Modify: `app/src/lib/desktop/NoteWindow.svelte:381-394`

**Acceptance Criteria:**
- [ ] In both files, `flushSave` body is wrapped in a `flushChain` promise sequencing pattern.
- [ ] A second `flushSave()` call invoked while the first is pending awaits the first before doing its own work.
- [ ] A thrown error inside one `flushSave` is caught and logged via `console.error` and does NOT break the chain (the next `flushSave` still runs).
- [ ] The function still returns a `Promise<void>` so existing `await flushSave()` call sites (e.g. `handleInternalLink`) keep working.
- [ ] Manual UI smoke: rename a note quickly in succession in two windows of the desktop view — typing remains responsive.

**Verify:**
```bash
cd app && npm run check && npm run test
```
Expected: full green. (Race fix is hard to unit-test reliably without flakiness; verification is by inspection + the manual smoke above. Type check covers the wiring.)

**Steps:**

- [ ] **Step 1: Edit `routes/note/[id]/+page.svelte`**

Locate the existing `flushSave` function (around line 349). Add a `flushChain` declaration immediately before it (alongside the other module-level `let` statements for `pendingDoc`, `saveTimer`, `lastSavedDocFingerprint`). Find the existing block (looks something like):

```ts
let pendingDoc: JSONContent | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSavedDocFingerprint = '';
```

Add immediately after that block:

```ts
let flushChain: Promise<void> = Promise.resolve();
```

Then replace the existing `async function flushSave()` with:

```ts
function flushSave(): Promise<void> {
	flushChain = flushChain.then(async () => {
		if (!pendingDoc || !note) return;
		const fingerprint = JSON.stringify(pendingDoc);
		if (fingerprint === lastSavedDocFingerprint) {
			pendingDoc = null;
			return;
		}
		saving = true;
		const updated = await updateNoteFromEditor(note.guid, pendingDoc);
		if (updated) note = updated;
		lastSavedDocFingerprint = fingerprint;
		pendingDoc = null;
		saving = false;
	}).catch((err) => {
		console.error('[flushSave]', err);
		saving = false;
	});
	return flushChain;
}
```

- [ ] **Step 2: Edit `lib/desktop/NoteWindow.svelte`**

Same pattern. Find the `let pendingDoc: JSONContent | null = null;` declarations near the `handleEditorChange` function and add right after them:

```ts
let flushChain: Promise<void> = Promise.resolve();
```

Replace the existing `async function flushSave()` at line 381 with:

```ts
function flushSave(): Promise<void> {
	flushChain = flushChain.then(async () => {
		if (!pendingDoc || !note) return;
		const fingerprint = JSON.stringify(pendingDoc);
		if (fingerprint === lastSavedDocFingerprint) {
			pendingDoc = null;
			return;
		}
		saving = true;
		const updated = await updateNoteFromEditor(note.guid, pendingDoc);
		if (updated) note = updated;
		lastSavedDocFingerprint = fingerprint;
		pendingDoc = null;
		saving = false;
	}).catch((err) => {
		console.error('[flushSave]', err);
		saving = false;
	});
	return flushChain;
}
```

- [ ] **Step 3: Type check + tests**

Run: `cd app && npm run check && npm run test`
Expected: green. The `await flushSave()` call sites (e.g. `handleInternalLink`) continue working because the function still returns a `Promise<void>`.

- [ ] **Step 4: Manual smoke**

Run: `cd app && npm run dev`
- Open the app, create three notes A, B, C with bodies referencing each other (`[[A]]`, `[[B]]`).
- Rename a note quickly while typing in another window (desktop mode). Verify no input lag past ~100ms and no inconsistent backlinks (open each receiver note, check that link marks resolve).

- [ ] **Step 5: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu
git add app/src/routes/note/[id]/+page.svelte app/src/lib/desktop/NoteWindow.svelte
git commit -m "$(cat <<'EOF'
fix(editor): serialize flushSave via promise chain

A new flushSave call now awaits any in-flight save before doing its
own work, closing the race window where a second sweep could launch
mid-way through the first and leave backlinks at the intermediate
title. Belt-and-suspenders alongside the backlinkIndex change that
already shrinks the sweep to O(M).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Admin tools "백링크 인덱스 재구성" button

**Goal:** Add a manual rebuild action on `/admin/tools` for ops/escape-hatch use. Clears the in-memory index and re-scans all notes. Does not modify note content.

**Files:**
- Modify: `app/src/routes/admin/tools/+page.svelte` (add import, handler, button)

**Acceptance Criteria:**
- [ ] New section / button labeled "백링크 인덱스 재구성" on `/admin/tools`.
- [ ] Click triggers `backlinkIndex.clear()` + a fresh scan from IDB.
- [ ] Button is disabled while rebuilding (uses the existing `running` flag or a new local one).
- [ ] Success toast shows the number of notes scanned.
- [ ] No note content is modified.

**Verify:**

Manual: open `/admin/tools`, click the button, confirm toast appears and the button briefly disables.

```bash
cd app && npm run check
```
Expected: type-check clean.

**Steps:**

- [ ] **Step 1: Add the import + handler + button**

Edit `app/src/routes/admin/tools/+page.svelte`:

Add to the imports at the top of the `<script lang="ts">` block:

```ts
import {
	clear as clearBacklinkIndex,
	updateNote as updateBacklinkIndex
} from '$lib/core/backlinkIndex.js';
import { getAllNotesIncludingTemplates } from '$lib/storage/noteStore.js';
```

(`getAllNotesIncludingTemplates` is already used by the index install; add the import if it's not already imported in this file. If it IS already imported via the existing `from '$lib/storage/noteStore.js'` line, extend that import instead of adding a new one.)

Add a state flag with the other `$state` declarations near the top:

```ts
let indexRebuilding = $state(false);
```

Add a handler function near the other admin handlers (alongside `handleClearImageCache`):

```ts
async function handleRebuildBacklinkIndex(): Promise<void> {
	if (indexRebuilding) return;
	indexRebuilding = true;
	try {
		clearBacklinkIndex();
		const all = await getAllNotesIncludingTemplates();
		for (const note of all) {
			if (note.deleted) continue;
			updateBacklinkIndex(note.guid, note.xmlContent, false);
		}
		pushToast(`백링크 인덱스를 다시 구성했습니다 (${all.length}개 노트 스캔).`);
	} finally {
		indexRebuilding = false;
	}
}
```

Add a button in the template — near the existing "이미지 캐시 비우기" button (around line 451):

```svelte
<section>
	<h3>백링크 인덱스</h3>
	<p>노트 제목 변경 시 백링크가 누락된 상태가 의심되면 인덱스를 다시 구성하세요. 노트 내용은 수정되지 않습니다.</p>
	<button class="btn" onclick={handleRebuildBacklinkIndex} disabled={indexRebuilding}>
		{indexRebuilding ? '재구성 중...' : '백링크 인덱스 재구성'}
	</button>
</section>
```

(Match the surrounding HTML structure — copy `<section>`/`<h3>` style from the closest existing block in the file. The exact wrapper may differ; the key is the button + onclick + disabled binding.)

- [ ] **Step 2: Type check**

Run: `cd app && npm run check`
Expected: no new errors.

- [ ] **Step 3: Manual smoke**

Run: `cd app && npm run dev`
- Navigate to `/admin/tools`.
- Click "백링크 인덱스 재구성". Confirm:
  - Button disables briefly.
  - Toast appears with note count.
  - Subsequent rename in another tab still hits affected notes correctly.

- [ ] **Step 4: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu
git add app/src/routes/admin/tools/+page.svelte
git commit -m "$(cat <<'EOF'
feat(admin): /admin/tools — 백링크 인덱스 재구성 버튼

Manual rebuild action for the in-memory backlink index. Clears + re-
scans all non-deleted notes. Doesn't modify note content; safe to run
any time. Lives under /admin because the concept is internal (general
users don't need to know the index exists).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Tasks 1-2 cover `backlinkIndex.ts` module (spec §Architecture, §New module, §Init timing). Task 3 covers spec §"Wire-in: noteStore.putNote / deleteNote". Task 4 covers spec §"Rewritten rewriteBacklinksForRename". Task 5 covers spec §"flushSave serialization". Task 6 covers spec §"Settings: rebuild action". Edge cases (XML escape, soft-delete, templates, init not finished) are covered by Task 1+3+4 tests.
- **No placeholders.** Every step contains the actual code/command/file path.
- **Type consistency:** `updateNote(guid, xml, deleted)` signature used identically in Tasks 1, 3, 6. `ensureBacklinkIndexReady` / `installBacklinkIndex` / `getSourcesFor` / `clear` exported names match across all references.
- **Out of scope** (per spec §Known limitations): cross-editor concurrent renames across multiple windows on different notes. Not addressed in this plan.
