# Terminal Note — tmux Per-Window History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the terminal-note command-history feature so that, inside tmux, each window keeps its own history bucket; outside tmux a single bucket is preserved.

**Architecture:** The note body's existing `history:` section becomes one of N possible sections — `history:` (non-tmux) plus zero or more `history:tmux:<window_id>:` per tmux window. The shell snippet's PS0 pass captures `tmux display -p '#{window_id}'` into a side marker file and appends the id to the OSC 133 `;C` payload (`C;<hex>;<id>`). An optional `~/.tmux.conf` `after-select-window` hook emits OSC `133;W;<id>` so the panel switches buckets the moment the user changes window — without that hook, the bucket switches when the user types the next command (lazy fallback). Multi-bucket reads/writes are routed through `historyStore` keyed by `(guid, windowKey)`.

**Tech Stack:** TypeScript, SvelteKit + Svelte 5 runes, TipTap 3 JSONContent, vitest, xterm.js OSC handler. Existing files only — no new framework or dependency.

---

## File Structure

Files modified (no new files):

| Path | Responsibility |
|------|----------------|
| `app/src/lib/editor/terminal/parseTerminalNote.ts` | Parse note body. Add `histories: Map<string, string[]>` field; keep `history` as flat alias. |
| `app/tests/unit/editor/parseTerminalNote.test.ts` | New cases for multi-section parsing. |
| `app/src/lib/editor/terminal/oscCapture.ts` | OSC 133 payload parser. Add `kind: 'W'` event and `windowId` field on C/W. |
| `app/tests/unit/editor/oscCapture.test.ts` | New cases for `W;<id>`, `C;<hex>;<id>`. |
| `app/src/lib/editor/terminal/historyStore.ts` | Multi-key debounce + read-modify-write. New helper `splitTerminalDocByKey`. |
| `app/tests/unit/editor/historyStore.test.ts` | New cases for per-key isolation, multi-section round-trip. |
| `app/src/lib/editor/terminal/TerminalView.svelte` | `currentWindowKey` state, OSC W/C dispatch, multi-bucket render. |
| `app/src/lib/editor/terminal/HistoryPanel.svelte` | Header chip showing current bucket name. |
| `app/src/routes/settings/+page.svelte` | Replace shell snippet; add tmux hook block + copy button. |
| `CLAUDE.md` | Add new invariants. |
| `.claude/skills/tomboy-terminal/SKILL.md` | Mirror invariants in skill file. |

---

## Task 1: parseTerminalNote — multi-section support

**Goal:** Parser emits a `Map<string, string[]>` of histories keyed by `''` (non-tmux) or `tmux:<window_id>` (tmux window). Existing single-section notes continue to parse identically; the flat `history: string[]` field stays as a sorted-by-recency aggregate so existing readers keep working.

**Files:**
- Modify: `app/src/lib/editor/terminal/parseTerminalNote.ts`
- Test: `app/tests/unit/editor/parseTerminalNote.test.ts`

**Acceptance Criteria:**
- [ ] `TerminalNoteSpec` has `histories: Map<string, string[]>` and unchanged `history: string[]` (flat aggregate, most-recent-first across buckets, dedup'd).
- [ ] Note with single `history:` section parses as `histories.size === 1`, key `''`.
- [ ] Note with `history:`, `history:tmux:@1:`, `history:tmux:@2:` sections parses with all three keys present.
- [ ] Section header text not matching `^history:(?:tmux:[A-Za-z0-9@$:_-]+:)?$` causes the whole note to fail terminal-note parsing (returns `null`).
- [ ] Sections may appear in any order; empty sections (header without bulletList) yield `[]` for that key.
- [ ] A free non-history paragraph after metadata (no `history:` header) → still falls back to `null` (existing behavior).
- [ ] All existing tests pass with the new field added.

**Verify:** `cd app && npm run test -- parseTerminalNote --run`

**Steps:**

- [ ] **Step 1: Add failing tests for multi-section parsing**

Append to `app/tests/unit/editor/parseTerminalNote.test.ts`:

```ts
describe('parseTerminalNote — multi-section history', () => {
  function listOf(items: string[]) {
    return {
      type: 'bulletList',
      content: items.map((t) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
      }))
    } as const;
  }
  function paragraph(text: string) {
    return { type: 'paragraph', content: [{ type: 'text', text }] } as const;
  }

  it('parses a single non-tmux history section into the map', () => {
    const doc = {
      type: 'doc',
      content: [
        paragraph('Title'),
        paragraph('ssh://localhost'),
        { type: 'paragraph' },
        paragraph('history:'),
        listOf(['ls -la', 'pwd'])
      ]
    };
    const out = parseTerminalNote(doc);
    expect(out?.histories.size).toBe(1);
    expect(out?.histories.get('')).toEqual(['ls -la', 'pwd']);
    expect(out?.history).toEqual(['ls -la', 'pwd']);
  });

  it('parses multiple history sections (non-tmux + two windows)', () => {
    const doc = {
      type: 'doc',
      content: [
        paragraph('Title'),
        paragraph('ssh://localhost'),
        { type: 'paragraph' },
        paragraph('history:'),
        listOf(['outer-cmd']),
        { type: 'paragraph' },
        paragraph('history:tmux:@1:'),
        listOf(['htop', 'tail -f log']),
        { type: 'paragraph' },
        paragraph('history:tmux:@2:'),
        listOf(['gdb a.out'])
      ]
    };
    const out = parseTerminalNote(doc);
    expect(out).not.toBeNull();
    expect(out?.histories.get('')).toEqual(['outer-cmd']);
    expect(out?.histories.get('tmux:@1')).toEqual(['htop', 'tail -f log']);
    expect(out?.histories.get('tmux:@2')).toEqual(['gdb a.out']);
  });

  it('parses sections in any order', () => {
    const doc = {
      type: 'doc',
      content: [
        paragraph('Title'),
        paragraph('ssh://localhost'),
        { type: 'paragraph' },
        paragraph('history:tmux:@2:'),
        listOf(['x']),
        { type: 'paragraph' },
        paragraph('history:'),
        listOf(['y'])
      ]
    };
    const out = parseTerminalNote(doc);
    expect(out?.histories.get('')).toEqual(['y']);
    expect(out?.histories.get('tmux:@2')).toEqual(['x']);
  });

  it('rejects an unknown header label', () => {
    const doc = {
      type: 'doc',
      content: [
        paragraph('Title'),
        paragraph('ssh://localhost'),
        { type: 'paragraph' },
        paragraph('historyX:'),
        listOf(['x'])
      ]
    };
    expect(parseTerminalNote(doc)).toBeNull();
  });

  it('accepts empty section (header without list)', () => {
    const doc = {
      type: 'doc',
      content: [
        paragraph('Title'),
        paragraph('ssh://localhost'),
        { type: 'paragraph' },
        paragraph('history:tmux:@1:')
      ]
    };
    const out = parseTerminalNote(doc);
    expect(out?.histories.get('tmux:@1')).toEqual([]);
  });

  it('history flat field is union, most-recent-first, dedup', () => {
    const doc = {
      type: 'doc',
      content: [
        paragraph('Title'),
        paragraph('ssh://localhost'),
        { type: 'paragraph' },
        paragraph('history:'),
        listOf(['a', 'shared']),
        { type: 'paragraph' },
        paragraph('history:tmux:@1:'),
        listOf(['b', 'shared'])
      ]
    };
    const out = parseTerminalNote(doc);
    expect(out?.history).toEqual(['a', 'shared', 'b']);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `cd app && npm run test -- parseTerminalNote --run`
Expected: 6 new tests fail (`histories` undefined, multi-section returns null, etc.).

- [ ] **Step 3: Replace parser body to support multi-section**

Replace `app/src/lib/editor/terminal/parseTerminalNote.ts` with:

```ts
import type { JSONContent } from '@tiptap/core';

export interface TerminalNoteSpec {
	target: string;
	host: string;
	port?: number;
	user?: string;
	bridge?: string;
	/**
	 * Histories keyed by bucket. Key `''` is the non-tmux bucket; keys of the
	 * form `tmux:<window_id>` (e.g. `tmux:@1`) are per-tmux-window buckets.
	 */
	histories: Map<string, string[]>;
	/**
	 * Flat aggregate across all buckets, most-recent-first, deduplicated.
	 * Provided for callers that don't care about per-window separation.
	 */
	history: string[];
}

const SSH_RE = /^ssh:\/\/(?:([^@\s/]+)@)?([^:\s/]+)(?::(\d{1,5}))?\/?\s*$/;
const BRIDGE_RE = /^bridge:\s*(wss?:\/\/\S+)\s*$/;
const HISTORY_HEADER_RE = /^history:(?:tmux:([A-Za-z0-9@$:_-]+):)?$/;

export function parseTerminalNote(doc: JSONContent | null | undefined): TerminalNoteSpec | null {
	if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return null;
	const blocks = doc.content;
	if (blocks.length < 2) return null;

	const bodyBlocks = blocks.slice(1);

	const meta: JSONContent[] = [];
	let i = 0;

	while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;

	while (i < bodyBlocks.length) {
		const b = bodyBlocks[i];
		const t = paragraphText(b);
		if (t === null) break;
		if (t === '') {
			i++;
			continue;
		}
		if (HISTORY_HEADER_RE.test(t.trim())) break;
		if (meta.length >= 2) return null;
		meta.push(b);
		i++;
	}

	if (meta.length < 1) return null;

	const line1 = paragraphText(meta[0]);
	if (line1 === null) return null;
	const sshMatch = SSH_RE.exec(line1);
	if (!sshMatch) return null;

	let bridge: string | undefined;
	if (meta.length === 2) {
		const line2 = paragraphText(meta[1]);
		if (line2 === null) return null;
		const bridgeMatch = BRIDGE_RE.exec(line2);
		if (!bridgeMatch) return null;
		bridge = bridgeMatch[1];
	}

	const user = sshMatch[1] || undefined;
	const host = sshMatch[2];
	const portRaw = sshMatch[3];
	const port = portRaw ? Number(portRaw) : undefined;
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;

	const histories = new Map<string, string[]>();

	while (i < bodyBlocks.length) {
		while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;
		if (i >= bodyBlocks.length) break;

		const headerText = paragraphText(bodyBlocks[i]);
		if (headerText === null) return null;
		const trimmedHeader = headerText.trim();
		const m = HISTORY_HEADER_RE.exec(trimmedHeader);
		if (!m) return null;
		const key = m[1] ? `tmux:${m[1]}` : '';
		i++;

		while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;

		let items: string[] = [];
		if (i < bodyBlocks.length && bodyBlocks[i].type === 'bulletList') {
			items = extractHistoryItems(bodyBlocks[i]);
			i++;
		} else if (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === null) {
			return null;
		}
		histories.set(key, items);
	}

	const history = flattenHistories(histories);

	return {
		target: line1.trim(),
		host,
		port,
		user,
		bridge,
		histories,
		history
	};
}

function flattenHistories(histories: Map<string, string[]>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const keys = Array.from(histories.keys()).sort((a, b) => {
		if (a === '') return -1;
		if (b === '') return 1;
		return a.localeCompare(b);
	});
	for (const k of keys) {
		for (const item of histories.get(k) ?? []) {
			if (seen.has(item)) continue;
			seen.add(item);
			out.push(item);
		}
	}
	return out;
}

function paragraphText(block: JSONContent): string | null {
	if (!block || block.type !== 'paragraph') return null;
	if (!block.content) return '';
	let out = '';
	for (const child of block.content) {
		if (child.type === 'text') {
			out += child.text ?? '';
		} else if (child.type === 'hardBreak') {
			return null;
		} else {
			return null;
		}
	}
	return out;
}

function extractHistoryItems(listBlock: JSONContent): string[] {
	const items: string[] = [];
	const children = Array.isArray(listBlock.content) ? listBlock.content : [];
	for (const li of children) {
		if (li.type !== 'listItem') continue;
		const text = listItemText(li).trim();
		if (text === '') continue;
		items.push(text);
	}
	return items;
}

function listItemText(item: JSONContent): string {
	if (!Array.isArray(item.content)) return '';
	let out = '';
	for (const child of item.content) {
		if (child.type === 'paragraph') {
			if (Array.isArray(child.content)) {
				for (const inline of child.content) {
					if (inline.type === 'text') out += inline.text ?? '';
				}
			}
		}
	}
	return out;
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd app && npm run test -- parseTerminalNote --run`
Expected: all pass (existing tests + 6 new).

- [ ] **Step 5: Run full type check**

Run: `cd app && npm run check`
Expected: no errors. (Callers reading `.history` still work; new field is additive.)

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/terminal/parseTerminalNote.ts \
        app/tests/unit/editor/parseTerminalNote.test.ts
git commit -m "feat(terminal): parse multi-section history (per-tmux-window)"
```

```json:metadata
{"files": ["app/src/lib/editor/terminal/parseTerminalNote.ts", "app/tests/unit/editor/parseTerminalNote.test.ts"], "verifyCommand": "cd app && npm run test -- parseTerminalNote --run", "acceptanceCriteria": ["histories: Map<string, string[]> field present", "single legacy section parses identically", "three-section note parses with three keys", "unknown header label returns null", "empty section yields []", "flat history is dedup union most-recent-first"]}
```

---

## Task 2: oscCapture — `W` event and `C;<hex>;<id>` payload

**Goal:** OSC 133 parser recognises `W;<id>` (window-select) and `C;<hex>;<id>` (command-with-window). Existing payloads keep working unchanged.

**Files:**
- Modify: `app/src/lib/editor/terminal/oscCapture.ts`
- Test: `app/tests/unit/editor/oscCapture.test.ts`

**Acceptance Criteria:**
- [ ] `Osc133Event` adds `kind: 'W'` to the union and a `windowId?: string` field.
- [ ] `parseOsc133Payload('W;@1')` → `{ kind: 'W', windowId: '@1' }`.
- [ ] `parseOsc133Payload('W')` and `parseOsc133Payload('W;')` → `null` (W requires a non-empty id).
- [ ] `parseOsc133Payload('C;6c73202d6c61;@1')` → `{ kind: 'C', commandText: 'ls -la', windowId: '@1' }`.
- [ ] `parseOsc133Payload('C;notHex;@1')` → `{ kind: 'C', windowId: '@1' }` (id preserved when hex fails).
- [ ] Existing C/A/B/D tests still pass.

**Verify:** `cd app && npm run test -- oscCapture --run`

**Steps:**

- [ ] **Step 1: Add failing tests**

Append to `app/tests/unit/editor/oscCapture.test.ts` inside `describe('parseOsc133Payload', ...)`:

```ts
it('parses W with window id', () => {
  expect(parseOsc133Payload('W;@1')).toEqual({ kind: 'W', windowId: '@1' });
  expect(parseOsc133Payload('W;@42')).toEqual({ kind: 'W', windowId: '@42' });
});

it('rejects W without an id', () => {
  expect(parseOsc133Payload('W')).toBeNull();
  expect(parseOsc133Payload('W;')).toBeNull();
});

it('parses C with hex command and window id', () => {
  expect(parseOsc133Payload('C;6c73202d6c61;@1')).toEqual({
    kind: 'C',
    commandText: 'ls -la',
    windowId: '@1'
  });
});

it('preserves window id when hex is malformed', () => {
  expect(parseOsc133Payload('C;notHex;@1')).toEqual({
    kind: 'C',
    windowId: '@1'
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `cd app && npm run test -- oscCapture --run`
Expected: 4 new tests fail.

- [ ] **Step 3: Update `parseOsc133Payload`**

In `app/src/lib/editor/terminal/oscCapture.ts`, replace the `Osc133Kind` and `Osc133Event` declarations and `parseOsc133Payload` body:

```ts
export type Osc133Kind = 'A' | 'B' | 'C' | 'D' | 'W';

export interface Osc133Event {
	kind: Osc133Kind;
	exitCode?: number;
	commandText?: string;
	/**
	 * tmux window id (e.g. `@1`). Set on `W` events and on `C` events whose
	 * payload was `C;<hex>;<id>`. Absent when the shell is not in tmux.
	 */
	windowId?: string;
}

export function parseOsc133Payload(payload: string): Osc133Event | null {
	if (!payload) return null;
	const parts = payload.split(';');
	const head = parts[0];
	if (head !== 'A' && head !== 'B' && head !== 'C' && head !== 'D' && head !== 'W') return null;
	if (head === 'W') {
		const id = parts[1];
		if (!id) return null;
		return { kind: 'W', windowId: id };
	}
	if (head === 'D' && parts.length > 1) {
		const code = Number(parts[1]);
		if (Number.isInteger(code)) return { kind: 'D', exitCode: code };
		return { kind: 'D' };
	}
	if (head === 'C' && parts.length > 1) {
		const decoded = decodeHex(parts[1]);
		const windowId = parts[2] || undefined;
		const ev: Osc133Event = { kind: 'C' };
		if (decoded !== null) ev.commandText = decoded;
		if (windowId) ev.windowId = windowId;
		return ev;
	}
	return { kind: head };
}
```

The `decodeHex` helper, `extractCommand`, `shouldRecordCommand`, and `Osc133State` class remain unchanged.

- [ ] **Step 4: Run tests — expect pass**

Run: `cd app && npm run test -- oscCapture --run`
Expected: all pass (existing + 4 new).

- [ ] **Step 5: Type check**

Run: `cd app && npm run check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/terminal/oscCapture.ts \
        app/tests/unit/editor/oscCapture.test.ts
git commit -m "feat(terminal): OSC 133 W event and windowId payload"
```

```json:metadata
{"files": ["app/src/lib/editor/terminal/oscCapture.ts", "app/tests/unit/editor/oscCapture.test.ts"], "verifyCommand": "cd app && npm run test -- oscCapture --run", "acceptanceCriteria": ["W;<id> parses to {kind:'W',windowId}", "bare W rejects", "C;<hex>;<id> parses with both fields", "C;notHex;<id> keeps windowId", "kind union extended"]}
```

---

## Task 3: historyStore — multi-key buckets

**Goal:** `historyStore` reads/writes per-bucket (`(guid, windowKey)`). All public mutators take an optional `windowKey: string` arg (`undefined` = `''` = non-tmux bucket). Pending debounce queues are keyed by `(guid, windowKey)` so two windows of the same note can flush independently. `splitTerminalDocByKey` exposes the multi-section split for tests.

**Files:**
- Modify: `app/src/lib/editor/terminal/historyStore.ts`
- Test: `app/tests/unit/editor/historyStore.test.ts`

**Acceptance Criteria:**
- [ ] `appendCommandToTerminalHistory(guid, cmd, windowKey?)` — `undefined` and `''` both target the non-tmux section; `'tmux:@1'` targets that window's section.
- [ ] Per-key independent dedup, cap, and FIFO. Pushing into bucket A does not change bucket B.
- [ ] Non-existent target section is created on first push (with header + bulletList).
- [ ] `removeCommandFromTerminalHistory(guid, index, windowKey?)` only removes from the targeted bucket.
- [ ] `clearTerminalHistory(guid, windowKey?)` removes the entire targeted section (header included).
- [ ] Pending Map key is composite `(guid, windowKey)` so flushing one bucket does not stall another.
- [ ] `splitTerminalDocByKey(doc) → { pre: JSONContent[]; histories: Map<string, string[]> }` exported for tests.
- [ ] `splitTerminalDoc(doc).historyItems` keeps returning the non-tmux bucket (back-compat alias).
- [ ] All existing historyStore tests pass with the new arg defaulted.

**Verify:** `cd app && npm run test -- historyStore --run`

**Steps:**

- [ ] **Step 1: Add failing tests**

Append to `app/tests/unit/editor/historyStore.test.ts`:

```ts
import {
  splitTerminalDocByKey,
  applyCommandsToDoc as _applyCommandsToDoc
} from '$lib/editor/terminal/historyStore.js';

function metaWithSections(sections: Record<string, string[]>): JSONContent {
  const blocks: JSONContent[] = [
    { type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] }
  ];
  const keys = Object.keys(sections).sort((a, b) => {
    if (a === '') return -1;
    if (b === '') return 1;
    return a.localeCompare(b);
  });
  for (const key of keys) {
    blocks.push({ type: 'paragraph' });
    const headerText = key === '' ? 'history:' : `history:${key}:`;
    blocks.push({ type: 'paragraph', content: [{ type: 'text', text: headerText }] });
    blocks.push({
      type: 'bulletList',
      content: sections[key].map((t) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
      }))
    });
  }
  return { type: 'doc', content: blocks };
}

describe('historyStore — multi-section helpers', () => {
  it('splitTerminalDocByKey returns all buckets and pre blocks', () => {
    const doc = metaWithSections({ '': ['out1'], 'tmux:@1': ['in1', 'in2'] });
    const split = splitTerminalDocByKey(doc);
    expect(split.histories.get('')).toEqual(['out1']);
    expect(split.histories.get('tmux:@1')).toEqual(['in1', 'in2']);
    // pre = title + ssh paragraph (anything before the first history header)
    expect(split.pre.length).toBe(2);
  });

  it('applyCommandsToDoc to non-tmux key leaves tmux section untouched', () => {
    const doc = metaWithSections({ '': ['old'], 'tmux:@1': ['win-a'] });
    const out = applyCommandsToDoc(doc, ['fresh']);
    const split = splitTerminalDocByKey(out);
    expect(split.histories.get('')).toEqual(['fresh', 'old']);
    expect(split.histories.get('tmux:@1')).toEqual(['win-a']);
  });

  it('applyCommandsToDoc to tmux key leaves other buckets untouched', () => {
    const doc = metaWithSections({ '': ['out1'], 'tmux:@1': ['a'] });
    const out = applyCommandsToDoc(doc, ['b'], 'tmux:@1');
    const split = splitTerminalDocByKey(out);
    expect(split.histories.get('')).toEqual(['out1']);
    expect(split.histories.get('tmux:@1')).toEqual(['b', 'a']);
  });

  it('applyCommandsToDoc creates a new tmux section when missing', () => {
    const doc = metaWithSections({ '': ['outer'] });
    const out = applyCommandsToDoc(doc, ['htop'], 'tmux:@2');
    const split = splitTerminalDocByKey(out);
    expect(split.histories.get('')).toEqual(['outer']);
    expect(split.histories.get('tmux:@2')).toEqual(['htop']);
  });

  it('clearHistoryFromDoc on a single key drops only that section', () => {
    const doc = metaWithSections({ '': ['x'], 'tmux:@1': ['y'] });
    const out = clearHistoryFromDoc(doc, 'tmux:@1');
    const split = splitTerminalDocByKey(out);
    expect(split.histories.get('')).toEqual(['x']);
    expect(split.histories.has('tmux:@1')).toBe(false);
  });

  it('clearHistoryFromDoc default key drops the non-tmux section only', () => {
    const doc = metaWithSections({ '': ['x'], 'tmux:@1': ['y'] });
    const out = clearHistoryFromDoc(doc);
    const split = splitTerminalDocByKey(out);
    expect(split.histories.has('')).toBe(false);
    expect(split.histories.get('tmux:@1')).toEqual(['y']);
  });

  it('removeItemFromDoc removes from the targeted bucket only', () => {
    const doc = metaWithSections({ '': ['a', 'b'], 'tmux:@1': ['x'] });
    const out = removeItemFromDoc(doc, 0, 'tmux:@1');
    const split = splitTerminalDocByKey(out);
    expect(split.histories.get('')).toEqual(['a', 'b']);
    expect(split.histories.has('tmux:@1')).toBe(false); // emptied → header dropped
  });

  it('caps each bucket independently at 50', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `cmd${i}`);
    let doc = metaWithSections({ '': fifty.slice() });
    doc = applyCommandsToDoc(doc, ['fresh-outer']);
    let split = splitTerminalDocByKey(doc);
    expect(split.histories.get('')?.length).toBe(50);
    expect(split.histories.get('')?.[0]).toBe('fresh-outer');

    // Inserting into tmux:@1 must not cap or affect the non-tmux bucket.
    doc = applyCommandsToDoc(doc, ['t1'], 'tmux:@1');
    split = splitTerminalDocByKey(doc);
    expect(split.histories.get('')?.length).toBe(50);
    expect(split.histories.get('tmux:@1')).toEqual(['t1']);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `cd app && npm run test -- historyStore --run`
Expected: 8 new tests fail.

- [ ] **Step 3: Replace historyStore.ts**

Replace `app/src/lib/editor/terminal/historyStore.ts` with:

```ts
import type { JSONContent } from '@tiptap/core';
import { getNote, putNote } from '$lib/storage/noteStore.js';
import { formatTomboyDate } from '$lib/core/note.js';
import { deserializeContent, serializeContent } from '$lib/core/noteContentArchiver.js';
import { emitNoteReload } from '$lib/core/noteReloadBus.js';
import { notifyNoteSaved } from '$lib/sync/firebase/orchestrator.js';
import { parseTerminalNote } from './parseTerminalNote.js';

const HISTORY_HEADER_RE = /^history:(?:tmux:([A-Za-z0-9@$:_-]+):)?$/;
const HISTORY_CAP = 50;
const DEBOUNCE_MS = 500;

interface PendingState {
	queue: string[];
	timer: ReturnType<typeof setTimeout> | null;
	chain: Promise<void>;
}

const pending = new Map<string, PendingState>();

function pendingKey(guid: string, windowKey: string): string {
	return `${guid} ${windowKey}`;
}

function getOrInitPending(guid: string, windowKey: string): PendingState {
	const k = pendingKey(guid, windowKey);
	let p = pending.get(k);
	if (!p) {
		p = { queue: [], timer: null, chain: Promise.resolve() };
		pending.set(k, p);
	}
	return p;
}

function normalizeKey(windowKey?: string): string {
	return windowKey ?? '';
}

export function appendCommandToTerminalHistory(
	guid: string,
	command: string,
	windowKey?: string
): void {
	if (command === '' || /^\s/.test(command)) return;
	const trimmed = command.trim();
	if (trimmed === '') return;
	const key = normalizeKey(windowKey);
	const p = getOrInitPending(guid, key);
	p.queue.push(trimmed);
	if (p.timer) clearTimeout(p.timer);
	p.timer = setTimeout(() => {
		void flushOne(guid, key);
	}, DEBOUNCE_MS);
}

export async function flushTerminalHistoryNow(guid?: string): Promise<void> {
	if (guid) {
		const matchPrefix = `${guid} `;
		const keys = Array.from(pending.keys()).filter((k) => k.startsWith(matchPrefix));
		await Promise.all(
			keys.map((k) => flushOne(guid, k.slice(matchPrefix.length)))
		);
		return;
	}
	const allKeys = Array.from(pending.keys());
	await Promise.all(
		allKeys.map((k) => {
			const idx = k.indexOf(' ');
			return flushOne(k.slice(0, idx), k.slice(idx + 1));
		})
	);
}

async function flushOne(guid: string, windowKey: string): Promise<void> {
	const k = pendingKey(guid, windowKey);
	const p = pending.get(k);
	if (!p) return;
	if (p.timer) {
		clearTimeout(p.timer);
		p.timer = null;
	}
	const batch = p.queue;
	p.queue = [];
	p.chain = p.chain.then(async () => {
		if (batch.length === 0) return;
		try {
			await applyBatch(guid, batch, windowKey);
		} catch (err) {
			console.warn('[terminalHistory] flush failed', err);
		}
	});
	await p.chain;
}

async function applyBatch(guid: string, commands: string[], windowKey: string): Promise<void> {
	const note = await getNote(guid);
	if (!note || note.deleted) return;
	const doc = deserializeContent(note.xmlContent);
	const spec = parseTerminalNote(doc);
	if (!spec) return;

	const next = applyCommandsToDoc(doc, commands, windowKey || undefined);
	const newXml = serializeContent(next);
	if (newXml === note.xmlContent) return;
	const now = formatTomboyDate(new Date());
	note.xmlContent = newXml;
	note.changeDate = now;
	note.metadataChangeDate = now;
	await putNote(note);
	notifyNoteSaved(guid);
	await emitNoteReload([guid]);
}

export async function removeCommandFromTerminalHistory(
	guid: string,
	index: number,
	windowKey?: string
): Promise<void> {
	const key = normalizeKey(windowKey);
	await flushOne(guid, key);
	const note = await getNote(guid);
	if (!note || note.deleted) return;
	const doc = deserializeContent(note.xmlContent);
	const spec = parseTerminalNote(doc);
	if (!spec) return;
	const items = spec.histories.get(key) ?? [];
	if (index < 0 || index >= items.length) return;
	const next = removeItemFromDoc(doc, index, key || undefined);
	const newXml = serializeContent(next);
	if (newXml === note.xmlContent) return;
	const now = formatTomboyDate(new Date());
	note.xmlContent = newXml;
	note.changeDate = now;
	note.metadataChangeDate = now;
	await putNote(note);
	notifyNoteSaved(guid);
	await emitNoteReload([guid]);
}

export async function clearTerminalHistory(guid: string, windowKey?: string): Promise<void> {
	const key = normalizeKey(windowKey);
	await flushOne(guid, key);
	const note = await getNote(guid);
	if (!note || note.deleted) return;
	const doc = deserializeContent(note.xmlContent);
	const spec = parseTerminalNote(doc);
	if (!spec) return;
	if (!spec.histories.has(key)) return;
	const next = clearHistoryFromDoc(doc, key || undefined);
	const newXml = serializeContent(next);
	if (newXml === note.xmlContent) return;
	const now = formatTomboyDate(new Date());
	note.xmlContent = newXml;
	note.changeDate = now;
	note.metadataChangeDate = now;
	await putNote(note);
	notifyNoteSaved(guid);
	await emitNoteReload([guid]);
}

// ── Pure doc helpers (exported for tests) ──────────────────────────────

interface SplitDocByKey {
	pre: JSONContent[];
	histories: Map<string, string[]>;
}

export function splitTerminalDocByKey(doc: JSONContent): SplitDocByKey {
	const out: SplitDocByKey = { pre: [], histories: new Map() };
	if (!Array.isArray(doc.content)) return out;
	const blocks = doc.content;
	let i = 0;

	// pre: everything up to (but not including) the first history header.
	while (i < blocks.length) {
		const b = blocks[i];
		if (b.type === 'paragraph' && HISTORY_HEADER_RE.test(paragraphTextSimple(b).trim())) break;
		out.pre.push(b);
		i++;
	}

	while (i < blocks.length) {
		const b = blocks[i];
		if (b.type !== 'paragraph') {
			i++;
			continue;
		}
		const t = paragraphTextSimple(b).trim();
		const m = HISTORY_HEADER_RE.exec(t);
		if (!m) {
			i++;
			continue;
		}
		const key = m[1] ? `tmux:${m[1]}` : '';
		i++;
		while (i < blocks.length && blocks[i].type === 'paragraph' && paragraphTextSimple(blocks[i]).trim() === '') {
			i++;
		}
		let items: string[] = [];
		if (i < blocks.length && blocks[i].type === 'bulletList') {
			items = extractListItems(blocks[i]);
			i++;
		}
		out.histories.set(key, items);
	}
	return out;
}

interface SplitDocLegacy {
	pre: JSONContent[];
	historyItems: string[];
	hasHistorySection: boolean;
}

/** Legacy single-section view — returns the non-tmux bucket only. */
export function splitTerminalDoc(doc: JSONContent): SplitDocLegacy {
	const split = splitTerminalDocByKey(doc);
	return {
		pre: split.pre,
		historyItems: split.histories.get('') ?? [],
		hasHistorySection: split.histories.has('')
	};
}

function paragraphTextSimple(p: JSONContent): string {
	if (!Array.isArray(p.content)) return '';
	let out = '';
	for (const child of p.content) {
		if (child.type === 'text') out += child.text ?? '';
	}
	return out;
}

function extractListItems(list: JSONContent): string[] {
	const items: string[] = [];
	const children = Array.isArray(list.content) ? list.content : [];
	for (const li of children) {
		if (li.type !== 'listItem') continue;
		let text = '';
		if (Array.isArray(li.content)) {
			for (const child of li.content) {
				if (child.type === 'paragraph') text += paragraphTextSimple(child);
			}
		}
		const trimmed = text.trim();
		if (trimmed !== '') items.push(trimmed);
	}
	return items;
}

function buildSection(key: string, items: string[]): JSONContent[] {
	if (items.length === 0) return [];
	const header = key === '' ? 'history:' : `history:${key}:`;
	return [
		{ type: 'paragraph' },
		{ type: 'paragraph', content: [{ type: 'text', text: header }] },
		{
			type: 'bulletList',
			content: items.map((t) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
			}))
		}
	];
}

function buildAllSections(histories: Map<string, string[]>): JSONContent[] {
	const keys = Array.from(histories.keys()).sort((a, b) => {
		if (a === '') return -1;
		if (b === '') return 1;
		return a.localeCompare(b);
	});
	const out: JSONContent[] = [];
	for (const k of keys) {
		out.push(...buildSection(k, histories.get(k) ?? []));
	}
	return out;
}

export function applyCommandsToDoc(
	doc: JSONContent,
	commands: string[],
	windowKey?: string
): JSONContent {
	const key = normalizeKey(windowKey);
	const split = splitTerminalDocByKey(doc);
	let items = (split.histories.get(key) ?? []).slice();
	for (const cmd of commands) {
		const trimmed = cmd.trim();
		if (trimmed === '') continue;
		items = items.filter((x) => x !== trimmed);
		items.unshift(trimmed);
		if (items.length > HISTORY_CAP) items = items.slice(0, HISTORY_CAP);
	}
	const next = new Map(split.histories);
	if (items.length === 0) next.delete(key);
	else next.set(key, items);
	return { type: 'doc', content: [...split.pre, ...buildAllSections(next)] };
}

export function removeItemFromDoc(
	doc: JSONContent,
	index: number,
	windowKey?: string
): JSONContent {
	const key = normalizeKey(windowKey);
	const split = splitTerminalDocByKey(doc);
	const items = (split.histories.get(key) ?? []).slice();
	if (index < 0 || index >= items.length) return doc;
	items.splice(index, 1);
	const next = new Map(split.histories);
	if (items.length === 0) next.delete(key);
	else next.set(key, items);
	return { type: 'doc', content: [...split.pre, ...buildAllSections(next)] };
}

export function clearHistoryFromDoc(doc: JSONContent, windowKey?: string): JSONContent {
	const key = normalizeKey(windowKey);
	const split = splitTerminalDocByKey(doc);
	const next = new Map(split.histories);
	next.delete(key);
	return { type: 'doc', content: [...split.pre, ...buildAllSections(next)] };
}

export function _resetForTest(): void {
	for (const p of pending.values()) {
		if (p.timer) clearTimeout(p.timer);
	}
	pending.clear();
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd app && npm run test -- historyStore --run`
Expected: all pass (existing + 8 new).

- [ ] **Step 5: Type check (catches downstream breakage)**

Run: `cd app && npm run check`
Expected: no errors. (`TerminalView.svelte` still calls `appendCommandToTerminalHistory(guid, cmd)` — the new arg is optional.)

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/terminal/historyStore.ts \
        app/tests/unit/editor/historyStore.test.ts
git commit -m "feat(terminal): historyStore multi-key (tmux per-window) buckets"
```

```json:metadata
{"files": ["app/src/lib/editor/terminal/historyStore.ts", "app/tests/unit/editor/historyStore.test.ts"], "verifyCommand": "cd app && npm run test -- historyStore --run", "acceptanceCriteria": ["appendCommandToTerminalHistory accepts windowKey", "per-key independent dedup/cap/FIFO", "splitTerminalDocByKey exported", "splitTerminalDoc legacy alias works", "clearTerminalHistory only drops targeted section", "applyCommandsToDoc creates missing section"]}
```

---

## Task 4: TerminalView + HistoryPanel — currentWindowKey + multi-bucket render

**Goal:** TerminalView tracks `currentWindowKey: string | null` (null = non-tmux). The OSC handler updates it from `W` events and from `C` events whose payload carried a `windowId`. The history panel renders only the current bucket. The panel header shows a small chip naming the bucket (`tmux:@1` or "기본").

**Files:**
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte`
- Modify: `app/src/lib/editor/terminal/HistoryPanel.svelte`

**Acceptance Criteria:**
- [ ] `TerminalView` has `let currentWindowKey: string | null = $state(null)` and `let histories: Map<string, string[]> = $state(new Map())`.
- [ ] `reloadHistory()` populates `histories` from `parsed.histories` (NOT the flat `parsed.history`).
- [ ] OSC `C` handler: if `evt.windowId`, sets `currentWindowKey = 'tmux:' + evt.windowId` and dispatches `appendCommandToTerminalHistory(guid, cmd, currentWindowKey)`. If absent, leaves `currentWindowKey` untouched and dispatches without windowKey.
- [ ] OSC `W` handler: sets `currentWindowKey = 'tmux:' + evt.windowId`. Does not append a command.
- [ ] Panel rendering uses `histories.get(currentWindowKey ?? '') ?? []` for the items list.
- [ ] Panel delete/clear callbacks pass the active key down.
- [ ] `HistoryPanel` accepts a new prop `bucketLabel: string` and renders it as a chip next to the title (e.g. "히스토리 · tmux @1").
- [ ] Bucket label: `'기본'` when `currentWindowKey === null`, `'tmux ' + windowId` otherwise (where `windowId` is the suffix after `tmux:`).
- [ ] `npm run check` passes.

**Verify:** `cd app && npm run check`

**Steps:**

- [ ] **Step 1: Update HistoryPanel with bucket-label chip**

Modify `app/src/lib/editor/terminal/HistoryPanel.svelte`:

Update the Props type (around line 4):

```ts
type Props = {
    count: number;
    items: string[];
    bucketLabel: string;
    onsend: (text: string) => void;
    onsendNow: (text: string) => void;
    ondelete: (index: number) => void;
    onclear: () => void;
    onclose: () => void;
    onedit: () => void;
};
let { count, items, bucketLabel, onsend, onsendNow, ondelete, onclear, onclose, onedit }: Props = $props();
```

Update the title block (around line 90-91) inside `.panel-header`:

```svelte
<span class="title">
    히스토리 <span class="bucket">{bucketLabel}</span> <span class="count">{count}</span>
</span>
```

Add CSS for `.bucket` (place near `.count` in the `<style>` block):

```css
.bucket {
    display: inline-block;
    padding: 0 6px;
    border-radius: 8px;
    background: #345470;
    color: #cfe1ff;
    font-size: 0.7rem;
    margin-left: 4px;
}
```

- [ ] **Step 2: Update TerminalView state + reload**

In `app/src/lib/editor/terminal/TerminalView.svelte`:

Replace `let history: string[] = $state([]);` (around line 44) with:

```ts
let histories: Map<string, string[]> = $state(new Map());
let currentWindowKey: string | null = $state(null);
```

Add a derived helper after the state block:

```ts
const currentItems = $derived(histories.get(currentWindowKey ?? '') ?? []);
const bucketLabel = $derived(
    currentWindowKey === null ? '기본' : currentWindowKey.replace(/^tmux:/, 'tmux ')
);
```

Replace `reloadHistory()` (around line 62-70):

```ts
async function reloadHistory(): Promise<void> {
    if (unmounted) return;
    const note = await getNote(guid);
    if (unmounted) return;
    if (!note) return;
    const doc = deserializeContent(note.xmlContent);
    const parsed = parseTerminalNote(doc);
    histories = parsed?.histories ?? new Map();
}
```

- [ ] **Step 3: Update OSC handler**

Replace the `kind === 'C'` branch (around lines 162-181) and add a new `'W'` branch:

```ts
} else if (evt.kind === 'C') {
    const buf = term!.buffer.active;
    const scraped = osc.consumeCommandOnExecute(
        buf.cursorY + buf.baseY,
        buf.cursorX,
        (row) => {
            const line = buf.getLine(row);
            return line ? line.translateToString(true) : '';
        }
    );
    const cmd = evt.commandText !== undefined ? evt.commandText : scraped;
    if (evt.windowId) {
        currentWindowKey = 'tmux:' + evt.windowId;
    }
    if (cmd && shouldRecordCommand(cmd, blocklist)) {
        appendCommandToTerminalHistory(guid, cmd, currentWindowKey ?? undefined);
    }
} else if (evt.kind === 'W') {
    if (evt.windowId) currentWindowKey = 'tmux:' + evt.windowId;
}
```

- [ ] **Step 4: Update panel handler callbacks to pass active key**

Replace the panel callbacks (around lines 86-93):

```ts
async function onPanelDelete(index: number): Promise<void> {
    await removeCommandFromTerminalHistory(guid, index, currentWindowKey ?? undefined);
    await reloadHistory();
}
async function onPanelClear(): Promise<void> {
    await clearTerminalHistory(guid, currentWindowKey ?? undefined);
    await reloadHistory();
}
```

- [ ] **Step 5: Update panel rendering**

Find the `<HistoryPanel ... />` invocation (around lines 332-334) and replace its `count`/`items` bindings with the derived values:

```svelte
<HistoryPanel
    count={currentItems.length}
    items={currentItems}
    bucketLabel={bucketLabel}
    onsend={onPanelSend}
    onsendNow={onPanelSendNow}
    ondelete={onPanelDelete}
    onclear={onPanelClear}
    onclose={onPanelClose}
    onedit={onPanelEdit}
/>
```

Also update the toggle-button label (around line 304) which currently shows `히스토리 ({history.length})`:

```svelte
히스토리 ({currentItems.length})
```

- [ ] **Step 6: Type check**

Run: `cd app && npm run check`
Expected: no errors.

- [ ] **Step 7: Run all editor tests as regression**

Run: `cd app && npm run test -- editor --run`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/editor/terminal/TerminalView.svelte \
        app/src/lib/editor/terminal/HistoryPanel.svelte
git commit -m "feat(terminal): per-tmux-window history bucket in panel"
```

```json:metadata
{"files": ["app/src/lib/editor/terminal/TerminalView.svelte", "app/src/lib/editor/terminal/HistoryPanel.svelte"], "verifyCommand": "cd app && npm run check && cd app && npm run test -- editor --run", "acceptanceCriteria": ["currentWindowKey state + W/C handler updates", "histories Map populated from parsed.histories", "panel renders only current bucket", "HistoryPanel bucketLabel chip prop", "delete/clear scoped to active key"]}
```

---

## Task 5: Settings page — new shell snippet and tmux hook block

**Goal:** Replace the existing shell snippet on the 터미널 settings tab with the version that captures `#{window_id}` via PS0 and emits `C;<hex>;<id>`. Below the shell snippet, add a second copy-able block for the optional `~/.tmux.conf` `after-select-window` hook with brief explanation.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte`

**Acceptance Criteria:**
- [ ] `shellSnippet` constant (around line 124) replaced with the new version.
- [ ] A `tmuxHookSnippet` constant added with the `set-hook` line.
- [ ] A second `<pre><code>` block + 복사 button rendered below the existing one.
- [ ] Copy buttons set independent state (`snippetCopied`, `tmuxSnippetCopied`).
- [ ] An explanatory paragraph above the tmux block in Korean.
- [ ] `npm run check` passes.

**Verify:** `cd app && npm run check`

**Steps:**

- [ ] **Step 1: Replace shell snippet constant**

In `app/src/routes/settings/+page.svelte`, replace lines 124-149 (the `shellSnippet` declaration) with:

```ts
    const shellSnippet = `# Append to ~/.bashrc (bash 4.4+; zsh users need a different snippet)
__th_state_file="\${XDG_RUNTIME_DIR:-/tmp}/.th_state_$$"

__th_osc() {
  if [ -n "$TMUX" ]; then
    printf '\\ePtmux;\\e\\e]133;%s\\a\\e\\\\' "$1"
  else
    printf '\\e]133;%s\\a' "$1"
  fi
}

__th_emit_C() {
  # PS0 (fires after Enter, before exec) creates the state file. The very
  # next DEBUG is the user's command — capture and clear. PROMPT_COMMAND
  # internals fire DEBUG without the file present, so they're skipped.
  [ -e "$__th_state_file" ] || return
  rm -f "$__th_state_file"
  local hex win payload
  hex=$(printf '%s' "$1" | od -An -tx1 | tr -d ' \\n')
  if [ -e "\${__th_state_file}.win" ]; then
    win=$(cat "\${__th_state_file}.win" 2>/dev/null)
    rm -f "\${__th_state_file}.win"
  fi
  if [ -n "$win" ]; then
    payload="C;$hex;$win"
  else
    payload="C;$hex"
  fi
  __th_osc "$payload"
}

PS0='$(: > "$__th_state_file" 2>/dev/null
       [ -n "$TMUX" ] && tmux display -p "#{window_id}" \\
         > "\${__th_state_file}.win" 2>/dev/null)'
PS1='\\[$(__th_osc A)\\]'"$PS1"'\\[$(__th_osc B)\\]'
PROMPT_COMMAND='rm -f "$__th_state_file" "\${__th_state_file}.win" 2>/dev/null
                __th_osc "D;$?"'"\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}"
trap '__th_emit_C "$BASH_COMMAND"' DEBUG`;

    const tmuxHookSnippet = `# Append to ~/.tmux.conf (optional — for instant panel sync on window switch)
set-hook -g after-select-window 'run-shell "printf \\"\\\\ePtmux;\\\\e\\\\e]133;W;#{window_id}\\\\a\\\\e\\\\\\\\\\" > #{client_tty}"'`;
```

- [ ] **Step 2: Add a separate `copied` state and copy handler**

Find `let snippetCopied = $state(false);` (around line 122) and add below it:

```ts
    let tmuxSnippetCopied = $state(false);
```

Find `async function copySnippet()` (search around line 230-240) and add a sibling function below it:

```ts
    async function copyTmuxHookSnippet(): Promise<void> {
        try {
            await navigator.clipboard.writeText(tmuxHookSnippet);
            tmuxSnippetCopied = true;
            setTimeout(() => {
                tmuxSnippetCopied = false;
            }, 1500);
        } catch (err) {
            console.warn('clipboard write failed', err);
        }
    }
```

- [ ] **Step 3: Render the new block in the terminal tab**

Find the existing `<pre class="snippet">…</pre>` block (around line 1022) and the immediately-following 복사 button. Right after the paragraph explaining tmux $TMUX detection (around lines 1025-1027 — the one currently saying "tmux 사용 시: 스니펫이 `$TMUX` 환경변수를 자동 감지하여 DCS 패스스루로 래핑하므로 `tmux.conf` 수정은 필요 없습니다."), REPLACE that paragraph with:

```svelte
                <p class="hint">
                    tmux 사용 시: 위 스니펫이 <code>$TMUX</code> 환경변수를 자동 감지해
                    DCS 패스스루로 래핑합니다. 추가로, 윈도우 전환 즉시 패널을
                    동기화하려면 다음을 <code>~/.tmux.conf</code>에 추가하세요. (선택 사항 —
                    추가하지 않아도 다음 명령을 입력하는 시점에 자동 동기화됩니다.)
                </p>
                <pre class="snippet"><code>{tmuxHookSnippet}</code></pre>
                <button class="btn btn-secondary" onclick={copyTmuxHookSnippet}>
                    {tmuxSnippetCopied ? '복사됨' : '복사'}
                </button>
```

- [ ] **Step 4: Type check**

Run: `cd app && npm run check`
Expected: no errors.

- [ ] **Step 5: Manual smoke (visual)**

Start dev server, navigate to `/settings → 터미널`. Verify:
- Updated shell snippet appears, with the PS0 multi-line block.
- Below it, a tmux hook code block + 복사 button.
- Both copy buttons work independently (test by clicking each, paste into a separate text editor, confirm the right content arrived).

Skip if the dev server isn't reachable; type-check is the gate.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "feat(settings): tmux per-window history shell snippet + hook block"
```

```json:metadata
{"files": ["app/src/routes/settings/+page.svelte"], "verifyCommand": "cd app && npm run check", "acceptanceCriteria": ["shell snippet replaced with PS0+#{window_id} version", "tmux hook code block added", "independent copy buttons", "explanation paragraph in Korean"]}
```

---

## Task 6: Documentation — CLAUDE.md and tomboy-terminal skill

**Goal:** CLAUDE.md and the `tomboy-terminal` skill file reflect the multi-section format and 5 new invariants from spec §7.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.claude/skills/tomboy-terminal/SKILL.md`

**Acceptance Criteria:**
- [ ] CLAUDE.md "터미널 노트" section's Invariants list adds the 5 new bullets.
- [ ] CLAUDE.md body description explicitly mentions per-tmux-window buckets and the optional `after-select-window` hook.
- [ ] tomboy-terminal SKILL.md mirrors the new invariants and format extension.
- [ ] `grep -F 'history:tmux:' CLAUDE.md` returns at least one match.
- [ ] `grep -F 'after-select-window' CLAUDE.md` returns at least one match.

**Verify:** `grep -F 'history:tmux:' CLAUDE.md && grep -F 'after-select-window' CLAUDE.md`

**Steps:**

- [ ] **Step 1: Update CLAUDE.md "터미널 노트" section**

In `CLAUDE.md`, find the "터미널 노트 (SSH terminal in a note)" section and update the invariants list (currently the bulleted list under "Invariants:") by adding these 5 bullets at the end:

```markdown
- **`history:` (non-tmux) and `history:tmux:<window_id>:` are independent buckets.** Dedup, 50-cap, and debounce all apply per-bucket. Never introduce cross-bucket dedup.
- **Window key uses `@<window_id>` only** — session_id is intentionally not part of the key. Keys stay stable for the lifetime of a tmux window, which matches the user's working unit.
- **OSC 133 `;W;<id>` is an optional fast-path signal.** The store must work correctly with only `;C;<hex>;<id>` (lazy fallback) — the `after-select-window` hook is an opt-in for instant panel switching.
- **The `after-select-window` hook is the user's responsibility.** Without it, the panel switches buckets when the next command is captured. The base shell snippet alone is sufficient for correctness.
- **Empty sections are dropped on serialize.** Both `clearTerminalHistory(guid, key)` and item-removal-to-empty leave the section header out of the doc. Do not "preserve" an empty header.
```

Also update the body description right below "터미널 노트 (SSH terminal in a note)". Find the paragraph that starts "is opened as an `xterm.js` terminal..." and replace the explanation around `history:` with one that mentions the multi-bucket form. Specifically replace the body-format example block with:

```
ssh://[user@]host[:port]
bridge: wss://my-pc.example.com/ws    # optional
                                       # optional blank
history:                               # optional, non-tmux bucket
- ls -la
- sudo systemctl restart caddy

history:tmux:@1:                       # optional, per-tmux-window bucket
- htop
- tail -f /var/log/caddy.log
```

And update the surrounding sentence to: "A 3rd free paragraph (or any non-history block), any list/markup outside the history section(s), or a malformed section header falls back to a regular note."

- [ ] **Step 2: Update tomboy-terminal SKILL.md**

Find `.claude/skills/tomboy-terminal/SKILL.md` (use `find . -path ./node_modules -prune -o -name SKILL.md -print | xargs grep -l 'tomboy-terminal' 2>/dev/null` if the path differs). Mirror the same 5 invariants in the skill file's invariants section, and update its format-description block to show the multi-section form.

If the skill file path lives elsewhere (e.g. `~/.claude/skills/...`), follow that path instead — but commit only files within the repo. (Skill files outside the repo are out of scope for this task.)

- [ ] **Step 3: Verify with grep**

Run:
```bash
grep -F 'history:tmux:' CLAUDE.md
grep -F 'after-select-window' CLAUDE.md
grep -F 'OSC 133' CLAUDE.md
```
Expected: at least one match each.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
# Add SKILL.md only if it lives inside the repo:
git add -- .claude/skills/tomboy-terminal/SKILL.md 2>/dev/null || true
git commit -m "docs: per-tmux-window history invariants in CLAUDE.md"
```

```json:metadata
{"files": ["CLAUDE.md", ".claude/skills/tomboy-terminal/SKILL.md"], "verifyCommand": "grep -F 'history:tmux:' CLAUDE.md && grep -F 'after-select-window' CLAUDE.md", "acceptanceCriteria": ["5 new invariants added", "body description updated for multi-bucket", "skill file mirrors changes when in repo"]}
```

---

## Self-Review Notes

After writing the plan I checked:

1. **Spec coverage** — every spec section maps to a task:
   - §1 노트 포맷 → Task 1
   - §2 셸 스니펫 → Task 5 (settings page) — note the snippet ships in settings/UI, not in code
   - §3 tmux 훅 → Task 5
   - §4 xterm 핸들러 → Task 2
   - §5 historyStore → Task 3
   - §6 TerminalView/HistoryPanel → Task 4
   - §7 불변식 → Task 6
   - §8 테스트 전략 → distributed across Tasks 1-3 (each task includes its own tests)
   - §9 out of scope — no task needed

2. **Type consistency** — `windowKey: string` (always full key like `'tmux:@1'`, `''` for non-tmux), `windowId: string` (just `@1`). `currentWindowKey: string | null` (null = non-tmux). Public store API uses `windowKey?: string` consistently across append/remove/clear. `histories: Map<string, string[]>` keys are the same `windowKey` values throughout.

3. **No placeholders** — every step has concrete code or exact commands. Skill-file path note in Task 6 is intentional flex (the file may live outside the repo); the verify step uses `grep` against in-repo files which is concrete.
