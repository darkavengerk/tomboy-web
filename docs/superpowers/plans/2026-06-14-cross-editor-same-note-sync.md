# Cross-Editor Same-Note Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the same note is open in N live editors in one tab (host page + note-bundle leaves + desktop windows), editing one converges every other to the saved content with no lost keystrokes.

**Architecture:** Reuse the existing `noteReloadBus` (the in-tab reload channel already used by the rename cascade). Give the bus per-subscriber *sender identity* (a token), make `updateNoteFromEditor` self-emit a reload for the saved guid on **every** write while excluding the editor that just saved, and add two no-loss guarantees on top: a focus/dirty guard so the editor you are typing in is never yanked, and flush-on-blur so leaving an editor commits it before another editor of the same note saves. Idle siblings reload from IDB; the active editor stays put.

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap 3 (ProseMirror), IndexedDB (`idb`), vitest + @testing-library/svelte, `fake-indexeddb`.

---

## Background: root cause (verified against the code)

`updateNoteFromEditor` (`app/src/lib/core/noteManager.ts:127`) persists via `putNote` and pushes to Firestore via `notifyNoteSaved`, but only calls `emitNoteReload(affected)` for **rename-affected OTHER notes** (`:183-187`); `rewriteBacklinksForRename` explicitly filters out `selfGuid` (`:261`). So a save to guid X never notifies a sibling editor of X. Each sibling keeps its stale in-memory ProseMirror doc and re-clobbers on its own next debounced flush (`updateNoteFromEditor` serializes the **whole** doc — no merge). The bus is `Map<guid, Set<fn>>` with no per-instance identity (`app/src/lib/core/noteReloadBus.ts:27`), so a naive "self-emit on every save" would also reload the **saver** mid-typing. The fix adds the missing sender identity and the convergence emit, then layers the no-loss guards.

### Why NOT pre-save same-guid flush

The original "저장 전 형제 flush" idea (have `updateNoteFromEditor` call `emitNoteFlush([guid], {except})` before `putNote`) is unsafe and ineffective for the **same** guid: (1) flushing a sibling re-enters `updateNoteFromEditor` for the same guid → recursive emit, and (2) the saver already read the note at function entry (`:128`) and serializes its **own** editor doc, so it overwrites whatever the sibling just flushed anyway — last-write-wins is unchanged. The sound realization of "no lost keystrokes in one tab" is **flush-on-blur** (guarantees at most one editor of a guid is dirty at a time) + the **focus/dirty guard** (never reload the editor you're in). That is what Tasks 4 and 5 implement. The existing cross-**guid** flush bus (rename sweep, `noteManager.ts:271`) is correct and stays untouched.

## File structure (what each task touches)

| File | Responsibility | Tasks |
|---|---|---|
| `app/src/lib/core/noteReloadBus.ts` | reload/flush bus; gains per-subscriber token + `except` | 1 |
| `app/src/lib/core/noteManager.ts` | `updateNoteFromEditor` self-emit on every write | 2 |
| `app/src/routes/note/[id]/+page.svelte` | mobile host: token, guard, flush-on-blur | 3,4,5 |
| `app/src/lib/desktop/NoteWindow.svelte` | desktop host: token, guard, flush-on-blur, drop redundant setContent | 3,4,5,6 |
| `app/src/lib/editor/noteBundle/NoteBundleCabinet.svelte` | bundle host (펼침): per-session token, guard, flush-on-blur | 3,4,5 |
| `app/src/lib/editor/noteBundle/NoteBundleStack.svelte` | bundle host (스택): per-session token, guard, flush-on-blur | 3,4,5 |
| `app/src/lib/editor/TomboyEditor.svelte` | `onblur` prop; atom-aware caret preserve on same-guid reload | 5,6 |
| `app/src/lib/automation/applyDataNoteCsv.ts`, `applyChartNote.ts` | drop now-redundant explicit `emitNoteReload` | 7 |
| `app/src/routes/settings/+page.svelte` | guide card documenting the behavior | 7 |

---

### Task 1: Bus sender identity (`token` + `except`)

**Goal:** `subscribeNoteReload` accepts an optional per-subscriber token; `emitNoteReload` accepts `{ except }` and skips the listener whose token matches — backward compatible for all existing token-less callers.

**Files:**
- Modify: `app/src/lib/core/noteReloadBus.ts:25-73`
- Test: `app/tests/unit/core/noteReloadBus.test.ts`

**Acceptance Criteria:**
- [ ] `subscribeNoteReload(guid, fn)` (2-arg) and `emitNoteReload(guids)` (1-arg) behave exactly as before.
- [ ] `subscribeNoteReload(guid, fn, token)` + `emitNoteReload([guid], { except: token })` does NOT call that listener, but DOES call other listeners of the same guid (even token-less ones).
- [ ] `emitNoteReload([guid], { except: undefined })` calls every listener (undefined never excludes).
- [ ] `subscribeNoteFlush` / `emitNoteFlush` are unchanged.

**Verify:** `cd app && npm run test -- noteReloadBus` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing tests** — append to `app/tests/unit/core/noteReloadBus.test.ts` inside `describe('noteReloadBus', …)`:

```ts
	it('excludes only the listener whose token matches `except`', async () => {
		const saver = vi.fn();
		const sibling = vi.fn();
		const tokenSaver = {};
		const tokenSibling = {};
		subscribeNoteReload('A', saver, tokenSaver);
		subscribeNoteReload('A', sibling, tokenSibling);
		await emitNoteReload(['A'], { except: tokenSaver });
		expect(saver).not.toHaveBeenCalled();
		expect(sibling).toHaveBeenCalledTimes(1);
	});

	it('except=undefined excludes nobody (back-compat)', async () => {
		const fn = vi.fn();
		subscribeNoteReload('A', fn, {});
		await emitNoteReload(['A'], { except: undefined });
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('a token-less listener is never excluded', async () => {
		const fn = vi.fn();
		subscribeNoteReload('A', fn); // no token
		await emitNoteReload(['A'], { except: {} });
		expect(fn).toHaveBeenCalledTimes(1);
	});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npm run test -- noteReloadBus`
Expected: the 3 new tests FAIL (`emitNoteReload` ignores the 2nd arg today).

- [ ] **Step 3: Implement** — replace the reload half of `app/src/lib/core/noteReloadBus.ts` (lines 25-73, the `ReloadListener` type through the end of `emitNoteReload`; leave the flush half below untouched):

```ts
type ReloadListener = () => void | Promise<void>;

/** A subscriber + the token identifying which editor instance owns it. */
interface ReloadEntry {
	fn: ReloadListener;
	token: unknown;
}

const listeners = new Map<string, Set<ReloadEntry>>();
const flushListeners = new Map<string, Set<ReloadListener>>();

/**
 * Register `fn` to be invoked when `emitNoteReload(guids)` contains `guid`.
 * `token` (optional) identifies the editor instance so a save by THAT instance
 * can exclude itself via `emitNoteReload(guids, { except: token })`. Returns an
 * unsubscribe function. Idempotent: calling it more than once is a no-op.
 */
export function subscribeNoteReload(
	guid: string,
	fn: ReloadListener,
	token?: unknown
): () => void {
	let set = listeners.get(guid);
	if (!set) {
		set = new Set();
		listeners.set(guid, set);
	}
	const entry: ReloadEntry = { fn, token };
	set.add(entry);
	return () => {
		const s = listeners.get(guid);
		if (!s) return;
		s.delete(entry);
		if (s.size === 0) listeners.delete(guid);
	};
}

export interface EmitReloadOptions {
	/** Skip the listener whose token === except. Undefined excludes nobody. */
	except?: unknown;
}

/**
 * Fire every listener registered for each guid in `guids`, except the one whose
 * token matches `opts.except` (the editor that just saved — so it isn't reloaded
 * out from under the user's cursor). Per-listener errors are swallowed so one
 * broken subscriber never stalls the batch. Resolves once every listener
 * (sync or async) has settled.
 */
export async function emitNoteReload(
	guids: Iterable<string>,
	opts?: EmitReloadOptions
): Promise<void> {
	const except = opts?.except;
	const tasks: Array<Promise<void>> = [];
	for (const guid of guids) {
		const set = listeners.get(guid);
		if (!set) continue;
		// Snapshot so a listener that unsubscribes during emit doesn't mutate
		// the set we're iterating.
		for (const entry of Array.from(set)) {
			if (except !== undefined && entry.token === except) continue;
			tasks.push(
				(async () => {
					await entry.fn();
				})().catch(() => {
					/* swallowed — one broken subscriber must not stall the batch */
				})
			);
		}
	}
	await Promise.all(tasks);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd app && npm run test -- noteReloadBus && npm run check`
Expected: all bus tests PASS; svelte-check clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/core/noteReloadBus.ts app/tests/unit/core/noteReloadBus.test.ts
git commit -m "feat(noteReloadBus): per-subscriber token + emitNoteReload except option"
```

---

### Task 2: `updateNoteFromEditor` self-emit on every write

**Goal:** Every successful editor save fires `emitNoteReload([guid], { except: sourceToken })` so sibling editors of the same guid converge, while the saver excludes itself. The rename `affected` emit stays a separate, unchanged call.

**Files:**
- Modify: `app/src/lib/core/noteManager.ts:127` (signature) and `:175-176` (insert self-emit)
- Test: `app/tests/unit/noteManager.renameRewrite.test.ts`

**Acceptance Criteria:**
- [ ] `updateNoteFromEditor(guid, doc, sourceToken?)` accepts an optional 3rd arg, default `undefined`.
- [ ] On any real write (after `putNote`/`noteMutated`) it calls `emitNoteReload([guid], { except: sourceToken })` exactly once.
- [ ] The no-op-skip (`:140`) and title-conflict (`:156`) early returns still fire NO emit.
- [ ] The rename branch still calls `emitNoteReload(affected)` (without self) as a separate call.
- [ ] `renameNote` (`:235`) is unchanged.

**Verify:** `cd app && npm run test -- noteManager.renameRewrite` → all pass.

**Steps:**

- [ ] **Step 1: Update the signature** — `app/src/lib/core/noteManager.ts:127`:

```ts
export async function updateNoteFromEditor(
	guid: string,
	doc: JSONContent,
	sourceToken?: unknown
): Promise<NoteData | undefined> {
```

- [ ] **Step 2: Insert the self-emit** — immediately AFTER `noteMutated(note);` (currently `:175`) and BEFORE the `if (titleChanged) {` block (`:176`):

```ts
	noteMutated(note);
	// Same-note convergence: tell every OTHER live editor of THIS guid (host
	// page, desktop window, note-bundle leaf) to drop its stale in-memory doc
	// and reload from IDB. `except` skips the editor that just saved so its own
	// caret isn't yanked. Kept SEPARATE from the rename `affected` emit below so
	// the rename sweep's self-exclusion contract (it must never emit the renamed
	// guid) stays intact.
	await emitNoteReload([guid], { except: sourceToken });
	if (titleChanged) {
```

(Leave the body of the `if (titleChanged)` block — including `await emitNoteReload(affected);` at the old `:186` — exactly as-is.)

- [ ] **Step 3: Update `noteManager.renameRewrite.test.ts`** — the self-emit adds one leading `emitNoteReload(['A'], …)` call to every write path. Apply these exact edits:

Test `'rewrites <link:internal>Foo</link:internal> … and emits reload'` — replace the `emitNoteReload` assertion block (currently lines ~176-181, the `toHaveBeenCalledTimes(1)` / `{B,C}` / `not.toContain('A')`) with:

```ts
		// First emit = same-note convergence for the saved guid (A); second =
		// the backlink targets (B, C), which never include the renamed self.
		expect(emitNoteReloadSpy).toHaveBeenCalledTimes(2);
		expect(Array.from(emitNoteReloadSpy.mock.calls[0]![0] as Iterable<string>)).toEqual(['A']);
		const emittedArr = Array.from(emitNoteReloadSpy.mock.calls[1]![0] as Iterable<string>);
		expect(new Set(emittedArr)).toEqual(new Set(['B', 'C']));
		expect(emittedArr).not.toContain('A');
```

Test `'rewrites <link:broken>Foo</link:broken> references too'` — replace lines ~213-217:

```ts
		expect(emitNoteReloadSpy).toHaveBeenCalledTimes(2);
		expect(Array.from(emitNoteReloadSpy.mock.calls[0]![0] as Iterable<string>)).toEqual(['A']);
		const emittedArr = Array.from(emitNoteReloadSpy.mock.calls[1]![0] as Iterable<string>);
		expect(emittedArr).toEqual(['D']);
```

Test `'does not rewrite or emit when no note references the old title'` — replace the final assertion (`:246`):

```ts
		// Self-convergence still fires for the renamed note itself (A); no
		// backlink emit because nothing referenced the old title.
		expect(emitNoteReloadSpy).toHaveBeenCalledTimes(1);
		expect(Array.from(emitNoteReloadSpy.mock.calls[0]![0] as Iterable<string>)).toEqual(['A']);
```

Test `'does not rewrite when the new title equals the old title'` — this is a real body-only write (title stays "Foo"), so it now self-emits. Replace `:272`:

```ts
		// Body-only edit still self-emits convergence for A; B untouched.
		expect(emitNoteReloadSpy).toHaveBeenCalledTimes(1);
		expect(Array.from(emitNoteReloadSpy.mock.calls[0]![0] as Iterable<string>)).toEqual(['A']);
		expect(store.get('B')!.xmlContent).toBe(B.xmlContent);
```

Test `'self-excludes: renaming A never rewrites A itself …'` — the self-emit `['A']` is now expected (it is the convergence call, carrying `except`); the invariant that survives is "A is never PUT twice". Replace lines ~327-333:

```ts
		// The only emit is the self-convergence call for A; there is no extra
		// backlink emit re-adding A. (The real exclusion of the SAVER happens
		// via the `except` token at the bus, not by A's absence here.)
		expect(emitNoteReloadSpy).toHaveBeenCalledTimes(1);
		expect(Array.from(emitNoteReloadSpy.mock.calls[0]![0] as Iterable<string>)).toEqual(['A']);
```

Tests `'does NOT rewrite when the title-conflict guard rejects the save'` (`:305`, asserts NOT called) and `'skips deleted notes …'` (`:373`, guards on `calls.length > 0`) need **no change**: the conflict test returns before any write, and the deleted-note test's `calls[0]` is `['A']` which does not contain `'F'`.

- [ ] **Step 4: Run to verify pass**

Run: `cd app && npm run test -- noteManager.renameRewrite && npm run check`
Expected: all PASS; svelte-check clean. (The mock at `:54-60` forwards only `guids`; the new `opts` arg is ignored by the spy, which is fine — assertions check guids only.)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/core/noteManager.ts app/tests/unit/noteManager.renameRewrite.test.ts
git commit -m "feat(noteManager): self-emit reload for the saved guid (except the saving editor)"
```

---

### Task 3: Thread a per-instance token through the four hosts

**Goal:** Each editor host owns a stable token, passes it when subscribing AND when saving, so it excludes itself from its own convergence emit while every other editor of that guid reloads.

**Files:**
- Modify: `app/src/routes/note/[id]/+page.svelte` (`:137` area, `:219`, `:413`)
- Modify: `app/src/lib/desktop/NoteWindow.svelte` (`:153` area, `:352`, `:435`)
- Modify: `app/src/lib/editor/noteBundle/NoteBundleCabinet.svelte` (`:307-323`, `:339`, `:369`, `:393-405`)
- Modify: `app/src/lib/editor/noteBundle/NoteBundleStack.svelte` (same regions: `:314-326`, `:342`, `:371`, `:394-406`)

**Acceptance Criteria:**
- [ ] Each host declares one stable token (object identity) per editor instance/session.
- [ ] The token is passed as the 3rd arg to `subscribeNoteReload`.
- [ ] The token is passed as the 3rd arg to `updateNoteFromEditor` in that host's flush path.
- [ ] In the bundles the token is per-session and survives the `{ ...s }` session-object replacement in `handleEmbeddedChange`.

**Verify:** `cd app && npm run check` → no type errors. (Behavior verified in Task 7.)

**Steps:**

- [ ] **Step 1: `+page.svelte`** — declare the token near the other editor state (after `let pendingDoc … = $state.raw(null);` at `:137`):

```ts
	// Stable identity for THIS page's editor on the reload bus, so its own
	// save-convergence emit excludes itself (other editors of the same guid
	// still reload). One token for the page instance — it persists across note
	// navigations because the editor is reused (no {#key noteId}).
	const reloadToken = {};
```

Pass it when subscribing — `:219`:

```ts
		const off = subscribeNoteReload(g, async () => {
```
becomes (token as 3rd arg on the `subscribeNoteReload` call — change only the closing `);` of this call at `:241` to include the token):
```ts
		const off = subscribeNoteReload(
			g,
			async () => {
				/* …existing handler body unchanged… */
			},
			reloadToken
		);
```

Pass it when saving — `:413`:

```ts
			const updated = await updateNoteFromEditor(note.guid, pendingDoc, reloadToken);
```

- [ ] **Step 2: `NoteWindow.svelte`** — declare near `:153`:

```ts
	const reloadToken = {};
```

Subscribe — `:352`, add `reloadToken` as the 3rd arg to `subscribeNoteReload(g, async () => { await externalReload(); }, reloadToken)`.

Save — `:435`:

```ts
			const updated = await updateNoteFromEditor(note.guid, pendingDoc, reloadToken);
```

- [ ] **Step 3: `NoteBundleCabinet.svelte`** — add a token field to the session interface (`:307-323`):

```ts
	interface EditorSession {
		guid: string;
		content: JSONContent;
		/** Last-known xml of this note — reload no-op guard (Task 4). */
		xmlContent: string;
		/** Stable reload-bus identity for THIS leaf (Task 3). */
		reloadToken: object;
		createDate: string | null;
		pendingDoc: JSONContent | null;
		saveTimer: ReturnType<typeof setTimeout> | null;
		offReload: () => void;
		offFlush: () => void;
		termSpec: TerminalNoteSpec | null;
		termConnect: boolean;
		scrollBottom: boolean;
		isMusic: boolean;
	}
```

In `flushSession` (`:339`) pass the token:

```ts
		try {
			await updateNoteFromEditor(guid, docJson, s.reloadToken);
		} catch (err) {
```

In `loadSession` (`:362`) create the token in the closure and use it in `subscribeNoteReload` + the initial `sessions.set`:

```ts
	async function loadSession(guid: string) {
		if (sessions.has(guid) || loading.has(guid)) return;
		loading.add(guid);
		try {
			const [note, scrollBottom] = await Promise.all([getNote(guid), isScrollBottomNote(guid)]);
			if (!note || destroyed || sessions.has(guid)) return;
			attachOpenNote(guid);
			const reloadToken = {};
			const offReload = subscribeNoteReload(
				guid,
				async () => {
					/* …existing handler body — updated in Task 4… */
				},
				reloadToken
			);
			const offFlush = subscribeNoteFlush(guid, () => flushSession(guid));
			const content = getNoteEditorContent(note);
			sessions.set(guid, {
				guid,
				content,
				xmlContent: note.xmlContent,
				reloadToken,
				createDate: note.createDate ?? null,
				pendingDoc: null,
				saveTimer: null,
				offReload,
				offFlush,
				termSpec: parseTerminalNote(content),
				termConnect: false,
				scrollBottom,
				isMusic: isMusicNoteDoc(content)
			});
		} finally {
			loading.delete(guid);
		}
	}
```

(The `{ ...s }` spreads in `handleEmbeddedChange:358` and `setTermConnect:414` automatically carry `reloadToken` and `xmlContent` forward — no change needed there.)

- [ ] **Step 4: `NoteBundleStack.svelte`** — apply the identical edits to its `EditorSession` interface (`:314-326`), `flushSession` (`:342`), and `loadSession` (`:364-406`). The code is byte-identical to Cabinet's — repeat it here rather than referencing Task 3 Step 3:

`EditorSession` gains `xmlContent: string;` and `reloadToken: object;`. `flushSession`:

```ts
		try {
			await updateNoteFromEditor(guid, docJson, s.reloadToken);
		} catch (err) {
```

`loadSession` creates `const reloadToken = {};`, passes it as the 3rd arg to `subscribeNoteReload`, and the initial `sessions.set` includes `xmlContent: note.xmlContent,` and `reloadToken,`.

- [ ] **Step 5: Verify + commit**

Run: `cd app && npm run check`
Expected: no type errors.

```bash
git add app/src/routes/note/\[id\]/+page.svelte app/src/lib/desktop/NoteWindow.svelte app/src/lib/editor/noteBundle/NoteBundleCabinet.svelte app/src/lib/editor/noteBundle/NoteBundleStack.svelte
git commit -m "feat(editor): per-instance reload token in all four note-editor hosts"
```

---

### Task 4: Reload-handler guards (xml-equality + focus/dirty)

**Goal:** Every reload handler (a) no-ops when the fresh IDB xml equals what it already shows, and (b) skips reload when its own editor is focused AND has unsaved edits — so the editor the user is typing in is never reloaded out from under them.

**Files:**
- Modify: `app/src/routes/note/[id]/+page.svelte:219-241` (add focus guard; xml guard already present at `:229`)
- Modify: `app/src/lib/desktop/NoteWindow.svelte:513-543` (add xml guard to `reloadFromIdb`, focus guard to `externalReload`)
- Modify: `app/src/lib/editor/noteBundle/NoteBundleCabinet.svelte:369-390` (add both guards; track `xmlContent`)
- Modify: `app/src/lib/editor/noteBundle/NoteBundleStack.svelte:371-391` (same)

**Acceptance Criteria:**
- [ ] A reload whose fresh xml equals the currently-shown xml performs no content swap, in all four hosts.
- [ ] A reload is skipped when `getEditor()?.isFocused` is true AND a `pendingDoc` is held, in all four hosts.
- [ ] The bundle sessions store and update `xmlContent` so their guard has something to compare.

**Verify:** `cd app && npm run check` → clean. (Behavior covered by Task 7.)

**Steps:**

- [ ] **Step 1: `+page.svelte`** — at the top of the reload handler body (just inside the `async () => {` opened in Task 3, before `if (saveTimer)` at `:222`):

```ts
				// Don't yank an editor the user is actively typing in. flush-on-blur
				// (Task 5) keeps only the focused editor dirty, so idle siblings
				// still reload and converge.
				const ed = editorComponent?.getEditor?.();
				if (ed?.isFocused && pendingDoc) return;
```

(The xml-equality guard already exists at `:229` — `if (fresh.xmlContent === note?.xmlContent) return;`.)

- [ ] **Step 2: `NoteWindow.svelte`** — add the focus guard at the top of `externalReload` (`:536`) and an xml-equality guard inside `reloadFromIdb` (`:513`):

```ts
	async function reloadFromIdb(): Promise<void> {
		if (!note) return;
		const fresh = await getNote(note.guid);
		if (!fresh) return;
		if (fresh.xmlContent === note.xmlContent) return; // no-op: nothing changed
		note = fresh;
		editorContent = getNoteEditorContent(fresh);
		isMusic = isMusicNoteDoc(editorContent as JSONContent);
		terminalSpec = parseTerminalNote(editorContent);
		if (!terminalSpec) terminalConnectMode = false;
		keysSpec = parseKeysNote(editorContent);
		if (!keysSpec) keysConnectMode = false;
		lastSavedDocFingerprint = null;
		const ed = getEditor();
		if (ed && editorContent) {
			ed.commands.setContent(editorContent, { emitUpdate: false });
		}
	}

	/**
	 * Called when another window's op has rewritten this note in IDB.
	 * Cancels any pending debounced save (its doc is stale) and reloads.
	 */
	async function externalReload(): Promise<void> {
		// Actively-typed editor must not be reloaded mid-keystroke.
		const ed = getEditor();
		if (ed?.isFocused && pendingDoc) return;
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		pendingDoc = null;
		await reloadFromIdb();
	}
```

(The direct `setContent` here is removed in Task 6; leave it for now so this task is self-contained.)

- [ ] **Step 3: `NoteBundleCabinet.svelte`** — replace the reload handler body created in Task 3 (`loadSession`'s `subscribeNoteReload` callback) with the guarded version, and update `xmlContent` on reload:

```ts
			const offReload = subscribeNoteReload(
				guid,
				async () => {
					const cur = sessions.get(guid);
					// Skip when THIS leaf is focused + dirty (user is typing here).
					const ed = editorRefs[guid]?.getEditor?.();
					if (ed?.isFocused && cur?.pendingDoc) return;
					if (cur) {
						if (cur.saveTimer) {
							clearTimeout(cur.saveTimer);
							cur.saveTimer = null;
						}
						cur.pendingDoc = null;
					}
					const fresh = await getNote(guid);
					const live = sessions.get(guid);
					if (!fresh || !live) return;
					if (fresh.xmlContent === live.xmlContent) return; // no-op
					const content = getNoteEditorContent(fresh);
					sessions.set(guid, {
						...live,
						content,
						xmlContent: fresh.xmlContent,
						termSpec: parseTerminalNote(content),
						isMusic: isMusicNoteDoc(content)
					});
				},
				reloadToken
			);
```

- [ ] **Step 4: `NoteBundleStack.svelte`** — apply the identical guarded reload handler (byte-for-byte the same as Cabinet's in Step 3) inside its `loadSession`.

- [ ] **Step 5: Verify + commit**

Run: `cd app && npm run check`

```bash
git add app/src/routes/note/\[id\]/+page.svelte app/src/lib/desktop/NoteWindow.svelte app/src/lib/editor/noteBundle/NoteBundleCabinet.svelte app/src/lib/editor/noteBundle/NoteBundleStack.svelte
git commit -m "feat(editor): no-op + focus/dirty guards on every same-note reload handler"
```

---

### Task 5: Flush-on-blur (the no-loss guarantee)

**Goal:** When an editor loses focus, it flushes its pending edit to IDB immediately. This guarantees at most one editor of a given guid is ever dirty at a time, so a sibling's save never overwrites unsaved keystrokes — the "무손실" guarantee the user chose.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte:458-805` (add `onblur` prop + wire `onBlur`)
- Modify: `app/src/routes/note/[id]/+page.svelte:834` (TomboyEditor usage)
- Modify: `app/src/lib/desktop/NoteWindow.svelte:963` (TomboyEditor usage)
- Modify: `app/src/lib/editor/noteBundle/NoteBundleCabinet.svelte:768` (embedded editor usage)
- Modify: `app/src/lib/editor/noteBundle/NoteBundleStack.svelte:748` (embedded editor usage)

**Acceptance Criteria:**
- [ ] `TomboyEditor` exposes an `onblur?: () => void` prop, fired from the ProseMirror editor's `blur` event.
- [ ] Each host wires `onblur` to its flush function (`flushSave` / `flushSession(guid)`).
- [ ] No regression: blurring an unchanged editor is a no-op (absorbed by `updateNoteFromEditor`'s byte-equality skip at `noteManager.ts:140`).

**Verify:** `cd app && npm run check`; manual — type in a bundle leaf, click into the host page view of the same note, confirm the leaf's text is present (saved on blur).

**Steps:**

- [ ] **Step 1: Add the prop** — in `TomboyEditor.svelte`, add to the `Props` block (near `onchange?` at `:158`):

```ts
		onchange?: (doc: JSONContent) => void;
		/** Fired when the editor loses focus — hosts flush pending edits here so
		 *  leaving an editor commits it before another view of the same note saves. */
		onblur?: () => void;
```

and to the destructure (near `onchange,` at `:260`):

```ts
		onchange,
		onblur,
```

- [ ] **Step 2: Wire the editor's blur** — in the `new Editor({ … })` config (`:458`), add an `onBlur` callback alongside `onUpdate` (`:789`):

```ts
			onBlur: () => {
				onblur?.();
			},
```

- [ ] **Step 3: Wire each host** — `+page.svelte:834` `<TomboyEditor … onchange={handleEditorChange}` gains:

```svelte
				onchange={handleEditorChange}
				onblur={() => { void flushSave(); }}
```

`NoteWindow.svelte:963`:

```svelte
				onchange={handleEditorChange}
				onblur={() => { void flushSave(); }}
```

`NoteBundleCabinet.svelte:768-770` (the embedded `<EditorComponent>` — note the inline `session.guid`):

```svelte
							onchange={(doc: JSONContent) => handleEmbeddedChange(session.guid, doc)}
							onblur={() => { void flushSession(session.guid); }}
```

`NoteBundleStack.svelte:748-750`: same `onblur={() => { void flushSession(session.guid); }}`.

- [ ] **Step 4: Verify + commit**

Run: `cd app && npm run check`

```bash
git add app/src/lib/editor/TomboyEditor.svelte app/src/routes/note/\[id\]/+page.svelte app/src/lib/desktop/NoteWindow.svelte app/src/lib/editor/noteBundle/NoteBundleCabinet.svelte app/src/lib/editor/noteBundle/NoteBundleStack.svelte
git commit -m "feat(editor): flush-on-blur so leaving an editor commits before a sibling saves"
```

---

### Task 6: Atom-aware caret preservation on same-guid reload

**Goal:** When an editor reloads the **same** note's newer content (a sibling saved), keep the caret/selection where it was instead of snapping to the document start. Restoration is atom-aware so it never lands inside an `inlineCheckbox` / footnote / radio node. Note navigation (different guid) is unaffected.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte:1213-1306` (content-swap `$effect`) + the `@tiptap/pm/state` import
- Modify: `app/src/lib/desktop/NoteWindow.svelte:525-528` (remove redundant direct `setContent`, rely on the content-prop effect)
- Test: `app/tests/unit/editor/reloadCaretPreserve.test.ts` (new)

**Acceptance Criteria:**
- [ ] On a same-guid content swap, the prior selection's `from`/`to` are restored, clamped to the new doc and snapped past atom boundaries.
- [ ] On a different-guid swap (navigation) the caret follows the existing new-note intent (no preservation).
- [ ] If the new doc shape diverges enough that restore throws, the caret falls back to default with no error.
- [ ] `NoteWindow.reloadFromIdb` no longer calls `setContent` directly; the swap happens once via the `content` prop effect.

**Verify:** `cd app && npm run test -- reloadCaretPreserve && npm run check`

**Steps:**

- [ ] **Step 1: Write the failing test** — create `app/tests/unit/editor/reloadCaretPreserve.test.ts`. It exercises the pure restore helper extracted in Step 2 against a real ProseMirror doc:

```ts
import { describe, it, expect } from 'vitest';
import { EditorState } from '@tiptap/pm/state';
import { schema as basicSchema } from '@tiptap/pm/schema-basic';
import { restoreSelectionClamped } from '$lib/editor/restoreSelection.js';

function docState(text: string): EditorState {
	const doc = basicSchema.node('doc', null, [
		basicSchema.node('paragraph', null, text ? [basicSchema.text(text)] : [])
	]);
	return EditorState.create({ schema: basicSchema, doc });
}

describe('restoreSelectionClamped', () => {
	it('restores an in-range caret position', () => {
		const st = docState('hello world');
		const tr = restoreSelectionClamped(st, { from: 4, to: 4 });
		expect(tr).not.toBeNull();
		expect(tr!.selection.from).toBe(4);
	});

	it('clamps a past-end position to the new doc size', () => {
		const st = docState('hi'); // doc size smaller than saved offset
		const tr = restoreSelectionClamped(st, { from: 999, to: 999 });
		expect(tr).not.toBeNull();
		expect(tr!.selection.from).toBeLessThanOrEqual(st.doc.content.size);
	});

	it('never throws on an empty doc', () => {
		const st = docState('');
		expect(() => restoreSelectionClamped(st, { from: 0, to: 0 })).not.toThrow();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npm run test -- reloadCaretPreserve`
Expected: FAIL — `restoreSelection.js` does not exist.

- [ ] **Step 3: Implement the helper** — create `app/src/lib/editor/restoreSelection.ts`:

```ts
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

export interface SavedSelection {
	from: number;
	to: number;
}

/**
 * Build a transaction that restores `saved` selection onto `state`'s (already
 * swapped) document, clamped to the doc size and snapped to valid positions via
 * TextSelection.between's bias so it never lands inside an atom node
 * (inlineCheckbox / footnote / radio). Returns null if no sensible selection can
 * be made (caller then leaves the default caret). Never throws.
 */
export function restoreSelectionClamped(
	state: EditorState,
	saved: SavedSelection
): Transaction | null {
	try {
		const size = state.doc.content.size;
		const from = Math.max(0, Math.min(saved.from, size));
		const to = Math.max(from, Math.min(saved.to, size));
		const sel = TextSelection.between(state.doc.resolve(from), state.doc.resolve(to), 1);
		return state.tr.setSelection(sel).setMeta('addToHistory', false);
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Wire it into the content-swap effect** — in `TomboyEditor.svelte`, add the import near the other pm/state imports:

```ts
import { restoreSelectionClamped } from "$lib/editor/restoreSelection.js";
```

Then in the `$effect` at `:1213`, capture same-guid BEFORE the `lastAppliedGuid` reassignment and restore after `setContent`. Replace the block from `if (c === lastAppliedContent && g === lastAppliedGuid) return;` (`:1246`) through `ed.commands.setContent(docContent, { emitUpdate: false });` (`:1280`) with:

```ts
		if (c === lastAppliedContent && g === lastAppliedGuid) return;
		// Same guid + new content = a sibling-save reload of THIS note. Preserve
		// the caret across the swap; a different guid is a navigation, where the
		// new-note intent positions the caret instead.
		const sameNoteReload = g === lastAppliedGuid;
		const savedSel =
			sameNoteReload && !ed.isDestroyed
				? { from: ed.state.selection.from, to: ed.state.selection.to }
				: null;
		lastAppliedContent = c;
		lastAppliedGuid = g;

		const docContent = c ?? {
			type: "doc",
			content: [{ type: "paragraph" }],
		};
		// Reseed HR split + fold state for the freshly loaded note BEFORE
		// swapping the doc. (unchanged block)
		{
			const persistedWidths = loadColumnWidths(g);
			ed.view.dispatch(
				ed.state.tr.setMeta(hrSplitPluginKey, {
					replace: Array.from(loadActiveOrdinals(g)),
					...(persistedWidths ? { widths: persistedWidths } : {}),
				}),
			);
			ed.view.dispatch(
				ed.state.tr.setMeta(hrFoldPluginKey, {
					replace: Array.from(loadFoldedOrdinals(g)),
				}),
			);
		}
		ed.commands.setContent(docContent, { emitUpdate: false });
		if (savedSel) {
			const tr = restoreSelectionClamped(ed.state, savedSel);
			if (tr) ed.view.dispatch(tr);
		}
```

(Leave everything after `setContent` — the autoLink clearDirty dispatch, autoWeekday, find-close, `applyNewNoteIntent`, `onnoteready` — unchanged. `applyNewNoteIntent` is a no-op when there's no pending new-note intent, so it won't fight the restored caret on a reload.)

- [ ] **Step 5: Remove NoteWindow's redundant setContent** — in `reloadFromIdb` (`:525-528`), delete the direct call so the swap happens once via the `content` prop effect (which now preserves the caret):

```ts
		lastSavedDocFingerprint = null;
	}
```

(i.e. drop the `const ed = getEditor(); if (ed && editorContent) { ed.commands.setContent(...); }` lines.)

- [ ] **Step 6: Run to verify pass**

Run: `cd app && npm run test -- reloadCaretPreserve && npm run check`
Expected: PASS; svelte-check clean.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/editor/restoreSelection.ts app/tests/unit/editor/reloadCaretPreserve.test.ts app/src/lib/editor/TomboyEditor.svelte app/src/lib/desktop/NoteWindow.svelte
git commit -m "feat(editor): atom-aware caret preservation on same-note reload"
```

---

### Task 7: Audit token-less callers, de-dupe automation emits, integration test, guide card

**Goal:** Confirm every non-editor `emitNoteReload` caller stays byte-identical, drop the now-redundant explicit emits in the two automation appliers, add an end-to-end convergence test, and document the behavior in 설정 → 가이드.

**Files:**
- Modify: `app/src/lib/automation/applyDataNoteCsv.ts:45`
- Modify: `app/src/lib/automation/applyChartNote.ts:24`
- Test: `app/tests/unit/core/sameNoteConvergence.test.ts` (new)
- Modify: `app/src/routes/settings/+page.svelte` (guide card, `guideSubTab: editor`)

**Acceptance Criteria:**
- [ ] The ~10 token-less `emitNoteReload(guids)` callers (terminal historyStore ×5, imagePromotion, orchestrator Firebase pull, syncManager ×3, plus `noteManager` internal ×2) are unchanged and still compile (optional 2nd arg).
- [ ] `applyDataNoteCsv` and `applyChartNote` no longer call `emitNoteReload` explicitly (the `updateNoteFromEditor` self-emit covers the bus; `desktopSession.reloadWindows` stays for the desktop session channel).
- [ ] Integration test: two subscribers for one guid with distinct tokens; `updateNoteFromEditor(guid, doc, tokenA)` fires subscriber B, not subscriber A, and IDB holds the new doc.
- [ ] A guide card under the editor sub-tab explains that editing a note open in multiple places (bundle leaf / page / window) now stays in sync.

**Verify:** `cd app && npm run test -- sameNoteConvergence && npm run check`

**Steps:**

- [ ] **Step 1: Audit (read-only)** — confirm each of these calls `emitNoteReload` with a single argument (so the new optional `opts` is harmless): `app/src/lib/editor/terminal/historyStore.ts:122,158,183,539,569`; `app/src/lib/sync/imagePromotion.ts:108`; `app/src/lib/sync/firebase/orchestrator.ts:280`; `app/src/lib/sync/syncManager.ts:777,805,855`. No edits — they intentionally reload ALL editors (no token).

- [ ] **Step 2: Drop the redundant automation emits** — `applyDataNoteCsv.ts:42-46`:

```ts
	const newDoc = buildUpdatedDoc(getNoteEditorContent(note), csv);
	await updateNoteFromEditor(note.guid, newDoc);
	// updateNoteFromEditor now self-emits the bus reload for this guid; we only
	// still need the desktop session channel for open NoteWindows.
	await desktopSession.reloadWindows([note.guid]);
	return outcome;
```

`applyChartNote.ts:22-25`:

```ts
	const note = await createNote(opts.noteTitle);
	await updateNoteFromEditor(note.guid, buildChartNoteDoc(opts));
	// Self-emit covers the bus; keep the desktop session reload for windows.
	await desktopSession.reloadWindows([note.guid]);
	return 'created';
```

(Remove the now-unused `emitNoteReload` import from each file if it has no other use — `npm run check` will flag it.)

- [ ] **Step 3: Write the integration test** — create `app/tests/unit/core/sameNoteConvergence.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import * as noteStore from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';
import { updateNoteFromEditor } from '$lib/core/noteManager.js';
import {
	subscribeNoteReload,
	_resetForTest as resetBus
} from '$lib/core/noteReloadBus.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';

// Firebase + schedule hooks are no-ops here; stub to keep the test offline.
vi.mock('$lib/sync/firebase/orchestrator.js', () => ({ notifyNoteSaved: vi.fn() }));
vi.mock('$lib/schedule/syncSchedule.js', () => ({
	syncScheduleFromNote: vi.fn(async () => ({ isScheduleNote: false, added: 0, removed: 0 }))
}));
vi.mock('$lib/schedule/flushScheduler.js', () => ({ flushIfEnabled: vi.fn(async () => {}) }));

beforeEach(() => {
	resetBus();
});

describe('same-note convergence', () => {
	it('reloads sibling editors of the same guid, excludes the saver', async () => {
		const note = createEmptyNote('G');
		note.title = 'Hello';
		note.xmlContent = '<note-content version="0.1">Hello\n\nbody</note-content>';
		await noteStore.putNote(note);

		const tokenA = {}; // the saving editor
		const tokenB = {}; // a sibling editor
		const reloadedA = vi.fn();
		const reloadedB = vi.fn();
		subscribeNoteReload('G', reloadedA, tokenA);
		subscribeNoteReload('G', reloadedB, tokenB);

		const newDoc = deserializeContent('<note-content version="0.1">Hello\n\nedited body</note-content>');
		await updateNoteFromEditor('G', newDoc, tokenA);

		expect(reloadedA).not.toHaveBeenCalled(); // saver excluded
		expect(reloadedB).toHaveBeenCalledTimes(1); // sibling converges
		const stored = await noteStore.getNote('G');
		expect(stored!.xmlContent).toContain('edited body');
	});
});
```

- [ ] **Step 4: Run to verify pass**

Run: `cd app && npm run test -- sameNoteConvergence`
Expected: PASS.

- [ ] **Step 5: Add the guide card** — in `app/src/routes/settings/+page.svelte`, find the `guideSubTab === 'editor'` section and append a `<details class="guide-card">` mirroring the existing pattern:

```svelte
				<details class="guide-card">
					<summary>같은 노트를 여러 곳에서 열어도 동기화</summary>
					<p class="info-text">
						한 노트를 노트 묶음 안과 노트 페이지(또는 데스크탑 창)에서 동시에 열어두고
						한쪽에서 편집하면, 잠시 뒤 다른 쪽도 자동으로 같은 내용으로 맞춰집니다.
					</p>
					<ul class="guide-list">
						<li>입력 중인 편집기는 바뀌지 않습니다 — 보고만 있던 쪽이 따라옵니다.</li>
						<li>편집기에서 포커스를 벗어나면(다른 곳 클릭) 그 즉시 저장되므로, 동시에 다른 곳에서 저장돼도 입력 내용이 사라지지 않습니다.</li>
						<li>커서 위치는 가능한 한 유지됩니다.</li>
					</ul>
				</details>
```

- [ ] **Step 6: Full suite + commit**

Run: `cd app && npm run test && npm run check`
Expected: all green.

```bash
git add app/src/lib/automation/applyDataNoteCsv.ts app/src/lib/automation/applyChartNote.ts app/tests/unit/core/sameNoteConvergence.test.ts app/src/routes/settings/+page.svelte
git commit -m "feat: de-dupe automation reloads, same-note convergence test, guide card"
```

---

## Manual verification checklist (after all tasks)

Run `cd app && npm run dev` and verify in the browser:

1. **Bundle leaf ↔ page.** Open a note normally; open a 노트 묶음 that contains the same note as a leaf. Type in the leaf → after ~1.5s the page view shows the same text. Type in the page view → the leaf updates.
2. **No caret yank.** While typing in the leaf, confirm the leaf's caret does NOT jump when the page view autosaves (focus guard).
3. **No-loss across focus switch.** Type in the leaf, immediately click into the page view and type → confirm the leaf's text was saved (flush-on-blur), not lost.
4. **Caret preserved.** Put the page-view caret mid-paragraph; trigger a sibling save from the leaf; confirm the page caret stays near where it was (not at the top).
5. **Desktop two windows.** Open the same note in two desktop NoteWindows; edit one → the other converges.
6. **Rename still works.** Rename a note that others link to; confirm backlinks rewrite and open editors refresh (Task 2 kept the `affected` path intact).
7. **Title-blur guard.** Edit a title, blur; confirm no double-toast / cursor-snap regression (flush-on-blur + `titleUniqueGuard.handleTitleBlur` coexist; the byte-equality skip absorbs redundant flushes).

## Residual / out of scope

- **True simultaneous dual-edit** of one note from two independent input sources at the same instant still converges to last-write — impossible with a single pointer once flush-on-blur holds the single-dirty invariant, so not addressed.
- **Pre-existing desktop session bug:** `lib/desktop/session.svelte.ts:131-133` keeps `reloadHooks`/`flushHooks`/`editorRegistry` as `Map<guid>` (last-write-wins), so two NoteWindows of one guid can't both be reached via the **session** channel. This plan routes same-guid convergence through the Set-based `noteReloadBus` instead, side-stepping it; a proper fix to the session maps is a separate change.
