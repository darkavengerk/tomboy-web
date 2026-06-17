# 제목 수평선 리스트 아코디언 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 제목이 달린 수평선(`텍스트 ---`) 아래 리스트를 그룹(`---` 경계)당 한 번에 하나만 펼쳐 보는 아코디언 접기 기능 추가.

**Architecture:** 기존 `labeledDivider` 데코 플러그인과 평행한 새 ProseMirror 플러그인. 순수 구조 계산(`assignAccordion.ts`) + 플러그인(상태·데코·토글 순환·split-inert) + per-guid localStorage. 토글은 위젯 `+/−` 버튼만(라벨 텍스트 편집 보존). 포커스 모델: 기본 다 펼침, 한 멤버 포커스 시 같은 그룹 형제 리스트만 숨김, 열린 것 닫기=다음 멤버로 순환.

**Tech Stack:** SvelteKit, TipTap 3 / ProseMirror, TypeScript, vitest + @testing-library/svelte, StarterKit lists (`bulletList`/`orderedList`).

스펙: `docs/superpowers/specs/2026-06-17-labeled-divider-list-accordion-design.md`

---

### Task 1: `assignAccordion.ts` — 순수 구조 계산 + 테스트

**Goal:** top-level 블록 분류 배열 → 라벨 디바이더 멤버 테이블(ord/group/소유 리스트 인덱스/list-bearing) + 그룹별 멤버 수를 내는 순수 함수.

**Files:**
- Create: `app/src/lib/editor/labeledDivider/assignAccordion.ts`
- Test: `app/tests/unit/editor/labeledFoldAccordion.test.ts`

**Acceptance Criteria:**
- [ ] `divider` 다음이 `list` 면 그 멤버 `isListBearing=true`, `listIndices`=직후 연속 리스트 런.
- [ ] `divider` 다음이 비-리스트면 `isListBearing=false`, 멤버 수 집계에서 제외.
- [ ] `hr`(`---`) 마다 group 증가 → `---` 양쪽 멤버는 다른 group.
- [ ] ordinal 은 list-bearing 여부 무관하게 **모든** divider 를 doc 순서로 0-based.
- [ ] `headerCount` 만큼 앞 블록 스킵.
- [ ] `memberCountByGroup` 은 group → list-bearing 멤버 수.

**Verify:** `cd app && npx vitest run tests/unit/editor/labeledFoldAccordion.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 테스트 작성** — `app/tests/unit/editor/labeledFoldAccordion.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
	assignAccordion,
	type AccordionBlockKind
} from '$lib/editor/labeledDivider/assignAccordion.js';

const H = 2; // headerCount

/** Build a kinds array: 2 header 'other' + the given post-header kinds. */
function withHeaders(...post: AccordionBlockKind[]): AccordionBlockKind[] {
	return ['other', 'other', ...post];
}

describe('assignAccordion', () => {
	it('divider followed by a list is a list-bearing member', () => {
		const { members, memberCountByGroup } = assignAccordion({
			kinds: withHeaders('divider', 'list'),
			headerCount: H
		});
		expect(members).toHaveLength(1);
		expect(members[0]).toMatchObject({
			index: 2,
			ord: 0,
			group: 0,
			listIndices: [3],
			isListBearing: true
		});
		expect(memberCountByGroup.get(0)).toBe(1);
	});

	it('divider NOT followed by a list is not list-bearing and not counted', () => {
		const { members, memberCountByGroup } = assignAccordion({
			kinds: withHeaders('divider', 'other'),
			headerCount: H
		});
		expect(members[0].isListBearing).toBe(false);
		expect(members[0].listIndices).toEqual([]);
		expect(memberCountByGroup.get(0)).toBeUndefined();
	});

	it('owns the maximal consecutive list run', () => {
		const { members } = assignAccordion({
			kinds: withHeaders('divider', 'list', 'list', 'other'),
			headerCount: H
		});
		expect(members[0].listIndices).toEqual([3, 4]);
	});

	it('a paragraph between divider and list breaks the run', () => {
		const { members } = assignAccordion({
			kinds: withHeaders('divider', 'other', 'list'),
			headerCount: H
		});
		expect(members[0].isListBearing).toBe(false);
	});

	it('--- (hr) splits groups; members on each side differ in group', () => {
		const { members, memberCountByGroup } = assignAccordion({
			kinds: withHeaders(
				'divider', 'list', // ord0 group0
				'divider', 'list', // ord1 group0
				'hr',
				'divider', 'list' // ord2 group1
			),
			headerCount: H
		});
		expect(members.map(m => m.ord)).toEqual([0, 1, 2]);
		expect(members.map(m => m.group)).toEqual([0, 0, 1]);
		expect(memberCountByGroup.get(0)).toBe(2);
		expect(memberCountByGroup.get(1)).toBe(1);
	});

	it('ordinals count ALL dividers incl. non-list-bearing', () => {
		const { members } = assignAccordion({
			kinds: withHeaders(
				'divider', 'other', // ord0, no list
				'divider', 'list' // ord1, list
			),
			headerCount: H
		});
		expect(members.map(m => m.ord)).toEqual([0, 1]);
		expect(members[1].isListBearing).toBe(true);
		expect(members[1].listIndices).toEqual([5]);
	});

	it('skips headerCount leading blocks', () => {
		// Without headers, a divider at index 0 owns list at index 1.
		const { members } = assignAccordion({
			kinds: ['divider', 'list'],
			headerCount: 0
		});
		expect(members[0].index).toBe(0);
		expect(members[0].listIndices).toEqual([1]);
	});

	it('no dividers → empty', () => {
		const { members, memberCountByGroup } = assignAccordion({
			kinds: withHeaders('other', 'list'),
			headerCount: H
		});
		expect(members).toEqual([]);
		expect(memberCountByGroup.size).toBe(0);
	});
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npx vitest run tests/unit/editor/labeledFoldAccordion.test.ts` → FAIL (module not found)

- [ ] **Step 3: 구현** — `app/src/lib/editor/labeledDivider/assignAccordion.ts`

```ts
/**
 * Pure accordion-assignment logic for the labeled-divider list fold.
 *
 * Model — labeled dividers (`텍스트 ---`) are grouped by plain `---` HR
 * markers: each `---` ends a group and starts the next. Within a group, a
 * labeled divider whose IMMEDIATELY following top-level block(s) form a
 * list owns that list run and is a foldable "member". The plugin shows at
 * most one member's list per group; this module only computes the static
 * structure.
 *
 * Ordinals number ALL labeled dividers post-header in document order, so
 * attaching/removing a list under a divider doesn't renumber the others.
 */

export type AccordionBlockKind = 'hr' | 'divider' | 'list' | 'other';

export interface AccordionMember {
	/** Index into the top-level children array (the divider paragraph). */
	index: number;
	/** Ordinal among all labeled dividers post-header, doc order, 0-based. */
	ord: number;
	/** Group index, 0-based; bumped by each plain `---` HR. */
	group: number;
	/** Top-level indices of the consecutive list run right after the
	 *  divider. Empty when the next block is not a list. */
	listIndices: number[];
	/** listIndices.length > 0. Only list-bearing members get fold UI and
	 *  participate in the accordion. */
	isListBearing: boolean;
}

export interface AccordionInput {
	kinds: AccordionBlockKind[];
	/** Leading children excluded (title + subtitle). Defaults to 0. */
	headerCount?: number;
}

export interface AccordionOutput {
	/** Every labeled divider post-header, doc order. */
	members: AccordionMember[];
	/** group → count of list-bearing members in it. */
	memberCountByGroup: Map<number, number>;
}

export function assignAccordion({
	kinds,
	headerCount: rawHeaderCount = 0
}: AccordionInput): AccordionOutput {
	const headerCount = Math.max(0, Math.min(rawHeaderCount, kinds.length));
	const members: AccordionMember[] = [];
	let group = 0;
	let ord = -1;

	for (let i = headerCount; i < kinds.length; i++) {
		const k = kinds[i];
		if (k === 'hr') {
			group++;
			continue;
		}
		if (k !== 'divider') continue;
		ord++;
		const listIndices: number[] = [];
		let j = i + 1;
		while (j < kinds.length && kinds[j] === 'list') {
			listIndices.push(j);
			j++;
		}
		members.push({
			index: i,
			ord,
			group,
			listIndices,
			isListBearing: listIndices.length > 0
		});
	}

	const memberCountByGroup = new Map<number, number>();
	for (const m of members) {
		if (!m.isListBearing) continue;
		memberCountByGroup.set(m.group, (memberCountByGroup.get(m.group) ?? 0) + 1);
	}

	return { members, memberCountByGroup };
}
```

- [ ] **Step 4: 통과 확인** — Run: `cd app && npx vitest run tests/unit/editor/labeledFoldAccordion.test.ts` → PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/labeledDivider/assignAccordion.ts app/tests/unit/editor/labeledFoldAccordion.test.ts
git commit -m "feat(labeledDivider): assignAccordion 순수 구조 계산 + 테스트"
```

---

### Task 2: `labeledFoldStore.ts` — per-guid 영속 + 테스트

**Goal:** 포커스된 ordinal 집합을 per-guid localStorage(`tomboy.labeledFold.<guid>`)에 저장/로드. `hrFoldStore` 패턴 복제.

**Files:**
- Create: `app/src/lib/editor/labeledDivider/labeledFoldStore.ts`
- Test: `app/tests/unit/editor/labeledFoldStore.test.ts`

**Acceptance Criteria:**
- [ ] 알 수 없는 guid → 빈 Set.
- [ ] round-trip 보존, guid 별 스코프.
- [ ] 빈 Set 저장 → 키 제거.
- [ ] 깨진 JSON / null guid → 빈 Set, throw 없음.

**Verify:** `cd app && npx vitest run tests/unit/editor/labeledFoldStore.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 테스트 작성** — `app/tests/unit/editor/labeledFoldStore.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
	loadFocusedOrdinals,
	saveFocusedOrdinals
} from '$lib/editor/labeledDivider/labeledFoldStore.js';

const GUID = 'aaaaaaaa-0000-0000-0000-000000000000';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000000';

describe('labeledFoldStore', () => {
	beforeEach(() => {
		try {
			window.localStorage.clear();
		} catch {
			/* ignore */
		}
	});

	it('returns empty set for unknown guid', () => {
		expect(loadFocusedOrdinals(GUID).size).toBe(0);
	});

	it('round-trips ordinals', () => {
		saveFocusedOrdinals(GUID, new Set([0, 2]));
		expect(Array.from(loadFocusedOrdinals(GUID)).sort((a, b) => a - b)).toEqual([
			0, 2
		]);
	});

	it('is scoped per guid', () => {
		saveFocusedOrdinals(GUID, new Set([1]));
		expect(loadFocusedOrdinals(OTHER).size).toBe(0);
	});

	it('empty set removes the key', () => {
		saveFocusedOrdinals(GUID, new Set([1]));
		saveFocusedOrdinals(GUID, new Set());
		expect(loadFocusedOrdinals(GUID).size).toBe(0);
	});

	it('null guid is a no-op / empty', () => {
		expect(loadFocusedOrdinals(null).size).toBe(0);
		expect(() => saveFocusedOrdinals(null, new Set([1]))).not.toThrow();
	});

	it('corrupt JSON returns empty set', () => {
		window.localStorage.setItem('tomboy.labeledFold.' + GUID, '{not json');
		expect(loadFocusedOrdinals(GUID).size).toBe(0);
	});
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npx vitest run tests/unit/editor/labeledFoldStore.test.ts` → FAIL

- [ ] **Step 3: 구현** — `app/src/lib/editor/labeledDivider/labeledFoldStore.ts`

```ts
/**
 * Per-browser persistence for the labeled-divider list accordion.
 *
 * Focused dividers are keyed by note guid + labeled-divider ordinal (same
 * numbering as assignAccordion). The ordinal shifts if the user
 * inserts/removes a divider — acceptable for ephemeral view state.
 *
 * Plain localStorage, scoped per browser. Never synced, never in `.note`.
 */

const KEY_PREFIX = 'tomboy.labeledFold.';

function storageKey(guid: string): string {
	return KEY_PREFIX + guid;
}

function safeStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null;
	}
}

export function loadFocusedOrdinals(guid: string | null): Set<number> {
	if (!guid) return new Set();
	const ls = safeStorage();
	if (!ls) return new Set();
	const raw = ls.getItem(storageKey(guid));
	if (!raw) return new Set();
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set();
		const out = new Set<number>();
		for (const v of parsed) {
			if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out.add(v);
		}
		return out;
	} catch {
		return new Set();
	}
}

export function saveFocusedOrdinals(
	guid: string | null,
	ordinals: ReadonlySet<number>
): void {
	if (!guid) return;
	const ls = safeStorage();
	if (!ls) return;
	try {
		if (ordinals.size === 0) {
			ls.removeItem(storageKey(guid));
		} else {
			const arr = Array.from(ordinals).sort((a, b) => a - b);
			ls.setItem(storageKey(guid), JSON.stringify(arr));
		}
	} catch {
		/* quota / disabled — fold still visible this session */
	}
}
```

- [ ] **Step 4: 통과 확인** — Run: `cd app && npx vitest run tests/unit/editor/labeledFoldStore.test.ts` → PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/labeledDivider/labeledFoldStore.ts app/tests/unit/editor/labeledFoldStore.test.ts
git commit -m "feat(labeledDivider): labeledFoldStore per-guid 영속 + 테스트"
```

---

### Task 3: `labeledFoldPlugin.ts` — ProseMirror 플러그인 + 테스트

**Goal:** 포커스 상태·데코(위젯 버튼 + 리스트 숨김)·토글 순환·doc reconcile·split-inert 를 구현하는 PM 플러그인.

**Files:**
- Create: `app/src/lib/editor/labeledDivider/labeledFoldPlugin.ts`
- Test: `app/tests/unit/editor/labeledFoldPlugin.test.ts`
- Read (재사용): `app/src/lib/editor/hrSplit/hrSplitPlugin.ts` (`isDashParagraph`, `HEADER_COUNT`), `app/src/lib/editor/hrSplit/pluginKeys.ts` (`hrSplitPluginKey`), `app/src/lib/editor/labeledDivider/parseLabeledDivider.ts`

**Acceptance Criteria:**
- [ ] 기본(포커스 없음): list-bearing & group 멤버 ≥2 인 멤버마다 위젯 버튼, 숨김 데코 0.
- [ ] group 멤버 <2 인 멤버: 버튼 없음.
- [ ] `toggle(ord)`(현재 포커스 없음) → 그 멤버 포커스, 같은 그룹 형제 리스트 숨김.
- [ ] 포커스된 멤버 `toggle` → 같은 그룹 다음 멤버로 순환(끝→처음).
- [ ] 다른(닫힌) 멤버 `toggle` → 그 멤버로 점프.
- [ ] 그룹 독립: 한 그룹 토글이 다른 `---` 그룹 포커스 안 건드림.
- [ ] hrSplit 활성 시 `decorations` 가 null.
- [ ] docChanged 시 유효하지 않은 ordinal pruning(reconcile).

**Verify:** `cd app && npx vitest run tests/unit/editor/labeledFoldPlugin.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 테스트 작성** — `app/tests/unit/editor/labeledFoldPlugin.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { EditorState } from '@tiptap/pm/state';
import type { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
	createLabeledFoldPlugin,
	labeledFoldPluginKey,
	getFocusedOrdinals
} from '$lib/editor/labeledDivider/labeledFoldPlugin.js';
import {
	createHrSplitPlugin,
	hrSplitPluginKey
} from '$lib/editor/hrSplit/hrSplitPlugin.js';

let currentEditor: Editor | null = null;

/** Doc (top-level index → content):
 *  0 제목(h) 1 날짜(h) 2 intro
 *  3 섹션1---(div ord0,grp0) 4 ul(a)
 *  5 섹션2---(div ord1,grp0) 6 ul(b)
 *  7 ---(hr → grp1)
 *  8 섹션3---(div ord2,grp1) 9 ul(c) */
const DOC =
	'<p>제목</p><p>2026-06-17</p><p>intro</p>' +
	'<p>섹션1 ---</p><ul><li><p>a</p></li></ul>' +
	'<p>섹션2 ---</p><ul><li><p>b</p></li></ul>' +
	'<p>---</p>' +
	'<p>섹션3 ---</p><ul><li><p>c</p></li></ul>';

function makeEditor(content: string = DOC): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit,
			Extension.create({
				name: 'tomboyHrSplit',
				addProseMirrorPlugins() {
					return [createHrSplitPlugin()];
				}
			}),
			Extension.create({
				name: 'tomboyLabeledFold',
				addProseMirrorPlugins() {
					return [createLabeledFoldPlugin()];
				}
			})
		],
		content
	});
	currentEditor = editor;
	return editor;
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

type DecoWithType = Decoration & {
	type: { attrs?: { class?: string }; toDOM?: unknown };
};

function foldDecos(editor: Editor): DecoWithType[] {
	const plugin = labeledFoldPluginKey.get(editor.state);
	if (!plugin) return [];
	const fn = plugin.spec.props?.decorations as (
		this: unknown,
		state: EditorState
	) => DecorationSet | null;
	const set = fn.call(plugin, editor.state);
	return set ? (set.find() as DecoWithType[]) : [];
}

function buttons(editor: Editor): DecoWithType[] {
	return foldDecos(editor).filter(d => typeof d.type.toDOM === 'function');
}

function hiddenDecos(editor: Editor): DecoWithType[] {
	return foldDecos(editor).filter(d =>
		(d.type.attrs?.class ?? '').includes('tomboy-labeled-fold-hidden')
	);
}

function toggle(editor: Editor, ord: number): void {
	editor.view.dispatch(
		editor.state.tr.setMeta(labeledFoldPluginKey, { toggle: ord })
	);
}

function focusedArr(editor: Editor): number[] {
	return Array.from(getFocusedOrdinals(editor.state)).sort((a, b) => a - b);
}

describe('labeledFoldPlugin', () => {
	it('default: buttons only on ≥2-member groups, nothing hidden', () => {
		const ed = makeEditor();
		// group0 has ord0, ord1 (count 2) → 2 buttons; group1 has only ord2 → 0.
		expect(buttons(ed)).toHaveLength(2);
		expect(hiddenDecos(ed)).toHaveLength(0);
	});

	it('focusing ord0 hides its group siblings, not other groups', () => {
		const ed = makeEditor();
		toggle(ed, 0);
		expect(focusedArr(ed)).toEqual([0]);
		// ord1's list (one ul) hidden; ord0's not. group1 untouched.
		expect(hiddenDecos(ed)).toHaveLength(1);
	});

	it('closing the open member cycles to the next (wraps)', () => {
		const ed = makeEditor();
		toggle(ed, 0); // focus 0
		toggle(ed, 0); // close open → advance to 1
		expect(focusedArr(ed)).toEqual([1]);
		toggle(ed, 1); // close open → advance wraps to 0
		expect(focusedArr(ed)).toEqual([0]);
	});

	it('clicking a closed member jumps to it', () => {
		const ed = makeEditor();
		toggle(ed, 0); // focus 0
		toggle(ed, 1); // 1 is closed, 0 focused → jump to 1
		expect(focusedArr(ed)).toEqual([1]);
	});

	it('a <2-member group ignores toggles', () => {
		const ed = makeEditor();
		toggle(ed, 2); // group1, only member → ignored
		expect(focusedArr(ed)).toEqual([]);
	});

	it('group focus is independent across --- boundaries', () => {
		const ed = makeEditor();
		toggle(ed, 0); // group0 focus
		expect(focusedArr(ed)).toEqual([0]); // group1 (ord2) unaffected
	});

	it('inert while hrSplit is active', () => {
		const ed = makeEditor();
		toggle(ed, 0);
		// Activate the split on the only --- (hrSplit HR ordinal 0).
		ed.view.dispatch(
			ed.state.tr.setMeta(hrSplitPluginKey, { toggle: 0 })
		);
		expect(foldDecos(ed)).toHaveLength(0);
	});

	it('reconcile prunes invalid ordinals on doc change', () => {
		const ed = makeEditor();
		// Seed a bogus focus ordinal via replace, then make any edit.
		ed.view.dispatch(
			ed.state.tr.setMeta(labeledFoldPluginKey, { replace: [99] })
		);
		expect(focusedArr(ed)).toEqual([99]);
		ed.view.dispatch(ed.state.tr.insertText('x', 1));
		expect(focusedArr(ed)).toEqual([]);
	});
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd app && npx vitest run tests/unit/editor/labeledFoldPlugin.test.ts` → FAIL (module not found)

- [ ] **Step 3: 구현** — `app/src/lib/editor/labeledDivider/labeledFoldPlugin.ts`

```ts
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import {
	assignAccordion,
	type AccordionBlockKind,
	type AccordionMember
} from './assignAccordion.js';
import { parseLabeledDivider } from './parseLabeledDivider.js';
import { isDashParagraph, HEADER_COUNT } from '../hrSplit/hrSplitPlugin.js';
import { hrSplitPluginKey } from '../hrSplit/pluginKeys.js';

export interface LabeledFoldPluginState {
	/** Labeled-divider ordinals that are "focused" (open while group
	 *  siblings fold). Invariant: at most one per group. */
	focused: Set<number>;
}

export const labeledFoldPluginKey = new PluginKey<LabeledFoldPluginState>(
	'tomboyLabeledFold'
);

interface ToggleMeta {
	toggle: number;
}
interface ReplaceMeta {
	replace: ReadonlyArray<number>;
}
type Meta = ToggleMeta | ReplaceMeta;

function isToggle(m: Meta): m is ToggleMeta {
	return typeof (m as ToggleMeta).toggle === 'number';
}
function isReplace(m: Meta): m is ReplaceMeta {
	return Array.isArray((m as ReplaceMeta).replace);
}

export interface LabeledFoldOptions {
	/** Fired after every user-driven change (toggle or doc-prune). NOT
	 *  called for `replace` (note-load); host is already in sync then. */
	onChange?: (focused: ReadonlySet<number>, prev: ReadonlySet<number>) => void;
}

/** Classify every top-level child for the accordion model. */
function describeAccordion(doc: PMNode): {
	kinds: AccordionBlockKind[];
	positions: number[];
} {
	const kinds: AccordionBlockKind[] = [];
	const positions: number[] = [];
	doc.forEach((node, offset) => {
		positions.push(offset);
		if (isDashParagraph(node)) {
			kinds.push('hr');
		} else if (
			node.type.name === 'bulletList' ||
			node.type.name === 'orderedList'
		) {
			kinds.push('list');
		} else if (
			node.type.name === 'paragraph' &&
			parseLabeledDivider(node.textContent) !== null
		) {
			kinds.push('divider');
		} else {
			kinds.push('other');
		}
	});
	return { kinds, positions };
}

/** The single focused ordinal within `group`, or null. */
function focusedInGroup(
	focused: ReadonlySet<number>,
	members: AccordionMember[],
	group: number
): number | null {
	for (const ord of focused) {
		const m = members.find(x => x.ord === ord);
		if (m && m.group === group) return ord;
	}
	return null;
}

/** Apply a toggle: focus / cycle-to-next / jump. Returns null when the
 *  toggle targets a non-member or a <2-member group (ignored). */
function applyToggle(
	doc: PMNode,
	prev: ReadonlySet<number>,
	toggleOrd: number
): Set<number> | null {
	const { kinds } = describeAccordion(doc);
	const { members, memberCountByGroup } = assignAccordion({
		kinds,
		headerCount: HEADER_COUNT
	});
	const m = members.find(x => x.ord === toggleOrd && x.isListBearing);
	if (!m) return null;
	if ((memberCountByGroup.get(m.group) ?? 0) < 2) return null;
	// members are built in doc order → ascending ord within the group.
	const groupMembers = members.filter(
		x => x.group === m.group && x.isListBearing
	);
	const cur = focusedInGroup(prev, members, m.group);
	const next = new Set(prev);
	for (const gm of groupMembers) next.delete(gm.ord);
	if (cur === m.ord) {
		const idx = groupMembers.findIndex(x => x.ord === m.ord);
		next.add(groupMembers[(idx + 1) % groupMembers.length].ord);
	} else {
		next.add(m.ord);
	}
	return next;
}

/** Drop focus ordinals that are no longer list-bearing members, and keep
 *  at most one per group (lowest ord wins). */
function reconcileAgainstDoc(
	doc: PMNode,
	focused: ReadonlySet<number>
): { changed: boolean; next: Set<number> } {
	const { kinds } = describeAccordion(doc);
	const { members } = assignAccordion({ kinds, headerCount: HEADER_COUNT });
	const validByOrd = new Map<number, AccordionMember>();
	for (const m of members) if (m.isListBearing) validByOrd.set(m.ord, m);
	const seenGroup = new Set<number>();
	const next = new Set<number>();
	let changed = false;
	for (const ord of [...focused].sort((a, b) => a - b)) {
		const m = validByOrd.get(ord);
		if (!m) {
			changed = true;
			continue;
		}
		if (seenGroup.has(m.group)) {
			changed = true;
			continue;
		}
		seenGroup.add(m.group);
		next.add(ord);
	}
	return { changed, next };
}

function buildDecorations(
	doc: PMNode,
	focused: ReadonlySet<number>
): DecorationSet {
	const { kinds, positions } = describeAccordion(doc);
	const { members, memberCountByGroup } = assignAccordion({
		kinds,
		headerCount: HEADER_COUNT
	});
	const decos: Decoration[] = [];
	for (const m of members) {
		if (!m.isListBearing) continue;
		if ((memberCountByGroup.get(m.group) ?? 0) < 2) continue;
		const f = focusedInGroup(focused, members, m.group);
		const isOpen = f === null || f === m.ord;
		const dividerFrom = positions[m.index];
		const ord = m.ord;
		decos.push(
			Decoration.widget(
				dividerFrom + 1,
				view => {
					const btn = document.createElement('button');
					btn.type = 'button';
					btn.className =
						'tomboy-labeled-fold-btn' +
						(isOpen ? '' : ' tomboy-labeled-fold-btn-folded');
					btn.textContent = isOpen ? '−' : '+';
					btn.title = isOpen ? '다음 리스트 보기' : '이 리스트 펼치기';
					btn.setAttribute('aria-label', btn.title);
					btn.setAttribute('contenteditable', 'false');
					btn.addEventListener('mousedown', e => {
						e.preventDefault();
						e.stopPropagation();
					});
					btn.addEventListener('click', e => {
						e.preventDefault();
						e.stopPropagation();
						if (view.isDestroyed) return;
						view.dispatch(
							view.state.tr.setMeta(labeledFoldPluginKey, { toggle: ord })
						);
					});
					return btn;
				},
				{
					side: -1,
					ignoreSelection: true,
					key: `tomboy-labeled-fold-btn-${ord}-${isOpen ? 'open' : 'folded'}`
				}
			)
		);
		if (!isOpen) {
			for (const li of m.listIndices) {
				const from = positions[li];
				const node = doc.child(li);
				decos.push(
					Decoration.node(from, from + node.nodeSize, {
						class: 'tomboy-labeled-fold-hidden'
					})
				);
			}
		}
	}
	return DecorationSet.create(doc, decos);
}

/**
 * Labeled-divider list accordion plugin.
 *
 * `텍스트 ---` dividers whose next block is a list become foldable
 * members. Members are grouped by plain `---` HR markers; within a group
 * at most one member's list shows at a time (focus). Toggling the open
 * member cycles to the next (wrapping); toggling a closed member jumps.
 * Default (no focus) shows all lists.
 *
 * Toggle is via the `+/−` widget button only (no line-click / handleClick)
 * so the divider's editable label text stays clickable.
 *
 * Inert while hrSplit is active (the split's grid placement assumes every
 * block is visible). Decoration-only — never restructures the DOM.
 */
export function createLabeledFoldPlugin(
	options: LabeledFoldOptions = {}
): Plugin {
	return new Plugin<LabeledFoldPluginState>({
		key: labeledFoldPluginKey,
		state: {
			init(): LabeledFoldPluginState {
				return { focused: new Set() };
			},
			apply(
				tr: Transaction,
				prev: LabeledFoldPluginState,
				_old,
				newState
			): LabeledFoldPluginState {
				const meta = tr.getMeta(labeledFoldPluginKey) as Meta | undefined;
				let next = prev.focused;
				let changed = false;
				let cameFromReplace = false;

				if (meta) {
					if (isReplace(meta)) {
						next = new Set(
							meta.replace.filter(n => Number.isInteger(n) && n >= 0)
						);
						changed = true;
						cameFromReplace = true;
					} else if (isToggle(meta)) {
						const toggled = applyToggle(newState.doc, prev.focused, meta.toggle);
						if (toggled) {
							next = toggled;
							changed = true;
						}
					}
				}

				let prunedByDoc = false;
				if (tr.docChanged) {
					const { changed: pruned, next: rec } = reconcileAgainstDoc(
						newState.doc,
						next
					);
					if (pruned) {
						next = rec;
						prunedByDoc = true;
						changed = true;
					}
				}

				if (!changed) return prev;
				if (!cameFromReplace || prunedByDoc) {
					const prevSnapshot = prev.focused;
					const nextSnapshot = next;
					queueMicrotask(() => options.onChange?.(nextSnapshot, prevSnapshot));
				}
				return { focused: next };
			}
		},
		props: {
			decorations(state: EditorState) {
				const s = labeledFoldPluginKey.getState(state);
				if (!s) return null;
				// Inert while the column split is active.
				const split = hrSplitPluginKey.getState(state);
				if (split && split.activeOrdinals.size > 0) return null;
				return buildDecorations(state.doc, s.focused);
			}
		}
	});
}

export function getFocusedOrdinals(state: EditorState): ReadonlySet<number> {
	const s = labeledFoldPluginKey.getState(state);
	return s?.focused ?? new Set();
}
```

- [ ] **Step 4: 통과 확인** — Run: `cd app && npx vitest run tests/unit/editor/labeledFoldPlugin.test.ts` → PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/labeledDivider/labeledFoldPlugin.ts app/tests/unit/editor/labeledFoldPlugin.test.ts
git commit -m "feat(labeledDivider): labeledFoldPlugin 아코디언 접기 + 테스트"
```

---

### Task 4: `TomboyEditor.svelte` 배선 + CSS

**Goal:** 새 플러그인 Extension 등록, 노트 로드 시 포커스 상태 reseed(두 지점), onChange 영속, 버튼·숨김 CSS 추가.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (imports / Extension 등록 ~733 / 두 reseed 블록 ~1297·~1337 / CSS ~2068 근처)

**Acceptance Criteria:**
- [ ] `createLabeledFoldPlugin` Extension 이 `tomboyLabeledDivider` 다음에 등록.
- [ ] 두 reseed 블록 모두 `labeledFoldPluginKey` replace 디스패치 추가.
- [ ] onChange → `saveFocusedOrdinals(lastAppliedGuid, …)`.
- [ ] CSS `.tomboy-labeled-fold-btn`(+hover) / `.tomboy-labeled-fold-hidden` 추가.
- [ ] `npm run check` 통과.

**Verify:** `cd app && npm run check` → 0 errors; `npm run dev` 후 브라우저에서 수동 확인(아래 Step 5).

**Steps:**

- [ ] **Step 1: import 추가** — `TomboyEditor.svelte` 의 labeledDivider import(`import { createLabeledDividerPlugin } from "./labeledDivider/labeledDividerPlugin.js";`) 바로 아래에:

```ts
	import {
		createLabeledFoldPlugin,
		labeledFoldPluginKey,
	} from "./labeledDivider/labeledFoldPlugin.js";
	import {
		loadFocusedOrdinals,
		saveFocusedOrdinals,
	} from "./labeledDivider/labeledFoldStore.js";
```

- [ ] **Step 2: Extension 등록** — `tomboyLabeledDivider` Extension 블록

```ts
				Extension.create({
					name: "tomboyLabeledDivider",
					addProseMirrorPlugins() {
						return [createLabeledDividerPlugin()];
					},
				}),
```

바로 뒤에 추가:

```ts
				Extension.create({
					name: "tomboyLabeledFold",
					addProseMirrorPlugins() {
						return [
							createLabeledFoldPlugin({
								onChange: (focused) => {
									saveFocusedOrdinals(lastAppliedGuid, focused);
								},
							}),
						];
					},
				}),
```

- [ ] **Step 3: reseed 두 지점** — 첫 reseed 블록(초기 노트, hrFold replace 디스패치 직후)에 추가:

```ts
				ed.view.dispatch(
					ed.state.tr.setMeta(labeledFoldPluginKey, {
						replace: Array.from(loadFocusedOrdinals(g)),
					}),
				);
```

같은 코드를 두 번째 reseed 블록(노트 reload, 두 번째 hrFold replace 디스패치 직후)에도 추가. **두 곳 모두** 넣어야 함(초기 로드 + 동일/타 노트 reload).

- [ ] **Step 4: CSS 추가** — `.tomboy-hr-fold-hidden` 규칙 블록(약 2066–2068줄) 다음, `.tomboy-labeled-divider` 규칙 앞에 삽입:

```css
	/* Labeled-divider list accordion — `+/−` 버튼으로 그룹당 한 리스트만
	   펼침. 버튼은 라벨 디바이더(position:relative + isolation:isolate)
	   안에 절대배치; 숨김은 소유 리스트 블록에 display:none. */
	.tomboy-editor :global(.tomboy-labeled-fold-btn) {
		position: absolute;
		right: 0;
		top: 50%;
		transform: translateY(-50%);
		width: 22px;
		height: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: 1.5px solid #777;
		border-radius: 4px;
		background: #fff;
		color: #333;
		font-size: 15px;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
		user-select: none;
		opacity: 0.9;
		/* Above the label (z-index:1) and the ::before line (z-index:0). */
		z-index: 2;
	}
	.tomboy-editor :global(.tomboy-labeled-fold-btn:hover) {
		opacity: 1;
		color: #000;
		border-color: #444;
		background: #f2f2f2;
	}
	.tomboy-editor :global(.tomboy-labeled-fold-hidden) {
		display: none;
	}
```

- [ ] **Step 5: 타입 체크 + 수동 검증** — Run: `cd app && npm run check` → 0 errors. 그 다음 `npm run dev`, 브라우저에서 노트 작성:

```
제목
2026-06-17

섹션1 ---
- 항목 a1
- 항목 a2
섹션2 ---
- 항목 b1
섹션3 ---
- 항목 c1
```

확인: 각 `섹션N ---` 우측에 `−` 버튼(세 멤버 모두 group0, count 3 ≥2). `섹션1` 버튼 클릭 → 섹션1 리스트만 남고 2·3 리스트 숨김. `섹션1` 다시 클릭 → 다음(섹션2)로 순환. 맨 끝(섹션3) 열린 상태에서 클릭 → 섹션1로 래핑. 페이지 새로고침 → 마지막 포커스 유지. 그 다음 `---`(순수) 한 줄로 그룹을 나눠 양쪽이 서로 영향 없는지 확인.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(labeledDivider): TomboyEditor 아코디언 배선 + CSS"
```

---

### Task 5: 설정 → 가이드 카드

**Goal:** 설정 → 가이드 → 편집 탭에 제목 수평선 리스트 아코디언(겸 라벨 구분선 렌더) 카드 추가. CLAUDE.md 필수 요건.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (`guideSubTab === 'editor'` 영역, HR fold 카드 `</details>` 다음)

**Acceptance Criteria:**
- [ ] `guideSubTab === 'editor'` 안에 새 `<details class="guide-card">` 추가.
- [ ] 형식(`텍스트 ---` / `-- 텍스트 --`), 멤버 조건(다음 블록이 리스트), 그룹(`---` 경계), 동작(버튼 클릭=포커스, 닫기=다음 순환), 기기 저장/비동기화, split 동시사용 불가를 설명.
- [ ] 기존 카드 패턴(summary + info-text + snippet + guide-list) 준수.
- [ ] `npm run check` 통과.

**Verify:** `cd app && npm run check` → 0 errors; `npm run dev` → 설정 → 가이드 → 편집 탭에 카드 노출.

**Steps:**

- [ ] **Step 1: 카드 삽입** — `+page.svelte`, HR fold 카드(`<summary>수평선 (<code>---</code>) — 섹션 구분 · 접기 · 나란히 보기</summary>` 로 시작하는 `<details>`)의 닫는 `</details>` 바로 다음에:

```svelte
				<details class="guide-card">
					<summary>제목 수평선 + 리스트 아코디언 (<code>텍스트 ---</code>)</summary>
					<p class="info-text">
						<code>텍스트 ---</code>(왼쪽) 또는 <code>-- 텍스트 --</code>(가운데)처럼
						<strong>라벨이 박힌 구분선</strong>을 만들 수 있습니다. 그 구분선
						<strong>바로 다음 줄이 리스트</strong>면, 구분선 우측 끝의
						<code>−</code> / <code>+</code> 버튼으로 <strong>그룹당 한 리스트만</strong>
						펼쳐 볼 수 있습니다 — 리스트가 많아 길어질 때 하나씩 보기 위한 기능입니다.
					</p>
					<pre class="snippet">개요 ---            [−]
- 개요 항목 1
- 개요 항목 2
상세 ---            [+]   ← 접힘
- 상세 항목 1
---                       ← 여기서 그룹이 나뉨(독립)
부록 ---
- 부록 항목</pre>
					<ul class="guide-list">
						<li><strong>멤버 조건</strong> — 구분선 <strong>바로 다음 블록이 리스트</strong>일 때만
							접기 버튼이 생깁니다. 다음이 리스트가 아니면 그냥 라벨 구분선입니다. 접히는 건
							<strong>리스트뿐</strong> — 구분선과 다른 문단은 그대로 남습니다.</li>
						<li><strong>그룹</strong> — 대시만 있는 <code>---</code> 한 줄이 경계입니다. 같은 그룹
							안에서만 "한 개만 펼침"이 적용되고, <code>---</code> 경계를 넘으면 서로 영향을 주지
							않습니다. (<code>---</code>가 없으면 노트 전체가 한 그룹.)</li>
						<li><strong>펼치기 / 순환</strong> — 닫힌 리스트의 <code>+</code>를 누르면 그 리스트가
							열리고 같은 그룹의 나머지는 접힙니다. 열린 리스트의 <code>−</code>를 누르면
							<strong>다음 리스트로 넘어갑니다</strong>(맨 끝이면 처음으로 순환). 항상 그룹당 하나만
							열립니다.</li>
						<li>같은 그룹에 접을 수 있는 리스트가 <strong>2개 이상</strong>일 때만 버튼이 나타납니다.</li>
						<li>접기 상태는 <strong>이 기기(브라우저)에만</strong> 저장됩니다 — 노트 내용·동기화에는
							영향이 없습니다. 모바일 · 데스크탑 모두 동작합니다.</li>
						<li><strong>나란히 보기(세로 칼럼 분할)가 켜진 동안에는 동작하지 않습니다</strong> — 분할이
							모든 블록이 보인다고 가정하기 때문입니다.</li>
						<li>숨겨진 리스트도 전체 선택 · 복사 · 검색에는 그대로 포함됩니다.</li>
					</ul>
				</details>
```

- [ ] **Step 2: 타입 체크** — Run: `cd app && npm run check` → 0 errors

- [ ] **Step 3: 커밋**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(settings): 제목 수평선 리스트 아코디언 가이드 카드"
```

---

## 최종 검증

- [ ] 전체 테스트: `cd app && npm run test` → 모두 통과(신규 3개 파일 포함).
- [ ] 타입: `cd app && npm run check` → 0 errors.
- [ ] 수동(Firefox/Chrome): Task 4 Step 5 시나리오 + `---` 그룹 분리 동작.
