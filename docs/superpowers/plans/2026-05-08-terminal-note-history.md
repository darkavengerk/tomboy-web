# Terminal Note Command History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a command-history side panel to terminal notes. Capture commands via OSC 133 shell integration, persist them in the note body (max 50, FIFO + move-to-top), and let the user click to re-input or Shift+click to execute.

**Architecture:** Extend `parseTerminalNote` to allow an optional `history:` header + bulletList in the body. A new `historyStore` module performs read-modify-write IDB updates with debounce + per-guid serialization. A new xterm OSC 133 handler in `TerminalView` captures `(promptRow, promptCol)` on `;B` and extracts the command line on `;C` from `term.buffer.active`. `HistoryPanel.svelte` renders the items; clicks call `TerminalWsClient.sendCommand`. Settings get a new "터미널" tab consolidating bridge + history + shell-integration UX.

**Tech Stack:** TipTap 3 (JSONContent), xterm.js (`registerOscHandler`, `term.buffer.active`), Svelte 5 runes, IndexedDB via `idb`, vitest + @testing-library/svelte.

**Spec:** `docs/superpowers/specs/2026-05-08-terminal-note-history-design.md`

---

## File Structure

**New:**
- `app/src/lib/editor/terminal/historyStore.ts` — read-modify-write history mutation + per-guid serialization + debounce
- `app/src/lib/editor/terminal/oscCapture.ts` — pure helpers for OSC 133 extraction (testable without xterm)
- `app/src/lib/editor/terminal/HistoryPanel.svelte` — desktop side panel + mobile bottom sheet
- `app/tests/unit/editor/historyStore.test.ts`
- `app/tests/unit/editor/oscCapture.test.ts`

**Modified:**
- `app/src/lib/storage/appSettings.ts` — typed accessors for 4 new keys
- `app/src/lib/editor/terminal/parseTerminalNote.ts` — accept `history:` section
- `app/src/lib/editor/terminal/wsClient.ts` — `sendCommand(text, autoExecute)`
- `app/src/lib/editor/terminal/TerminalView.svelte` — OSC handler wiring + panel toggle + integration
- `app/src/routes/settings/+page.svelte` — new `terminal` tab; move bridge UI; add history settings + shell-integration snippet
- `app/tests/unit/editor/parseTerminalNote.test.ts` — new history cases
- `CLAUDE.md` — extend "터미널 노트" section
- `.claude/skills/tomboy-terminal/SKILL.md` (or actual skill location) — same updates

---

## Task 0: appSettings — 4 new typed keys

**Goal:** Add typed getter/setter helpers for the four new settings consumed by every other task. Pure data layer, no UI.

**Files:**
- Modify: `app/src/lib/storage/appSettings.ts` (append new accessors)
- Test: `app/tests/unit/appSettings.test.ts` (create only if no existing test file; the underlying `getSetting`/`setSetting` already exist — we only need to verify the new accessors return defaults correctly)

**Acceptance Criteria:**
- [ ] `getTerminalHistoryPanelOpenDesktop()` returns `true` when no value stored
- [ ] `getTerminalHistoryPanelOpenMobile()` returns `false` when no value stored
- [ ] `getTerminalHistoryBlocklist()` returns the canonical default array when no value stored
- [ ] `getTerminalShellIntegrationBannerDismissed()` returns `false` when no value stored
- [ ] Each setter persists; subsequent get returns the set value
- [ ] `getTerminalHistoryBlocklist` tolerates a stored non-array value (returns defaults)

**Verify:** `cd app && npm run test -- appSettings` → all new tests pass

**Steps:**

- [ ] **Step 1: Append accessors to `appSettings.ts`**

Add at the end of `app/src/lib/storage/appSettings.ts`:

```ts
// ── Terminal history settings ────────────────────────────────────────

const TERM_HIST_OPEN_DESKTOP = 'terminalHistoryPanelOpenDesktop';
const TERM_HIST_OPEN_MOBILE = 'terminalHistoryPanelOpenMobile';
const TERM_HIST_BLOCKLIST = 'terminalHistoryBlocklist';
const TERM_HIST_BANNER_DISMISSED = 'terminalShellIntegrationBannerDismissed';

export const TERMINAL_HISTORY_BLOCKLIST_DEFAULT: string[] = [
	'ls', 'cd', 'pwd', 'clear', 'cls', 'exit', 'logout', 'whoami', 'date', 'history'
];

export async function getTerminalHistoryPanelOpenDesktop(): Promise<boolean> {
	const v = await getSetting<boolean>(TERM_HIST_OPEN_DESKTOP);
	return typeof v === 'boolean' ? v : true;
}

export async function setTerminalHistoryPanelOpenDesktop(value: boolean): Promise<void> {
	await setSetting(TERM_HIST_OPEN_DESKTOP, value);
}

export async function getTerminalHistoryPanelOpenMobile(): Promise<boolean> {
	const v = await getSetting<boolean>(TERM_HIST_OPEN_MOBILE);
	return typeof v === 'boolean' ? v : false;
}

export async function setTerminalHistoryPanelOpenMobile(value: boolean): Promise<void> {
	await setSetting(TERM_HIST_OPEN_MOBILE, value);
}

export async function getTerminalHistoryBlocklist(): Promise<string[]> {
	const v = await getSetting<unknown>(TERM_HIST_BLOCKLIST);
	if (!Array.isArray(v)) return [...TERMINAL_HISTORY_BLOCKLIST_DEFAULT];
	const out: string[] = [];
	for (const item of v) {
		if (typeof item === 'string' && item.trim() !== '') out.push(item.trim());
	}
	return out.length > 0 ? out : [...TERMINAL_HISTORY_BLOCKLIST_DEFAULT];
}

export async function setTerminalHistoryBlocklist(value: string[]): Promise<void> {
	await setSetting(TERM_HIST_BLOCKLIST, value);
}

export async function getTerminalShellIntegrationBannerDismissed(): Promise<boolean> {
	const v = await getSetting<boolean>(TERM_HIST_BANNER_DISMISSED);
	return typeof v === 'boolean' ? v : false;
}

export async function setTerminalShellIntegrationBannerDismissed(value: boolean): Promise<void> {
	await setSetting(TERM_HIST_BANNER_DISMISSED, value);
}
```

- [ ] **Step 2: Write tests**

Create `app/tests/unit/appSettings-terminalHistory.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
	getTerminalHistoryPanelOpenDesktop,
	setTerminalHistoryPanelOpenDesktop,
	getTerminalHistoryPanelOpenMobile,
	setTerminalHistoryPanelOpenMobile,
	getTerminalHistoryBlocklist,
	setTerminalHistoryBlocklist,
	getTerminalShellIntegrationBannerDismissed,
	setTerminalShellIntegrationBannerDismissed,
	TERMINAL_HISTORY_BLOCKLIST_DEFAULT
} from '$lib/storage/appSettings.js';
import { setSetting } from '$lib/storage/appSettings.js';

describe('terminal history settings — defaults', () => {
	it('panel open desktop defaults true', async () => {
		expect(await getTerminalHistoryPanelOpenDesktop()).toBe(true);
	});

	it('panel open mobile defaults false', async () => {
		expect(await getTerminalHistoryPanelOpenMobile()).toBe(false);
	});

	it('blocklist defaults to canonical list', async () => {
		expect(await getTerminalHistoryBlocklist()).toEqual(TERMINAL_HISTORY_BLOCKLIST_DEFAULT);
	});

	it('banner dismissed defaults false', async () => {
		expect(await getTerminalShellIntegrationBannerDismissed()).toBe(false);
	});
});

describe('terminal history settings — round-trip', () => {
	it('panel open desktop persists', async () => {
		await setTerminalHistoryPanelOpenDesktop(false);
		expect(await getTerminalHistoryPanelOpenDesktop()).toBe(false);
	});

	it('blocklist trims and filters empties', async () => {
		await setTerminalHistoryBlocklist(['  ls  ', '', 'cat']);
		expect(await getTerminalHistoryBlocklist()).toEqual(['ls', 'cat']);
	});

	it('blocklist falls back to defaults when stored value is corrupted', async () => {
		await setSetting('terminalHistoryBlocklist', 'not-an-array');
		expect(await getTerminalHistoryBlocklist()).toEqual(TERMINAL_HISTORY_BLOCKLIST_DEFAULT);
	});
});
```

- [ ] **Step 3: Run tests**

Run: `cd app && npm run test -- appSettings-terminalHistory --run`
Expected: 7 tests pass

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/storage/appSettings.ts app/tests/unit/appSettings-terminalHistory.test.ts
git commit -m "터미널 히스토리 설정 4종 추가 (appSettings)"
```

---

## Task 1: parseTerminalNote — accept optional history section

**Goal:** Extend the parser to recognize an optional trailing `history:` paragraph + bulletList. Return `history: string[]` on the spec.

**Files:**
- Modify: `app/src/lib/editor/terminal/parseTerminalNote.ts`
- Test: `app/tests/unit/editor/parseTerminalNote.test.ts` (extend existing)

**Acceptance Criteria:**
- [ ] Existing 1–2 paragraph notes parse with `history: []`
- [ ] `(ssh-line) [+ bridge-line] [+ empty-paragraph] + "history:" paragraph + bulletList` parses; `history` contains the list-item texts in order
- [ ] `history:` paragraph without a following bulletList → `history: []` (still a terminal note)
- [ ] A non-`history:` free paragraph after the metadata still returns `null` (general fallback)
- [ ] BulletList items: only paragraph children with text are collected; nested lists / non-text inline nodes inside a list-item make that item read as its concatenated text content (marks ignored), empty items dropped
- [ ] More than 50 list items: parser returns all of them (truncation is a write-side concern, not parse-side)

**Verify:** `cd app && npm run test -- parseTerminalNote --run` → all existing + new tests pass

**Steps:**

- [ ] **Step 1: Update the type and function signature**

In `app/src/lib/editor/terminal/parseTerminalNote.ts`, modify the interface and add helpers:

```ts
import type { JSONContent } from '@tiptap/core';

export interface TerminalNoteSpec {
	target: string;
	host: string;
	port?: number;
	user?: string;
	bridge?: string;
	/** Captured command history. Empty array when none. */
	history: string[];
}

const SSH_RE = /^ssh:\/\/(?:([^@\s/]+)@)?([^:\s/]+)(?::(\d{1,5}))?\/?\s*$/;
const BRIDGE_RE = /^bridge:\s*(wss?:\/\/\S+)\s*$/;
const HISTORY_HEADER = 'history:';

export function parseTerminalNote(doc: JSONContent | null | undefined): TerminalNoteSpec | null {
	if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return null;
	const blocks = doc.content;
	if (blocks.length < 2) return null;

	const bodyBlocks = blocks.slice(1);

	// Walk the body building (a) the SSH/bridge metadata paragraphs and
	// (b) the optional history section. Any unexpected block fails the
	// whole match — same strictness as before.
	const meta: JSONContent[] = [];
	let i = 0;

	// Skip leading empty paragraphs (Tomboy round-trip artefact).
	while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;

	// Collect non-empty paragraphs until we hit either the history header
	// or a non-paragraph block. We allow up to 2 metadata paragraphs.
	while (i < bodyBlocks.length) {
		const b = bodyBlocks[i];
		const t = paragraphText(b);
		if (t === null) break; // non-paragraph — could be the bulletList of a malformed note; handled below
		if (t === '') {
			// Empty paragraph between metadata and history is the optional separator.
			// Skip it.
			i++;
			continue;
		}
		if (t.trim() === HISTORY_HEADER) break; // history section starts here
		if (meta.length >= 2) return null; // a third meaningful metadata paragraph → fail
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

	// Now `i` points at either end-of-body, the history-header paragraph,
	// or some other block. If end-of-body → no history. If history-header
	// paragraph → consume it and look for an immediately-following
	// bulletList. Anything else → not a terminal note.
	let history: string[] = [];

	// Skip trailing empty paragraphs that don't precede a history block.
	while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;

	if (i < bodyBlocks.length) {
		const headerText = paragraphText(bodyBlocks[i]);
		if (headerText === null) return null; // bulletList without header → fail
		if (headerText.trim() !== HISTORY_HEADER) return null;
		i++;

		// Optional empty paragraph between header and list (defensive — TipTap
		// shouldn't insert one but the original note may have been hand-edited).
		while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;

		if (i < bodyBlocks.length) {
			const listBlock = bodyBlocks[i];
			if (listBlock.type !== 'bulletList') return null;
			history = extractHistoryItems(listBlock);
			i++;
		}

		// Allow trailing empty paragraphs after the list.
		while (i < bodyBlocks.length && paragraphText(bodyBlocks[i]) === '') i++;
		if (i < bodyBlocks.length) return null; // anything else after history → fail
	}

	return {
		target: line1.trim(),
		host,
		port,
		user,
		bridge,
		history
	};
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
		// Nested bulletLists inside a listItem are ignored: we only take
		// the listItem's own paragraph text. This keeps history flat.
	}
	return out;
}
```

- [ ] **Step 2: Update existing tests for the new `history` field**

Existing tests (in `app/tests/unit/editor/parseTerminalNote.test.ts`) use `toEqual({...})` and `toMatchObject({...})`. The strict `toEqual` ones need `history: []` added. Edit:

```ts
// In "matches ssh://host" test:
expect(r).toEqual({
	target: 'ssh://example.com',
	host: 'example.com',
	port: undefined,
	user: undefined,
	bridge: undefined,
	history: []
});
```

The `toMatchObject` tests don't need changes (subset match).

- [ ] **Step 3: Add new history tests**

Append to `app/tests/unit/editor/parseTerminalNote.test.ts`:

```ts
function docWithHistory(
	title: string,
	ssh: string,
	bridge: string | null,
	historyItems: string[]
): JSONContent {
	const content: JSONContent[] = [
		{ type: 'paragraph', content: [{ type: 'text', text: title }] },
		{ type: 'paragraph', content: [{ type: 'text', text: ssh }] }
	];
	if (bridge !== null) {
		content.push({ type: 'paragraph', content: [{ type: 'text', text: bridge }] });
	}
	content.push({ type: 'paragraph' });
	content.push({ type: 'paragraph', content: [{ type: 'text', text: 'history:' }] });
	if (historyItems.length > 0) {
		content.push({
			type: 'bulletList',
			content: historyItems.map((t) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
			}))
		});
	}
	return { type: 'doc', content };
}

describe('parseTerminalNote — history', () => {
	it('returns empty history for a plain ssh note', () => {
		const r = parseTerminalNote(doc('Title', 'ssh://localhost'));
		expect(r?.history).toEqual([]);
	});

	it('parses a 3-item history', () => {
		const r = parseTerminalNote(
			docWithHistory('Title', 'ssh://localhost', null, ['ls -la', 'cd /etc', 'tail -f log'])
		);
		expect(r?.host).toBe('localhost');
		expect(r?.history).toEqual(['ls -la', 'cd /etc', 'tail -f log']);
	});

	it('parses history with bridge line', () => {
		const r = parseTerminalNote(
			docWithHistory('Title', 'ssh://localhost', 'bridge: wss://x/ws', ['cmd1'])
		);
		expect(r?.bridge).toBe('wss://x/ws');
		expect(r?.history).toEqual(['cmd1']);
	});

	it('header without bullet list returns empty history', () => {
		const r = parseTerminalNote({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'history:' }] }
			]
		});
		expect(r).toMatchObject({ host: 'localhost', history: [] });
	});

	it('drops empty list items', () => {
		const r = parseTerminalNote({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'history:' }] },
				{
					type: 'bulletList',
					content: [
						{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
						{ type: 'listItem', content: [{ type: 'paragraph' }] },
						{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }
					]
				}
			]
		});
		expect(r?.history).toEqual(['a', 'b']);
	});

	it('returns null when a free paragraph is after history', () => {
		const r = parseTerminalNote({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'history:' }] },
				{
					type: 'bulletList',
					content: [
						{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }
					]
				},
				{ type: 'paragraph', content: [{ type: 'text', text: 'extra junk' }] }
			]
		});
		expect(r).toBeNull();
	});

	it('returns null when bullet list appears without header', () => {
		const r = parseTerminalNote({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
				{ type: 'bulletList', content: [] }
			]
		});
		expect(r).toBeNull();
	});

	it('marks ignored — italic in list item still extracts plain text', () => {
		const r = parseTerminalNote({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'history:' }] },
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							content: [
								{
									type: 'paragraph',
									content: [
										{ type: 'text', text: 'sudo ' },
										{ type: 'text', marks: [{ type: 'italic' }], text: 'systemctl' },
										{ type: 'text', text: ' restart caddy' }
									]
								}
							]
						}
					]
				}
			]
		});
		expect(r?.history).toEqual(['sudo systemctl restart caddy']);
	});
});
```

- [ ] **Step 4: Run tests**

Run: `cd app && npm run test -- parseTerminalNote --run`
Expected: All tests pass (existing + 8 new history tests)

- [ ] **Step 5: Verify type-check**

Run: `cd app && npm run check`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/terminal/parseTerminalNote.ts app/tests/unit/editor/parseTerminalNote.test.ts
git commit -m "parseTerminalNote: history 섹션 인식"
```

---

## Task 2: TerminalWsClient.sendCommand

**Goal:** Add a thin re-input helper to the WS client. Trivial wrapper around `send()`, but explicit so callers don't sprinkle `'\r'` literals around.

**Files:**
- Modify: `app/src/lib/editor/terminal/wsClient.ts` (~3-line addition)
- Test: `app/tests/unit/editor/wsClientSendCommand.test.ts` (new)

**Acceptance Criteria:**
- [ ] `sendCommand(text, false)` calls underlying `send(text)` once
- [ ] `sendCommand(text, true)` calls `send(text + '\r')`
- [ ] Both no-op when WebSocket isn't `OPEN` (delegated to existing `send`)

**Verify:** `cd app && npm run test -- wsClientSendCommand --run` → passes

**Steps:**

- [ ] **Step 1: Add `sendCommand` to `TerminalWsClient`**

In `app/src/lib/editor/terminal/wsClient.ts`, add after `send`:

```ts
	/**
	 * Re-input helper used by the history panel. `autoExecute=false` types
	 * the text into the prompt without pressing Enter; `autoExecute=true`
	 * appends `\r` so the shell runs it immediately.
	 */
	sendCommand(text: string, autoExecute: boolean): void {
		this.send(autoExecute ? text + '\r' : text);
	}
```

- [ ] **Step 2: Write test with mock WebSocket**

Create `app/tests/unit/editor/wsClientSendCommand.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalWsClient } from '$lib/editor/terminal/wsClient.js';

class FakeWs {
	readyState = 1; // OPEN
	sent: string[] = [];
	send(s: string) { this.sent.push(s); }
	close() {}
	onopen?: () => void;
	onmessage?: () => void;
	onclose?: () => void;
	onerror?: () => void;
	static OPEN = 1;
}

describe('TerminalWsClient.sendCommand', () => {
	let fake: FakeWs;
	let client: TerminalWsClient;

	beforeEach(() => {
		fake = new FakeWs();
		// @ts-expect-error patch global
		globalThis.WebSocket = vi.fn(() => fake);
		// @ts-expect-error
		globalThis.WebSocket.OPEN = 1;
		client = new TerminalWsClient({
			bridge: 'wss://example.com',
			target: 'ssh://localhost',
			token: 't',
			cols: 80,
			rows: 24,
			onData: () => {},
			onStatus: () => {}
		});
		client.connect();
		// Trigger onopen so the connect frame is sent and clear it from sent[].
		fake.onopen?.();
		fake.sent.length = 0;
	});

	it('sends plain text without trailing CR when autoExecute=false', () => {
		client.sendCommand('ls -la', false);
		expect(fake.sent).toEqual([JSON.stringify({ type: 'data', d: 'ls -la' })]);
	});

	it('appends \\r when autoExecute=true', () => {
		client.sendCommand('ls -la', true);
		expect(fake.sent).toEqual([JSON.stringify({ type: 'data', d: 'ls -la\r' })]);
	});

	it('no-ops when ws is not open', () => {
		fake.readyState = 3; // CLOSED
		client.sendCommand('whatever', true);
		expect(fake.sent).toEqual([]);
	});
});
```

- [ ] **Step 3: Run tests**

Run: `cd app && npm run test -- wsClientSendCommand --run`
Expected: 3 tests pass

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/editor/terminal/wsClient.ts app/tests/unit/editor/wsClientSendCommand.test.ts
git commit -m "TerminalWsClient.sendCommand 추가"
```

---

## Task 3: historyStore — read-modify-write with debounce

**Goal:** Provide three async functions to mutate the history bullet list inside a terminal note: `appendCommandToTerminalHistory`, `removeCommandFromTerminalHistory`, `clearTerminalHistory`. Per-guid serialized; `appendCommandToTerminalHistory` debounces internally.

**Files:**
- Create: `app/src/lib/editor/terminal/historyStore.ts`
- Test: `app/tests/unit/editor/historyStore.test.ts`

**Acceptance Criteria:**
- [ ] `appendCommandToTerminalHistory(guid, cmd)` adds `cmd` as the first listItem
- [ ] If a listItem with identical text already exists, the existing one is removed before prepending (move-to-top)
- [ ] Cap at 50: when prepending makes the list 51, the last item is dropped. (No upfront trim if the existing list is hand-edited to >50 — only the prepend operation enforces cap.)
- [ ] If `parseTerminalNote(doc)` returns `null`, the call resolves silently without writing
- [ ] If the note has no `history:` section, one is created (header paragraph + bulletList appended to body)
- [ ] After a successful write, `notifyNoteSaved(guid)` and `emitNoteReload([guid])` are called
- [ ] Multiple `appendCommandToTerminalHistory` calls within 500ms coalesce into one IDB write per guid
- [ ] Concurrent appends across different guids do not block each other
- [ ] `removeCommandFromTerminalHistory(guid, index)` removes that index from the list and writes
- [ ] `clearTerminalHistory(guid)` removes the entire `history:` section
- [ ] Commands starting with whitespace AND the `cmd === ''` after trim are not added (caller responsibility, but the store also rejects to be defensive)
- [ ] `flushTerminalHistoryNow(guid?)` flushes the debounce queue immediately (used on `pagehide`/before-unload)

**Verify:** `cd app && npm run test -- historyStore --run` → all tests pass

**Steps:**

- [ ] **Step 1: Implement `historyStore.ts`**

Create `app/src/lib/editor/terminal/historyStore.ts`:

```ts
import type { JSONContent } from '@tiptap/core';
import { getNote } from '$lib/storage/noteStore.js';
import { putNote } from '$lib/storage/noteStore.js';
import { formatTomboyDate } from '$lib/core/note.js';
import { deserializeContent, serializeContent } from '$lib/core/noteContentArchiver.js';
import { emitNoteReload } from '$lib/core/noteReloadBus.js';
import { notifyNoteSaved } from '$lib/sync/firebase/orchestrator.js';
import { parseTerminalNote } from './parseTerminalNote.js';

const HISTORY_HEADER = 'history:';
const HISTORY_CAP = 50;
const DEBOUNCE_MS = 500;

interface PendingState {
	queue: string[];
	timer: ReturnType<typeof setTimeout> | null;
	chain: Promise<void>;
}

const pending = new Map<string, PendingState>();

function getOrInitPending(guid: string): PendingState {
	let p = pending.get(guid);
	if (!p) {
		p = { queue: [], timer: null, chain: Promise.resolve() };
		pending.set(guid, p);
	}
	return p;
}

/**
 * Append a captured command to the terminal note's history. Debounced
 * 500ms per guid; coalesces multiple appends into a single read-modify-write.
 *
 * If the note is no longer a terminal note (parseTerminalNote returns null)
 * the queued command is silently dropped on flush.
 *
 * Commands that are empty after trim, or that start with whitespace
 * (HISTCONTROL=ignorespace convention) are rejected here as a defensive
 * second check — primary filtering is in oscCapture.
 */
export function appendCommandToTerminalHistory(guid: string, command: string): void {
	if (command === '' || /^\s/.test(command)) return;
	const trimmed = command.trim();
	if (trimmed === '') return;
	const p = getOrInitPending(guid);
	p.queue.push(trimmed);
	if (p.timer) clearTimeout(p.timer);
	p.timer = setTimeout(() => {
		void flushOne(guid);
	}, DEBOUNCE_MS);
}

/**
 * Flush the debounced queue NOW. Without arguments, flushes every queued
 * guid. With a guid, flushes only that one.
 */
export async function flushTerminalHistoryNow(guid?: string): Promise<void> {
	if (guid) {
		await flushOne(guid);
		return;
	}
	const guids = Array.from(pending.keys());
	await Promise.all(guids.map((g) => flushOne(g)));
}

async function flushOne(guid: string): Promise<void> {
	const p = pending.get(guid);
	if (!p) return;
	if (p.timer) {
		clearTimeout(p.timer);
		p.timer = null;
	}
	const batch = p.queue;
	p.queue = [];
	if (batch.length === 0) return;
	// Chain so concurrent appendCommandToTerminalHistory calls land in
	// order. We swallow per-batch errors to avoid stalling the chain.
	p.chain = p.chain.then(async () => {
		try {
			await applyBatch(guid, batch);
		} catch (err) {
			console.warn('[terminalHistory] flush failed', err);
		}
	});
	await p.chain;
}

async function applyBatch(guid: string, commands: string[]): Promise<void> {
	const note = await getNote(guid);
	if (!note || note.deleted) return;
	const doc = deserializeContent(note.xmlContent);
	const spec = parseTerminalNote(doc);
	if (!spec) return; // not a terminal note (anymore) — drop

	const next = applyCommandsToDoc(doc, commands);
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

/**
 * Remove the history item at `index`. Index is into the current list
 * (most-recent-first ordering). No-op if out of range.
 */
export async function removeCommandFromTerminalHistory(
	guid: string,
	index: number
): Promise<void> {
	// Flush any pending appends first so the index the caller saw is
	// consistent with what we mutate.
	await flushOne(guid);
	const note = await getNote(guid);
	if (!note || note.deleted) return;
	const doc = deserializeContent(note.xmlContent);
	const spec = parseTerminalNote(doc);
	if (!spec) return;
	if (index < 0 || index >= spec.history.length) return;
	const next = removeItemFromDoc(doc, index);
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

export async function clearTerminalHistory(guid: string): Promise<void> {
	await flushOne(guid);
	const note = await getNote(guid);
	if (!note || note.deleted) return;
	const doc = deserializeContent(note.xmlContent);
	const spec = parseTerminalNote(doc);
	if (!spec || spec.history.length === 0) return;
	const next = clearHistoryFromDoc(doc);
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

interface SplitDoc {
	pre: JSONContent[]; // title + meta paragraphs (everything before history)
	historyItems: string[]; // current items
	hasHistorySection: boolean;
}

export function splitTerminalDoc(doc: JSONContent): SplitDoc {
	const out: SplitDoc = { pre: [], historyItems: [], hasHistorySection: false };
	if (!Array.isArray(doc.content)) return out;
	const blocks = doc.content;
	let i = 0;
	while (i < blocks.length) {
		const b = blocks[i];
		if (b.type === 'paragraph') {
			const t = paragraphTextSimple(b);
			if (t.trim() === HISTORY_HEADER) {
				out.hasHistorySection = true;
				i++;
				// Skip empty paragraphs immediately after the header.
				while (i < blocks.length && blocks[i].type === 'paragraph' && paragraphTextSimple(blocks[i]).trim() === '') {
					i++;
				}
				if (i < blocks.length && blocks[i].type === 'bulletList') {
					out.historyItems = extractListItems(blocks[i]);
					i++;
				}
				// Anything after the list is dropped — the parser would
				// have rejected it, but in writers we tolerate by ignoring.
				break;
			}
		}
		out.pre.push(b);
		i++;
	}
	return out;
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

function buildHistorySection(items: string[]): JSONContent[] {
	if (items.length === 0) return [];
	return [
		{ type: 'paragraph' }, // visual separator before header
		{ type: 'paragraph', content: [{ type: 'text', text: HISTORY_HEADER }] },
		{
			type: 'bulletList',
			content: items.map((t) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
			}))
		}
	];
}

export function applyCommandsToDoc(doc: JSONContent, commands: string[]): JSONContent {
	const split = splitTerminalDoc(doc);
	let items = split.historyItems.slice();
	for (const cmd of commands) {
		const trimmed = cmd.trim();
		if (trimmed === '') continue;
		// move-to-top dedup
		items = items.filter((x) => x !== trimmed);
		items.unshift(trimmed);
		if (items.length > HISTORY_CAP) items = items.slice(0, HISTORY_CAP);
	}
	return { type: 'doc', content: [...split.pre, ...buildHistorySection(items)] };
}

export function removeItemFromDoc(doc: JSONContent, index: number): JSONContent {
	const split = splitTerminalDoc(doc);
	if (index < 0 || index >= split.historyItems.length) return doc;
	const items = split.historyItems.slice();
	items.splice(index, 1);
	return { type: 'doc', content: [...split.pre, ...buildHistorySection(items)] };
}

export function clearHistoryFromDoc(doc: JSONContent): JSONContent {
	const split = splitTerminalDoc(doc);
	return { type: 'doc', content: split.pre };
}

/** Test-only reset of pending state. */
export function _resetForTest(): void {
	for (const p of pending.values()) {
		if (p.timer) clearTimeout(p.timer);
	}
	pending.clear();
}
```

- [ ] **Step 2: Write tests**

Create `app/tests/unit/editor/historyStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	splitTerminalDoc,
	applyCommandsToDoc,
	removeItemFromDoc,
	clearHistoryFromDoc
} from '$lib/editor/terminal/historyStore.js';
import type { JSONContent } from '@tiptap/core';

function metaDoc(): JSONContent {
	return {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
			{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] }
		]
	};
}

function metaWithHistory(items: string[]): JSONContent {
	return {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
			{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
			{ type: 'paragraph' },
			{ type: 'paragraph', content: [{ type: 'text', text: 'history:' }] },
			{
				type: 'bulletList',
				content: items.map((t) => ({
					type: 'listItem',
					content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
				}))
			}
		]
	};
}

function readHistory(doc: JSONContent): string[] {
	return splitTerminalDoc(doc).historyItems;
}

describe('historyStore — pure doc helpers', () => {
	it('appends to a doc with no history section', () => {
		const out = applyCommandsToDoc(metaDoc(), ['ls -la']);
		expect(readHistory(out)).toEqual(['ls -la']);
	});

	it('prepends new commands', () => {
		const out = applyCommandsToDoc(metaWithHistory(['old1', 'old2']), ['fresh']);
		expect(readHistory(out)).toEqual(['fresh', 'old1', 'old2']);
	});

	it('dedups via move-to-top', () => {
		const out = applyCommandsToDoc(metaWithHistory(['a', 'b', 'c']), ['b']);
		expect(readHistory(out)).toEqual(['b', 'a', 'c']);
	});

	it('caps at 50', () => {
		const fifty = Array.from({ length: 50 }, (_, i) => `cmd${i}`);
		const out = applyCommandsToDoc(metaWithHistory(fifty), ['NEW']);
		const got = readHistory(out);
		expect(got.length).toBe(50);
		expect(got[0]).toBe('NEW');
		expect(got[got.length - 1]).toBe('cmd48');
	});

	it('handles a batch of commands in order (last-most-recent)', () => {
		const out = applyCommandsToDoc(metaWithHistory([]), ['a', 'b', 'c']);
		expect(readHistory(out)).toEqual(['c', 'b', 'a']);
	});

	it('removeItemFromDoc removes by index', () => {
		const out = removeItemFromDoc(metaWithHistory(['a', 'b', 'c']), 1);
		expect(readHistory(out)).toEqual(['a', 'c']);
	});

	it('removeItemFromDoc no-ops on out-of-range', () => {
		const before = metaWithHistory(['a']);
		const after = removeItemFromDoc(before, 5);
		expect(after).toEqual(before);
	});

	it('clearHistoryFromDoc removes the section entirely', () => {
		const out = clearHistoryFromDoc(metaWithHistory(['a', 'b']));
		expect(splitTerminalDoc(out).hasHistorySection).toBe(false);
	});

	it('preserves bridge line when adding history', () => {
		const docWithBridge: JSONContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'bridge: wss://x/ws' }] }
			]
		};
		const out = applyCommandsToDoc(docWithBridge, ['cmd']);
		const blocks = (out.content ?? []) as JSONContent[];
		expect(blocks[2]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'bridge: wss://x/ws' }] });
		expect(readHistory(out)).toEqual(['cmd']);
	});
});

// ── Integration tests against real IDB (fake-indexeddb) ──────────────

import 'fake-indexeddb/auto';
import { putNote, getNote } from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';
import { serializeContent } from '$lib/core/noteContentArchiver.js';
import {
	appendCommandToTerminalHistory,
	flushTerminalHistoryNow,
	clearTerminalHistory,
	removeCommandFromTerminalHistory,
	_resetForTest
} from '$lib/editor/terminal/historyStore.js';

vi.mock('$lib/sync/firebase/orchestrator.js', () => ({
	notifyNoteSaved: vi.fn()
}));

async function seedTerminalNote(guid: string, items: string[] = []): Promise<void> {
	const note = createEmptyNote(guid);
	note.title = 'Title';
	note.xmlContent = serializeContent(metaWithHistory(items));
	await putNote(note);
}

describe('historyStore — IDB integration', () => {
	beforeEach(() => {
		_resetForTest();
	});

	it('appendCommandToTerminalHistory writes after debounce', async () => {
		const guid = 'g1';
		await seedTerminalNote(guid, []);
		appendCommandToTerminalHistory(guid, 'cmd1');
		await flushTerminalHistoryNow(guid);
		const after = await getNote(guid);
		expect(after?.xmlContent).toContain('cmd1');
	});

	it('coalesces multiple appends within debounce', async () => {
		const guid = 'g2';
		await seedTerminalNote(guid, []);
		appendCommandToTerminalHistory(guid, 'a');
		appendCommandToTerminalHistory(guid, 'b');
		appendCommandToTerminalHistory(guid, 'c');
		await flushTerminalHistoryNow(guid);
		const after = await getNote(guid);
		// Order: most recent first, so c, b, a.
		expect(after?.xmlContent).toMatch(/c[\s\S]*b[\s\S]*a/);
	});

	it('rejects whitespace-prefixed commands', async () => {
		const guid = 'g3';
		await seedTerminalNote(guid, []);
		appendCommandToTerminalHistory(guid, ' secret');
		await flushTerminalHistoryNow(guid);
		const after = await getNote(guid);
		expect(after?.xmlContent).not.toContain('secret');
	});

	it('aborts silently when note is no longer a terminal note', async () => {
		const guid = 'g4';
		const note = createEmptyNote(guid);
		note.title = 'Plain';
		note.xmlContent = serializeContent({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain' }] }]
		});
		await putNote(note);
		appendCommandToTerminalHistory(guid, 'cmd');
		await expect(flushTerminalHistoryNow(guid)).resolves.toBeUndefined();
	});

	it('clearTerminalHistory removes the section', async () => {
		const guid = 'g5';
		await seedTerminalNote(guid, ['a', 'b']);
		await clearTerminalHistory(guid);
		const after = await getNote(guid);
		expect(after?.xmlContent).not.toContain('history:');
	});

	it('removeCommandFromTerminalHistory drops the right index', async () => {
		const guid = 'g6';
		await seedTerminalNote(guid, ['a', 'b', 'c']);
		await removeCommandFromTerminalHistory(guid, 1);
		const after = await getNote(guid);
		expect(after?.xmlContent).toContain('a');
		expect(after?.xmlContent).not.toContain('>b<'); // crude check — the trimmed value 'b' should no longer be a list-item text
		expect(after?.xmlContent).toContain('c');
	});
});
```

- [ ] **Step 3: Run tests**

Run: `cd app && npm run test -- historyStore --run`
Expected: 9 pure tests + 6 IDB tests pass

- [ ] **Step 4: Verify type-check**

Run: `cd app && npm run check`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/terminal/historyStore.ts app/tests/unit/editor/historyStore.test.ts
git commit -m "historyStore: 터미널 노트 히스토리 read-modify-write"
```

---

## Task 4: OSC 133 capture + command extraction

**Goal:** Hook xterm's OSC parser to receive 133 ;A/;B/;C/;D. On ;C, scrape the buffer between the recorded prompt position and the cursor, sanitize, filter against blocklist, and call `appendCommandToTerminalHistory`.

**Files:**
- Create: `app/src/lib/editor/terminal/oscCapture.ts` — pure helpers (state machine + extraction logic)
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte` — wire the OSC handler + buffer scrape
- Test: `app/tests/unit/editor/oscCapture.test.ts`

**Acceptance Criteria:**
- [ ] `parseOsc133Payload(payload)` returns `{ kind: 'A'|'B'|'C'|'D', exitCode?: number }` for valid payloads, `null` otherwise
- [ ] `extractCommand({ promptRow, promptCol, cursorRow, cursorCol, getLine })` returns the trimmed command string between the prompt position and cursor, walking backward through wrapped lines
- [ ] When cursor is on `promptRow` and to the right of `promptCol`: read just that slice
- [ ] When cursor is on a later row: concatenate (each line's content stripped of trailing spaces) backward to `promptRow + 1`'s start, prepend the slice from `promptRow` after `promptCol`
- [ ] `shouldRecordCommand(text, blocklist)` returns false when: empty after trim, starts with whitespace, or first whitespace-split token ∈ blocklist
- [ ] In `TerminalView.svelte`, OSC 133 sequences do not appear on screen (`registerOscHandler` returns `true`)
- [ ] On `;C`, a captured non-trivial command is dispatched to `appendCommandToTerminalHistory(spec.guid, cmd)` — `spec.guid` is added as a new prop (see Task 5)
- [ ] First `;A` or `;B` seen flips `shellIntegrationDetected` to true; consumed by Task 5 to suppress the banner

**Verify:** `cd app && npm run test -- oscCapture --run` → all helper tests pass. Manual end-to-end test deferred to Task 5 wiring.

**Steps:**

- [ ] **Step 1: Write `oscCapture.ts`**

Create `app/src/lib/editor/terminal/oscCapture.ts`:

```ts
/** Pure helpers for OSC 133 shell-integration capture. No xterm import here. */

export type Osc133Kind = 'A' | 'B' | 'C' | 'D';

export interface Osc133Event {
	kind: Osc133Kind;
	/** Exit code, only set for kind 'D' when the payload supplied one. */
	exitCode?: number;
}

/**
 * Parse the body of an OSC 133 sequence (i.e. the part after `]133;`).
 * Examples: `A`, `B`, `C`, `D`, `D;0`, `D;130`. Anything else returns null.
 */
export function parseOsc133Payload(payload: string): Osc133Event | null {
	if (!payload) return null;
	const parts = payload.split(';');
	const head = parts[0];
	if (head !== 'A' && head !== 'B' && head !== 'C' && head !== 'D') return null;
	if (head === 'D' && parts.length > 1) {
		const code = Number(parts[1]);
		if (Number.isInteger(code)) return { kind: 'D', exitCode: code };
		return { kind: 'D' };
	}
	return { kind: head };
}

export interface CommandExtractionInput {
	promptRow: number;
	promptCol: number;
	cursorRow: number;
	cursorCol: number;
	/** Returns the visible text of `row` (no trailing spaces stripped). */
	getLine: (row: number) => string;
}

/**
 * Extract the command text between (promptRow, promptCol) and (cursorRow,
 * cursorCol). Walks line-by-line, concatenating without inserting newlines
 * (visual lines that wrap belong to the same logical line).
 */
export function extractCommand(input: CommandExtractionInput): string {
	const { promptRow, promptCol, cursorRow, cursorCol, getLine } = input;
	if (cursorRow < promptRow) return '';
	if (cursorRow === promptRow) {
		const line = getLine(promptRow);
		return line.substring(promptCol, cursorCol);
	}
	let out = getLine(promptRow).substring(promptCol).replace(/\s+$/, '');
	for (let r = promptRow + 1; r < cursorRow; r++) {
		out += getLine(r).replace(/\s+$/, '');
	}
	out += getLine(cursorRow).substring(0, cursorCol);
	return out;
}

/**
 * Returns true if this command should be recorded.
 *
 * Rules (in order):
 *  1. starts with whitespace → reject (HISTCONTROL=ignorespace)
 *  2. empty after trim → reject
 *  3. first whitespace-split token is in blocklist → reject
 */
export function shouldRecordCommand(text: string, blocklist: string[]): boolean {
	if (text === '' || /^\s/.test(text)) return false;
	const trimmed = text.trim();
	if (trimmed === '') return false;
	const firstToken = trimmed.split(/\s+/, 1)[0];
	const blockset = new Set(blocklist);
	if (blockset.has(firstToken)) return false;
	return true;
}

/** Stateful tracker — TerminalView keeps one of these per session. */
export class Osc133State {
	private promptRow: number | null = null;
	private promptCol: number | null = null;
	private detected = false;

	get hasDetected(): boolean { return this.detected; }

	onPromptStart(): void {
		this.detected = true;
	}

	onCommandStart(row: number, col: number): void {
		this.detected = true;
		this.promptRow = row;
		this.promptCol = col;
	}

	consumeCommandOnExecute(
		cursorRow: number,
		cursorCol: number,
		getLine: (row: number) => string
	): string | null {
		if (this.promptRow === null || this.promptCol === null) {
			// ;C without a prior ;B — likely the user pressed Enter on a
			// shell that emitted ;A and ;C but skipped ;B (rare). Fall
			// back to the cursor row's start.
			const line = getLine(cursorRow);
			const text = line.substring(0, cursorCol);
			this.promptRow = null;
			this.promptCol = null;
			return text;
		}
		const text = extractCommand({
			promptRow: this.promptRow,
			promptCol: this.promptCol,
			cursorRow,
			cursorCol,
			getLine
		});
		this.promptRow = null;
		this.promptCol = null;
		return text;
	}
}
```

- [ ] **Step 2: Write tests**

Create `app/tests/unit/editor/oscCapture.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	parseOsc133Payload,
	extractCommand,
	shouldRecordCommand,
	Osc133State
} from '$lib/editor/terminal/oscCapture.js';

describe('parseOsc133Payload', () => {
	it('parses A/B/C with no params', () => {
		expect(parseOsc133Payload('A')).toEqual({ kind: 'A' });
		expect(parseOsc133Payload('B')).toEqual({ kind: 'B' });
		expect(parseOsc133Payload('C')).toEqual({ kind: 'C' });
	});

	it('parses D with exit code', () => {
		expect(parseOsc133Payload('D;0')).toEqual({ kind: 'D', exitCode: 0 });
		expect(parseOsc133Payload('D;130')).toEqual({ kind: 'D', exitCode: 130 });
	});

	it('parses bare D', () => {
		expect(parseOsc133Payload('D')).toEqual({ kind: 'D' });
	});

	it('returns null for unknown payloads', () => {
		expect(parseOsc133Payload('X')).toBeNull();
		expect(parseOsc133Payload('')).toBeNull();
		expect(parseOsc133Payload('AA')).toBeNull();
	});
});

describe('extractCommand', () => {
	const lines: Record<number, string> = {
		3: 'user@host:~$ ls -la                                          ',
		4: '/very/long/path/that/wraps/here-and-here-and-here',
		5: ''
	};
	const getLine = (r: number) => lines[r] ?? '';

	it('single-row case', () => {
		const cmd = extractCommand({
			promptRow: 3,
			promptCol: 14, // start of 'ls -la'
			cursorRow: 3,
			cursorCol: 20, // after 'ls -la'
			getLine
		});
		expect(cmd).toBe('ls -la');
	});

	it('wrapped: command spans rows', () => {
		const cmd = extractCommand({
			promptRow: 3,
			promptCol: 14,
			cursorRow: 4,
			cursorCol: lines[4].length,
			getLine
		});
		// Trailing spaces of row 3 are stripped, row 4 is appended.
		expect(cmd).toBe('ls -la' + lines[4]);
	});

	it('cursor before prompt → empty', () => {
		expect(
			extractCommand({ promptRow: 5, promptCol: 0, cursorRow: 3, cursorCol: 0, getLine })
		).toBe('');
	});
});

describe('shouldRecordCommand', () => {
	const blocklist = ['ls', 'cd', 'pwd'];

	it('accepts a normal command', () => {
		expect(shouldRecordCommand('cat foo', blocklist)).toBe(true);
	});

	it('rejects empty', () => {
		expect(shouldRecordCommand('', blocklist)).toBe(false);
		expect(shouldRecordCommand('   ', blocklist)).toBe(false);
	});

	it('rejects whitespace-prefixed (ignorespace)', () => {
		expect(shouldRecordCommand(' echo hi', blocklist)).toBe(false);
		expect(shouldRecordCommand('\tcat foo', blocklist)).toBe(false);
	});

	it('rejects when first token is in blocklist', () => {
		expect(shouldRecordCommand('ls -la', blocklist)).toBe(false);
		expect(shouldRecordCommand('cd /etc', blocklist)).toBe(false);
		expect(shouldRecordCommand('pwd', blocklist)).toBe(false);
	});

	it('does not match blocklist on substring', () => {
		expect(shouldRecordCommand('lsblk', blocklist)).toBe(true); // first token 'lsblk' ≠ 'ls'
	});
});

describe('Osc133State', () => {
	it('hasDetected flips on first event', () => {
		const s = new Osc133State();
		expect(s.hasDetected).toBe(false);
		s.onPromptStart();
		expect(s.hasDetected).toBe(true);
	});

	it('command extraction uses recorded ;B coords', () => {
		const s = new Osc133State();
		s.onCommandStart(3, 14);
		const cmd = s.consumeCommandOnExecute(3, 20, (r) =>
			r === 3 ? 'user@host:~$ ls -la' : ''
		);
		expect(cmd).toBe('ls -la');
	});

	it('falls back to cursor row when ;B was missed', () => {
		const s = new Osc133State();
		const cmd = s.consumeCommandOnExecute(3, 6, (r) => (r === 3 ? 'pwd' : ''));
		expect(cmd).toBe('pwd');
	});

	it('clears prompt position after consume', () => {
		const s = new Osc133State();
		s.onCommandStart(3, 14);
		s.consumeCommandOnExecute(3, 20, () => 'user@host:~$ ls -la');
		const cmd = s.consumeCommandOnExecute(4, 5, (r) =>
			r === 4 ? 'echo' : ''
		);
		// Without a new ;B, the second extraction falls back to row start.
		expect(cmd).toBe('echo');
	});
});
```

- [ ] **Step 3: Wire OSC handler in `TerminalView.svelte`**

Edit `app/src/lib/editor/terminal/TerminalView.svelte` — add imports at the top of `<script>`:

```ts
import { Osc133State, parseOsc133Payload, shouldRecordCommand } from './oscCapture.js';
import { appendCommandToTerminalHistory, flushTerminalHistoryNow } from './historyStore.js';
import { getTerminalHistoryBlocklist } from '$lib/storage/appSettings.js';
```

Add to props:

```ts
type Props = {
	spec: TerminalNoteSpec;
	guid: string;            // ← NEW: needed by historyStore
	onedit: () => void;
};
let { spec, guid, onedit }: Props = $props();
```

Add state for shell-integration detection (used by Task 5 for the banner):

```ts
let shellIntegrationDetected = $state(false);
```

In `onMount`, after `term = new Terminal(...)` but before `term.open(...)`, register the OSC 133 handler:

```ts
const osc = new Osc133State();
let blocklist: string[] = await getTerminalHistoryBlocklist();
// Re-read blocklist when settings change is out of scope for this version;
// the user can reload the terminal note to pick up new values.

term.parser.registerOscHandler(133, (data: string) => {
	const evt = parseOsc133Payload(data);
	if (!evt) return false; // let xterm render — defensive; unknown payloads
	if (!shellIntegrationDetected) shellIntegrationDetected = true;
	if (evt.kind === 'A') {
		osc.onPromptStart();
	} else if (evt.kind === 'B') {
		const buf = term!.buffer.active;
		osc.onCommandStart(buf.cursorY + buf.baseY, buf.cursorX);
	} else if (evt.kind === 'C') {
		const buf = term!.buffer.active;
		const cmd = osc.consumeCommandOnExecute(
			buf.cursorY + buf.baseY,
			buf.cursorX,
			(row) => {
				const line = buf.getLine(row);
				return line ? line.translateToString(true) : '';
			}
		);
		if (cmd && shouldRecordCommand(cmd, blocklist)) {
			appendCommandToTerminalHistory(guid, cmd);
		}
	}
	// kind 'D' is ignored for now.
	return true; // suppress xterm output of the OSC sequence
});
```

In `onDestroy`, before `term?.dispose()`:

```ts
// Best-effort flush so commands captured shortly before navigation aren't lost.
void flushTerminalHistoryNow(guid);
```

Also add a `pagehide` listener earlier in `onMount`:

```ts
const onPageHide = () => { void flushTerminalHistoryNow(guid); };
window.addEventListener('pagehide', onPageHide);
```

…and remove it in `onDestroy`:

```ts
window.removeEventListener('pagehide', onPageHide);
```

- [ ] **Step 4: Update callers of `<TerminalView>` to pass `guid`**

Two call sites — `app/src/routes/note/[id]/+page.svelte` and `app/src/lib/desktop/NoteWindow.svelte`. Find each `<TerminalView spec={...} onedit={...} />` and add `guid={note.guid}` (the variable name will already be in scope — both files load the note before rendering).

Use this command to find them:

```bash
grep -rn "TerminalView" app/src/routes app/src/lib/desktop
```

Then add the `guid` attribute. Example diff:

```svelte
<TerminalView {spec} guid={note.guid} onedit={...} />
```

- [ ] **Step 5: Run tests**

Run: `cd app && npm run test -- oscCapture --run`
Expected: 18 tests pass.

Run: `cd app && npm run check`
Expected: 0 errors. (If TerminalView callers are missed, check will flag the missing `guid` prop.)

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/terminal/oscCapture.ts \
        app/src/lib/editor/terminal/TerminalView.svelte \
        app/src/routes/note/\[id\]/+page.svelte \
        app/src/lib/desktop/NoteWindow.svelte \
        app/tests/unit/editor/oscCapture.test.ts
git commit -m "OSC 133 캡처: ;C 시점 명령어 추출 → historyStore"
```

---

## Task 5: HistoryPanel + TerminalView integration

**Goal:** Render the history panel on top of `TerminalView`. Desktop: 240px right side panel, default open. Mobile: bottom sheet, default closed. Header toggle button shows count. Click = re-input, Shift+click = execute. Right-click / long-press menu: 복사 / 삭제 / 편집 모드. Banner when shell integration not detected within 30s.

**Files:**
- Create: `app/src/lib/editor/terminal/HistoryPanel.svelte`
- Modify: `app/src/lib/editor/terminal/TerminalView.svelte` — toggle, panel rendering, integration glue

**Acceptance Criteria:**
- [ ] Header shows `히스토리 (N)` button; click toggles panel
- [ ] Panel state persists per-platform via `getTerminalHistoryPanelOpen{Desktop,Mobile}` / `set...`
- [ ] Desktop layout: 240px-wide column to the right of `.xterm-host`, panel scrollable, terminal shrinks to fill remaining width
- [ ] Mobile layout (`(max-width: 767px)`): panel becomes a bottom sheet ~50% height when open
- [ ] Items render most-recent-first; truncate with single-line ellipsis; full text in `title` attribute (tooltip)
- [ ] Click → `client.sendCommand(text, false)` then `term.focus()`
- [ ] Shift+click → `client.sendCommand(text, true)` then `term.focus()`
- [ ] Item highlight pulse on click (CSS `@keyframes` 0.15s)
- [ ] Right-click (desktop) / long-press 500ms (mobile) opens a menu: 복사 / 삭제 / 편집 모드
- [ ] 복사 → `navigator.clipboard.writeText(text)`
- [ ] 삭제 → `removeCommandFromTerminalHistory(guid, index)`
- [ ] 편집 모드 → calls the existing `onedit` callback prop
- [ ] Panel header has 비우기 (with confirm) and 닫기 buttons
- [ ] When `shellIntegrationDetected === false` 30s after first connect, banner shows. Has a 닫기 (×) that calls `setTerminalShellIntegrationBannerDismissed(true)`. Once dismissed, never shown again until the user clears the setting.
- [ ] Subscribes to `noteReloadBus` to re-derive history on external changes (e.g. cross-device push)

**Verify:**
- `cd app && npm run check` → 0 errors
- Manual: connect to a real ssh target with the snippet from Task 6 installed; type a few commands; observe panel populating, click to re-input, Shift+click to execute, long-press for menu.

**Steps:**

- [ ] **Step 1: Create `HistoryPanel.svelte`**

Create `app/src/lib/editor/terminal/HistoryPanel.svelte`:

```svelte
<script lang="ts">
	import { onMount } from 'svelte';

	type Props = {
		count: number;
		items: string[];
		onsend: (text: string) => void;
		onsendNow: (text: string) => void;
		ondelete: (index: number) => void;
		onclear: () => void;
		onclose: () => void;
		onedit: () => void;
	};
	let { count, items, onsend, onsendNow, ondelete, onclear, onclose, onedit }: Props = $props();

	let menuOpenIndex: number | null = $state(null);
	let menuX = $state(0);
	let menuY = $state(0);
	let pulseIndex: number | null = $state(null);

	function pulse(index: number): void {
		pulseIndex = index;
		setTimeout(() => {
			if (pulseIndex === index) pulseIndex = null;
		}, 200);
	}

	function handleClick(ev: MouseEvent, index: number): void {
		if ((ev.target as HTMLElement).closest('.menu')) return;
		const text = items[index];
		if (!text) return;
		pulse(index);
		if (ev.shiftKey) onsendNow(text);
		else onsend(text);
	}

	function handleContextMenu(ev: MouseEvent, index: number): void {
		ev.preventDefault();
		menuOpenIndex = index;
		menuX = ev.clientX;
		menuY = ev.clientY;
	}

	let pressTimer: ReturnType<typeof setTimeout> | null = null;
	function handlePointerDown(ev: PointerEvent, index: number): void {
		if (ev.pointerType !== 'touch') return;
		pressTimer = setTimeout(() => {
			menuOpenIndex = index;
			menuX = ev.clientX;
			menuY = ev.clientY;
			if ('vibrate' in navigator) navigator.vibrate(20);
			pressTimer = null;
		}, 500);
	}
	function handlePointerUp(): void {
		if (pressTimer) {
			clearTimeout(pressTimer);
			pressTimer = null;
		}
	}

	function copy(text: string): void {
		void navigator.clipboard.writeText(text);
		menuOpenIndex = null;
	}

	async function confirmClear(): Promise<void> {
		if (confirm('히스토리를 모두 삭제할까요?')) {
			onclear();
		}
	}

	function closeMenu(): void {
		menuOpenIndex = null;
	}

	onMount(() => {
		const onDocClick = (ev: MouseEvent) => {
			if (menuOpenIndex !== null) {
				const t = ev.target as HTMLElement;
				if (!t.closest('.menu')) closeMenu();
			}
		};
		document.addEventListener('click', onDocClick);
		return () => document.removeEventListener('click', onDocClick);
	});
</script>

<div class="history-panel" role="region" aria-label="명령어 히스토리">
	<div class="panel-header">
		<span class="title">히스토리 <span class="count">{count}</span></span>
		<div class="actions">
			<button type="button" class="icon-btn" title="비우기" onclick={confirmClear}>⌫</button>
			<button type="button" class="icon-btn" title="닫기" onclick={onclose}>×</button>
		</div>
	</div>
	<ul class="items">
		{#if items.length === 0}
			<li class="empty">기록된 명령어가 없습니다</li>
		{:else}
			{#each items as text, index (index + ':' + text)}
				<li
					class="item"
					class:pulse={pulseIndex === index}
					title={text}
					onclick={(e) => handleClick(e, index)}
					oncontextmenu={(e) => handleContextMenu(e, index)}
					onpointerdown={(e) => handlePointerDown(e, index)}
					onpointerup={handlePointerUp}
					onpointercancel={handlePointerUp}
					role="button"
					tabindex="0"
					onkeydown={(e) => {
						if (e.key === 'Enter') handleClick(e as unknown as MouseEvent, index);
					}}
				>
					{text}
				</li>
			{/each}
		{/if}
	</ul>

	{#if menuOpenIndex !== null}
		<div class="menu" style="left:{menuX}px; top:{menuY}px;" role="menu">
			<button type="button" onclick={() => { copy(items[menuOpenIndex!]); }}>복사</button>
			<button type="button" onclick={() => { ondelete(menuOpenIndex!); closeMenu(); }}>삭제</button>
			<button type="button" onclick={() => { onedit(); closeMenu(); }}>편집 모드</button>
		</div>
	{/if}
</div>

<style>
	.history-panel {
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: #232323;
		color: #ddd;
		border-left: 1px solid #111;
	}
	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 8px;
		background: #2a2a2a;
		border-bottom: 1px solid #111;
	}
	.title { font-size: 0.78rem; }
	.count {
		display: inline-block;
		padding: 0 6px;
		border-radius: 8px;
		background: #444;
		color: #ddd;
		font-size: 0.7rem;
		margin-left: 4px;
	}
	.actions { display: flex; gap: 2px; }
	.icon-btn {
		background: transparent;
		border: none;
		color: #aaa;
		cursor: pointer;
		font-size: 0.9rem;
		padding: 2px 6px;
		border-radius: 3px;
	}
	.icon-btn:hover { background: #3a3a3a; color: #fff; }

	.items {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		flex: 1;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}
	.empty {
		color: #666;
		font-size: 0.8rem;
		padding: 8px;
		text-align: center;
	}
	.item {
		padding: 4px 8px;
		font-size: 0.78rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
		transition: background 0.05s;
	}
	.item:hover { background: #2f2f2f; }
	.item.pulse { animation: pulse 0.2s ease-out; }
	@keyframes pulse {
		0% { background: #4a6a9c; }
		100% { background: transparent; }
	}

	.menu {
		position: fixed;
		background: #2f2f2f;
		border: 1px solid #555;
		border-radius: 4px;
		padding: 2px;
		display: flex;
		flex-direction: column;
		gap: 1px;
		z-index: 100;
		min-width: 100px;
	}
	.menu button {
		background: transparent;
		border: none;
		color: #ddd;
		text-align: left;
		padding: 4px 10px;
		font-size: 0.78rem;
		cursor: pointer;
	}
	.menu button:hover { background: #3a4a6a; }
</style>
```

- [ ] **Step 2: Wire the panel into `TerminalView.svelte`**

Add imports at the top of `<script>`:

```ts
import HistoryPanel from './HistoryPanel.svelte';
import {
	getTerminalHistoryPanelOpenDesktop,
	setTerminalHistoryPanelOpenDesktop,
	getTerminalHistoryPanelOpenMobile,
	setTerminalHistoryPanelOpenMobile,
	getTerminalShellIntegrationBannerDismissed,
	setTerminalShellIntegrationBannerDismissed
} from '$lib/storage/appSettings.js';
import { subscribeNoteReload } from '$lib/core/noteReloadBus.js';
import { getNote } from '$lib/storage/noteStore.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { parseTerminalNote } from './parseTerminalNote.js';
import {
	removeCommandFromTerminalHistory,
	clearTerminalHistory
} from './historyStore.js';
```

Add reactive state (declarations near the existing `status`, `statusMessage`, etc.):

```ts
let history: string[] = $state([]);
let panelOpen = $state(false);
let isMobile = $state(false);
let shellHintDismissed = $state(false);
let shellHintVisible = $state(false);
```

Add a helper that derives `history` from the current note:

```ts
async function reloadHistory(): Promise<void> {
	const note = await getNote(guid);
	if (!note) return;
	const doc = deserializeContent(note.xmlContent);
	const parsed = parseTerminalNote(doc);
	history = parsed?.history ?? [];
}
```

In `onMount`, before the `term = new Terminal(...)` block, initialize the panel state:

```ts
isMobile = window.matchMedia && !window.matchMedia('(min-width: 768px)').matches;
panelOpen = isMobile
	? await getTerminalHistoryPanelOpenMobile()
	: await getTerminalHistoryPanelOpenDesktop();
shellHintDismissed = await getTerminalShellIntegrationBannerDismissed();
await reloadHistory();
const unsubReload = subscribeNoteReload(guid, () => reloadHistory());
```

Add the unsubscribe to cleanup:

```ts
onDestroy(() => {
	unsubReload();
	resizeObserver?.disconnect();
	// ... existing cleanup
});
```

Wait — the existing `onDestroy` is defined separately. Move `unsubReload` so it's accessible in `onDestroy`. Declare it at module scope inside `<script>`:

```ts
let unsubReload: (() => void) | null = null;
```

Then assign in `onMount`:

```ts
unsubReload = subscribeNoteReload(guid, () => reloadHistory());
```

And in `onDestroy`:

```ts
unsubReload?.();
unsubReload = null;
```

Schedule the shell-integration banner check 30s after `client.connect()`:

```ts
setTimeout(() => {
	if (!shellIntegrationDetected && !shellHintDismissed) {
		shellHintVisible = true;
	}
}, 30_000);
```

Toggle handler:

```ts
async function togglePanel(): Promise<void> {
	panelOpen = !panelOpen;
	if (isMobile) await setTerminalHistoryPanelOpenMobile(panelOpen);
	else await setTerminalHistoryPanelOpenDesktop(panelOpen);
}
```

Click handlers passed into `<HistoryPanel>`:

```ts
function onPanelSend(text: string): void {
	client?.sendCommand(text, false);
	term?.focus();
}
function onPanelSendNow(text: string): void {
	client?.sendCommand(text, true);
	term?.focus();
}
async function onPanelDelete(index: number): Promise<void> {
	await removeCommandFromTerminalHistory(guid, index);
	await reloadHistory();
}
async function onPanelClear(): Promise<void> {
	await clearTerminalHistory(guid);
	await reloadHistory();
}
function onPanelClose(): void {
	void togglePanel();
}
async function dismissShellHint(): Promise<void> {
	shellHintVisible = false;
	shellHintDismissed = true;
	await setTerminalShellIntegrationBannerDismissed(true);
}
```

Update the markup. Replace the old structure starting at `<div class="terminal-page">` with:

```svelte
<div class="terminal-page" class:panel-open={panelOpen} class:mobile={isMobile}>
	<div class="terminal-header">
		<div class="meta">
			<div class="line"><span class="label">target</span><code>{spec.target}</code></div>
			{#if spec.bridge}
				<div class="line"><span class="label">bridge</span><code>{spec.bridge}</code></div>
			{:else if resolvedBridge}
				<div class="line"><span class="label">bridge</span><code class="muted">{resolvedBridge} (기본값)</code></div>
			{/if}
		</div>
		<div class="actions">
			<button type="button" class="toggle" onclick={togglePanel}>
				히스토리 ({history.length})
			</button>
			<span class="status status-{status}">
				{#if status === 'connecting'}연결 중…
				{:else if status === 'open'}연결됨
				{:else if status === 'closed'}끊김
				{:else}오류{/if}
			</span>
			<button type="button" onclick={reconnect} disabled={!resolvedBridge}>재연결</button>
			<button type="button" onclick={onedit}>편집 모드</button>
		</div>
	</div>

	{#if statusMessage}
		<div class="banner" class:banner-error={status === 'error' || bridgeMissing}>{statusMessage}</div>
	{/if}

	{#if shellHintVisible}
		<div class="banner banner-hint">
			셸 통합이 감지되지 않았습니다. 명령어가 자동으로 기록되지 않습니다.
			<a href="/settings#terminal" target="_self">설정 안내 보기</a>
			<button type="button" class="banner-close" onclick={dismissShellHint}>×</button>
		</div>
	{/if}

	<div class="body">
		<div class="xterm-host" bind:this={xtermContainer}></div>
		{#if panelOpen}
			<HistoryPanel
				count={history.length}
				items={history}
				onsend={onPanelSend}
				onsendNow={onPanelSendNow}
				ondelete={onPanelDelete}
				onclear={onPanelClear}
				onclose={onPanelClose}
				{onedit}
			/>
		{/if}
	</div>
</div>
```

Update CSS:

```css
.terminal-page {
	display: flex;
	flex-direction: column;
	height: 100%;
	background: #1e1e1e;
	color: #ddd;
}

.body {
	flex: 1;
	display: flex;
	min-height: 0;
}

/* Desktop (default): panel on the right */
.body :global(.history-panel) {
	width: 240px;
	flex-shrink: 0;
}
.xterm-host {
	flex: 1;
	padding: 4px;
	overflow: hidden;
}

/* Mobile: panel becomes a bottom sheet ~50% height */
.terminal-page.mobile.panel-open .body {
	flex-direction: column;
}
.terminal-page.mobile.panel-open .xterm-host {
	flex: 1 1 50%;
	min-height: 0;
}
.terminal-page.mobile.panel-open .body :global(.history-panel) {
	width: auto;
	flex: 1 1 50%;
	border-left: none;
	border-top: 1px solid #111;
}

.actions .toggle {
	background: #3a3a3a;
	color: #ddd;
	border: 1px solid #555;
	border-radius: 4px;
	padding: 3px 8px;
	font-size: 0.78rem;
	cursor: pointer;
}

.banner-hint {
	background: #3a3a4a;
	color: #ddd;
	display: flex;
	align-items: center;
	gap: 6px;
}
.banner-hint a { color: #9bf; }
.banner-close {
	margin-left: auto;
	background: transparent;
	border: none;
	color: #aaa;
	cursor: pointer;
	font-size: 1rem;
}
```

Keep the existing `xterm` global selector and other styles unchanged.

- [ ] **Step 3: Manual smoke check (or stubbed integration test)**

Run: `cd app && npm run check`
Expected: 0 errors.

Run: `cd app && npm run dev`, open a terminal note, click 히스토리, type some commands (after installing the snippet from Task 6 on a remote), confirm:
- panel populates as commands are entered
- click types into prompt without Enter
- Shift+click executes
- 비우기 confirms then clears

If no SSH target is available in this environment, mark this manual check as deferred and note in the commit message.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/editor/terminal/HistoryPanel.svelte \
        app/src/lib/editor/terminal/TerminalView.svelte
git commit -m "히스토리 패널 + TerminalView 통합"
```

---

## Task 6: Settings page — new "터미널" tab

**Goal:** Add a new top-level tab in `/settings` with three sections: 브릿지 연결 (moved from current 동기화 설정 tab), 명령어 히스토리, 셸 통합 (스니펫 + 복사). Remove the 터미널 브릿지 block from 동기화 설정.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte`

**Acceptance Criteria:**
- [ ] `Tab` type extended to include `'terminal'`
- [ ] `tabs` array includes `{ id: 'terminal', label: '터미널' }` placed between `config` and `notify`
- [ ] The `<section class="section"><h2>터미널 브릿지</h2>...` block (lines ~847-909 in the current file) moves verbatim into the new tab branch
- [ ] New "명령어 히스토리" section in the same tab: two checkboxes (desktop default open / mobile default open), a textarea (comma-separated blocklist), 기본값 복원 button
- [ ] New "셸 통합" section: explanation paragraph, code block with the bash snippet, [복사] button, tmux note
- [ ] New "보안" notes section: 비밀번호 인라인 사용 금지, 공백-시작 명령은 캡처 안 됨
- [ ] Bind variables initialize on tab mount (or component mount, gated behind `if (activeTab === 'terminal')` for lazy loading)

**Verify:**
- `cd app && npm run check` → 0 errors
- Manual: navigate to `/settings`, click 터미널 tab, edit blocklist, save, reload, verify persistence; click 복사 on snippet, paste into a scratchpad to confirm contents.

**Steps:**

- [ ] **Step 1: Update `Tab` type and `tabs` array**

In `app/src/routes/settings/+page.svelte`, change:

```ts
type Tab = 'sync' | 'config' | 'notify' | 'advanced';
```

to:

```ts
type Tab = 'sync' | 'config' | 'terminal' | 'notify' | 'advanced';
```

Update the `tabs` array (around line 571):

```ts
const tabs: { id: Tab; label: string }[] = [
	{ id: 'sync', label: '동기화' },
	{ id: 'config', label: '동기화 설정' },
	{ id: 'terminal', label: '터미널' },
	{ id: 'notify', label: '알림' },
	{ id: 'advanced', label: '고급' }
];
```

- [ ] **Step 2: Move the bridge UI into the new tab and add new sections**

Cut the entire `<section class="section"><h2>터미널 브릿지</h2>...</section>` block (currently at the end of the `config` branch, around lines 847–909).

Add a new branch before `{:else if activeTab === 'notify'}`:

```svelte
{:else if activeTab === 'terminal'}
	<!-- ── 터미널 탭 ───────────────────────────────────────────────── -->
	<section class="section">
		<h2>브릿지 연결</h2>
		<p class="info-text">
			터미널 노트(<code>ssh://...</code> 형식)를 열 때 사용할 기본 브릿지 URL을 설정합니다.
			노트 본문에 <code>bridge:</code> 줄이 없으면 이 값이 사용됩니다.
		</p>

		<!-- (paste the bridge URL + login form + status block here, unchanged) -->
	</section>

	<section class="section">
		<h2>명령어 히스토리</h2>
		<p class="info-text">
			터미널 노트 우측 패널에 표시되는 최근 명령어 목록입니다. 노트 본문에
			저장되어 모든 디바이스에서 공유됩니다. 최대 50개까지 보관됩니다.
		</p>

		<label class="profile-row">
			<input type="checkbox" bind:checked={termHistOpenDesktop} onchange={saveTermHistOpenDesktop} />
			<span>데스크톱에서 패널 기본 열림</span>
		</label>
		<label class="profile-row">
			<input type="checkbox" bind:checked={termHistOpenMobile} onchange={saveTermHistOpenMobile} />
			<span>모바일에서 패널 기본 열림</span>
		</label>

		<p class="info-text small">기록하지 않을 명령어 (첫 토큰 기준, 콤마 구분)</p>
		<textarea
			class="path-input"
			rows="2"
			bind:value={termHistBlocklistText}
			onblur={saveTermHistBlocklist}
		></textarea>
		<button class="btn btn-secondary" onclick={resetTermHistBlocklist}>기본값으로 되돌리기</button>
	</section>

	<section class="section">
		<h2>셸 통합 (OSC 133)</h2>
		<p class="info-text">
			히스토리 캡처에는 원격 셸에 1회 설정이 필요합니다. 아래 스니펫을
			원격의 <code>~/.bashrc</code> (또는 <code>~/.zshrc</code>) 끝에
			추가하세요.
		</p>
		<pre class="snippet"><code>{shellSnippet}</code></pre>
		<button class="btn btn-secondary" onclick={copySnippet}>{snippetCopied ? '복사됨' : '복사'}</button>
		<p class="info-text small">
			tmux 사용 시: 스니펫이 <code>$TMUX</code> 환경변수를 자동 감지하여
			DCS 패스스루로 래핑하므로 <code>tmux.conf</code> 수정은 필요 없습니다.
		</p>
	</section>

	<section class="section">
		<h2>보안 안내</h2>
		<ul class="info-text">
			<li>명령어 히스토리는 노트 본문에 평문으로 저장되어 Dropbox/Firestore와 동기화됩니다. <strong>비밀번호를 명령 인자로 입력하지 마세요</strong>.</li>
			<li>공백 또는 탭으로 시작하는 명령은 캡처되지 않습니다 (<code>HISTCONTROL=ignorespace</code> 관행). 일회성으로 민감한 명령을 숨기고 싶다면 명령 앞에 공백을 한 칸 두고 입력하세요.</li>
		</ul>
	</section>
{:else if activeTab === 'notify'}
```

Where the section comment says "paste the bridge URL ... block here, unchanged", insert the previous bridge URL + login form + status row + message block (the inner content of the old `<section>`, **without** its `<h2>터미널 브릿지</h2>` since the new section uses `<h2>브릿지 연결</h2>`).

- [ ] **Step 3: Add the new state + handlers**

Append imports at the top of `<script>` (near the existing imports):

```ts
import {
	getTerminalHistoryPanelOpenDesktop,
	setTerminalHistoryPanelOpenDesktop,
	getTerminalHistoryPanelOpenMobile,
	setTerminalHistoryPanelOpenMobile,
	getTerminalHistoryBlocklist,
	setTerminalHistoryBlocklist,
	TERMINAL_HISTORY_BLOCKLIST_DEFAULT
} from '$lib/storage/appSettings.js';
```

Add state declarations near the existing `terminalBridgeUrl` etc.:

```ts
let termHistOpenDesktop = $state(true);
let termHistOpenMobile = $state(false);
let termHistBlocklistText = $state('');
let snippetCopied = $state(false);

const shellSnippet = `# Append to ~/.bashrc (or ~/.zshrc)
__th_osc() {
  if [ -n "$TMUX" ]; then
    printf '\\ePtmux;\\e\\e]133;%s\\a\\e\\\\' "$1"
  else
    printf '\\e]133;%s\\a' "$1"
  fi
}
PS1='\\[$(__th_osc A)\\]'"$PS1"'\\[$(__th_osc B)\\]'
PROMPT_COMMAND='__th_osc "D;$?"; '"\${PROMPT_COMMAND:-}"
trap '__th_osc C' DEBUG`;

async function loadTerminalHistorySettings(): Promise<void> {
	termHistOpenDesktop = await getTerminalHistoryPanelOpenDesktop();
	termHistOpenMobile = await getTerminalHistoryPanelOpenMobile();
	const list = await getTerminalHistoryBlocklist();
	termHistBlocklistText = list.join(', ');
}

async function saveTermHistOpenDesktop(): Promise<void> {
	await setTerminalHistoryPanelOpenDesktop(termHistOpenDesktop);
}
async function saveTermHistOpenMobile(): Promise<void> {
	await setTerminalHistoryPanelOpenMobile(termHistOpenMobile);
}
async function saveTermHistBlocklist(): Promise<void> {
	const items = termHistBlocklistText
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s !== '');
	await setTerminalHistoryBlocklist(items);
}
async function resetTermHistBlocklist(): Promise<void> {
	termHistBlocklistText = TERMINAL_HISTORY_BLOCKLIST_DEFAULT.join(', ');
	await setTerminalHistoryBlocklist([...TERMINAL_HISTORY_BLOCKLIST_DEFAULT]);
}

async function copySnippet(): Promise<void> {
	await navigator.clipboard.writeText(shellSnippet);
	snippetCopied = true;
	setTimeout(() => { snippetCopied = false; }, 2000);
}
```

In the existing `onMount` block (which already calls `void loadTerminalBridgeState()`), add a sibling call:

```ts
void loadTerminalHistorySettings();
```

- [ ] **Step 4: Add minimal CSS for `.snippet`**

Append to the `<style>` block:

```css
.snippet {
	background: #111;
	color: #cfe;
	padding: 8px;
	border-radius: 4px;
	font-size: 0.78rem;
	overflow-x: auto;
	white-space: pre;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
```

- [ ] **Step 5: Run checks**

Run: `cd app && npm run check`
Expected: 0 errors.

Run: `cd app && npm run dev`, navigate to `/settings`, click 터미널 tab, verify:
- Bridge URL/login still works (no functional change, just relocated)
- Both checkboxes toggle and persist across reload
- Blocklist textarea saves on blur, 기본값 복원 restores defaults
- 복사 button copies the snippet (paste into a text editor to verify)

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "설정: 터미널 탭 신설 (브릿지 + 히스토리 + 셸 통합)"
```

---

## Task 7: CLAUDE.md & tomboy-terminal skill update

**Goal:** Reflect the new note-format extension and invariants in the project's CLAUDE.md and the `tomboy-terminal` skill file.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.claude/skills/tomboy-terminal/SKILL.md` (or wherever the skill resolves — find via `find`)

**Acceptance Criteria:**
- [ ] CLAUDE.md "터미널 노트" section's "Note body has at most 2 non-empty paragraphs" invariant is updated to reflect the optional `history:` section
- [ ] CLAUDE.md adds the 6 new invariants from the spec's Section 7
- [ ] CLAUDE.md "Quick map" lists the new files: `historyStore.ts`, `oscCapture.ts`, `HistoryPanel.svelte`
- [ ] tomboy-terminal skill file gets the same updates so Claude future sessions know the new format
- [ ] No invariant says the body is exactly 1 or 2 paragraphs anymore — it says "1 or 2 metadata paragraphs, optionally followed by a `history:` section"

**Verify:** `git diff CLAUDE.md` shows the updated invariants list. `find ~/.claude -name 'SKILL.md' -path '*tomboy-terminal*' 2>/dev/null` returns the skill path.

**Steps:**

- [ ] **Step 1: Locate the tomboy-terminal skill file**

```bash
find ~/.claude -name 'SKILL.md' -path '*tomboy-terminal*' 2>/dev/null
find /home /var/home -name 'SKILL.md' -path '*tomboy-terminal*' 2>/dev/null | head
```

Note the path returned. Common locations include `~/.claude/plugins/...` or a per-project directory. Use whichever is canonical for this repo.

- [ ] **Step 2: Update CLAUDE.md "터미널 노트" section**

In `CLAUDE.md`, find the "터미널 노트 (SSH terminal in a note)" section. Replace the format block to allow the optional history section:

```
A note whose body is **(1) exactly 1 or 2 non-empty paragraphs matching the
SSH/bridge metadata, OPTIONALLY followed by (2) a `history:` paragraph and a
bulletList of recent commands** is opened as an `xterm.js` terminal:

ssh://[user@]host[:port]
bridge: wss://my-pc.example.com/ws    # optional
                                       # optional blank
history:                               # optional
- ls -la
- sudo systemctl restart caddy
```

In the same section's invariants list, replace the "Note body has at most 2 non-empty paragraphs" bullet with:

```
- **Note body = 1–2 metadata paragraphs + (optional) `history:` section.**
  A 3rd free paragraph (or any non-history block) means it's no longer a
  terminal note — by design, so the user opts out simply by typing more.
- **`history:` header text is fixed** — exactly that string, not localized.
- **History items are plain text only.** Marks ignored, nested lists ignored.
- **History capacity = 50, FIFO + move-to-top dedup.** Older items are
  dropped when a new command pushes the list past the cap.
- **Re-input does not auto-press Enter.** Click stages text into the
  prompt; Shift+click sends `\r`. The user explicitly executes.
- **Whitespace-prefixed commands are NOT captured** (HISTCONTROL=ignorespace
  convention). Use a leading space to keep a one-off command out of history.
- **Note body = plaintext.** Do not put passwords as command arguments;
  they will be captured + synced to Dropbox/Firestore in plain text.
- **OSC 133 shell integration is opt-in per remote** — without the snippet
  installed, capture is NO-OP and the existing terminal note behaviour is
  100% unchanged.
```

In the "Quick map" sub-list, add:

```
- `app/src/lib/editor/terminal/historyStore.ts` — read-modify-write
  history mutation + per-guid serialization + 500ms debounce.
- `app/src/lib/editor/terminal/oscCapture.ts` — pure OSC 133 parser /
  command-extraction helpers.
- `app/src/lib/editor/terminal/HistoryPanel.svelte` — desktop side panel
  + mobile bottom sheet UI for the captured history.
```

- [ ] **Step 3: Mirror updates into the tomboy-terminal skill file**

Open the skill file located in Step 1 and apply the same content changes (the body-format paragraph, the invariants, and the file-map entries). Skills are versioned independently of the repo so make sure the actual file at the resolved path is edited, not a copy.

- [ ] **Step 4: Run a sanity grep**

```bash
grep -n "history:" CLAUDE.md
grep -n "OSC 133" CLAUDE.md
```

Expect at least one match for each.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
# Plus the skill file path, e.g.:
# git add ~/.claude/skills/tomboy-terminal/SKILL.md  (or wherever)
git commit -m "docs: 터미널 노트 히스토리 포맷·불변식 반영"
```

---

## Self-Review

**Spec coverage check:**
| Spec section | Implemented in |
|---|---|
| §1 Note format & parser | Task 1 |
| §2 OSC 133 capture | Task 4 (oscCapture.ts), Task 5 (TerminalView wiring) |
| §3 Storage pipeline | Task 3 (historyStore + debounce + per-guid chain) |
| §4 UI panel | Task 5 (HistoryPanel + TerminalView integration) |
| §5 Re-input | Task 2 (sendCommand) + Task 5 (click handlers + focus) |
| §6 Settings reorg | Task 6 |
| §7 Edge cases & invariants | Task 4 (whitespace + blocklist filter), Task 3 (ABORT on non-terminal note), Task 5 (banner), Task 7 (docs) |

**Type-consistency check:**
- `TerminalNoteSpec` gains `history: string[]` (Task 1) — consumed by Task 5's `HistoryPanel`.
- `appendCommandToTerminalHistory` / `removeCommandFromTerminalHistory` / `clearTerminalHistory` / `flushTerminalHistoryNow` names are consistent across Task 3 (definition) and Task 5 (callers).
- `sendCommand(text, autoExecute)` signature matches between Task 2 (definition) and Task 5 (caller).
- `Osc133State` API (`onPromptStart`, `onCommandStart`, `consumeCommandOnExecute`, `hasDetected`) consistent between Task 4 (definition) and Task 5's `shellIntegrationDetected` consumption.
- `getTerminalHistory*` accessors named consistently across Task 0 (definition), Task 5 (TerminalView), Task 6 (settings page).

**Placeholder scan:** No `TBD`/`TODO`/"add appropriate error handling" entries. Each step has either complete code or a precise mechanical edit with file/line context.

**Resolved during self-review:** None — review pass clean.

---

## Notes for the Engineer

- **Run all tests + check after each task:** `cd app && npm run test --run && npm run check`. Don't batch task commits.
- **OSC capture cannot be unit-tested end-to-end** — it requires a running xterm + a remote shell. The pure helpers in `oscCapture.ts` are heavily tested; the wiring in `TerminalView` is verified manually (Task 5 step 3).
- **The blocklist read happens once at `onMount`.** A user changing the blocklist in settings must reopen the terminal note for it to take effect. Acceptable for v1; document in the settings tab if desired.
- **Don't forget to pass `guid` to `<TerminalView>`** in both call sites (Task 4 step 4) — otherwise `npm run check` will flag it.
