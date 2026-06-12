# 노트 묶음 (Note Bundle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `[ ]노트 묶음:N` 키워드 + 내부 링크 리스트를 서류함 스택(접힌 제목 바 ≤4 + 펼친 임베디드 에디터)으로 렌더하는 순수 뷰 레이어 에디터 기능.

**Architecture:** ProseMirror 위젯 데코레이션이 체크 시 링크 리스트를 숨기고 그 자리에 Svelte 스택 컴포넌트를 mount(). 펼친 노트는 진짜 TomboyEditor 인스턴스(자체 저장 파이프라인). 라디오 atom = 펼침 상태 영구화, `:N` 텍스트 = 높이 영구화. XML 무변경 (geoMap 패턴).

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap 3 / ProseMirror, vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-06-12-note-bundle-design.md`

---

## 사전 컨텍스트 (구현자 필독)

- **inlineCheckbox / inlineRadio 는 atom 노드** (`src/lib/editor/inlineCheckbox/node.ts`, `inlineRadio/node.ts`). 노드명 `inlineCheckbox`(attr `checked`), `inlineRadio`(attr `selected`). plain-JSON 텍스트 스캔으로는 안 보임 — 라이브 PMNode 워크 필수.
- **내부 링크 마크** `tomboyInternalLink`, attr `target` = 대상 노트 제목 (`src/lib/editor/extensions/TomboyInternalLink.ts`).
- **title→guid**: `lookupGuidByTitle` / `ensureTitleIndexReady` (`src/lib/editor/autoLink/titleProvider.ts`). exact-case trimmed.
- **위젯 플러그인 패턴**: `src/lib/editor/geoMap/geoMapPlugin.ts` — buildState 재파싱, Decoration.widget, contenteditable=false, mousedown stopPropagation.
- **노트 로드/저장**: `getNote(guid)` / `updateNoteFromEditor(guid, doc)` / `getNoteEditorContent(note)` (`src/lib/core/noteManager.ts`). guid 다르면 동시 저장 안전.
- **버스**: `subscribeNoteReload(guid, fn)` (`src/lib/core/noteReloadBus.ts`). **Firestore**: `attachOpenNote/detachOpenNote` (`src/lib/sync/firebase/orchestrator.ts`).
- **NoteWindow 저장 패턴** (`src/lib/desktop/NoteWindow.svelte:148-440`): pendingDoc + 1500ms saveTimer + flushSave.
- **에디터 테스트**: jsdom + `new Editor({...})`, **afterEach destroy 필수** (teardown flake). 패턴: `tests/unit/editor/inlineRadio/node.test.ts`, `autoLinkTitleLine.test.ts`.
- 모든 명령은 `app/` 디렉토리에서 실행.

---

### Task 1: parser.ts + stackMath.ts (순수 함수 + 테스트)

**Goal:** doc 에서 BundleSpec[] 을 추출하는 파서와 스택 인덱스 계산 헬퍼.

**Files:**
- Create: `app/src/lib/editor/noteBundle/parser.ts`
- Create: `app/src/lib/editor/noteBundle/stackMath.ts`
- Test: `app/tests/unit/editor/noteBundle/parser.test.ts`
- Test: `app/tests/unit/editor/noteBundle/stackMath.test.ts`

**Acceptance Criteria:**
- [ ] `[ ]노트 묶음:30` + bulletList → BundleSpec(checked, heightPct=30, entries with title/radioPos/selected)
- [ ] `노트묶음:` 변형 허용, `:N` 생략 시 50, digitsFrom===digitsTo
- [ ] 체크박스 없는 라인 / 제목 라인(index 0) 미인식; 링크 마크 없는 항목 무시; 다중 번들 ordinal 0,1
- [ ] clampHeightPct: 5→20, 95→90, NaN→50

**Verify:** `cd app && npx vitest run tests/unit/editor/noteBundle/` → all pass

**Steps:**

- [ ] **Step 1: stackMath.ts 작성**

```ts
/** 노트 묶음 스택 인덱스 계산 — 순수 함수. */
export const MAX_COLLAPSED_BARS = 4;

/** 접힌 바 윈도우 시작 — 펼침 k 위로 최대 4개 (총 타이틀 5개). */
export function collapsedBarStart(k: number): number {
	return Math.max(0, k - MAX_COLLAPSED_BARS);
}

export interface ResolvedEntryLike {
	broken: boolean;
}

/** dir 방향 가장 가까운 펼침 가능(비-broken) 인덱스. 없으면 from 유지. */
export function nextValidIndex(entries: ResolvedEntryLike[], from: number, dir: 1 | -1): number {
	let i = from + dir;
	while (i >= 0 && i < entries.length) {
		if (!entries[i].broken) return i;
		i += dir;
	}
	return from;
}

/** 첫 펼침 가능 인덱스. 없으면 -1. */
export function firstValidIndex(entries: ResolvedEntryLike[]): number {
	for (let i = 0; i < entries.length; i++) if (!entries[i].broken) return i;
	return -1;
}
```

- [ ] **Step 2: parser.ts 작성**

```ts
/**
 * 노트 묶음 파서.
 *
 * `[ ]노트 묶음:N` 키워드 paragraph + 직후 bulletList(내부 링크 항목)를
 * 라이브 PMNode 워크로 찾아 BundleSpec[] 로 반환. 체크박스/라디오는 atom
 * 노드라 plain-JSON 텍스트 스캔으로는 보이지 않는다 — 노드 트리를 걷는다.
 *
 * 순수 함수: IDB/타이틀 인덱스 접근 없음. guid 해석은 NoteBundleStack 이
 * lookupGuidByTitle 로 수행.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

export interface BundleEntry {
	/** tomboyInternalLink mark 의 target (= 대상 노트 제목) */
	title: string;
	/** listItem 첫 paragraph 의 inline 시작 pos — 라디오 자동 삽입 지점 */
	itemTextFrom: number;
	/** inlineRadio atom pos. 없으면 null (자동 삽입 대상) */
	radioPos: number | null;
	selected: boolean;
}

export interface BundleSpec {
	ordinal: number;
	checkboxPos: number;
	checked: boolean;
	/** 20–90 클램프, 생략 시 50 */
	heightPct: number;
	/** `:` 뒤 숫자 텍스트 범위 — 높이 쓰기백 대상. 숫자 없으면 from===to */
	digitsFrom: number;
	digitsTo: number;
	/** 키워드 paragraph 끝 pos — 리스트 없을 때 위젯 fallback 위치 */
	keywordEnd: number;
	listPos: number | null;
	listEnd: number | null;
	entries: BundleEntry[];
}

export const DEFAULT_HEIGHT_PCT = 50;

export function clampHeightPct(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_HEIGHT_PCT;
	return Math.min(90, Math.max(20, Math.round(n)));
}

const KEYWORD_RE = /^\s*노트\s*묶음:(\d+)?\s*$/;

interface KeywordInfo {
	checkboxPos: number;
	checked: boolean;
	heightPct: number;
	digitsFrom: number;
	digitsTo: number;
	keywordEnd: number;
}

function parseKeywordParagraph(para: PMNode, paraPos: number): KeywordInfo | null {
	if (para.childCount < 2) return null;
	const first = para.child(0);
	if (first.type.name !== 'inlineCheckbox') return null;
	let text = '';
	for (let i = 1; i < para.childCount; i++) {
		const c = para.child(i);
		if (!c.isText) return null;
		text += c.text ?? '';
	}
	const m = KEYWORD_RE.exec(text);
	if (!m) return null;
	const colonIdx = text.indexOf(':');
	const digitsLen = m[1]?.length ?? 0;
	// 키워드 텍스트 시작 abs pos = paragraph 내용 시작(paraPos+1) + 체크박스 nodeSize 1
	const textBase = paraPos + 2;
	return {
		checkboxPos: paraPos + 1,
		checked: first.attrs.checked === true,
		heightPct: m[1] ? clampHeightPct(parseInt(m[1], 10)) : DEFAULT_HEIGHT_PCT,
		digitsFrom: textBase + colonIdx + 1,
		digitsTo: textBase + colonIdx + 1 + digitsLen,
		keywordEnd: paraPos + para.nodeSize
	};
}

function parseListEntries(list: PMNode, listPos: number): BundleEntry[] {
	const entries: BundleEntry[] = [];
	list.forEach((li, liOff) => {
		if (li.type.name !== 'listItem' || li.childCount === 0) return;
		const para = li.child(0);
		if (para.type.name !== 'paragraph') return;
		const liPos = listPos + 1 + liOff;
		const paraPos = liPos + 1;
		let radioPos: number | null = null;
		let selected = false;
		let title: string | null = null;
		para.forEach((child, childOff) => {
			const abs = paraPos + 1 + childOff;
			if (child.type.name === 'inlineRadio' && radioPos === null) {
				radioPos = abs;
				selected = child.attrs.selected === true;
			} else if (child.isText && title === null) {
				const mark = child.marks.find((mk) => mk.type.name === 'tomboyInternalLink');
				if (mark?.attrs.target) title = String(mark.attrs.target);
			}
		});
		if (title !== null) {
			entries.push({ title, itemTextFrom: paraPos + 1, radioPos, selected });
		}
	});
	return entries;
}

export function parseNoteBundles(doc: PMNode): BundleSpec[] {
	const out: BundleSpec[] = [];
	let pending: KeywordInfo | null = null;

	const flush = (list: PMNode | null, listPos: number | null) => {
		if (!pending) return;
		out.push({
			ordinal: out.length,
			checkboxPos: pending.checkboxPos,
			checked: pending.checked,
			heightPct: pending.heightPct,
			digitsFrom: pending.digitsFrom,
			digitsTo: pending.digitsTo,
			keywordEnd: pending.keywordEnd,
			listPos,
			listEnd: list && listPos !== null ? listPos + list.nodeSize : null,
			entries: list && listPos !== null ? parseListEntries(list, listPos) : []
		});
		pending = null;
	};

	doc.forEach((node, offset, index) => {
		if (pending) {
			if (node.type.name === 'bulletList') {
				flush(node, offset);
				return;
			}
			flush(null, null);
		}
		// index 0 = 제목 라인 — 번들 키워드로 취급하지 않는다
		if (index === 0) return;
		if (node.type.name === 'paragraph') {
			pending = parseKeywordParagraph(node, offset);
		}
	});
	flush(null, null);
	return out;
}
```

- [ ] **Step 3: stackMath.test.ts 작성**

```ts
import { describe, it, expect } from 'vitest';
import {
	collapsedBarStart,
	firstValidIndex,
	nextValidIndex
} from '$lib/editor/noteBundle/stackMath.js';

const e = (broken: boolean) => ({ broken });

describe('stackMath', () => {
	it('collapsedBarStart: k 위로 최대 4개', () => {
		expect(collapsedBarStart(0)).toBe(0);
		expect(collapsedBarStart(3)).toBe(0);
		expect(collapsedBarStart(4)).toBe(0);
		expect(collapsedBarStart(5)).toBe(1);
		expect(collapsedBarStart(9)).toBe(5);
	});

	it('nextValidIndex: broken 건너뜀, 끝이면 from 유지', () => {
		const entries = [e(false), e(true), e(false)];
		expect(nextValidIndex(entries, 0, 1)).toBe(2);
		expect(nextValidIndex(entries, 2, -1)).toBe(0);
		expect(nextValidIndex(entries, 2, 1)).toBe(2);
		expect(nextValidIndex(entries, 0, -1)).toBe(0);
	});

	it('firstValidIndex: 전부 broken 이면 -1', () => {
		expect(firstValidIndex([e(true), e(false)])).toBe(1);
		expect(firstValidIndex([e(true), e(true)])).toBe(-1);
		expect(firstValidIndex([])).toBe(-1);
	});
});
```

- [ ] **Step 4: parser.test.ts 작성**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyInlineCheckbox } from '$lib/editor/inlineCheckbox';
import { TomboyInlineRadio } from '$lib/editor/inlineRadio';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import {
	parseNoteBundles,
	clampHeightPct,
	DEFAULT_HEIGHT_PCT
} from '$lib/editor/noteBundle/parser.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(content: object): Editor {
	currentEditor = new Editor({
		extensions: [
			StarterKit,
			...TomboyInlineCheckbox,
			...TomboyInlineRadio,
			TomboyInternalLink.configure({
				getTitles: () => [],
				getCurrentGuid: () => null,
				deferred: true // 자동 스캔 억제 — 파서 입력을 그대로 유지
			})
		],
		content
	});
	return currentEditor;
}

// --- JSON 빌더 ----------------------------------------------------------
const titleLine = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const kw = (text: string, checked = false) => ({
	type: 'paragraph',
	content: [{ type: 'inlineCheckbox', attrs: { checked } }, { type: 'text', text }]
});
const li = (t: string, radio: boolean | null) => ({
	type: 'listItem',
	content: [
		{
			type: 'paragraph',
			content: [
				...(radio === null ? [] : [{ type: 'inlineRadio', attrs: { selected: radio } }]),
				{
					type: 'text',
					text: t,
					marks: [{ type: 'tomboyInternalLink', attrs: { target: t } }]
				}
			]
		}
	]
});
const list = (...items: object[]) => ({ type: 'bulletList', content: items });
const doc = (...blocks: object[]) => ({ type: 'doc', content: blocks });

describe('parseNoteBundles', () => {
	it('기본 번들: 체크박스 + 노트 묶음:30 + 라디오/링크 리스트', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('노트 묶음:30', true),
				list(li('노트A', false), li('노트B', true), li('노트C', null))
			)
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(1);
		const b = bundles[0];
		expect(b.checked).toBe(true);
		expect(b.heightPct).toBe(30);
		expect(b.listPos).not.toBeNull();
		expect(b.entries.map((e) => e.title)).toEqual(['노트A', '노트B', '노트C']);
		expect(b.entries[0].selected).toBe(false);
		expect(b.entries[1].selected).toBe(true);
		expect(b.entries[2].radioPos).toBeNull();
		// digits 범위가 실제 "30" 텍스트를 가리킨다
		expect(ed.state.doc.textBetween(b.digitsFrom, b.digitsTo)).toBe('30');
	});

	it('키워드 변형: 노트묶음(붙임) + :N 생략 → 기본 50, digits 빈 범위', () => {
		const ed = makeEditor(doc(titleLine('호스트'), kw('노트묶음:'), list(li('노트A', null))));
		const b = parseNoteBundles(ed.state.doc)[0];
		expect(b.heightPct).toBe(DEFAULT_HEIGHT_PCT);
		expect(b.digitsFrom).toBe(b.digitsTo);
		expect(b.checked).toBe(false);
	});

	it('체크박스 없는 키워드 라인은 미인식', () => {
		const ed = makeEditor(
			doc(titleLine('호스트'), titleLine('노트 묶음:50'), list(li('노트A', null)))
		);
		expect(parseNoteBundles(ed.state.doc)).toHaveLength(0);
	});

	it('제목 라인(index 0)은 번들 키워드로 취급하지 않음', () => {
		const ed = makeEditor(doc(kw('노트 묶음:50'), list(li('노트A', null))));
		expect(parseNoteBundles(ed.state.doc)).toHaveLength(0);
	});

	it('링크 마크 없는 항목 무시 + 리스트 없는 번들은 entries 빈 배열', () => {
		const plainLi = {
			type: 'listItem',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '그냥 텍스트' }] }]
		};
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kw('노트 묶음:'),
				list(plainLi, li('노트A', null)),
				kw('노트 묶음:70')
			)
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(2);
		expect(bundles[0].entries.map((e) => e.title)).toEqual(['노트A']);
		expect(bundles[1].entries).toEqual([]);
		expect(bundles[1].listPos).toBeNull();
		expect(bundles.map((b) => b.ordinal)).toEqual([0, 1]);
	});
});

describe('clampHeightPct', () => {
	it('20–90 클램프, NaN → 기본값', () => {
		expect(clampHeightPct(5)).toBe(20);
		expect(clampHeightPct(95)).toBe(90);
		expect(clampHeightPct(50)).toBe(50);
		expect(clampHeightPct(NaN)).toBe(DEFAULT_HEIGHT_PCT);
	});
});
```

- [ ] **Step 5: 테스트 실행**

Run: `cd app && npx vitest run tests/unit/editor/noteBundle/`
Expected: parser + stackMath all PASS

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/noteBundle/ app/tests/unit/editor/noteBundle/
git commit -m "feat(noteBundle): 노트 묶음 파서 + 스택 인덱스 헬퍼"
```

---

### Task 2: noteBundlePlugin.ts (데코레이션 + 라디오 자동삽입 + tr 헬퍼)

**Goal:** 체크된 번들에 리스트 숨김 + 위젯 데코레이션, 라디오 의무 자동삽입, selectBundleEntry / writeBundleHeightPct 헬퍼.

**Files:**
- Create: `app/src/lib/editor/noteBundle/noteBundlePlugin.ts`
- Create: `app/src/lib/editor/noteBundle/index.ts`
- Test: `app/tests/unit/editor/noteBundle/noteBundlePlugin.test.ts`

**Acceptance Criteria:**
- [ ] checked 번들 → mountStack 1회 호출(리마운트 없음), 리스트에 `tomboy-note-bundle-hidden` 노드 데코레이션
- [ ] checked + 라디오 없는 항목 → microtask 후 inlineRadio 자동 삽입, 선택 없으면 첫 항목 `(o)`
- [ ] 체크 해제 → controller.destroy 호출, 데코레이션 제거
- [ ] selectBundleEntry → 라디오 상호 배타 갱신; writeBundleHeightPct → `:N` 텍스트 교체(숫자 없으면 삽입)
- [ ] serializeContent 라운드트립에 `[x]노트 묶음:` / `(o)` 보존 (XML 무변경 확인)

**Verify:** `cd app && npx vitest run tests/unit/editor/noteBundle/noteBundlePlugin.test.ts` → PASS

**Steps:**

- [ ] **Step 1: noteBundlePlugin.ts 작성**

```ts
/**
 * 노트 묶음 ProseMirror 플러그인.
 *
 * - 체크된 번들: 링크 리스트에 .tomboy-note-bundle-hidden 노드 데코레이션
 *   + 리스트 끝(리스트 없으면 키워드 끝)에 위젯 → mountStack 콜백으로
 *   Svelte 스택 마운트. 순수 뷰 레이어, XML 무변경 (geoMap 패턴).
 * - 라디오 의무: 체크된 번들에 라디오 없는 링크 항목이 보이면 microtask
 *   에서 자동 삽입 tr 디스패치 (멱등 — 삽입 후엔 missing 이 없다).
 * - 위젯 컨테이너는 ordinal 키로 캐시 — 호스트 타이핑마다 스택이
 *   리마운트되지 않는다. spec 변경은 StackController.update 로 전달.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseNoteBundles, clampHeightPct, type BundleSpec } from './parser.js';

export interface StackController {
	update(spec: BundleSpec): void;
	destroy(): void;
}

export interface NoteBundleOptions {
	mountStack(container: HTMLElement, view: EditorView, spec: BundleSpec): StackController;
}

interface PluginState {
	bundles: BundleSpec[];
	decorations: DecorationSet;
}

export const noteBundlePluginKey = new PluginKey<PluginState>('tomboyNoteBundle');

function buildState(doc: PMNode, containers: Map<number, HTMLElement>): PluginState {
	const bundles = parseNoteBundles(doc);
	const decos: Decoration[] = [];
	for (const b of bundles) {
		if (!b.checked) continue;
		if (b.listPos !== null && b.listEnd !== null && b.entries.length > 0) {
			decos.push(
				Decoration.node(b.listPos, b.listEnd, { class: 'tomboy-note-bundle-hidden' })
			);
		}
		const widgetPos = b.listEnd ?? b.keywordEnd;
		decos.push(
			Decoration.widget(
				widgetPos,
				() => {
					// 같은 ordinal 은 항상 같은 엘리먼트 — PM 이 toDOM 을 다시
					// 불러도 마운트된 Svelte 컴포넌트가 보존된다.
					let el = containers.get(b.ordinal);
					if (el) return el;
					el = document.createElement('div');
					el.className = 'tomboy-note-bundle';
					el.setAttribute('contenteditable', 'false');
					containers.set(b.ordinal, el);
					return el;
				},
				{ key: `note-bundle-${b.ordinal}`, side: 1 }
			)
		);
	}
	return {
		bundles,
		decorations: decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty
	};
}

export function createNoteBundlePlugin(opts: NoteBundleOptions): Plugin<PluginState> {
	const containers = new Map<number, HTMLElement>();
	const controllers = new Map<number, StackController>();
	let insertScheduled = false;

	const syncControllers = (view: EditorView) => {
		const st = noteBundlePluginKey.getState(view.state);
		if (!st) return;
		const active = new Set<number>();
		for (const b of st.bundles) {
			if (!b.checked) continue;
			active.add(b.ordinal);
			const existing = controllers.get(b.ordinal);
			if (existing) {
				existing.update(b);
			} else {
				const el = containers.get(b.ordinal);
				if (el && el.isConnected) {
					controllers.set(b.ordinal, opts.mountStack(el, view, b));
				}
			}
		}
		for (const [ord, ctrl] of [...controllers]) {
			if (!active.has(ord)) {
				ctrl.destroy();
				controllers.delete(ord);
				containers.delete(ord);
			}
		}
	};

	const scheduleRadioInsert = (view: EditorView) => {
		if (insertScheduled) return;
		const st = noteBundlePluginKey.getState(view.state);
		if (!st) return;
		const needs = st.bundles.some(
			(b) => b.checked && b.entries.some((e) => e.radioPos === null)
		);
		if (!needs) return;
		insertScheduled = true;
		// microtask 로 미루는 이유: 플러그인 view.update 안에서 dispatch 금지.
		queueMicrotask(() => {
			insertScheduled = false;
			if (view.isDestroyed) return;
			// 신선한 state 에서 재계산 — 사이 편집으로 pos 가 밀려도 안전.
			const cur = noteBundlePluginKey.getState(view.state);
			const radioType = view.state.schema.nodes.inlineRadio;
			if (!cur || !radioType) return;
			const tr = view.state.tr;
			let changed = false;
			for (const b of cur.bundles) {
				if (!b.checked) continue;
				const missing = b.entries.filter((e) => e.radioPos === null);
				if (missing.length === 0) continue;
				const hasSelected = b.entries.some((e) => e.selected);
				const firstEntry = b.entries[0];
				// 뒤에서 앞으로 삽입 — 앞 위치가 밀리지 않게.
				const sorted = [...missing].sort((a, z) => z.itemTextFrom - a.itemTextFrom);
				for (const e of sorted) {
					const makeSelected = !hasSelected && e === firstEntry;
					tr.insert(e.itemTextFrom, radioType.create({ selected: makeSelected }));
					changed = true;
				}
				// 첫 항목에 기존 라디오가 있는데 아무것도 선택 안 됨 → 첫 라디오 (o).
				// (삽입은 전부 뒤쪽 항목 — firstEntry.radioPos 는 밀리지 않는다.)
				if (!hasSelected && firstEntry && firstEntry.radioPos !== null) {
					tr.setNodeAttribute(firstEntry.radioPos, 'selected', true);
					changed = true;
				}
			}
			if (changed) view.dispatch(tr);
		});
	};

	return new Plugin<PluginState>({
		key: noteBundlePluginKey,
		state: {
			init: (_, s) => buildState(s.doc, containers),
			apply(tr, old) {
				if (!tr.docChanged) return old;
				return buildState(tr.doc, containers);
			}
		},
		props: {
			decorations(state) {
				return noteBundlePluginKey.getState(state)?.decorations;
			}
		},
		view(view) {
			// XML 로드 직후에도 체크된 번들이 있을 수 있다 — 초기 1회 sync.
			// (위젯 DOM 이 붙은 뒤여야 하므로 microtask 로 미룬다.)
			queueMicrotask(() => {
				if (view.isDestroyed) return;
				syncControllers(view);
				scheduleRadioInsert(view);
			});
			return {
				update(v) {
					syncControllers(v);
					scheduleRadioInsert(v);
				},
				destroy() {
					for (const c of controllers.values()) c.destroy();
					controllers.clear();
					containers.clear();
				}
			};
		}
	});
}

/** 스크롤/바 클릭 → 펼침 항목 변경. 라디오 상호 배타 tr 디스패치. */
export function selectBundleEntry(view: EditorView, bundle: BundleSpec, index: number): void {
	const tr = view.state.tr;
	bundle.entries.forEach((e, i) => {
		if (e.radioPos === null) return;
		const want = i === index;
		if (e.selected !== want) tr.setNodeAttribute(e.radioPos, 'selected', want);
	});
	if (tr.steps.length > 0) view.dispatch(tr);
}

/** 드래그 리사이즈 종료 → `:N` 텍스트 영구화. */
export function writeBundleHeightPct(view: EditorView, bundle: BundleSpec, pct: number): void {
	const clamped = clampHeightPct(pct);
	if (clamped === bundle.heightPct) return;
	view.dispatch(view.state.tr.insertText(String(clamped), bundle.digitsFrom, bundle.digitsTo));
}
```

- [ ] **Step 2: index.ts 작성**

```ts
export { parseNoteBundles, clampHeightPct, DEFAULT_HEIGHT_PCT } from './parser.js';
export type { BundleSpec, BundleEntry } from './parser.js';
export {
	createNoteBundlePlugin,
	noteBundlePluginKey,
	selectBundleEntry,
	writeBundleHeightPct
} from './noteBundlePlugin.js';
export type { NoteBundleOptions, StackController } from './noteBundlePlugin.js';
```

- [ ] **Step 3: noteBundlePlugin.test.ts 작성**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { EditorView } from '@tiptap/pm/view';
import { TomboyInlineCheckbox } from '$lib/editor/inlineCheckbox';
import { TomboyInlineRadio } from '$lib/editor/inlineRadio';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import {
	createNoteBundlePlugin,
	noteBundlePluginKey,
	selectBundleEntry,
	writeBundleHeightPct,
	type BundleSpec,
	type StackController
} from '$lib/editor/noteBundle';
import { serializeContent } from '$lib/core/noteContentArchiver.js';

let currentEditor: Editor | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
	host?.remove();
	host = null;
});

function makeStub() {
	const calls = { mounted: 0, updates: [] as BundleSpec[], destroyed: 0 };
	const mountStack = (
		_c: HTMLElement,
		_v: EditorView,
		_s: BundleSpec
	): StackController => {
		calls.mounted++;
		return {
			update: (s) => calls.updates.push(s),
			destroy: () => calls.destroyed++
		};
	};
	return { calls, mountStack };
}

function makeEditor(content: object, mountStack: ReturnType<typeof makeStub>['mountStack']) {
	// 위젯 isConnected 가드 통과를 위해 실제 document 에 붙인다.
	host = document.createElement('div');
	document.body.appendChild(host);
	currentEditor = new Editor({
		element: host,
		extensions: [
			StarterKit,
			...TomboyInlineCheckbox,
			...TomboyInlineRadio,
			TomboyInternalLink.configure({
				getTitles: () => [],
				getCurrentGuid: () => null,
				deferred: true
			}),
			Extension.create({
				name: 'tomboyNoteBundle',
				addProseMirrorPlugins() {
					return [createNoteBundlePlugin({ mountStack })];
				}
			})
		],
		content
	});
	return currentEditor;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const titleLine = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const kw = (text: string, checked: boolean) => ({
	type: 'paragraph',
	content: [{ type: 'inlineCheckbox', attrs: { checked } }, { type: 'text', text }]
});
const li = (t: string, radio: boolean | null) => ({
	type: 'listItem',
	content: [
		{
			type: 'paragraph',
			content: [
				...(radio === null ? [] : [{ type: 'inlineRadio', attrs: { selected: radio } }]),
				{
					type: 'text',
					text: t,
					marks: [{ type: 'tomboyInternalLink', attrs: { target: t } }]
				}
			]
		}
	]
});
const list = (...items: object[]) => ({ type: 'bulletList', content: items });
const doc = (...blocks: object[]) => ({ type: 'doc', content: blocks });

function radios(ed: Editor): boolean[] {
	const out: boolean[] = [];
	ed.state.doc.descendants((n) => {
		if (n.type.name === 'inlineRadio') out.push(n.attrs.selected === true);
	});
	return out;
}

describe('noteBundlePlugin', () => {
	it('checked 번들 → 스택 1회 마운트 + 리스트 숨김 데코레이션', async () => {
		const { calls, mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', true), list(li('A', true), li('B', false))),
			mountStack
		);
		await tick();
		expect(calls.mounted).toBe(1);
		const st = noteBundlePluginKey.getState(ed.state)!;
		const b = st.bundles[0];
		const hidden = st.decorations.find(b.listPos!, b.listEnd!);
		expect(hidden.length).toBeGreaterThan(0);
		// 호스트 타이핑 → 리마운트 없음, update 로 전달
		ed.commands.insertContentAt(ed.state.doc.content.size, { type: 'paragraph' });
		await tick();
		expect(calls.mounted).toBe(1);
		expect(calls.updates.length).toBeGreaterThan(0);
	});

	it('unchecked 번들 → 마운트 안 함', async () => {
		const { calls, mountStack } = makeStub();
		makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', false), list(li('A', true))),
			mountStack
		);
		await tick();
		expect(calls.mounted).toBe(0);
	});

	it('라디오 자동삽입: checked + 라디오 없는 항목 → 삽입 + 첫 항목 (o)', async () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', true), list(li('A', null), li('B', null))),
			mountStack
		);
		await tick();
		await tick(); // 삽입 tr 반영
		expect(radios(ed)).toEqual([true, false]);
	});

	it('체크 해제 → destroy + 데코레이션 제거', async () => {
		const { calls, mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', true), list(li('A', true))),
			mountStack
		);
		await tick();
		const st = noteBundlePluginKey.getState(ed.state)!;
		ed.view.dispatch(ed.state.tr.setNodeAttribute(st.bundles[0].checkboxPos, 'checked', false));
		await tick();
		expect(calls.destroyed).toBe(1);
		const st2 = noteBundlePluginKey.getState(ed.state)!;
		expect(st2.decorations.find().length).toBe(0);
	});

	it('selectBundleEntry: 라디오 상호 배타 갱신', async () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', true), list(li('A', true), li('B', false))),
			mountStack
		);
		await tick();
		const b = noteBundlePluginKey.getState(ed.state)!.bundles[0];
		selectBundleEntry(ed.view, b, 1);
		expect(radios(ed)).toEqual([false, true]);
	});

	it('writeBundleHeightPct: 숫자 교체 + 숫자 없으면 삽입 + 클램프', async () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', true), list(li('A', true))),
			mountStack
		);
		await tick();
		let b = noteBundlePluginKey.getState(ed.state)!.bundles[0];
		writeBundleHeightPct(ed.view, b, 63);
		expect(ed.state.doc.textBetween(0, ed.state.doc.content.size, '\n')).toContain('노트 묶음:63');
		// 숫자 없는 키워드에 삽입
		const ed2 = makeEditor(
			doc(titleLine('호스트2'), kw('노트 묶음:', true), list(li('A', true))),
			makeStub().mountStack
		);
		await tick();
		b = noteBundlePluginKey.getState(ed2.state)!.bundles[0];
		writeBundleHeightPct(ed2.view, b, 95);
		expect(ed2.state.doc.textBetween(0, ed2.state.doc.content.size, '\n')).toContain(
			'노트 묶음:90'
		);
	});

	it('XML 라운드트립: 데코레이션은 직렬화에 영향 없음', async () => {
		const { mountStack } = makeStub();
		const ed = makeEditor(
			doc(titleLine('호스트'), kw('노트 묶음:50', true), list(li('A', true), li('B', false))),
			mountStack
		);
		await tick();
		const xml = serializeContent(ed.getJSON());
		expect(xml).toContain('[x]노트 묶음:50');
		expect(xml).toContain('(o)');
		expect(xml).toContain('( )');
		expect(xml).toContain('<link:internal>A</link:internal>');
	});
});
```

- [ ] **Step 4: 테스트 실행**

Run: `cd app && npx vitest run tests/unit/editor/noteBundle/noteBundlePlugin.test.ts`
Expected: PASS. (라운드트립 assert 의 정확한 XML 문자열은 archiver 실제 출력에 맞춰 조정 가능 — `[x]`/`(o)`/`( )` 보존이 본질.)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/noteBundle/ app/tests/unit/editor/noteBundle/
git commit -m "feat(noteBundle): 데코레이션 플러그인 + 라디오 자동삽입 + tr 헬퍼"
```

---

### Task 3: NoteBundleStack.svelte (스택 UI + 임베디드 에디터)

**Goal:** 접힌 바 + 펼친 노트(임베디드 TomboyEditor) + 휠/스와이프 전환 + 드래그 리사이즈 컴포넌트.

**Files:**
- Create: `app/src/lib/editor/noteBundle/NoteBundleStack.svelte`

**Acceptance Criteria:**
- [ ] `npm run check` 통과 (컴포넌트는 Task 4 에서 마운트 — 여기선 타입/컴파일 검증)
- [ ] 이벤트 격벽: 루트에서 입력/클립보드/포인터 이벤트 stopPropagation
- [ ] 펼친 노트 저장: pendingDoc + 1500ms 디바운스 + 전환/언마운트 시 flush
- [ ] attachOpenNote/detachOpenNote + subscribeNoteReload 수명주기

**Verify:** `cd app && npm run check` → 0 errors

**Steps:**

- [ ] **Step 1: NoteBundleStack.svelte 작성**

```svelte
<script lang="ts">
	/**
	 * 노트 묶음 스택 — 접힌 제목 바(≤4) + 펼친 노트(임베디드 TomboyEditor).
	 *
	 * noteBundlePlugin 의 위젯 컨테이너(외부 에디터의 contenteditable=false
	 * 섬) 안에 mount() 된다. 루트에서 입력/클립보드/포인터 이벤트를
	 * stopPropagation — 외부 PM 이 임베디드 에디터 이벤트를 보지 못하게
	 * 하는 editor-in-editor 격벽.
	 *
	 * EditorComponent 는 TomboyEditor 자신 (셀프 임포트로 주입) — 이
	 * 파일이 TomboyEditor 를 직접 임포트하면 순환이 생기므로 prop 으로
	 * 받는다.
	 */
	import { onMount, onDestroy } from 'svelte';
	import type { Component } from 'svelte';
	import type { EditorView } from '@tiptap/pm/view';
	import type { JSONContent } from '@tiptap/core';
	import type { BundleSpec } from './parser.js';
	import { selectBundleEntry, writeBundleHeightPct } from './noteBundlePlugin.js';
	import { collapsedBarStart, firstValidIndex, nextValidIndex } from './stackMath.js';
	import { lookupGuidByTitle, ensureTitleIndexReady } from '../autoLink/titleProvider.js';
	import {
		getNote,
		getNoteEditorContent,
		updateNoteFromEditor
	} from '$lib/core/noteManager.js';
	import { subscribeNoteReload } from '$lib/core/noteReloadBus.js';
	import { attachOpenNote, detachOpenNote } from '$lib/sync/firebase/orchestrator.js';

	interface Props {
		spec: BundleSpec;
		view: EditorView;
		hostGuid: string | null;
		// eslint 없음 — any 컴포넌트 프롭은 TomboyEditor 의 방대한 Props 를
		// 다 알 필요가 없다는 의도적 선택.
		EditorComponent: Component<Record<string, unknown>>;
		oninternallink?: (target: string) => void;
	}
	let { spec, view, hostGuid, EditorComponent, oninternallink }: Props = $props();

	// --- guid 해석 ----------------------------------------------------------
	let titleEpoch = $state(0);
	onMount(() => {
		void ensureTitleIndexReady().then(() => {
			titleEpoch++;
		});
	});

	interface ResolvedEntry {
		title: string;
		guid: string | null;
		broken: boolean;
		/** spec.entries 인덱스 — selectBundleEntry 용 */
		originalIndex: number;
		selected: boolean;
	}
	const resolved = $derived.by<ResolvedEntry[]>(() => {
		void titleEpoch;
		const out: ResolvedEntry[] = [];
		spec.entries.forEach((e, i) => {
			const guid = lookupGuidByTitle(e.title);
			if (guid !== null && guid === hostGuid) return; // 자기참조 제외
			out.push({
				title: e.title,
				guid,
				broken: guid === null,
				originalIndex: i,
				selected: e.selected
			});
		});
		return out;
	});

	// 펼침 인덱스(resolved 기준): 라디오 선택 우선, 없으면 첫 유효 항목
	const k = $derived.by(() => {
		const sel = resolved.findIndex((e) => e.selected && !e.broken);
		if (sel >= 0) return sel;
		return firstValidIndex(resolved);
	});
	const expanded = $derived(k >= 0 ? resolved[k] : null);
	const barStart = $derived(k >= 0 ? collapsedBarStart(k) : 0);
	const bars = $derived(k >= 0 ? resolved.slice(barStart, k) : []);

	// --- 높이 ----------------------------------------------------------------
	let rootEl = $state<HTMLElement | null>(null);
	let hostH = $state(600);
	let dragPx = $state<number | null>(null);
	const stackH = $derived(dragPx ?? Math.max(140, Math.round((hostH * spec.heightPct) / 100)));

	onMount(() => {
		const hostEl = view.dom.closest<HTMLElement>('.tomboy-editor') ?? view.dom.parentElement;
		if (!hostEl) return;
		hostH = hostEl.clientHeight || 600;
		const ro = new ResizeObserver(() => {
			hostH = hostEl.clientHeight || hostH;
		});
		ro.observe(hostEl);
		return () => ro.disconnect();
	});

	// --- 이벤트 격벽 -----------------------------------------------------------
	const ISOLATED_EVENTS = [
		'keydown',
		'keyup',
		'keypress',
		'beforeinput',
		'input',
		'compositionstart',
		'compositionupdate',
		'compositionend',
		'paste',
		'copy',
		'cut',
		'pointerdown',
		'mousedown',
		'click',
		'touchstart',
		'dragstart',
		'dragover',
		'drop'
	] as const;
	onMount(() => {
		const el = rootEl;
		if (!el) return;
		const stop = (e: Event) => e.stopPropagation();
		for (const t of ISOLATED_EVENTS) el.addEventListener(t, stop);
		return () => {
			for (const t of ISOLATED_EVENTS) el.removeEventListener(t, stop);
		};
	});

	// --- 펼침 노트 로드/저장 (NoteWindow 패턴 축소판) ----------------------------
	let editorContent = $state.raw<JSONContent | null>(null);
	let loadedGuid = $state<string | null>(null);
	let createDate = $state<string | null>(null);
	let pendingDoc: JSONContent | null = null;
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let loadEpoch = 0;
	let offReload: (() => void) | null = null;

	async function flushSave(): Promise<void> {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		const docJson = pendingDoc;
		const guid = loadedGuid;
		pendingDoc = null;
		if (!docJson || !guid) return;
		try {
			await updateNoteFromEditor(guid, docJson);
		} catch (err) {
			console.error('[noteBundle flushSave]', err);
		}
	}

	function handleEmbeddedChange(doc: JSONContent) {
		pendingDoc = doc;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			void flushSave();
		}, 1500);
	}

	async function loadExpanded(guid: string) {
		const epoch = ++loadEpoch;
		await flushSave();
		if (epoch !== loadEpoch) return;
		if (loadedGuid && loadedGuid !== guid) {
			detachOpenNote(loadedGuid);
			offReload?.();
			offReload = null;
		}
		const note = await getNote(guid);
		if (epoch !== loadEpoch) return;
		if (!note) {
			editorContent = null;
			loadedGuid = null;
			return;
		}
		editorContent = getNoteEditorContent(note);
		createDate = note.createDate ?? null;
		loadedGuid = guid;
		attachOpenNote(guid);
		offReload = subscribeNoteReload(guid, async () => {
			// 렌임 스윕 등 외부 rewrite — pending 폐기 후 IDB 재로드
			pendingDoc = null;
			const fresh = await getNote(guid);
			if (fresh && loadedGuid === guid) editorContent = getNoteEditorContent(fresh);
		});
	}

	$effect(() => {
		const g = expanded?.guid ?? null;
		if (g && g !== loadedGuid) void loadExpanded(g);
	});

	onDestroy(() => {
		void flushSave();
		if (loadedGuid) detachOpenNote(loadedGuid);
		offReload?.();
	});

	// --- 전환 (휠 / 스와이프 / 바 클릭) ------------------------------------------
	function moveTo(target: number) {
		if (target < 0 || target >= resolved.length || target === k) return;
		const entry = resolved[target];
		if (entry.broken) return;
		selectBundleEntry(view, spec, entry.originalIndex);
	}
	function step(dir: 1 | -1) {
		if (k < 0) return;
		moveTo(nextValidIndex(resolved, k, dir));
	}

	let wheelAcc = 0;
	function handleBarsWheel(e: WheelEvent) {
		e.preventDefault();
		e.stopPropagation();
		wheelAcc += e.deltaY;
		while (wheelAcc >= 50) {
			step(1);
			wheelAcc -= 50;
		}
		while (wheelAcc <= -50) {
			step(-1);
			wheelAcc += 50;
		}
	}

	let swipeY: number | null = null;
	function handleBarsPointerDown(e: PointerEvent) {
		swipeY = e.clientY;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function handleBarsPointerMove(e: PointerEvent) {
		if (swipeY === null) return;
		const dy = e.clientY - swipeY;
		if (Math.abs(dy) >= 30) {
			step(dy < 0 ? 1 : -1); // 위로 끌면 다음 파일철
			swipeY = e.clientY;
		}
	}
	function handleBarsPointerUp() {
		swipeY = null;
	}

	// --- 하단 리사이즈 핸들 -------------------------------------------------------
	let resizeStartY = 0;
	let resizeStartH = 0;
	function handleResizeDown(e: PointerEvent) {
		e.preventDefault();
		e.stopPropagation();
		resizeStartY = e.clientY;
		resizeStartH = stackH;
		dragPx = stackH;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function handleResizeMove(e: PointerEvent) {
		if (dragPx === null) return;
		dragPx = Math.max(140, resizeStartH + (e.clientY - resizeStartY));
	}
	function handleResizeUp() {
		if (dragPx === null) return;
		const pct = Math.round((dragPx / Math.max(1, hostH)) * 100);
		dragPx = null;
		writeBundleHeightPct(view, spec, pct);
	}
</script>

<div class="bundle-stack" bind:this={rootEl} style:height={`${stackH}px`}>
	{#if resolved.length === 0}
		<div class="bundle-empty">묶을 노트 없음</div>
	{:else}
		<div
			class="bundle-bars"
			onwheel={handleBarsWheel}
			onpointerdown={handleBarsPointerDown}
			onpointermove={handleBarsPointerMove}
			onpointerup={handleBarsPointerUp}
			onpointercancel={handleBarsPointerUp}
		>
			{#each bars as bar, i (barStart + i)}
				<button
					type="button"
					class="bundle-bar"
					class:broken={bar.broken}
					onclick={() => moveTo(barStart + i)}
				>{bar.title}</button>
			{/each}
			{#if expanded}
				<div class="bundle-bar expanded-bar">{expanded.title}</div>
			{/if}
		</div>
		{#if expanded && editorContent && loadedGuid}
			<div class="bundle-body">
				<EditorComponent
					content={editorContent}
					currentGuid={loadedGuid}
					onchange={handleEmbeddedChange}
					oninternallink={(t: string) => oninternallink?.(t)}
					enableNoteBundle={false}
					hrSplitEnabled={false}
					{createDate}
				/>
			</div>
		{:else if expanded}
			<div class="bundle-empty">로딩…</div>
		{:else}
			<div class="bundle-empty">펼칠 수 있는 노트 없음</div>
		{/if}
	{/if}
	<div
		class="bundle-resize"
		onpointerdown={handleResizeDown}
		onpointermove={handleResizeMove}
		onpointerup={handleResizeUp}
		onpointercancel={handleResizeUp}
	></div>
</div>

<style>
	.bundle-stack {
		display: flex;
		flex-direction: column;
		margin: 8px 0;
		border: 1px solid #444;
		border-radius: 6px;
		overflow: hidden;
		background: #1e1e1e;
	}
	.bundle-bars {
		flex-shrink: 0;
		touch-action: none;
		user-select: none;
		display: flex;
		flex-direction: column;
	}
	/* NoteWindow .title-bar 시각 언어 재사용 (dark #2a2a2a / focused green) */
	.bundle-bar {
		display: block;
		width: 100%;
		text-align: left;
		border: none;
		border-bottom: 1px solid #1a1a1a;
		padding: clamp(4px, 1vw, 6px) clamp(8px, 2vw, 12px);
		background: #2a2a2a;
		color: #eee;
		font-size: 0.85rem;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: pointer;
	}
	.bundle-bar.broken {
		color: #777;
		cursor: default;
	}
	.expanded-bar {
		background: #2d5a3d;
		cursor: grab;
	}
	.bundle-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		background: #fff;
	}
	.bundle-empty {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #888;
		font-size: 0.85rem;
	}
	.bundle-resize {
		flex-shrink: 0;
		height: 8px;
		cursor: ns-resize;
		touch-action: none;
		background: #2a2a2a;
	}
	.bundle-resize::after {
		content: '';
		display: block;
		width: 36px;
		height: 3px;
		border-radius: 2px;
		margin: 2.5px auto;
		background: #555;
	}
</style>
```

- [ ] **Step 2: 타입 체크**

Run: `cd app && npm run check`
Expected: 0 errors (경고는 기존 수준 유지)

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/editor/noteBundle/NoteBundleStack.svelte
git commit -m "feat(noteBundle): 서류함 스택 컴포넌트 — 임베디드 에디터 + 휠/스와이프 + 리사이즈"
```

---

### Task 4: TomboyEditor 통합 (prop + 확장 + CSS + 수동 검증)

**Goal:** `enableNoteBundle` prop, tomboyNoteBundle 확장 등록, mountStack 콜백($state props 로 reactive 전달), 숨김 CSS.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (Props 인터페이스 ~line 148-239, destructure ~line 241-270, extensions 배열 ~line 502-507 부근, `<style>` geoMap 블록 ~line 1695 부근)

**Acceptance Criteria:**
- [ ] `enableNoteBundle` prop (기본 true); false 면 플러그인 미설치 (임베디드 = 중첩 가드 depth 1)
- [ ] mountStack: `$state` props 객체로 spec 변경이 리마운트 없이 반영
- [ ] `.tomboy-note-bundle-hidden` → display:none
- [ ] 수동 검증 시나리오 통과 (아래 Step 5)

**Verify:** `cd app && npm run check && npx vitest run tests/unit/editor/` → 통과; `npm run dev` 수동 시나리오

**Steps:**

- [ ] **Step 1: import 추가** (TomboyEditor.svelte script 상단, 기존 import 묶음에)

```ts
import { mount as mountSvelte, unmount as unmountSvelte } from "svelte";
import TomboyEditorSelf from "./TomboyEditor.svelte"; // 셀프 임포트 — 임베디드 에디터 주입용
import NoteBundleStack from "./noteBundle/NoteBundleStack.svelte";
import { createNoteBundlePlugin } from "./noteBundle/noteBundlePlugin.js";
import type { BundleSpec } from "./noteBundle/parser.js";
```

- [ ] **Step 2: Props 인터페이스 + destructure 에 추가**

인터페이스 (`cursorVisibilityMode` 항목 뒤):

```ts
		/** 노트 묶음 스택 렌더 여부. 임베디드(번들 안) 에디터는 false 로
		 *  중첩 번들을 막는다 (depth 1 — 번들 안 번들은 리스트로만 보임). */
		enableNoteBundle?: boolean;
```

destructure (`onsendremarkable,` 뒤):

```ts
		enableNoteBundle = true,
```

- [ ] **Step 3: extensions 배열에 확장 추가** (tomboyGeoMap Extension 블록 바로 뒤)

```ts
				Extension.create({
					name: "tomboyNoteBundle",
					addProseMirrorPlugins() {
						if (!enableNoteBundle) return [];
						return [
							createNoteBundlePlugin({
								mountStack: (container, view, spec) => {
									// $state 프록시 props — 이후 spec 갱신이
									// 리마운트 없이 컴포넌트에 반영된다.
									const props = $state({
										spec,
										view,
										hostGuid: currentGuid,
										EditorComponent: TomboyEditorSelf,
										oninternallink: (t: string) =>
											oninternallink?.(t),
									});
									const inst = mountSvelte(NoteBundleStack, {
										target: container,
										props,
									});
									return {
										update(s: BundleSpec) {
											props.spec = s;
											props.hostGuid = currentGuid;
										},
										destroy() {
											void unmountSvelte(inst);
										},
									};
								},
							}),
						];
					},
				}),
```

- [ ] **Step 4: 숨김 CSS 추가** (`<style>` 의 `.tomboy-editor :global(.tomboy-geo-map)` 블록 근처)

```css
	/* 노트 묶음: 체크 시 링크 리스트 숨김 (노드 데코레이션 클래스) */
	.tomboy-editor :global(.tomboy-note-bundle-hidden) {
		display: none;
	}
	.tomboy-editor :global(.tomboy-note-bundle) {
		display: block;
	}
```

- [ ] **Step 5: 타입 체크 + 전체 에디터 테스트 + 수동 검증**

Run: `cd app && npm run check && npx vitest run tests/unit/editor/`
Expected: 통과 (기존 테스트 회귀 없음)

`npm run dev` 수동 시나리오 (데스크톱 NoteWindow + 모바일 viewport 각각):
1. 노트에 `[ ]노트 묶음:` 입력 + 다음 줄 bullet 리스트로 기존 노트 3개 링크 (autolink 로 파란 링크 확인)
2. 체크박스 클릭 → 리스트 사라지고 스택 등장, 라디오 `( )` 자동 삽입 + 첫 항목 `(o)` (체크 해제 후 리스트 확인)
3. 휠/스와이프로 전환 → 접힌 바 이동, 라디오 따라감, 노트 다시 열면 위치 복원
4. 펼친 노트에서 타이핑 → 1.5s 후 저장(해당 노트 단독 열어 확인); 음악 노트 펼쳐 ▶ 재생
5. 하단 핸들 드래그 → `:N` 숫자 갱신 확인 (체크 해제 상태에서)
6. 깨진 링크(없는 제목) 항목 → 회색 바, 클릭/펼침 무시
7. 호스트 본문 타이핑 → 스택 리마운트 안 됨 (펼친 노트 상태 유지)
8. 번들 안 노트에 또 번들 → 리스트로만 보임

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(noteBundle): TomboyEditor 통합 — enableNoteBundle prop + 스택 마운트"
```

---

### Task 5: 가이드 카드 + 최종 검증

**Goal:** 설정 → 가이드 → 에디터 탭 guide-card (사용자 발견 표면 — CLAUDE.md 필수 불변식) + 전체 테스트.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (`guideSubTab === 'editor'` 섹션 끝에 카드 추가 — 기존 카드 패턴 미러)

**Acceptance Criteria:**
- [ ] 에디터 가이드 탭에 노트 묶음 카드 (snippet + 제약 목록)
- [ ] `npm run check` + `npm run test` 전체 통과

**Verify:** `cd app && npm run check && npm run test` → 통과

**Steps:**

- [ ] **Step 1: guide-card 추가** (에디터 sub-tab 의 마지막 `</details>` 뒤, 기존 카드와 동일 들여쓰기)

```html
<details class="guide-card">
	<summary>노트 묶음 — 연관 노트 서류함</summary>
	<p class="info-text">
		체크박스 + "노트 묶음:" 키워드 뒤에 내부 링크 리스트를 두면, 체크 시 그 자리에
		서류함 스택이 나타납니다. 제목 바를 휠/스와이프로 넘기며 맨 아래 노트를 바로
		편집·재생할 수 있습니다.
	</p>
	<pre class="snippet">[ ]노트 묶음:50
• 시계탑 구현 할 거
• 시계탑 버그 리스트
• 시계탑 캐릭터 구현 확인</pre>
	<ul class="guide-list">
		<li>체크 = 스택 표시(리스트 숨김), 해제 = 리스트만 표시</li>
		<li>:N 은 스택 높이(노트 화면의 N%, 20–90). 하단 가장자리 드래그로도 조절 — 숫자에 자동 반영</li>
		<li>리스트 항목 앞 라디오 ( )/(o) 가 펼친 노트를 기억 — 체크 시 자동 삽입</li>
		<li>제목 바는 최대 5개 — 휠/스와이프로 파일철 넘기듯 이동</li>
		<li>삭제된 노트 링크는 회색 바로 표시되고 펼쳐지지 않음</li>
		<li>묶음 안 노트의 또 다른 묶음은 리스트로만 보임 (1단계 중첩)</li>
	</ul>
</details>
```

(실제 파일의 기존 카드 마크업과 클래스/들여쓰기를 맞출 것 — `guideSubTab` 분기 구조 먼저 확인.)

- [ ] **Step 2: 전체 검증**

Run: `cd app && npm run check && npm run test`
Expected: 둘 다 통과

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(guide): 노트 묶음 가이드 카드 추가"
```

---

## Self-Review 결과

- **Spec coverage:** 문법/파싱(T1), 데코레이션+라디오 의무+높이 쓰기백(T2), 스택 UI+임베디드 수명주기+동기화(T3), 통합+중첩 가드+수동 시나리오(T4), 가이드 카드(T5). 엣지 케이스 표 → T1 (제목 라인/링크 0개), T3 (자기참조/broken/플레이스홀더), T4 시나리오 6·8. 누락 없음.
- **Type consistency:** `BundleSpec`/`BundleEntry`/`StackController`/`selectBundleEntry`/`writeBundleHeightPct`/`clampHeightPct` — T1 정의, T2 구현, T3 소비, T4 주입. 일치 확인.
- **알려진 조정 지점:** T2 라운드트립 assert 의 XML 문자열은 archiver 실제 출력 기준으로 조정 가능 (본질은 `[x]`/`(o)` 보존). T5 카드 마크업은 기존 카드와 맞춤.
