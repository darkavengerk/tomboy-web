# New-note Result Panel + Corpus Link Sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After creating a note, keep the progress popup open as a result panel showing per-stage timings, add a confirmed whole-corpus "link this title everywhere" sweep, and stop the silent post-creation autolink stutter by delta-gating the automatic per-editor rescan.

**Architecture:** Two independent threads. (A) `newNoteFlow` gains a persistent `result` phase + a headless `linkSweep` (count→confirm→apply) that links the new title across the corpus via a pure additive `addInternalLinksForTitle` JSON linker reusing `findTitleMatches`. (B) `titleProvider` broadcasts an `{added, removed}` delta and `TomboyEditor` skips the automatic rescan unless a pure `shouldRescanForDelta` predicate says the doc could be affected.

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap 3 / ProseMirror, `idb`, vitest + `fake-indexeddb`. Spec: `docs/superpowers/specs/2026-06-14-new-note-result-panel-design.md`.

**Reference facts (verified against the current code):**
- Internal-link mark JSON: `{ "type": "tomboyInternalLink", "attrs": { "target": "<title>" } }` (`extensions/TomboyInternalLink.ts:30,43`). `broken` defaults `false`, `instanceId` defaults `null` — omit both when adding.
- Suppress-mark names: `['tomboyUrlLink', 'tomboyMonospace', 'code']` (`autoLinkPlugin.ts:55`).
- `findTitleMatches(text, titles: {title,guid}[], {excludeGuid?}) → {from,to,target,guid}[]` — whole-word, longest-first, exact case (`autoLink/findTitleMatches.ts:46`).
- `deserializeContent(xml) → JSONContent` (`{type:'doc',content:[block,…]}`), `serializeContent(JSONContent) → xml` (`core/noteContentArchiver.ts:219,249`). A textblock = a node whose `content` includes `{type:'text'}` children; text node = `{type:'text', text, marks?:[{type,attrs}]}`.
- Title-line skip rule (mirror `applyInRange.ts`): skip the first top-level block **only when the doc has >1 top-level block** (`autoLinkPlugin.ts:289-299`).
- `titleProvider.doSharedRefresh` already diffs via `entriesEquivalent` and fans out `sharedListeners` (`autoLink/titleProvider.ts:47-89`). `onChange(cb)` currently `() => void`.
- `TomboyEditor` autolink rescan trigger: `const offChange = titleProvider.onChange(() => { scheduleAutoLinkScan({ full: true }); });` (`TomboyEditor.svelte:1147`).
- Popup host: `+layout.svelte:374` `{#if newNoteFlow.phase === 'input'} … {:else if newNoteFlow.phase === 'creating'} …` (outside the `{#if isChromeless}` branch → renders on mobile + desktop).
- Cross-window mutation contract (CLAUDE.md): `await desktopSession.flushAll()` before a multi-note read/write; `await desktopSession.reloadWindows(guids)` + `emitNoteReload(guids)` after.

---

### Task 1: `addInternalLinksForTitle` — pure additive JSON linker

**Goal:** A schema-free function that adds the `tomboyInternalLink` mark to whole-word matches of ONE title in a note's JSONContent, reusing `findTitleMatches`, idempotent and respecting suppressed/title-line skips.

**Files:**
- Create: `app/src/lib/editor/autoLink/linkifyDocJson.ts`
- Test: `app/tests/unit/editor/linkifyDocJson.test.ts`

**Acceptance Criteria:**
- [ ] Adds the mark on a whole-word match in a body paragraph; `attrs.target` === title.
- [ ] No-op (`changed:false`, same json) when the title doesn't occur or only as a sub-word.
- [ ] Idempotent: a run whose match span already carries a `tomboyInternalLink` mark is skipped.
- [ ] Skips the first block (title line) when the doc has >1 block; links it when the doc is a single block.
- [ ] Skips matches whose chars sit under a suppressed mark (`tomboyMonospace`/`tomboyUrlLink`/`code`).
- [ ] Recurses into list items (match inside `bulletList > listItem > paragraph` gets linked).

**Verify:** `cd app && npx vitest run tests/unit/editor/linkifyDocJson.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing tests.**

```ts
// app/tests/unit/editor/linkifyDocJson.test.ts
import { describe, it, expect } from 'vitest';
import { addInternalLinksForTitle } from '$lib/editor/autoLink/linkifyDocJson.js';
import type { JSONContent } from '@tiptap/core';

const para = (text: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): JSONContent => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text, ...(marks ? { marks } : {}) }] : []
});
const doc = (...blocks: JSONContent[]): JSONContent => ({ type: 'doc', content: blocks });

const linkMark = (target: string) => ({ type: 'tomboyInternalLink', attrs: { target } });

describe('addInternalLinksForTitle', () => {
  it('links a whole-word match in a body paragraph', () => {
    const input = doc(para('Title line'), para('see Foo here'));
    const { docJson, changed } = addInternalLinksForTitle(input, 'Foo', 'g-foo');
    expect(changed).toBe(true);
    const inline = (docJson.content![1].content!) as JSONContent[];
    // 'see ' | 'Foo'(linked) | ' here'
    const linked = inline.find((n) => n.marks?.some((m) => m.type === 'tomboyInternalLink'));
    expect(linked?.text).toBe('Foo');
    expect(linked?.marks?.[0].attrs).toEqual({ target: 'Foo' });
  });

  it('no-ops on sub-word and on absence', () => {
    expect(addInternalLinksForTitle(doc(para('t'), para('Foobar')), 'Foo', 'g').changed).toBe(false);
    expect(addInternalLinksForTitle(doc(para('t'), para('nothing')), 'Foo', 'g').changed).toBe(false);
  });

  it('is idempotent when the span already carries the mark', () => {
    const pre = doc(para('t'), { type: 'paragraph', content: [
      { type: 'text', text: 'see ' },
      { type: 'text', text: 'Foo', marks: [linkMark('Foo')] }
    ]});
    expect(addInternalLinksForTitle(pre, 'Foo', 'g').changed).toBe(false);
  });

  it('skips the title line only when the doc has a body', () => {
    expect(addInternalLinksForTitle(doc(para('Foo')), 'Foo', 'g').changed).toBe(true); // single block → link
    expect(addInternalLinksForTitle(doc(para('Foo'), para('x')), 'Foo', 'g')
      .docJson.content![0].content![0].marks).toBeUndefined(); // title line untouched
  });

  it('skips matches under a suppressed mark', () => {
    const input = doc(para('t'), para('Foo', [{ type: 'tomboyMonospace' }]));
    expect(addInternalLinksForTitle(input, 'Foo', 'g').changed).toBe(false);
  });

  it('recurses into list items', () => {
    const li = { type: 'bulletList', content: [
      { type: 'listItem', content: [para('Foo')] }
    ]};
    const { changed, docJson } = addInternalLinksForTitle(doc(para('t'), li), 'Foo', 'g');
    expect(changed).toBe(true);
    const liPara = ((docJson.content![1].content![0] as JSONContent).content![0] as JSONContent);
    expect(liPara.content!.some((n) => n.marks?.some((m) => m.type === 'tomboyInternalLink'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run → fail** (`module not found`). `cd app && npx vitest run tests/unit/editor/linkifyDocJson.test.ts`

- [ ] **Step 3: Implement.**

```ts
// app/src/lib/editor/autoLink/linkifyDocJson.ts
import type { JSONContent } from '@tiptap/core';
import { findTitleMatches } from './findTitleMatches.js';

const LINK_MARK = 'tomboyInternalLink';
const DEFAULT_SUPPRESS = ['tomboyUrlLink', 'tomboyMonospace', 'code'];

interface CharMeta { node: JSONContent; suppressed: boolean; hasLink: boolean; }

/**
 * Add the `tomboyInternalLink` mark to whole-word matches of `title` in `docJson`.
 * Additive only (never removes/reconciles). Pure: returns a new doc when changed,
 * otherwise the original object with `changed:false`. No ProseMirror schema needed.
 *
 * Mirrors autoLinkPlugin.applyInRange's run-building + skip rules, but reuses the
 * SAME pure `findTitleMatches`, so matching stays consistent with the live editor.
 */
export function addInternalLinksForTitle(
  docJson: JSONContent,
  title: string,
  targetGuid: string,
  suppressMarks: string[] = DEFAULT_SUPPRESS
): { docJson: JSONContent; changed: boolean } {
  const trimmed = title.trim();
  const blocks = docJson.content ?? [];
  if (!trimmed || blocks.length === 0) return { docJson, changed: false };
  const suppress = new Set(suppressMarks);
  const hasBody = blocks.length > 1;
  let changed = false;

  const isText = (n: JSONContent) => n.type === 'text';
  const hasInlineText = (n: JSONContent) => Array.isArray(n.content) && n.content.some(isText);

  // Returns a (possibly new) node; mutates nothing in place.
  function processBlock(node: JSONContent): JSONContent {
    if (hasInlineText(node)) return linkInline(node);
    if (!Array.isArray(node.content)) return node;
    const newContent = node.content.map(processBlock);
    return { ...node, content: newContent };
  }

  // Rebuild a textblock's inline content, adding the link mark on fresh matches.
  function linkInline(block: JSONContent): JSONContent {
    const inline = block.content ?? [];
    // Build runs of contiguous text nodes (split on any non-text inline node).
    let out: JSONContent[] = [];
    let run: JSONContent[] = [];
    const flush = () => {
      if (run.length) { out = out.concat(relinkRun(run)); run = []; }
    };
    for (const child of inline) {
      if (isText(child)) run.push(child);
      else { flush(); out.push(child); }
    }
    flush();
    return { ...block, content: out };
  }

  // Given consecutive text nodes, return the (possibly re-split) text nodes with
  // the link mark applied to fresh, non-suppressed, not-already-linked matches.
  function relinkRun(textNodes: JSONContent[]): JSONContent[] {
    let text = '';
    const meta: CharMeta[] = [];
    for (const n of textNodes) {
      const t = n.text ?? '';
      const marks = (n.marks ?? []) as { type: string }[];
      const suppressed = marks.some((m) => suppress.has(m.type));
      const hasLink = marks.some((m) => m.type === LINK_MARK);
      for (let i = 0; i < t.length; i++) { text += t[i]; meta.push({ node: n, suppressed, hasLink }); }
    }
    const matches = findTitleMatches(text, [{ title: trimmed, guid: targetGuid }]);
    // marked[i] = char i should receive the link mark.
    const marked = new Array(text.length).fill(false);
    for (const m of matches) {
      let ok = true;
      for (let i = m.from; i < m.to; i++) if (meta[i].suppressed || meta[i].hasLink) { ok = false; break; }
      if (!ok) continue;
      for (let i = m.from; i < m.to; i++) marked[i] = true;
      changed = true;
    }
    if (!matches.length || marked.every((v) => !v)) return textNodes; // unchanged

    // Re-emit, splitting each original text node at its node boundary AND at
    // marked/unmarked transitions, so original marks are preserved per node.
    const result: JSONContent[] = [];
    let gi = 0; // global char index
    for (const n of textNodes) {
      const t = n.text ?? '';
      let i = 0;
      while (i < t.length) {
        const want = marked[gi + i];
        let j = i;
        while (j < t.length && marked[gi + j] === want) j++;
        const piece = t.slice(i, j);
        const baseMarks = (n.marks ?? []) as JSONContent[];
        const marks = want ? [...baseMarks, { type: LINK_MARK, attrs: { target: trimmed } }] : baseMarks;
        result.push({ type: 'text', text: piece, ...(marks.length ? { marks } : {}) });
        i = j;
      }
      gi += t.length;
    }
    return result;
  }

  const newBlocks = blocks.map((b, idx) => {
    if (hasBody && idx === 0) return b; // title line — never linked
    return processBlock(b);
  });

  if (!changed) return { docJson, changed: false };
  return { docJson: { ...docJson, content: newBlocks }, changed: true };
}
```

- [ ] **Step 4: Run → pass.** `cd app && npx vitest run tests/unit/editor/linkifyDocJson.test.ts`

- [ ] **Step 5: Commit.**

```bash
git add app/src/lib/editor/autoLink/linkifyDocJson.ts app/tests/unit/editor/linkifyDocJson.test.ts
git commit -m "feat(autolink): pure additive addInternalLinksForTitle (JSON, schema-free)"
```

---

### Task 2: `linkSweep` — corpus count + apply

**Goal:** Headless `countLinkSweep` / `applyLinkSweep` that prefilter the corpus by raw-XML substring, run `addInternalLinksForTitle` per candidate, and (apply) persist via `noteStore.putNote` + `noteMutated`, with progress + cancel.

**Files:**
- Create: `app/src/lib/core/linkSweep.ts`
- Test: `app/tests/unit/core/linkSweep.test.ts`

**Acceptance Criteria:**
- [ ] `countLinkSweep` returns the guids of notes that *would* change; excludes the target note, deleted notes, and notes whose `xmlContent` lacks the title substring (no parse for those).
- [ ] Already-linked notes are NOT counted (idempotent via Task 1).
- [ ] `applyLinkSweep` writes only the matched notes; `getNote` after shows the `<link:internal>` mark in XML; returns `{ updated, failed }`.
- [ ] A per-note throw increments `failed` and does not abort the rest.
- [ ] `cancelToken.cancelled === true` stops the loop; apply returns the subset written so far.

**Verify:** `cd app && npx vitest run tests/unit/core/linkSweep.test.ts`

**Steps:**

- [ ] **Step 1: Write failing tests** (fake-indexeddb). Use the existing noteStore test helpers pattern (see `tests/unit/noteListCache.test.ts` for IDB setup).

```ts
// app/tests/unit/core/linkSweep.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import * as noteStore from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';
import { countLinkSweep, applyLinkSweep } from '$lib/core/linkSweep.js';

async function seed(guid: string, title: string, body: string) {
  const n = createEmptyNote(guid);
  n.title = title;
  n.xmlContent = `<note-content version="0.1">${title}\n${body}\n\n</note-content>`;
  await noteStore.putNote(n);
}

describe('linkSweep', () => {
  beforeEach(async () => { await noteStore.clearAll?.(); /* or recreate DB per suite */ });

  it('counts only notes that gain a link', async () => {
    await seed('g1', 'Apple', 'I like Apple pie');   // matches "Apple"
    await seed('g2', 'Banana', 'no fruit here');     // no match
    await seed('gT', 'Apple', '');                   // the target itself
    const { matched } = await countLinkSweep('Apple', 'gT');
    expect(matched).toEqual(['g1']);
  });

  it('applies marks and is idempotent on re-run', async () => {
    await seed('g1', 'Note', 'see Apple now');
    await applyLinkSweep('Apple', 'gT', ['g1']);
    const after = await noteStore.getNote('g1');
    expect(after!.xmlContent).toContain('<link:internal>Apple</link:internal>');
    const second = await countLinkSweep('Apple', 'gT');
    expect(second.matched).not.toContain('g1');
  });

  it('cancel stops apply and reports the subset', async () => {
    await seed('a', 'N', 'Apple'); await seed('b', 'N2', 'Apple');
    const token = { cancelled: true };
    const r = await applyLinkSweep('Apple', 'gT', ['a', 'b'], { cancelToken: token });
    expect(r.updated).toBe(0);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.**

```ts
// app/src/lib/core/linkSweep.ts
import * as noteStore from '$lib/storage/noteStore.js';
import { deserializeContent, serializeContent } from './noteContentArchiver.js';
import { addInternalLinksForTitle } from '$lib/editor/autoLink/linkifyDocJson.js';
import { noteMutated } from '$lib/stores/noteListCache.js';

export interface CancelToken { cancelled: boolean; }
export interface SweepProgress { scanned: number; total: number; matched: number; }
type OnProgress = (p: SweepProgress) => void;

/** Notes whose raw XML contains the title substring (cheap prefilter), excluding
 *  the target note and deleted notes. */
async function candidates(title: string, targetGuid: string) {
  const all = await noteStore.getAllNotes();
  return all.filter((n) => !n.deleted && n.guid !== targetGuid && n.xmlContent.includes(title));
}

export async function countLinkSweep(
  title: string,
  targetGuid: string,
  opts: { onProgress?: OnProgress; cancelToken?: CancelToken } = {}
): Promise<{ matched: string[]; total: number }> {
  const cands = await candidates(title, targetGuid);
  const matched: string[] = [];
  for (let i = 0; i < cands.length; i++) {
    if (opts.cancelToken?.cancelled) break;
    const n = cands[i];
    try {
      const { changed } = addInternalLinksForTitle(deserializeContent(n.xmlContent), title, targetGuid);
      if (changed) matched.push(n.guid);
    } catch { /* unparseable note — skip in count */ }
    opts.onProgress?.({ scanned: i + 1, total: cands.length, matched: matched.length });
  }
  return { matched, total: cands.length };
}

export async function applyLinkSweep(
  title: string,
  targetGuid: string,
  guids: string[],
  opts: { onProgress?: OnProgress; cancelToken?: CancelToken } = {}
): Promise<{ updated: string[]; failed: number }> {
  const updated: string[] = [];
  let failed = 0;
  for (let i = 0; i < guids.length; i++) {
    if (opts.cancelToken?.cancelled) break;
    try {
      const n = await noteStore.getNote(guids[i]);
      if (!n) continue;
      const { docJson, changed } = addInternalLinksForTitle(deserializeContent(n.xmlContent), title, targetGuid);
      if (!changed) continue;
      n.xmlContent = serializeContent(docJson);
      await noteStore.putNote(n);   // also updates the in-memory backlink index
      noteMutated(n);
      updated.push(n.guid);
    } catch { failed++; }
    opts.onProgress?.({ scanned: i + 1, total: guids.length, matched: updated.length });
  }
  return { updated, failed };
}
```

> Note: confirm `noteStore` exposes `getAllNotes`, `getNote`, `putNote`, and a test-reset (`clearAll` or equivalent — check `storage/noteStore.ts`; if the reset helper differs, adapt the test `beforeEach`). `putNote` must be the index-maintaining path (per the backlink-index contract).

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit.**

```bash
git add app/src/lib/core/linkSweep.ts app/tests/unit/core/linkSweep.test.ts
git commit -m "feat(core): linkSweep count/apply over corpus (prefilter + idempotent)"
```

---

### Task 3: `newNoteFlow` — `result` phase + sweep orchestration

**Goal:** Stop auto-closing after creation; add a `result` phase holding stage timings + sweep sub-state, with `startSweepCount` / `applySweep` / `cancelSweep` / `dismiss` wired to `linkSweep` + cross-window reload.

**Files:**
- Modify: `app/src/lib/stores/newNoteFlow.svelte.ts`
- Test: `app/tests/unit/stores/newNoteFlow.test.ts` (extend)

**Acceptance Criteria:**
- [ ] After a successful `submit`, `phase === 'result'` (not `'idle'`); `stages` retain their `ms`.
- [ ] `dismiss()` returns to `'idle'` and clears `stages` + `sweep` + `navigateFn` + `createdGuid`/`createdTitle`.
- [ ] `startSweepCount()` flushes windows, runs `countLinkSweep`, sets `sweep.status='confirm'` with `matched`/`total`.
- [ ] `applySweep()` runs `applyLinkSweep`, then `emitNoteReload` + `reloadWindows` for written guids, sets `sweep.status='done'` with `updated`/`failed`/`ms`.
- [ ] `cancelSweep()` sets the cancel flag; a count in progress ends without entering `confirm`.
- [ ] Failure in stage 0–2 still toasts and returns to `'idle'` (unchanged).

**Verify:** `cd app && npx vitest run tests/unit/stores/newNoteFlow.test.ts`

**Steps:**

- [ ] **Step 1: Extend the test** — assert the new state machine. Mock `linkSweep` + `desktopSession` + `noteReloadBus` via `vi.mock`. Key cases: submit→result; dismiss clears; startSweepCount→confirm with matched; applySweep→done + reloadWindows called with updated guids.

```ts
// add to app/tests/unit/stores/newNoteFlow.test.ts
import { vi } from 'vitest';
vi.mock('$lib/core/linkSweep.js', () => ({
  countLinkSweep: vi.fn(async () => ({ matched: ['g1', 'g2'], total: 5 })),
  applyLinkSweep: vi.fn(async () => ({ updated: ['g1', 'g2'], failed: 0 }))
}));
const reloadWindows = vi.fn(async () => {});
vi.mock('$lib/desktop/session.svelte.js', () => ({
  desktopSession: { flushAll: vi.fn(async () => {}), reloadWindows }
}));
vi.mock('$lib/core/noteReloadBus.js', () => ({ emitNoteReload: vi.fn(async () => {}) }));

// … given a created note (drive submit with a stubbed createNote/navigate) …
it('persists result and runs the sweep', async () => {
  // after submit:
  expect(newNoteFlow.phase).toBe('result');
  await newNoteFlow.startSweepCount();
  expect(newNoteFlow.sweep.status).toBe('confirm');
  expect(newNoteFlow.sweep.matched).toBe(2);
  await newNoteFlow.applySweep();
  expect(newNoteFlow.sweep.status).toBe('done');
  expect(reloadWindows).toHaveBeenCalledWith(['g1', 'g2']);
  newNoteFlow.dismiss();
  expect(newNoteFlow.phase).toBe('idle');
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** In `newNoteFlow.svelte.ts`:
  - Add `'result'` to the `phase` union and a `sweep` `$state` object:
    `{ status: 'idle'|'counting'|'confirm'|'applying'|'done', scanned:0, total:0, matched:0, updated:0, failed:0, ms:0 }` plus module-level `let cancelFlag = { cancelled:false }`, `createdGuid`, `createdTitle`, `matchedGuids: string[]`.
  - In `submit()`'s `try`, after stage 2 completes, set `createdGuid=note.guid; createdTitle=finalTitle;` and in the success path set `phase = 'result'`. **Remove** the unconditional `phase='idle'` from `finally`; keep clearing pending refs only on error/dismiss. (Keep the `catch` → toast; on error set `phase='idle'`.)
  - Add getters `get sweep()`, and methods:

```ts
async startSweepCount() {
  if (!createdTitle || !createdGuid) return;
  cancelFlag = { cancelled: false };
  sweep = { ...sweep, status: 'counting', scanned: 0, total: 0, matched: 0 };
  await desktopSession.flushAll();
  const { matched, total } = await countLinkSweep(createdTitle, createdGuid, {
    cancelToken: cancelFlag,
    onProgress: (p) => { sweep = { ...sweep, scanned: p.scanned, total: p.total, matched: p.matched }; }
  });
  if (cancelFlag.cancelled) { sweep = { ...sweep, status: 'idle' }; return; }
  matchedGuids = matched;
  sweep = { ...sweep, status: 'confirm', total, matched: matched.length };
},
async applySweep() {
  if (!createdTitle || !createdGuid) return;
  cancelFlag = { cancelled: false };
  const t0 = performance.now();
  sweep = { ...sweep, status: 'applying', updated: 0, failed: 0, total: matchedGuids.length };
  const { updated, failed } = await applyLinkSweep(createdTitle, createdGuid, matchedGuids, {
    cancelToken: cancelFlag,
    onProgress: (p) => { sweep = { ...sweep, scanned: p.scanned, updated: p.matched }; }
  });
  if (updated.length) { await emitNoteReload(updated); await desktopSession.reloadWindows(updated); }
  sweep = { ...sweep, status: 'done', updated: updated.length, failed, ms: Math.round(performance.now() - t0) };
},
cancelSweep() { cancelFlag.cancelled = true; },
dismiss() {
  phase = 'idle'; stages = []; navigateFn = null;
  createdGuid = null; createdTitle = null; matchedGuids = [];
  sweep = { status: 'idle', scanned: 0, total: 0, matched: 0, updated: 0, failed: 0, ms: 0 };
}
```
  - Imports: `countLinkSweep, applyLinkSweep` from `$lib/core/linkSweep.js`; `desktopSession` from `$lib/desktop/session.svelte.js`; `emitNoteReload` from `$lib/core/noteReloadBus.js`. Verify these exact export names against source before relying on them.

- [ ] **Step 4: Run → pass** (`npm run check` too).

- [ ] **Step 5: Commit.**

```bash
git add app/src/lib/stores/newNoteFlow.svelte.ts app/tests/unit/stores/newNoteFlow.test.ts
git commit -m "feat(new-note): result phase + corpus sweep orchestration in newNoteFlow"
```

---

### Task 4: `NewNoteResultPanel` + layout wiring

**Goal:** Render the persistent result/sweep UI for `phase === 'result'`.

**Files:**
- Create: `app/src/lib/components/NewNoteResultPanel.svelte`
- Modify: `app/src/routes/+layout.svelte` (the `newNoteFlow.phase` block at `:374`)

**Acceptance Criteria:**
- [ ] On `phase==='result'` a modal panel shows each stage name + `ms`.
- [ ] `[전체 문서에 이 제목 반영]` calls `startSweepCount()`; during `counting` shows `scanned/total`; in `confirm` shows `N개 노트가 업데이트됩니다` + `[적용]`/`[취소]`; during `applying` shows `M/N`; in `done` shows `M개 완료 (xxx ms[, K 실패])`.
- [ ] `[적용]`→`applySweep()`, `[취소]`(confirm)→`cancelSweep()` back to idle, `[닫기]`→`dismiss()`.
- [ ] `npm run check` clean.

**Verify:** `cd app && npm run check` → no new errors; manual: `npm run dev`, create a note, confirm panel stays + sweep flow.

**Steps:**

- [ ] **Step 1: Build the component** (mirror `NoteTitleDialog.svelte` styling — backdrop + `.dialog` via `use:portal`, `--z-modal`; reuse its `.stages` markup for the timing list).

```svelte
<!-- app/src/lib/components/NewNoteResultPanel.svelte -->
<script lang="ts">
  import { portal } from '$lib/utils/portal.js';
  import { newNoteFlow } from '$lib/stores/newNoteFlow.svelte.js';
  const s = $derived(newNoteFlow.sweep);
</script>

<div class="backdrop" use:portal></div>
<div class="dialog" role="dialog" aria-modal="true" use:portal>
  <div class="dlg-title">새 노트 생성 완료</div>
  <ul class="stages">
    {#each newNoteFlow.stages as st (st.name)}
      <li class="stage done"><span class="stage-name">{st.name}</span>
        {#if st.ms !== null}<span class="stage-ms">{st.ms}ms</span>{/if}</li>
    {/each}
  </ul>

  {#if s.status === 'idle'}
    <button class="btn" onclick={() => newNoteFlow.startSweepCount()}>전체 문서에 이 제목 반영</button>
  {:else if s.status === 'counting'}
    <p class="info">검색 중… {s.scanned}/{s.total}</p>
    <button class="btn" onclick={() => newNoteFlow.cancelSweep()}>취소</button>
  {:else if s.status === 'confirm'}
    <p class="info">{s.matched}개 노트가 업데이트됩니다.</p>
    <div class="actions">
      <button class="btn" onclick={() => newNoteFlow.cancelSweep()}>취소</button>
      <button class="btn primary" onclick={() => newNoteFlow.applySweep()}>적용</button>
    </div>
  {:else if s.status === 'applying'}
    <p class="info">적용 중… {s.updated}/{s.total}</p>
  {:else if s.status === 'done'}
    <p class="info">{s.updated}개 완료 ({s.ms}ms){#if s.failed}, {s.failed}개 실패{/if}</p>
  {/if}

  <div class="actions">
    <button class="btn primary" onclick={() => newNoteFlow.dismiss()}>닫기</button>
  </div>
</div>

<style>
  /* copy backdrop/.dialog/.stages/.btn rules from NoteTitleDialog.svelte;
     z-index: var(--z-modal); */
</style>
```

- [ ] **Step 2: Wire into layout.** In `app/src/routes/+layout.svelte`, after the `{:else if newNoteFlow.phase === 'creating'}` block, add:

```svelte
{:else if newNoteFlow.phase === 'result'}
  <NewNoteResultPanel />
{/if}
```
and `import NewNoteResultPanel from '$lib/components/NewNoteResultPanel.svelte';` near the existing `NoteTitleDialog` import.

- [ ] **Step 3: Verify** `npm run check`; `npm run dev` manual smoke (panel stays, button → count → confirm → apply → done → close).

- [ ] **Step 4: Commit.**

```bash
git add app/src/lib/components/NewNoteResultPanel.svelte app/src/routes/+layout.svelte
git commit -m "feat(new-note): result panel UI + layout wiring"
```

---

### Task 5: Guide card (설정 → 가이드)

**Goal:** Document the result panel + 전체 문서 반영 in 설정 → 가이드 `notes` sub-tab (CLAUDE.md requirement).

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (find the `guideSubTab === 'notes'` block; append a `<details class="guide-card">`)

**Acceptance Criteria:**
- [ ] A new `<details class="guide-card">` under the `notes` sub-tab with `<summary>`, one `<p class="info-text">`, and a `<ul class="guide-list">` covering: panel stays open / 소요시간 확인 / 전체 반영 = 매칭 노트에 링크 추가 → 백링크 / 확인 후 적용 / 동기화 영향.
- [ ] `npm run check` clean.

**Verify:** `cd app && npm run check`; manual: 설정 → 가이드 → 노트 탭에 카드 노출.

**Steps:**

- [ ] **Step 1: Add the card** (mirror an existing card's structure in that file):

```svelte
<details class="guide-card">
  <summary>새 노트 결과 패널 · 전체 문서에 제목 반영</summary>
  <p class="info-text">새 노트를 만들면 진행 팝업이 자동으로 닫히지 않고 각 단계 소요 시간을 보여줍니다. 원하면 이 제목을 기존 모든 노트에 링크로 반영할 수 있습니다.</p>
  <ul class="guide-list">
    <li>“전체 문서에 이 제목 반영”을 누르면 먼저 <b>몇 개 노트가 업데이트되는지</b> 집계 후 확인을 받습니다.</li>
    <li>적용하면 제목과 일치하는 본문이 내부 링크가 되어 새 노트의 백링크로 잡힙니다.</li>
    <li>업데이트된 노트는 다음 Dropbox “지금 동기화” 때 함께 올라갑니다.</li>
    <li>닫기 전까지 결과·소요 시간이 유지됩니다.</li>
  </ul>
</details>
```

- [ ] **Step 2: Verify** `npm run check`.

- [ ] **Step 3: Commit.**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(guide): new-note result panel + 전체 문서 반영 가이드 카드"
```

---

### Task 6: `titleProvider` delta + `shouldRescanForDelta` predicate

**Goal:** Broadcast `{added, removed}` from `doSharedRefresh`, and a pure predicate deciding whether an editor must rescan.

**Files:**
- Create: `app/src/lib/editor/autoLink/shouldRescanForDelta.ts`
- Modify: `app/src/lib/editor/autoLink/titleProvider.ts`
- Test: `app/tests/unit/editor/shouldRescanForDelta.test.ts`, extend `app/tests/unit/editor/titleProvider.test.ts`

**Acceptance Criteria:**
- [ ] `shouldRescanForDelta(delta, docText)`: `removed.length>0` → true; else `added` whose title occurs in `docText` → true; else false; empty delta → false.
- [ ] `doSharedRefresh` computes `{added, removed}` (by guid+title diff of old vs next) and passes it to listeners; no broadcast when unchanged.
- [ ] Existing `onChange` consumers (ignore the arg) still compile and fire.

**Verify:** `cd app && npx vitest run tests/unit/editor/shouldRescanForDelta.test.ts tests/unit/editor/titleProvider.test.ts`

**Steps:**

- [ ] **Step 1: Tests.**

```ts
// app/tests/unit/editor/shouldRescanForDelta.test.ts
import { describe, it, expect } from 'vitest';
import { shouldRescanForDelta } from '$lib/editor/autoLink/shouldRescanForDelta.js';
const E = { added: [], removed: [] };
describe('shouldRescanForDelta', () => {
  it('removed → always rescan', () => expect(shouldRescanForDelta({ ...E, removed: [{ title: 'X', guid: 'g' }] }, 'no')).toBe(true));
  it('added present → rescan', () => expect(shouldRescanForDelta({ ...E, added: [{ title: 'Foo', guid: 'g' }] }, 'see Foo')).toBe(true));
  it('added absent → skip', () => expect(shouldRescanForDelta({ ...E, added: [{ title: 'Foo', guid: 'g' }] }, 'nope')).toBe(false));
  it('empty → skip', () => expect(shouldRescanForDelta(E, 'anything')).toBe(false));
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement predicate.**

```ts
// app/src/lib/editor/autoLink/shouldRescanForDelta.ts
import type { TitleEntry } from './findTitleMatches.js';
export interface TitleDelta { added: TitleEntry[]; removed: TitleEntry[]; }
export function shouldRescanForDelta(delta: TitleDelta | undefined, docText: string): boolean {
  if (!delta) return true; // unknown delta → conservative full rescan
  if (delta.removed.length > 0) return true;
  return delta.added.some((e) => e.title && docText.includes(e.title));
}
```

- [ ] **Step 4: Implement delta in `titleProvider.ts`.** In `doSharedRefresh`, replace the `entriesEquivalent` early-out with a diff that computes `{added, removed}` and broadcasts it:

```ts
// compute delta old (sharedEntries) → next
const oldByGuid = new Map(sharedEntries.map((e) => [e.guid, e]));
const nextByGuid = new Map(next.map((e) => [e.guid, e]));
const added = next.filter((e) => { const o = oldByGuid.get(e.guid); return !o || o.title !== e.title; });
const removed = sharedEntries.filter((e) => { const n = nextByGuid.get(e.guid); return !n || n.title !== e.title; });
sharedEntries = next;
if (added.length === 0 && removed.length === 0) return;
const delta = { added, removed };
for (const l of sharedListeners) l(delta);
```
  Change `sharedListeners` type + `forward` + `onChange` signature to `(delta?: TitleDelta) => void`, forwarding `delta`:
```ts
const sharedListeners = new Set<(delta?: TitleDelta) => void>();
// in createTitleProvider:
const forward = (delta?: TitleDelta) => { if (disposed) return; for (const l of myListeners) l(delta); };
onChange(cb: (delta?: TitleDelta) => void) { myListeners.add(cb); return () => myListeners.delete(cb); }
```
  Import `TitleDelta` from `./shouldRescanForDelta.js`. (A rename/title change appears in BOTH added and removed — correct: removed forces rescan to unlink the old, added covers the new.)

- [ ] **Step 5: Extend titleProvider test** — after a create-style refresh, the broadcast delta has `added=[the new]`, `removed=[]`; a delete has `removed` non-empty; an unrelated invalidate (same set) does not broadcast.

- [ ] **Step 6: Run → pass** + `npm run check`.

- [ ] **Step 7: Commit.**

```bash
git add app/src/lib/editor/autoLink/shouldRescanForDelta.ts app/src/lib/editor/autoLink/titleProvider.ts app/tests/unit/editor/shouldRescanForDelta.test.ts app/tests/unit/editor/titleProvider.test.ts
git commit -m "feat(autolink): titleProvider {added,removed} delta + shouldRescanForDelta gate"
```

---

### Task 7: Delta-gate `TomboyEditor`'s automatic rescan

**Goal:** Skip the automatic full rescan unless the delta could affect this editor's doc.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (the `titleProvider.onChange` handler at `:1147`)

**Acceptance Criteria:**
- [ ] The `onChange` handler only calls `scheduleAutoLinkScan({ full: true })` when `shouldRescanForDelta(delta, editor.state.doc.textContent)` is true.
- [ ] `npm run check` clean; existing editor tests still pass.

**Verify:** `cd app && npm run check && npx vitest run tests/unit/editor/` ; manual: open 2+ desktop windows with notes that don't mention a new title, create a note → those editors don't rescan (no jank); a window whose doc mentions the new title gets the link.

**Steps:**

- [ ] **Step 1: Edit the handler.** Replace (`TomboyEditor.svelte:1147`):

```ts
const offChange = titleProvider.onChange(() => {
  scheduleAutoLinkScan({ full: true });
});
```
with:
```ts
const offChange = titleProvider.onChange((delta) => {
  const ed = editor;
  if (!ed || ed.isDestroyed) { scheduleAutoLinkScan({ full: true }); return; }
  if (shouldRescanForDelta(delta, ed.state.doc.textContent)) {
    scheduleAutoLinkScan({ full: true });
  }
});
```
and add the import: `import { shouldRescanForDelta } from "./autoLink/shouldRescanForDelta.js";`.

- [ ] **Step 2: Verify** `npm run check`; `npx vitest run tests/unit/editor/`.

- [ ] **Step 3: Commit.**

```bash
git add app/src/lib/editor/TomboyEditor.svelte
git commit -m "perf(autolink): delta-gate automatic per-editor rescan (kills new-note stutter)"
```

---

## Self-review notes

- **Spec coverage:** Result panel (T3/T4), corpus sweep count→confirm→apply (T2/T3/T4), confirmation gate (T4), guide card (T5), delta-gate (T6/T7), idempotency + suppress + title-line skip (T1). All spec sections map to a task.
- **Type consistency:** `addInternalLinksForTitle(docJson, title, targetGuid, suppressMarks?)` used identically in T1/T2; `TitleDelta {added,removed}` defined in T6 and consumed in T6/T7; `sweep` shape defined in T3 and rendered in T4; `countLinkSweep`/`applyLinkSweep` signatures match across T2/T3.
- **Assumptions to verify at execution (flagged inline):** exact `noteStore` reset helper for tests; exact export names `desktopSession`/`reloadWindows`/`flushAll`/`emitNoteReload`; the `guideSubTab==='notes'` block location in settings.
