# 노트 드래그 → 묶음 리스트에 추가 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a desktop note's drag handle be dropped onto a 묶음 (bundle) cabinet so the dragged note is added as a new internal-link list item at the hovered bar boundary.

**Architecture:** Reuse the existing native-HTML5 drag source (`NoteDragHandle`, MIME `application/x-tomboy-note-title` = title) unchanged. `NoteBundleCabinet` (kind `bundle` only) becomes a drop target on its bars; it maps a hovered bar to a top-level structural boundary via a new parser field `srcTop`, then inserts either through a new ProseMirror plugin export (in-body 묶음, has a live `view`) or a host callback that splices the note JSON and saves (dedicated `묶음::` note, no live view). The cabinet stays view-only except for this single deliberate append.

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap 3 / ProseMirror, vitest + @testing-library, `idb`.

---

### Task 1: Parser — add `srcTop` to bundle entries

**Goal:** Every `BundleEntry` carries `srcTop`, the index of the top-level structural unit it descends from, so a flattened bar maps back to an insertion boundary.

**Files:**
- Modify: `app/src/lib/editor/noteBundle/parser.ts` (interface `BundleEntry`; `parseListInto`; `parseEntries`; `parseListIntoJson`; `parseDedicatedEntries`; `buildSyntheticBundleSpec`)
- Test: `app/tests/unit/editor/noteBundle/parser.test.ts`

**Index space (load-bearing):**
- In-body (`parseEntries`): `srcTop` = the index of the **top-level `listItem`** the entry descends from (nested children inherit the parent's index).
- Dedicated (`parseDedicatedEntries`): `srcTop` = the **absolute `doc.content` block index** of the unit start (a category textblock+list shares the textblock's index; a standalone list uses its own index; nested children inherit).
- Synthetic (`buildSyntheticBundleSpec`): `srcTop = -1` (never a drop target).

**Acceptance Criteria:**
- [ ] `BundleEntry` has `srcTop: number`.
- [ ] Flat top-level leaves get `srcTop` = their top-level listItem index.
- [ ] A multi-link line shares one `srcTop` across its links.
- [ ] Nested category children inherit the top-level item's `srcTop`.
- [ ] Dedicated entries get the absolute body-block index; `buildSyntheticBundleSpec` entries get `-1`.

**Verify:** `cd app && npx vitest run tests/unit/editor/noteBundle/parser.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Update the `ent` test helper and add failing tests**

In `parser.test.ts`, change the `ent` helper to accept `srcTop` (default 0) and add a `describe` block. The existing `link`/`li`/`liNodes`/`list`/`doc`/`kw` builders are already defined in the file.

```ts
// replace the existing `ent` helper
const ent = (title: string, category: string | null = null, srcTop = 0): BundleEntry => ({
	title,
	category,
	srcTop
});

describe('parseNoteBundles — srcTop (bundle 엔트리)', () => {
	it('최상위 잎 항목 → srcTop = 최상위 listItem 인덱스', () => {
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('묶음:50', true), list(li('A'), li('B'), li('C')))
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.entries).toEqual([ent('A', null, 0), ent('B', null, 1), ent('C', null, 2)]);
	});

	it('한 줄 다중 링크 → 같은 srcTop 공유', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('묶음:50', true),
				list(li('A'), liNodes([link('B'), txt(' '), link('C')]))
			)
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.entries).toEqual([ent('A', null, 0), ent('B', null, 1), ent('C', null, 1)]);
	});

	it('중첩 카테고리 자식 → 부모 최상위 srcTop 상속', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('묶음:50', true),
				list(li('A'), liNodes([txt('분류')], list(li('자식1'), li('자식2'))))
			)
		);
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.entries).toEqual([
			ent('A', null, 0),
			ent('자식1', '분류', 1),
			ent('자식2', '분류', 1)
		]);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run tests/unit/editor/noteBundle/parser.test.ts -t srcTop`
Expected: FAIL — `srcTop` missing on entries (existing tests using `ent` may also fail until the default `srcTop:0` matches; that is expected and fixed by the implementation).

- [ ] **Step 3: Add `srcTop` to the interface**

In `parser.ts`, the `BundleEntry` interface (currently lines ~39-44):

```ts
/** 'bundle' 평탄 엔트리 — 중첩 리스트는 category 로만 표시. */
export interface BundleEntry {
	/** tomboyInternalLink mark 의 target (= 대상 노트 제목) */
	title: string;
	/** 부모(상위 들여쓰기) 항목의 전체 타이틀 — 바에 우측정렬 표시. 없으면 null */
	category: string | null;
	/** 이 엔트리가 속한 최상위 구조 단위의 인덱스 — 드래그-드롭 삽입 경계 매핑용.
	 *  in-body=최상위 listItem 인덱스, 전용=doc.content 블록 인덱스, 합성=-1. */
	srcTop: number;
}
```

- [ ] **Step 4: Thread `topIndex` through the in-body walker**

Replace `parseListInto` and `parseEntries` (currently lines ~242-275):

```ts
function parseListInto(
	list: PMNode,
	category: string | null,
	entries: BundleEntry[],
	topIndex: number | null
): void {
	list.forEach((li, _off, idx) => {
		if (li.type.name !== 'listItem' || li.childCount === 0) return;
		// 최상위 호출이면 자기 인덱스가 srcTop, 중첩이면 부모 것 상속.
		const myTop = topIndex ?? idx;
		const para = li.child(0);
		const isPara = para.type.name === 'paragraph';
		const ownTitle = isPara ? paragraphText(para) || null : null;
		let hasNested = false;
		for (let ci = 0; ci < li.childCount; ci++) {
			const c = li.child(ci);
			if (c.type.name === 'bulletList' || c.type.name === 'orderedList') {
				hasNested = true;
				break;
			}
		}
		if (hasNested) {
			const childCategory = ownTitle ?? category;
			for (let ci = 0; ci < li.childCount; ci++) {
				const c = li.child(ci);
				if (c.type.name === 'bulletList' || c.type.name === 'orderedList') {
					parseListInto(c, childCategory, entries, myTop);
				}
			}
		} else if (isPara) {
			for (const t of collectLinks(para)) entries.push({ title: t, category, srcTop: myTop });
		}
	});
}

function parseEntries(list: PMNode): BundleEntry[] {
	const entries: BundleEntry[] = [];
	parseListInto(list, null, entries, null);
	return entries;
}
```

- [ ] **Step 5: Thread the block index through the dedicated walkers**

Replace `parseListIntoJson` (currently lines ~408-425) to accept + stamp a `topIndex`:

```ts
function parseListIntoJson(
	list: JSONNode,
	category: string | null,
	entries: BundleEntry[],
	topIndex: number
): void {
	for (const li of list.content ?? []) {
		if (li.type !== 'listItem' || !li.content?.length) continue;
		const para = li.content[0];
		const isPara = isTextblockJson(para);
		const ownTitle = isPara ? paragraphTextJson(para) || null : null;
		const hasNested = (li.content ?? []).some((c) => isListJson(c));
		if (hasNested) {
			const childCategory = ownTitle ?? category;
			for (const c of li.content) {
				if (isListJson(c)) parseListIntoJson(c, childCategory, entries, topIndex);
			}
		} else if (isPara) {
			for (const t of collectLinksJson(para)) entries.push({ title: t, category, srcTop: topIndex });
		}
	}
}
```

Replace `parseDedicatedEntries` (currently lines ~485-504) so `srcTop` = the absolute `doc.content` block index of the unit start:

```ts
function parseDedicatedEntries(doc: JSONNode, start = 1): BundleEntry[] {
	const entries: BundleEntry[] = [];
	const blocks = bodyBlocks(doc, start);
	for (let i = 0; i < blocks.length; i++) {
		const node = blocks[i];
		const blockIndex = start + i; // doc.content 의 절대 인덱스
		if (isTextblockJson(node)) {
			const next = blocks[i + 1];
			if (next && isListJson(next)) {
				parseListIntoJson(next, paragraphTextJson(node) || null, entries, blockIndex);
				i++; // 리스트 소비
			} else {
				for (const t of collectLinksJson(node))
					entries.push({ title: t, category: null, srcTop: blockIndex });
			}
		} else if (isListJson(node)) {
			parseListIntoJson(node, null, entries, blockIndex);
		}
	}
	return entries;
}
```

- [ ] **Step 6: Stamp `-1` on synthetic entries**

In `buildSyntheticBundleSpec` (currently line ~555), update the entries map:

```ts
		entries:
			kind === 'bundle' ? clean.map((t) => ({ title: t, category: null, srcTop: -1 })) : []
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd app && npx vitest run tests/unit/editor/noteBundle/parser.test.ts`
Expected: PASS (all parser tests, including the new srcTop block).

- [ ] **Step 8: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/viper
git add app/src/lib/editor/noteBundle/parser.ts app/tests/unit/editor/noteBundle/parser.test.ts
git commit -m "feat(notebundle): srcTop on bundle entries for drag-drop boundary mapping"
```

---

### Task 2: Plugin — `insertBundleListItemLink` export

**Goal:** A plugin function that inserts a new `listItem > paragraph > [[title]]` into an in-body 묶음's underlying bulletList at a top-level boundary, via a single ProseMirror transaction.

**Files:**
- Modify: `app/src/lib/editor/noteBundle/noteBundlePlugin.ts`
- Test: `app/tests/unit/editor/noteBundle/noteBundlePlugin.test.ts`

**Boundary contract:** `boundary: number | null`. A number = the top-level `listItem` index to insert **before**. `null` = append after the last top-level item.

**Acceptance Criteria:**
- [ ] Inserting with `boundary=1` places the new item before top-level item index 1.
- [ ] Inserting with `boundary=null` appends after the last item.
- [ ] The new item is a `listItem` containing a `paragraph` whose text carries a `tomboyInternalLink` mark with `target` = the title.
- [ ] Returns `false` (no dispatch) on an unknown ordinal or a bundle with no list.
- [ ] Ordinal is re-looked-up on the current state before insertion.

**Verify:** `cd app && npx vitest run tests/unit/editor/noteBundle/noteBundlePlugin.test.ts` → PASS

**Steps:**

- [ ] **Step 1: Write failing tests**

Append to `noteBundlePlugin.test.ts` (the `li`/`list`/`doc`/`kw`/`titleLine` builders and `makeStub`/`makeEditor` already exist in the file):

```ts
import { insertBundleListItemLink } from '$lib/editor/noteBundle';

function entryTitles(ed: Editor): string[] {
	const titles: string[] = [];
	ed.state.doc.descendants((node) => {
		const mark = node.marks?.find((m) => m.type.name === 'tomboyInternalLink');
		if (mark) titles.push(String(mark.attrs.target));
	});
	return titles;
}

describe('insertBundleListItemLink', () => {
	it('boundary=1 → 최상위 항목 1 앞에 새 링크 항목 삽입', () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(doc(titleLine('호스트'), kw('묶음:50', true), list(li('A'), li('B'))), mountStack);
		const ok = insertBundleListItemLink(ed.view as EditorView, 0, 1, '새노트');
		expect(ok).toBe(true);
		expect(entryTitles(ed)).toEqual(['A', '새노트', 'B']);
	});

	it('boundary=null → 마지막에 추가', () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(doc(titleLine('호스트'), kw('묶음:50', true), list(li('A'), li('B'))), mountStack);
		insertBundleListItemLink(ed.view as EditorView, 0, null, '끝노트');
		expect(entryTitles(ed)).toEqual(['A', 'B', '끝노트']);
	});

	it('새 항목은 tomboyInternalLink target 을 갖는다', () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(doc(titleLine('호스트'), kw('묶음:50', true), list(li('A'))), mountStack);
		insertBundleListItemLink(ed.view as EditorView, 0, 0, '대상');
		const titles = entryTitles(ed);
		expect(titles).toContain('대상');
	});

	it('알 수 없는 ordinal → false, 문서 불변', () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(doc(titleLine('호스트'), kw('묶음:50', true), list(li('A'))), mountStack);
		const before = ed.state.doc.toJSON();
		const ok = insertBundleListItemLink(ed.view as EditorView, 99, 0, 'X');
		expect(ok).toBe(false);
		expect(ed.state.doc.toJSON()).toEqual(before);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run tests/unit/editor/noteBundle/noteBundlePlugin.test.ts -t insertBundleListItemLink`
Expected: FAIL — `insertBundleListItemLink` is not exported.

- [ ] **Step 3: Implement the export**

Append to `noteBundlePlugin.ts` (after `setBundleChecked`):

```ts
/** 묶음 링크 리스트에 새 내부링크 항목 삽입(드래그-드롭). ordinal 로 신선한
 *  번들 재조회 → 최상위 bulletList 의 boundary 위치(number=그 인덱스 항목 앞,
 *  null=끝)에 `listItem>paragraph>[[title]]` 삽입. 명시적 tomboyInternalLink
 *  마크라 재파싱 즉시 바로 바가 뜬다(autolink 대기 없음). 리스트/번들 없으면
 *  no-op(false). 묶음 유일의 의도적 리스트 변형 — 추가만, 재정렬/삭제 없음. */
export function insertBundleListItemLink(
	view: EditorView,
	ordinal: number,
	boundary: number | null,
	title: string
): boolean {
	const bundle = noteBundlePluginKey
		.getState(view.state)
		?.bundles.find((b) => b.ordinal === ordinal);
	if (!bundle || bundle.listPos === null || bundle.listEnd === null) return false;
	const t = title.trim();
	if (!t) return false;
	const { schema } = view.state;
	const linkMark = schema.marks.tomboyInternalLink;
	const listItemType = schema.nodes.listItem;
	const paragraphType = schema.nodes.paragraph;
	if (!linkMark || !listItemType || !paragraphType) return false;
	const listNode = view.state.doc.nodeAt(bundle.listPos);
	if (!listNode) return false;
	const textNode = schema.text(t, [linkMark.create({ target: t })]);
	const li = listItemType.create(null, paragraphType.create(null, textNode));
	// 끝(append): 닫기 토큰 바로 안쪽. 그 외: boundary 인덱스 자식의 시작 pos.
	let pos = bundle.listEnd - 1;
	if (boundary !== null) {
		let found = false;
		listNode.forEach((child, offset, index) => {
			if (!found && index === boundary) {
				pos = bundle.listPos! + 1 + offset;
				found = true;
			}
		});
	}
	view.dispatch(view.state.tr.insert(pos, li).scrollIntoView());
	return true;
}
```

- [ ] **Step 4: Export from the barrel**

In `app/src/lib/editor/noteBundle/index.ts`, add `insertBundleListItemLink` to the `noteBundlePlugin` re-export (it currently exports `writeBundleHeightPct`, `setBundleChecked`, etc.). Confirm the line reads, e.g.:

```ts
export {
	createNoteBundlePlugin,
	noteBundlePluginKey,
	writeBundleHeightPct,
	setBundleChecked,
	insertBundleListItemLink
} from './noteBundlePlugin.js';
```

(If the barrel uses `export * from './noteBundlePlugin.js'`, no change is needed — verify which form is present and only edit if it is an explicit list.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd app && npx vitest run tests/unit/editor/noteBundle/noteBundlePlugin.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/viper
git add app/src/lib/editor/noteBundle/noteBundlePlugin.ts app/src/lib/editor/noteBundle/index.ts app/tests/unit/editor/noteBundle/noteBundlePlugin.test.ts
git commit -m "feat(notebundle): insertBundleListItemLink plugin export"
```

---

### Task 3: Cabinet — drop target, visual feedback, dispatch

**Goal:** `NoteBundleCabinet` accepts a note drop on its bars: it highlights and shows an insertion line on dragover, and on drop inserts at the hovered boundary (in-body via the plugin, dedicated via a new `oninsertentry` prop), silently skipping self/duplicate.

**Files:**
- Modify: `app/src/lib/editor/noteBundle/NoteBundleCabinet.svelte`

**Acceptance Criteria:**
- [ ] `oninsertentry?(boundary: number | null, title: string)` prop added.
- [ ] `ResolvedEntry` carries `srcTop` (from `spec.entries`).
- [ ] Dragging a note (MIME present) over a bar highlights the cabinet and shows a top/bottom insertion line on that bar; leaving the cabinet clears it.
- [ ] Dropping over a bar inserts via `insertBundleListItemLink(view, ...)` when `view` is set, else `oninsertentry(...)`.
- [ ] Self (`guid === hostGuid`) and duplicate (title already resolved) are skipped with a toast; no insert.
- [ ] Dropping over the expanded `.bundle-body` does nothing here (embedded editor keeps its own drop).

**Verify:** `cd app && npm run check` → 0 errors; manual smoke in Task 6.

**Steps:**

- [ ] **Step 1: Add imports**

Near the other imports in `NoteBundleCabinet.svelte`:

```ts
	import { writeBundleHeightPct, setBundleChecked, insertBundleListItemLink } from './noteBundlePlugin.js';
	import { NOTE_TITLE_DND_MIME } from '../noteTitleDrop/noteTitleDropPlugin.js';
	import { pushToast } from '$lib/stores/toast.js';
```

(Replace the existing `import { writeBundleHeightPct, setBundleChecked } from './noteBundlePlugin.js';` line with the three-symbol version.)

- [ ] **Step 2: Add the `oninsertentry` prop**

In the `Props` interface (after `onwindowdrag`):

```ts
		/** dedicated(전용 노트) 드래그-드롭 — 호스트가 본문 JSON 에 링크 항목을
		 *  삽입+저장. boundary=null=끝. in-body(view 있음)는 이 콜백 대신 플러그인
		 *  으로 직접 삽입하므로 미사용. */
		oninsertentry?: (boundary: number | null, title: string) => void;
```

And in the `let { … }: Props = $props();` destructure, add `oninsertentry`:

```ts
	let {
		spec,
		view,
		hostGuid,
		EditorComponent,
		oninternallink,
		variant = 'inline',
		onclose,
		onraw,
		onwindowdrag,
		oninsertentry
	}: Props = $props();
```

- [ ] **Step 3: Carry `srcTop` on resolved entries**

In the `ResolvedEntry` interface add `srcTop`, and stamp it in the `resolved` derivation:

```ts
	interface ResolvedEntry {
		title: string;
		category: string | null;
		guid: string | null;
		broken: boolean;
		srcIndex: number;
		/** 최상위 구조 단위 인덱스(파서 stamp) — 드롭 경계 매핑. */
		srcTop: number;
	}
```

In the `resolved = $derived.by(...)` push call, add `srcTop: e.srcTop`:

```ts
			out.push({
				title: e.title,
				category: e.category,
				guid,
				broken: guid === null,
				srcIndex: i,
				srcTop: e.srcTop
			});
```

- [ ] **Step 4: Add drop state + handlers**

In the `<script>`, near the other gesture handlers, add:

```ts
	// --- 드래그-드롭(노트 추가) -------------------------------------------------
	// 데스크탑 노트 드래그 핸들(NoteDragHandle)을 묶음 바 위로 드롭 → 그 경계의
	// 최상위 리스트 위치에 새 내부링크 항목 추가. 바디(임베디드 에디터) 위 드롭은
	// 건드리지 않는다(그 에디터 자체 드롭이 처리).
	let dropActive = $state(false);
	let dropTargetIdx = $state(-1);
	let dropBefore = $state(true);

	function clearDrop() {
		if (dropActive) dropActive = false;
		if (dropTargetIdx !== -1) dropTargetIdx = -1;
	}

	/** 이벤트 좌표 → 대상 바 인덱스 + 위/아래 절반. 바 밖이면 null. */
	function dropTargetFromEvent(ev: DragEvent): { idx: number; topHalf: boolean } | null {
		const barEl = (ev.target as HTMLElement | null)?.closest?.('.bundle-bar') as HTMLElement | null;
		if (!barEl) return null;
		const idx = Number(barEl.dataset.idx);
		if (!Number.isFinite(idx) || idx < 0 || idx >= resolved.length) return null;
		const r = barEl.getBoundingClientRect();
		return { idx, topHalf: ev.clientY < r.top + r.height / 2 };
	}

	/** resolved idx + 위/아래 → 삽입 경계(그 단위 앞의 srcTop, 또는 다음 단위
	 *  srcTop; 마지막이면 null=끝). srcTop<0(합성) → null. */
	function boundaryFor(idx: number, topHalf: boolean): number | null {
		const s = resolved[idx]?.srcTop ?? -1;
		if (s < 0) return null;
		if (topHalf) return s;
		const tops = [...new Set(resolved.map((r) => r.srcTop))]
			.filter((x) => x >= 0)
			.sort((a, b) => a - b);
		const j = tops.indexOf(s);
		return j >= 0 && j + 1 < tops.length ? tops[j + 1] : null;
	}

	function handleListDragOver(ev: DragEvent) {
		const dt = ev.dataTransfer;
		if (!dt || !dt.types.includes(NOTE_TITLE_DND_MIME)) return;
		// 바디(임베디드 에디터) 위 → 그 에디터 드롭에 맡긴다.
		if ((ev.target as HTMLElement | null)?.closest?.('.bundle-body')) {
			clearDrop();
			return;
		}
		const t = dropTargetFromEvent(ev);
		if (!t) {
			clearDrop();
			return;
		}
		ev.preventDefault();
		dt.dropEffect = 'copy';
		dropActive = true;
		dropTargetIdx = t.idx;
		dropBefore = t.topHalf;
	}

	function handleListDragLeave(ev: DragEvent) {
		if (!rootEl) return;
		const to = ev.relatedTarget as Node | null;
		if (to && rootEl.contains(to)) return; // 내부 이동
		clearDrop();
	}

	function handleListDrop(ev: DragEvent) {
		const dt = ev.dataTransfer;
		const t = dropTargetFromEvent(ev);
		clearDrop();
		if (!dt || !t) return;
		const title = dt.getData(NOTE_TITLE_DND_MIME);
		if (!title) return;
		if ((ev.target as HTMLElement | null)?.closest?.('.bundle-body')) return;
		ev.preventDefault();
		const guid = lookupGuidByTitle(title);
		if (guid !== null && guid === hostGuid) {
			pushToast('자기 자신은 묶음에 추가할 수 없어요');
			return;
		}
		if (resolved.some((r) => r.title === title)) {
			pushToast('이미 묶음에 있는 노트예요');
			return;
		}
		const boundary = boundaryFor(t.idx, t.topHalf);
		if (view) insertBundleListItemLink(view, spec.ordinal, boundary, title);
		else oninsertentry?.(boundary, title);
	}
```

- [ ] **Step 5: Wire the handlers to the `.bundle-list` and add drop classes to bars**

In the `.bundle-list` `use:direct={{ … }}` map, add the three drag handlers:

```svelte
			<div
				class="bundle-list"
				class:drop-active={dropActive}
				use:direct={{
					wheel: handleListWheel,
					pointerdown: handleListPointerDown as (e: Event) => void,
					pointermove: handleListPointerMove as (e: Event) => void,
					pointerup: handleListPointerUp,
					pointercancel: handleListPointerUp,
					dragover: handleListDragOver as (e: Event) => void,
					dragleave: handleListDragLeave as (e: Event) => void,
					drop: handleListDrop as (e: Event) => void
				}}
			>
```

On the `.bundle-bar` button, add the two insertion-line classes:

```svelte
					<button
						type="button"
						class="bundle-bar"
						class:broken={e.broken}
						class:expanded-bar={idx === k}
						class:off
						class:draggable={!!onwindowdrag}
						class:drop-before={dropActive && dropTargetIdx === idx && dropBefore}
						class:drop-after={dropActive && dropTargetIdx === idx && !dropBefore}
						data-idx={idx}
					>
```

- [ ] **Step 6: Add the CSS**

In the `<style>` block, add:

```css
	.bundle-list.drop-active {
		outline: 2px dashed var(--accent, #4a8);
		outline-offset: -2px;
		border-radius: 6px;
	}
	.bundle-bar.drop-before {
		box-shadow: inset 0 3px 0 0 var(--accent, #4a8);
	}
	.bundle-bar.drop-after {
		box-shadow: inset 0 -3px 0 0 var(--accent, #4a8);
	}
```

(If `--accent` is not a defined token in `app.css`, use the existing active-bar green used elsewhere in this file — search the file's styles for the `.expanded-bar` / active color and reuse that literal.)

- [ ] **Step 7: Type-check**

Run: `cd app && npm run check`
Expected: 0 errors. (Fix any `(e: Event)` cast mismatches the same way the existing `direct` handlers are cast.)

- [ ] **Step 8: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/viper
git add app/src/lib/editor/noteBundle/NoteBundleCabinet.svelte
git commit -m "feat(notebundle): 묶음 cabinet accepts note drops on bars"
```

---

### Task 4: NoteWindow — dedicated host insert callback

**Goal:** A dedicated `묶음::` note window persists a dropped note by splicing a new internal-link list item into its body JSON and saving.

**Files:**
- Modify: `app/src/lib/desktop/NoteWindow.svelte`

**Acceptance Criteria:**
- [ ] `handleBundleInsertEntry(boundary, title)` builds a `listItem` JSON with a `tomboyInternalLink` mark and splices it into `editorContent.content` (merge into an adjacent `bulletList`, else a new single-item list; `null` = append).
- [ ] Sets `editorContent` to the new doc (so `dedicatedSpec` reparses and the bar appears) and persists via `updateNoteFromEditor(note.guid, newDoc)`.
- [ ] Passed as `oninsertentry` to the dedicated `NoteBundleCabinet` branch only.

**Verify:** `cd app && npm run check` → 0 errors; manual smoke in Task 6.

**Steps:**

- [ ] **Step 1: Add the handler**

In `NoteWindow.svelte` `<script>`, near `exitRawBundle`/`handleBundleTitleDrag`:

```ts
	// 전용 묶음 노트 — 드롭된 노트를 본문 JSON 에 새 내부링크 항목으로 삽입+저장.
	// boundary = doc.content 블록 인덱스(그 앞에 삽입), null = 끝. 인접 bulletList
	// 있으면 합쳐 단일-항목 리스트 난립을 막는다.
	function handleBundleInsertEntry(boundary: number | null, title: string) {
		if (!editorContent || !note) return;
		const t = title.trim();
		if (!t) return;
		const newItem = {
			type: 'listItem',
			content: [
				{
					type: 'paragraph',
					content: [{ type: 'text', text: t, marks: [{ type: 'tomboyInternalLink', attrs: { target: t } }] }]
				}
			]
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const content: any[] = [...((editorContent.content as any[]) ?? [])];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const mergeInto = (block: any, atStart: boolean) => ({
			...block,
			content: atStart ? [newItem, ...(block.content ?? [])] : [...(block.content ?? []), newItem]
		});
		if (boundary === null) {
			const last = content[content.length - 1];
			if (last && last.type === 'bulletList') content[content.length - 1] = mergeInto(last, false);
			else content.push({ type: 'bulletList', content: [newItem] });
		} else {
			const at = content[boundary];
			const prev = content[boundary - 1];
			if (at && at.type === 'bulletList') content[boundary] = mergeInto(at, true);
			else if (prev && prev.type === 'bulletList') content[boundary - 1] = mergeInto(prev, false);
			else content.splice(boundary, 0, { type: 'bulletList', content: [newItem] });
		}
		const newDoc = { ...editorContent, content };
		editorContent = newDoc; // 즉시 재파싱 → 새 바
		void updateNoteFromEditor(note.guid, newDoc); // 영속
	}
```

- [ ] **Step 2: Pass it to the dedicated cabinet**

In the `{:else if dedicatedKind && dedicatedSpec && !showRawBundle}` block, the `{#if dedicatedKind === 'bundle'}` `<NoteBundleCabinet>` — add the prop:

```svelte
					<NoteBundleCabinet
						spec={dedicatedSpec}
						view={null}
						hostGuid={guid}
						variant="dedicated"
						EditorComponent={TomboyEditor}
						oninternallink={handleInternalLink}
						onraw={() => (showRawBundle = true)}
						onclose={handleClose}
						onwindowdrag={handleBundleTitleDrag}
						oninsertentry={handleBundleInsertEntry}
					/>
```

(Do NOT add it to the `NoteBundleStack` branch — tab is excluded.)

- [ ] **Step 3: Type-check**

Run: `cd app && npm run check`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/viper
git add app/src/lib/desktop/NoteWindow.svelte
git commit -m "feat(notebundle): dedicated 묶음:: note accepts note drops (JSON splice + save)"
```

---

### Task 5: Docs + invariant amendments

**Goal:** Record the new capability in the user guide and amend the "view-layer / list never mutated" invariant in both CLAUDE.md and the skill body.

**Files:**
- Modify: `CLAUDE.md` (notebundle row + the noteBundle invariant note, if present in the file's notebundle section)
- Modify: `.claude/skills/tomboy-notebundle/SKILL.md` (Invariants + Known dead ends as relevant)
- Modify: `app/src/routes/settings/+page.svelte` (가이드 → editor 탭)

**Acceptance Criteria:**
- [ ] CLAUDE.md notebundle row mentions the desktop drag-drop add (묶음 only).
- [ ] The skill body's "View layer only — list never mutated" invariant is amended to allow the single drag-drop append.
- [ ] A new `<details class="guide-card">` exists under the editor sub-tab describing the feature, its constraints, and that it is 묶음-only / desktop-only.

**Verify:** `grep -n "드래그" .claude/skills/tomboy-notebundle/SKILL.md app/src/routes/settings/+page.svelte` shows the new content; `cd app && npm run check` → 0 errors.

**Steps:**

- [ ] **Step 1: Amend the skill invariant**

In `.claude/skills/tomboy-notebundle/SKILL.md`, under **Invariants**, change the first bullet from a flat "list never mutated" to note the exception:

```md
- **View layer — `.note` XML never restructured.** The list is read-only **except**
  the desktop drag-drop add: dropping a note's drag handle onto a 묶음 cabinet
  **appends a single internal-link list item** at the hovered top-level boundary
  (in-body via `insertBundleListItemLink`, dedicated via the host's
  `oninsertentry` JSON splice + save). No reorder, no delete, no edit of existing
  items. `activePath`/mode/sessions stay ephemeral.
```

Add a one-line note under the **File map** for `parser.ts` that `BundleEntry.srcTop` exists for boundary mapping, and a bullet under the cabinet section that it owns the bar drop zone.

- [ ] **Step 2: Amend CLAUDE.md**

In `CLAUDE.md`, the `tomboy-notebundle` row in the Skills index table — append to its description: `데스크탑 노트 드래그 핸들 → 묶음 위 드롭 = 리스트에 항목 추가(묶음 전용)`.

- [ ] **Step 3: Add the guide card**

In `app/src/routes/settings/+page.svelte`, find the editor sub-tab (`guideSubTab === 'editor'`) card group and add, mirroring the existing `<details class="guide-card">` pattern:

```svelte
				<details class="guide-card">
					<summary>묶음에 노트 끌어다 넣기</summary>
					<p class="info-text">
						데스크탑 멀티윈도우에서 노트 창 왼쪽 위 아이콘을 다른 노트의
						묶음(<code>묶음:</code> 또는 제목 <code>묶음::</code> 전용 노트) 위로
						끌어다 놓으면, 놓은 자리에 맞춰 묶음 리스트에 그 노트가 추가됩니다.
					</p>
					<ul class="guide-list">
						<li>데스크탑 전용 — 드래그 아이콘은 노트 창에만 있습니다.</li>
						<li>묶음 전용 — 탭(<code>탭:</code>)은 대상이 아닙니다.</li>
						<li>바(접힌 제목) 위에 놓으세요. 펼친 본문 위에 놓으면 그 노트 본문에 들어갑니다.</li>
						<li>이미 있는 노트나 자기 자신은 자동으로 무시됩니다.</li>
					</ul>
				</details>
```

- [ ] **Step 4: Type-check + commit**

Run: `cd app && npm run check`
Expected: 0 errors.

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/viper
git add CLAUDE.md .claude/skills/tomboy-notebundle/SKILL.md app/src/routes/settings/+page.svelte
git commit -m "docs(notebundle): document drag-drop into 묶음 + amend list-mutation invariant"
```

---

### Task 6: Final verification

**Goal:** Whole-suite type-check + unit tests pass; manual desktop smoke confirms the four behaviors.

**Files:** none (verification only)

**Acceptance Criteria:**
- [ ] `npm run check` → 0 errors.
- [ ] `npm run test` → all noteBundle tests pass (pre-existing unrelated DOMObserver teardown flake aside).
- [ ] Manual: drag onto an in-body 묶음 bar → highlight + line → drop → new bar at the boundary.
- [ ] Manual: drag onto a dedicated `묶음::` note window → drop → new bar, and the note's saved body shows the new link.
- [ ] Manual: dropping a duplicate or the host note itself is skipped (toast).
- [ ] Manual: dropping on the expanded body still inserts into that note's text (not the list).

**Verify:** commands below + manual checklist.

**Steps:**

- [ ] **Step 1: Type-check**

Run: `cd app && npm run check`
Expected: 0 errors.

- [ ] **Step 2: Unit tests**

Run: `cd app && npm run test -- tests/unit/editor/noteBundle`
Expected: PASS (parser srcTop + plugin insert).

- [ ] **Step 3: Manual smoke**

Run: `cd app && npm run dev`. In a desktop browser open `/desktop`. Open two note windows: one normal note A, one note B that contains a checked `묶음:50` with a link list (and separately a `묶음::` dedicated note). Drag A's left-top handle over B's 묶음 bars — confirm highlight + insertion line, drop, new bar at the boundary. Repeat for the dedicated note and confirm via `/desktop` raw view (Ctrl → ✎ 편집) that the body list gained the link. Try a duplicate and self-drop (toast, no change). Drop on the expanded body and confirm it edits that note, not the list.

- [ ] **Step 4: Commit any fixes** (if Step 1/2 surfaced issues)

```bash
cd /var/home/umayloveme/workspace/tomboy-web/.worktrees/viper
git add -A && git commit -m "fix(notebundle): drag-drop verification fixes"
```

---

## Self-review notes

- **Spec coverage:** §Parser→Task 1, §In-body insert→Task 2, §Cabinet drop/feedback→Task 3, §Dedicated host→Task 4, §Invariant+docs→Task 5, §Testing→Tasks 1/2/6. All spec sections mapped.
- **Type consistency:** `srcTop` is `number` everywhere; `boundary: number | null` identical in plugin (Task 2), cabinet (Task 3), and host callback (Task 4); `insertBundleListItemLink` signature identical in def (Task 2) and call (Task 3); `oninsertentry` signature identical in prop (Task 3) and pass-down (Task 4).
- **Surface note:** the mobile `/note/[id]` route is intentionally NOT given `oninsertentry` (no drag source exists there — matches the route already omitting `onclose`/`onwindowdrag`). In-body 묶음 works anywhere a live `view` exists via Task 2, with no host wiring.
