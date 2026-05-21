# 노트 내 찾기 (Find in Note) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 개별 노트 편집기에서 `Ctrl/Cmd+F`(또는 모바일 툴바 버튼)로 찾기 바를 열어 검색어와 일치하는 텍스트를 녹색으로 하이라이팅하고 매치 사이를 이동한다.

**Architecture:** ProseMirror 데코레이션 플러그인이 텍스트블록 단위로 매치를 스캔해 인라인 데코레이션(녹색 CSS 클래스)으로 그린다 — 문서는 절대 수정하지 않아 `.note` XML 라운드트립을 보존한다. 찾기 UI 일체를 `TomboyEditor.svelte` 내부에 두어 모바일 노트 라우트와 데스크탑 `NoteWindow` 양쪽에서 동작한다.

**Tech Stack:** SvelteKit · Svelte 5 runes · TipTap 3 / ProseMirror · TypeScript · vitest

설계 문서: `docs/superpowers/specs/2026-05-21-find-in-note-design.md`

---

## File Structure

신설 (`app/src/lib/editor/find/`):

| 파일 | 책임 |
|------|------|
| `find/findMatches.ts` | 순수 함수 `findMatches(doc, query)` — 텍스트블록 단위 대소문자 무시 부분 일치 스캔 |
| `find/findPlugin.ts` | ProseMirror 플러그인 — 상태·데코레이션·메타 처리·재스캔·활성 매치 스크롤 |
| `find/FindBar.svelte` | 검색바 UI (표현 전용 컴포넌트) |
| `tests/unit/editor/findMatches.test.ts` | `findMatches` 단위 테스트 |
| `tests/unit/editor/findPlugin.test.ts` | 플러그인 `apply` 리듀서 테스트 |

수정:

| 파일 | 변경 |
|------|------|
| `editor/TomboyEditor.svelte` | 플러그인 등록, `Ctrl/Cmd+F`, `FindBar` 렌더링, 찾기 상태, `openFind()`, 셸 래핑 + CSS |
| `routes/note/[id]/+page.svelte` | `.editor-area` 를 flex column 으로 (셸이 높이를 받도록), `<Toolbar onfind>` 배선 |
| `lib/desktop/NoteWindow.svelte` | `<Toolbar onfind>` 배선 |
| `editor/Toolbar.svelte` | 선택적 `onfind` prop + dock 행 찾기 버튼 |

모든 새 `.ts`/`.svelte` 파일은 탭 들여쓰기 + 작은따옴표(`hrSplitPlugin.ts` 관례). `TomboyEditor.svelte` 편집은 그 파일의 기존 스타일(탭 + 큰따옴표)을 따른다.

---

### Task 1: `findMatches` 매칭 함수

**Goal:** 문서와 검색어를 받아 대소문자 무시로 모든 매치를 문서 위치로 반환하는 순수 함수.

**Files:**
- Create: `app/src/lib/editor/find/findMatches.ts`
- Test: `app/tests/unit/editor/findMatches.test.ts`

**Acceptance Criteria:**
- [ ] `findMatches(doc, query)` 가 `{from, to}[]` 를 문서 위치 오름차순으로 반환
- [ ] 빈 쿼리는 `[]` 반환
- [ ] 대소문자 무시 (`apple` ↔ `Apple`/`APPLE`)
- [ ] 단어 중간에 마크가 걸려도 매치 (`hel` + 굵게 `lo` → `hello`)
- [ ] 문단/하드브레이크 경계를 넘는 거짓 매치 없음
- [ ] 헤딩·리스트 항목 안의 텍스트도 스캔

**Verify:** `cd app && npm run test -- findMatches` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/editor/findMatches.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { Node as PMNode } from '@tiptap/pm/model';
import { findMatches } from '$lib/editor/find/findMatches.js';

let currentEditor: Editor | null = null;

/** Build a ProseMirror doc from content HTML via a throwaway editor. */
function docOf(content: string): PMNode {
	currentEditor?.destroy();
	const editor = new Editor({ extensions: [StarterKit], content });
	currentEditor = editor;
	return editor.state.doc;
}

/** Map each match back to the verbatim (original-case) document text. */
function textsOf(doc: PMNode, query: string): string[] {
	return findMatches(doc, query).map((m) => doc.textBetween(m.from, m.to));
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

describe('findMatches', () => {
	it('empty query → no matches', () => {
		expect(findMatches(docOf('<p>hello</p>'), '')).toEqual([]);
	});

	it('finds a single match and reports its text', () => {
		expect(textsOf(docOf('<p>hello world</p>'), 'world')).toEqual(['world']);
	});

	it('finds multiple matches in one block', () => {
		expect(textsOf(docOf('<p>na na na</p>'), 'na')).toEqual(['na', 'na', 'na']);
	});

	it('is case-insensitive and maps back to original case', () => {
		const doc = docOf('<p>Apple APPLE apple</p>');
		expect(findMatches(doc, 'apple').length).toBe(3);
		expect(textsOf(doc, 'apple')).toEqual(['Apple', 'APPLE', 'apple']);
	});

	it('matches a word split across a mark boundary', () => {
		const doc = docOf('<p>hel<strong>lo</strong> there</p>');
		expect(textsOf(doc, 'hello')).toEqual(['hello']);
	});

	it('does not match across a paragraph boundary', () => {
		expect(findMatches(docOf('<p>foo</p><p>bar</p>'), 'foobar')).toEqual([]);
	});

	it('does not match across a hard break', () => {
		const doc = docOf('<p>foo<br>bar</p>');
		expect(findMatches(doc, 'foobar')).toEqual([]);
		expect(textsOf(doc, 'foo')).toEqual(['foo']);
		expect(textsOf(doc, 'bar')).toEqual(['bar']);
	});

	it('scans headings, not just paragraphs', () => {
		expect(textsOf(docOf('<h1>Heading text</h1><p>body</p>'), 'heading')).toEqual([
			'Heading'
		]);
	});

	it('returns matches in ascending document order', () => {
		const matches = findMatches(docOf('<p>x</p><p>x</p><p>x</p>'), 'x');
		expect(matches.length).toBe(3);
		expect(matches[0].from).toBeLessThan(matches[1].from);
		expect(matches[1].from).toBeLessThan(matches[2].from);
	});

	it('finds matches inside list items', () => {
		const doc = docOf('<ul><li><p>target one</p></li><li><p>target two</p></li></ul>');
		expect(textsOf(doc, 'target')).toEqual(['target', 'target']);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- findMatches`
Expected: FAIL — `findMatches` 모듈을 찾을 수 없음.

- [ ] **Step 3: `findMatches.ts` 구현** — `app/src/lib/editor/find/findMatches.ts`

```ts
import type { Node as PMNode } from '@tiptap/pm/model';

/** A single search hit, expressed as ProseMirror document positions. */
export interface FindMatch {
	/** Document position of the first matched character. */
	from: number;
	/** Document position just past the last matched character. */
	to: number;
}

/**
 * Placeholder substituted for inline atom nodes (hard breaks, inline
 * widgets) so their single document position is kept in the per-textblock
 * search string without ever taking part in a match. U+FFFF is a permanent
 * Unicode non-character — it cannot occur in real note text or in a query.
 */
const ATOM_PLACEHOLDER = '￿';

/**
 * Find every case-insensitive occurrence of `query` inside `doc`.
 *
 * Matching is scoped to a single textblock, so a query never spans a
 * paragraph / heading boundary. Within a textblock the inline text is
 * concatenated across mark boundaries, so a partially-bold word
 * (`hel` + bold `lo`) still matches `hello`.
 *
 * Returns matches as document positions in ascending order. An empty
 * `query` returns no matches.
 *
 * Note: case folding uses `String.prototype.toLowerCase()`, which is 1:1
 * for Latin + Hangul (this app's content). The rare characters that change
 * length when lowercased are not handled.
 */
export function findMatches(doc: PMNode, query: string): FindMatch[] {
	if (query === '') return [];
	const needle = query.toLowerCase();
	const matches: FindMatch[] = [];

	doc.descendants((node, pos) => {
		if (!node.isTextblock) return true;

		// Build the textblock's search string and a parallel array mapping
		// each string index to its document position. Inline content
		// starts at pos + 1 (just inside the block's opening token).
		let haystack = '';
		const posAt: number[] = [];
		let childPos = pos + 1;
		node.forEach((child) => {
			if (child.isText) {
				const text = child.text ?? '';
				for (let i = 0; i < text.length; i++) {
					haystack += text[i];
					posAt.push(childPos + i);
				}
			} else {
				// Inline atom: one document position, one placeholder char.
				haystack += ATOM_PLACEHOLDER;
				posAt.push(childPos);
			}
			childPos += child.nodeSize;
		});

		const lower = haystack.toLowerCase();
		let idx = lower.indexOf(needle);
		while (idx !== -1) {
			matches.push({
				from: posAt[idx],
				to: posAt[idx + needle.length - 1] + 1
			});
			idx = lower.indexOf(needle, idx + needle.length);
		}

		// Textblocks don't nest — no need to descend into inline content.
		return false;
	});

	return matches;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- findMatches`
Expected: PASS — 10개 테스트 모두 통과.

- [ ] **Step 5: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web
git add app/src/lib/editor/find/findMatches.ts app/tests/unit/editor/findMatches.test.ts
git commit -m "$(cat <<'EOF'
feat(find): 노트 내 찾기 매칭 함수 (findMatches)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `findPlugin` ProseMirror 플러그인

**Goal:** 활성 검색을 상태로 보유하고 매치를 인라인 데코레이션으로 그리며, 메타로 쿼리·이동·닫기를 처리하고 편집 시 재스캔하는 ProseMirror 플러그인.

**Files:**
- Create: `app/src/lib/editor/find/findPlugin.ts`
- Test: `app/tests/unit/editor/findPlugin.test.ts`

**Acceptance Criteria:**
- [ ] `{query}` 메타 → 재스캔, `activeIndex` 는 매치 있으면 0, 없으면 -1
- [ ] `{nav:'next'|'prev'}` 메타 → `activeIndex` 순환 증감, 매치 0개면 무시
- [ ] `{close:true}` 메타 → 상태 초기화
- [ ] 메타 없는 `docChanged` 트랜잭션 + 활성 쿼리 → 재스캔 + `activeIndex` 클램프
- [ ] `decorations` 가 매치에 `tomboy-find-match`, 활성 매치에 `tomboy-find-active` 부여
- [ ] 문서는 절대 수정하지 않음 (데코레이션 전용)

**Verify:** `cd app && npm run test -- findPlugin` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/editor/findPlugin.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createFindPlugin, findPluginKey, type FindState } from '$lib/editor/find/findPlugin.js';

let currentEditor: Editor | null = null;

function makeEditor(content: string): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit,
			Extension.create({
				name: 'tomboyFindTest',
				addProseMirrorPlugins() {
					return [createFindPlugin()];
				}
			})
		],
		content
	});
	currentEditor = editor;
	return editor;
}

function findState(editor: Editor): FindState {
	const fs = findPluginKey.getState(editor.state);
	if (!fs) throw new Error('find plugin state missing');
	return fs;
}

function setQuery(editor: Editor, query: string): void {
	editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { query }));
}
function nav(editor: Editor, dir: 'next' | 'prev'): void {
	editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { nav: dir }));
}
function close(editor: Editor): void {
	editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { close: true }));
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

describe('findPlugin — query meta', () => {
	it('resolves matches and activates the first', () => {
		const editor = makeEditor('<p>apple banana apple</p>');
		setQuery(editor, 'apple');
		const fs = findState(editor);
		expect(fs.query).toBe('apple');
		expect(fs.matches.length).toBe(2);
		expect(fs.activeIndex).toBe(0);
	});

	it('a query with no matches yields activeIndex -1', () => {
		const editor = makeEditor('<p>apple</p>');
		setQuery(editor, 'zzz');
		const fs = findState(editor);
		expect(fs.matches.length).toBe(0);
		expect(fs.activeIndex).toBe(-1);
	});
});

describe('findPlugin — nav meta', () => {
	it('next advances and wraps around', () => {
		const editor = makeEditor('<p>a a a</p>');
		setQuery(editor, 'a');
		expect(findState(editor).activeIndex).toBe(0);
		nav(editor, 'next');
		expect(findState(editor).activeIndex).toBe(1);
		nav(editor, 'next');
		expect(findState(editor).activeIndex).toBe(2);
		nav(editor, 'next');
		expect(findState(editor).activeIndex).toBe(0);
	});

	it('prev retreats and wraps around', () => {
		const editor = makeEditor('<p>a a a</p>');
		setQuery(editor, 'a');
		nav(editor, 'prev');
		expect(findState(editor).activeIndex).toBe(2);
	});

	it('nav with no matches is a no-op', () => {
		const editor = makeEditor('<p>apple</p>');
		setQuery(editor, 'zzz');
		nav(editor, 'next');
		expect(findState(editor).activeIndex).toBe(-1);
	});
});

describe('findPlugin — close meta', () => {
	it('clears the query and matches', () => {
		const editor = makeEditor('<p>apple apple</p>');
		setQuery(editor, 'apple');
		expect(findState(editor).matches.length).toBe(2);
		close(editor);
		const fs = findState(editor);
		expect(fs.query).toBe('');
		expect(fs.matches).toEqual([]);
		expect(fs.activeIndex).toBe(-1);
	});
});

describe('findPlugin — re-scan on doc change', () => {
	it('editing under an active search re-scans and clamps activeIndex', () => {
		const editor = makeEditor('<p>apple apple apple</p>');
		setQuery(editor, 'apple');
		nav(editor, 'next');
		nav(editor, 'next');
		expect(findState(editor).activeIndex).toBe(2);
		editor.commands.setContent('<p>apple</p>');
		const fs = findState(editor);
		expect(fs.matches.length).toBe(1);
		expect(fs.activeIndex).toBe(0);
	});

	it('a doc change with no active query leaves state untouched', () => {
		const editor = makeEditor('<p>apple</p>');
		editor.commands.setContent('<p>banana</p>');
		const fs = findState(editor);
		expect(fs.query).toBe('');
		expect(fs.matches).toEqual([]);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- findPlugin`
Expected: FAIL — `findPlugin` 모듈을 찾을 수 없음.

- [ ] **Step 3: `findPlugin.ts` 구현** — `app/src/lib/editor/find/findPlugin.ts`

```ts
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { findMatches, type FindMatch } from './findMatches.js';

/** Plugin state — the live search and its resolved matches. */
export interface FindState {
	query: string;
	matches: FindMatch[];
	/** Index into `matches` of the highlighted match, or -1 when none. */
	activeIndex: number;
}

/** Meta payloads accepted on `findPluginKey` via `tr.setMeta`. */
export type FindMeta =
	| { query: string }
	| { nav: 'next' | 'prev' }
	| { close: true };

export const findPluginKey = new PluginKey<FindState>('tomboyFind');

/** Wrap `index` into `[0, length)`, returning -1 for an empty range. */
function wrapIndex(index: number, length: number): number {
	if (length === 0) return -1;
	return ((index % length) + length) % length;
}

/** Compute the next plugin state for an explicit meta command. */
function reduceMeta(prev: FindState, meta: FindMeta, doc: PMNode): FindState {
	if ('close' in meta) {
		return { query: '', matches: [], activeIndex: -1 };
	}
	if ('query' in meta) {
		const matches = findMatches(doc, meta.query);
		return {
			query: meta.query,
			matches,
			activeIndex: matches.length > 0 ? 0 : -1
		};
	}
	// { nav } — no-op when there is nothing to navigate.
	if (prev.matches.length === 0) return prev;
	const delta = meta.nav === 'next' ? 1 : -1;
	return {
		...prev,
		activeIndex: wrapIndex(prev.activeIndex + delta, prev.matches.length)
	};
}

/** Build the green-highlight decoration set for the current matches. */
function buildDecorations(state: FindState, doc: PMNode): DecorationSet {
	if (state.matches.length === 0) return DecorationSet.empty;
	const decos = state.matches.map((m, i) =>
		Decoration.inline(m.from, m.to, {
			class:
				i === state.activeIndex
					? 'tomboy-find-match tomboy-find-active'
					: 'tomboy-find-match'
		})
	);
	return DecorationSet.create(doc, decos);
}

/**
 * ProseMirror plugin for in-note find. Holds the active search, resolves
 * matches to document positions, and renders them as inline decorations.
 *
 * Invariant: the document is NEVER modified — matches are decorations
 * only, so a search triggers no save and never pollutes the `.note` XML.
 */
export function createFindPlugin(): Plugin<FindState> {
	return new Plugin<FindState>({
		key: findPluginKey,
		state: {
			init: () => ({ query: '', matches: [], activeIndex: -1 }),
			apply(
				tr: Transaction,
				prev: FindState,
				_old: EditorState,
				next: EditorState
			): FindState {
				const meta = tr.getMeta(findPluginKey) as FindMeta | undefined;
				if (meta) return reduceMeta(prev, meta, next.doc);
				// No meta: if the doc changed under an active search,
				// re-scan against the new doc and clamp the active index.
				if (tr.docChanged && prev.query !== '') {
					const matches = findMatches(next.doc, prev.query);
					const activeIndex =
						matches.length === 0
							? -1
							: Math.min(Math.max(prev.activeIndex, 0), matches.length - 1);
					return { query: prev.query, matches, activeIndex };
				}
				return prev;
			}
		},
		props: {
			decorations(state) {
				const fs = findPluginKey.getState(state);
				return fs ? buildDecorations(fs, state.doc) : DecorationSet.empty;
			}
		},
		view() {
			let prevActive = -1;
			let prevMatches: FindMatch[] | null = null;
			return {
				update(view: EditorView) {
					const fs = findPluginKey.getState(view.state);
					if (!fs) return;
					const changed =
						fs.activeIndex !== prevActive || fs.matches !== prevMatches;
					prevActive = fs.activeIndex;
					prevMatches = fs.matches;
					if (!changed || fs.activeIndex < 0) return;
					// Scroll the active match into view once the decoration
					// DOM has been applied.
					requestAnimationFrame(() => {
						const el = view.dom.querySelector('.tomboy-find-active');
						el?.scrollIntoView({ block: 'center' });
					});
				}
			};
		}
	});
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- findPlugin`
Expected: PASS — 8개 테스트 모두 통과.

- [ ] **Step 5: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web
git add app/src/lib/editor/find/findPlugin.ts app/tests/unit/editor/findPlugin.test.ts
git commit -m "$(cat <<'EOF'
feat(find): 찾기 ProseMirror 플러그인 (findPlugin)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `FindBar` 검색바 UI 컴포넌트

**Goal:** props와 콜백만 받는 표현 전용 검색바 컴포넌트 — 입력창·매치 카운트·이전/다음·닫기.

**Files:**
- Create: `app/src/lib/editor/find/FindBar.svelte`

**Acceptance Criteria:**
- [ ] `query`/`count`/`activeIndex` props 와 `onquery`/`onnext`/`onprev`/`onclose` 콜백
- [ ] 마운트 시 입력창 자동 포커스 + 텍스트 전체 선택
- [ ] 카운트 표시: query 빈 문자열이면 공백, 0이면 "일치 없음", 그 외 `{activeIndex+1} / {count}`
- [ ] 입력창 키: `Enter`→다음, `Shift+Enter`→이전, `Esc`→닫기, IME 조합 중에는 무시
- [ ] 이전/다음 버튼은 `count===0` 일 때 비활성
- [ ] `npm run check` 타입 통과

**Verify:** `cd app && npm run check` → `FindBar.svelte` 관련 오류 없음

**Steps:**

- [ ] **Step 1: `FindBar.svelte` 작성** — `app/src/lib/editor/find/FindBar.svelte`

```svelte
<script lang="ts">
	interface Props {
		/** Current search text (controlled by the parent). */
		query: string;
		/** Total number of matches. */
		count: number;
		/** Index of the active match, or -1 when none. */
		activeIndex: number;
		onquery: (q: string) => void;
		onnext: () => void;
		onprev: () => void;
		onclose: () => void;
	}
	let { query, count, activeIndex, onquery, onnext, onprev, onclose }: Props = $props();

	let inputEl: HTMLInputElement | undefined = $state(undefined);

	// Focus + select the input as soon as the bar mounts, so a prefilled
	// query can be overtyped immediately.
	$effect(() => {
		if (inputEl) {
			inputEl.focus();
			inputEl.select();
		}
	});

	function handleInput(e: Event) {
		onquery((e.target as HTMLInputElement).value);
	}

	function handleKeydown(e: KeyboardEvent) {
		// Ignore Enter/Escape while an IME composition is in flight — that
		// Enter confirms a Korean composition, it is not a navigation.
		if (e.isComposing) return;
		if (e.key === 'Enter') {
			e.preventDefault();
			if (e.shiftKey) onprev();
			else onnext();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		} else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
			// Bar already open — swallow the browser find shortcut and
			// just re-select the input text.
			e.preventDefault();
			inputEl?.select();
		}
	}
</script>

<div class="find-bar" role="search">
	<input
		bind:this={inputEl}
		class="find-input"
		type="text"
		placeholder="노트에서 찾기"
		value={query}
		oninput={handleInput}
		onkeydown={handleKeydown}
		aria-label="노트에서 찾기"
	/>
	<span class="find-count">
		{#if query === ''}{:else if count === 0}일치 없음{:else}{activeIndex + 1} / {count}{/if}
	</span>
	<button
		class="find-btn"
		onclick={onprev}
		disabled={count === 0}
		title="이전 (Shift+Enter)"
		aria-label="이전 일치"
	>↑</button>
	<button
		class="find-btn"
		onclick={onnext}
		disabled={count === 0}
		title="다음 (Enter)"
		aria-label="다음 일치"
	>↓</button>
	<button
		class="find-btn find-close"
		onclick={onclose}
		title="닫기 (Esc)"
		aria-label="찾기 닫기"
	>✕</button>
</div>

<style>
	.find-bar {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 4px 6px;
		background: #fff;
		border: 1px solid #ccc;
		border-radius: 8px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
	}
	.find-input {
		border: none;
		outline: none;
		font-size: 0.9rem;
		padding: 4px 6px;
		width: clamp(110px, 28vw, 190px);
		background: transparent;
		color: #222;
	}
	.find-count {
		font-size: 0.75rem;
		color: #666;
		white-space: nowrap;
		min-width: 3.4em;
		text-align: center;
	}
	.find-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border: none;
		background: transparent;
		border-radius: 6px;
		font-size: 0.95rem;
		color: #444;
		cursor: pointer;
		flex-shrink: 0;
		-webkit-tap-highlight-color: transparent;
	}
	.find-btn:hover:not(:disabled) {
		background: #eee;
	}
	.find-btn:disabled {
		opacity: 0.3;
		cursor: default;
	}
	.find-close {
		color: #888;
	}
</style>
```

- [ ] **Step 2: 타입 체크**

Run: `cd app && npm run check`
Expected: PASS — `FindBar.svelte` 관련 오류 없음 (플랜 이전부터 있던 무관한 경고는 무시).

- [ ] **Step 3: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web
git add app/src/lib/editor/find/FindBar.svelte
git commit -m "$(cat <<'EOF'
feat(find): 찾기 바 UI 컴포넌트 (FindBar)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 에디터에 찾기 통합 + 호스트 레이아웃

**Goal:** `TomboyEditor` 에 찾기 플러그인·`FindBar`·`Ctrl/Cmd+F`·`openFind()` 를 통합하고, 찾기 바가 고정되도록 에디터를 셸로 감싸 모바일 노트 라우트의 `.editor-area` 를 flex column 으로 만든다. 완료 후 `Ctrl/Cmd+F` 로 찾기가 동작한다.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte`
- Modify: `app/src/routes/note/[id]/+page.svelte` (`.editor-area` CSS)

**Acceptance Criteria:**
- [ ] 찾기 플러그인이 `Extension.create({name:'tomboyFind'})` 로 등록됨
- [ ] `Ctrl/Cmd+F` (Alt/Shift 없이) 가 브라우저 찾기를 막고 찾기 바를 엶
- [ ] 단일 텍스트블록 선택이 있으면 그 텍스트로 쿼리 프리필, 그 외엔 직전 쿼리 재적용
- [ ] 검색어 입력 시 매치가 연녹색, 활성 매치가 진녹색+테두리로 표시됨
- [ ] `Enter`/`Shift+Enter` 로 활성 매치 이동, 활성 매치가 화면으로 스크롤됨
- [ ] `Esc`/✕ 로 닫으면 데코레이션 제거 + 에디터에 포커스 복귀
- [ ] 다른 노트로 이동하면 찾기 바가 닫히고 쿼리가 비워짐
- [ ] `export function openFind()` 노출
- [ ] 찾기 바가 본문 스크롤과 무관하게 에디터 우상단에 고정됨

**Verify:** `cd app && npm run check && npm run test` 통과; `npm run dev` 후 노트에서 `Ctrl+F` → 검색어 입력 → 녹색 하이라이트 + `Enter` 이동 + 카운트 + `Esc` 닫기 수동 확인.

**Steps:**

- [ ] **Step 1: import 추가** — `TomboyEditor.svelte`

찾기: `import { TomboyBlockquote } from "./blockquote/index.js";`
바로 다음 줄에 추가:

```ts
	import { TomboyBlockquote } from "./blockquote/index.js";
	import { createFindPlugin, findPluginKey } from "./find/findPlugin.js";
	import FindBar from "./find/FindBar.svelte";
```

- [ ] **Step 2: 찾기 상태 `$state` 선언** — `TomboyEditor.svelte`

찾기: `let editor: Editor | null = $state(null);`
바로 다음 줄에 추가:

```ts
	let editor: Editor | null = $state(null);
	// --- In-note find ("Ctrl/Cmd+F") state ---
	// findOpen drives the FindBar; findQuery is the controlled input value;
	// findCount / findActiveIndex mirror the find plugin's state on every
	// transaction so the bar can render "3 / 12".
	let findOpen = $state(false);
	let findQuery = $state("");
	let findCount = $state(0);
	let findActiveIndex = $state(-1);
```

- [ ] **Step 3: 플러그인 등록** — `TomboyEditor.svelte` extensions 배열

찾기 (extensions 배열 마지막 항목):
```ts
				TomboyBlockquote,
			],
```
교체:
```ts
				TomboyBlockquote,
				Extension.create({
					name: "tomboyFind",
					addProseMirrorPlugins() {
						return [createFindPlugin()];
					},
				}),
			],
```

- [ ] **Step 4: 트랜잭션 리스너로 찾기 상태 미러링** — `TomboyEditor.svelte` `onMount`

찾기 (`selectionUpdate` 핸들러의 끝):
```ts
			prevCursorInTitle = nowInTitle;
		});
```
교체:
```ts
			prevCursorInTitle = nowInTitle;
		});

		// Mirror the find plugin's match count + active index into Svelte
		// state on every transaction, so the FindBar can render "3 / 12".
		editor.on("transaction", ({ editor: ed }) => {
			const fs = findPluginKey.getState(ed.state);
			if (!fs) return;
			findCount = fs.matches.length;
			findActiveIndex = fs.activeIndex;
		});
```

- [ ] **Step 5: `Ctrl/Cmd+F` 단축키** — `TomboyEditor.svelte` `handleKeyDown`

찾기 (Ctrl/Cmd 단축키 switch 의 시작):
```ts
						switch (event.key) {
							case "d":
								event.preventDefault();
								insertTodayDate(ed);
								return true;
```
교체:
```ts
						switch (event.key) {
							case "f":
								event.preventDefault();
								openFind();
								return true;
							case "d":
								event.preventDefault();
								insertTodayDate(ed);
								return true;
```

- [ ] **Step 6: 노트 전환 시 찾기 바 닫기** — `TomboyEditor.svelte` content-swap `$effect`

찾기 (content-swap `$effect` 의 끝):
```ts
		// Any pending scan timer was for the previous note; drop it.
		cancelAutoLinkScan();
	});
```
교체:
```ts
		// Any pending scan timer was for the previous note; drop it.
		cancelAutoLinkScan();

		// Close the find bar — find is scoped to a single note.
		if (findOpen) {
			findOpen = false;
			ed.view.dispatch(
				ed.state.tr.setMeta(findPluginKey, { close: true }),
			);
		}
		findQuery = "";
	});
```

- [ ] **Step 7: 찾기 함수들 추가** — `TomboyEditor.svelte`

찾기:
```ts
	export function getEditor(): Editor | null {
		return editor;
	}
```
바로 앞에 추가:

```ts
	/**
	 * Open the in-note find bar. If the current selection is non-empty and
	 * lies within a single textblock, its text prefills the query;
	 * otherwise the last query (if any) is re-applied. Exposed so the
	 * Toolbar's 찾기 button can open find on mobile.
	 */
	export function openFind(): void {
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		findOpen = true;
		const { from, to, empty } = ed.state.selection;
		let prefill: string | null = null;
		if (!empty) {
			const $from = ed.state.doc.resolve(from);
			const $to = ed.state.doc.resolve(to);
			if ($from.sameParent($to) && $from.parent.isTextblock) {
				prefill = ed.state.doc.textBetween(from, to);
			}
		}
		const q = prefill ? prefill : findQuery;
		findQuery = q;
		ed.view.dispatch(ed.state.tr.setMeta(findPluginKey, { query: q }));
	}

	function handleFindQuery(q: string): void {
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		findQuery = q;
		ed.view.dispatch(ed.state.tr.setMeta(findPluginKey, { query: q }));
	}

	function handleFindNav(direction: "next" | "prev"): void {
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		ed.view.dispatch(
			ed.state.tr.setMeta(findPluginKey, { nav: direction }),
		);
	}

	function closeFind(): void {
		findOpen = false;
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		ed.view.dispatch(ed.state.tr.setMeta(findPluginKey, { close: true }));
		ed.commands.focus();
	}

```

- [ ] **Step 8: 마크업 — 셸 래핑 + FindBar 렌더링** — `TomboyEditor.svelte`

찾기:
```svelte
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={editorElement}
	class="tomboy-editor"
	class:tomboy-todo-ctrl-hold={ctrlHeld}
	oncontextmenu={handleContextMenu}
></div>
```
교체:
```svelte
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="tomboy-editor-shell">
	{#if findOpen}
		<div class="find-bar-slot">
			<FindBar
				query={findQuery}
				count={findCount}
				activeIndex={findActiveIndex}
				onquery={handleFindQuery}
				onnext={() => handleFindNav("next")}
				onprev={() => handleFindNav("prev")}
				onclose={closeFind}
			/>
		</div>
	{/if}
	<div
		bind:this={editorElement}
		class="tomboy-editor"
		class:tomboy-todo-ctrl-hold={ctrlHeld}
		oncontextmenu={handleContextMenu}
	></div>
</div>
```

- [ ] **Step 9: CSS — 셸·슬롯·매치 스타일** — `TomboyEditor.svelte` `<style>`

(a) 찾기:
```css
	.tomboy-editor {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
		font-size: 16px;
		line-height: 1.4;
	}
```
교체:
```css
	.tomboy-editor-shell {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	/* Find bar floats at the editor's top-right. The shell does not scroll
	   (the inner .tomboy-editor does), so the bar stays pinned. */
	.find-bar-slot {
		position: absolute;
		top: 6px;
		right: 6px;
		z-index: 10;
	}

	.tomboy-editor {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		padding: 0.5rem;
		font-size: 16px;
		line-height: 1.4;
	}
```

(b) 찾기:
```css
	/* Highlight */
	.tomboy-editor :global(mark) {
		background-color: #fff176;
	}
```
교체:
```css
	/* Highlight */
	.tomboy-editor :global(mark) {
		background-color: #fff176;
	}

	/* In-note find matches (decorations — never part of the document). */
	.tomboy-editor :global(.tomboy-find-match) {
		background-color: #a5d6a7;
		border-radius: 2px;
	}
	.tomboy-editor :global(.tomboy-find-active) {
		background-color: #66bb6a;
		box-shadow: 0 0 0 1px #2e7d32;
	}
```

- [ ] **Step 10: 모바일 라우트 `.editor-area` 를 flex column 으로** — `app/src/routes/note/[id]/+page.svelte`

셸이 부모로부터 높이를 받아야 찾기 바가 고정된다. `.editor-area` 가 현재 블록 스크롤러이므로 flex column 으로 바꾸고 스크롤은 안쪽 에디터에 넘긴다.

찾기:
```css
	.editor-area {
		flex: 1;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}
```
교체:
```css
	.editor-area {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
```

(참고: 데스크탑 `NoteWindow.svelte` 의 `.body` 는 이미 `display:flex; flex-direction:column` 이라 수정 불필요. `.tomboy-editor-shell` 은 자신의 scoped CSS 로 `flex:1` 을 가지므로 두 호스트 모두에서 셸이 부모의 flex column 안에서 공간을 차지한다.)

- [ ] **Step 11: 타입 체크 + 테스트**

Run: `cd app && npm run check && npm run test`
Expected: PASS — 찾기 관련 신규 오류 없음, 모든 테스트 통과.

- [ ] **Step 12: 수동 확인**

Run: `cd app && npm run dev`
브라우저에서 노트 하나를 열고 확인:
1. `Ctrl+F` → 우상단에 찾기 바가 뜨고 입력창에 포커스.
2. 노트 본문에 있는 단어 입력 → 일치 텍스트가 연녹색, 첫 매치가 진녹색+테두리, 카운트 `1 / N` 표시.
3. `Enter`/`Shift+Enter` → 활성 매치가 순환 이동하며 화면으로 스크롤, 카운트 갱신.
4. 본문을 스크롤해도 찾기 바가 우상단에 고정.
5. `Esc` 또는 ✕ → 바가 닫히고 녹색 하이라이트 제거.
6. 다른 노트로 이동 → 바가 닫혀 있음.

- [ ] **Step 13: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web
git add app/src/lib/editor/TomboyEditor.svelte app/src/routes/note/\[id\]/+page.svelte
git commit -m "$(cat <<'EOF'
feat(find): 에디터에 찾기 통합 — Ctrl+F · 녹색 하이라이트

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 모바일 툴바 찾기 버튼

**Goal:** `Toolbar` 에 선택적 `onfind` prop 과 항상 보이는 dock 행의 🔍 버튼을 추가하고, 두 호스트에서 `openFind()` 로 배선한다.

**Files:**
- Modify: `app/src/lib/editor/Toolbar.svelte`
- Modify: `app/src/routes/note/[id]/+page.svelte`
- Modify: `app/src/lib/desktop/NoteWindow.svelte`

**Acceptance Criteria:**
- [ ] `Toolbar` 가 선택적 `onfind?: () => void` prop 을 받음
- [ ] `onfind` 가 있으면 dock 행에 🔍 찾기 버튼 표시 (데스크탑은 dock 이 `display:none` 이라 모바일에서만 보임)
- [ ] 버튼 클릭 시 `onfind()` 호출
- [ ] 노트 라우트와 `NoteWindow` 의 `<Toolbar>` 가 `onfind={() => editorComponent?.openFind()}` 배선
- [ ] `npm run check` 타입 통과

**Verify:** `cd app && npm run check` 통과; `npm run dev` 후 모바일 폭(개발자도구 디바이스 모드)에서 하단 툴바의 🔍 버튼 탭 → 찾기 바가 열림.

**Steps:**

- [ ] **Step 1: `Toolbar` 에 `onfind` prop 추가** — `app/src/lib/editor/Toolbar.svelte`

찾기:
```ts
	interface Props {
		editor: Editor | null;
		onextractnote?: () => void;
		onuploadimage?: (file: File) => void;
	}

	let { editor, onextractnote, onuploadimage }: Props = $props();
```
교체:
```ts
	interface Props {
		editor: Editor | null;
		onextractnote?: () => void;
		onuploadimage?: (file: File) => void;
		onfind?: () => void;
	}

	let { editor, onextractnote, onuploadimage, onfind }: Props = $props();
```

- [ ] **Step 2: dock 행에 찾기 버튼 추가** — `Toolbar.svelte`

찾기 (dock 안 `.drawer-toggle` 버튼):
```svelte
		<button
			class="drawer-toggle"
			onclick={toggleDrawer}
			aria-expanded={drawerOpen}
			title={drawerOpen ? '서식 도구 닫기' : '서식 도구 열기'}
		>
```
바로 앞에 추가:
```svelte
		{#if onfind}
			<button
				class="find-toggle"
				onclick={() => onfind?.()}
				title="노트에서 찾기"
				aria-label="노트에서 찾기"
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="11" cy="11" r="7" />
					<line x1="21" y1="21" x2="16.65" y2="16.65" />
				</svg>
			</button>
		{/if}

		<button
			class="drawer-toggle"
			onclick={toggleDrawer}
			aria-expanded={drawerOpen}
			title={drawerOpen ? '서식 도구 닫기' : '서식 도구 열기'}
		>
```

- [ ] **Step 3: `.find-toggle` CSS 추가** — `Toolbar.svelte` `<style>`

찾기 (`<style>` 안 마지막 규칙):
```css
	.icon-btn {
		color: #495057;
	}
```
교체:
```css
	.icon-btn {
		color: #495057;
	}

	.find-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		border: none;
		background: transparent;
		border-radius: 6px;
		color: #495057;
		cursor: pointer;
		flex-shrink: 0;
		-webkit-tap-highlight-color: transparent;
	}

	.find-toggle:active {
		background: #dee2e6;
	}
```

- [ ] **Step 4: 노트 라우트 `<Toolbar>` 배선** — `app/src/routes/note/[id]/+page.svelte`

찾기:
```svelte
			<Toolbar
				editor={getEditor()}
				onextractnote={handleExtractNote}
				onuploadimage={(file) => editorComponent?.uploadAndInsertImage(file)}
			/>
```
교체:
```svelte
			<Toolbar
				editor={getEditor()}
				onextractnote={handleExtractNote}
				onuploadimage={(file) => editorComponent?.uploadAndInsertImage(file)}
				onfind={() => editorComponent?.openFind()}
			/>
```

- [ ] **Step 5: `NoteWindow` `<Toolbar>` 배선** — `app/src/lib/desktop/NoteWindow.svelte`

찾기:
```svelte
			<Toolbar
				editor={getEditor()}
				onuploadimage={(file) => editorComponent?.uploadAndInsertImage(file)}
			/>
```
교체:
```svelte
			<Toolbar
				editor={getEditor()}
				onuploadimage={(file) => editorComponent?.uploadAndInsertImage(file)}
				onfind={() => editorComponent?.openFind()}
			/>
```

- [ ] **Step 6: 타입 체크**

Run: `cd app && npm run check`
Expected: PASS — 찾기 관련 신규 오류 없음.

- [ ] **Step 7: 수동 확인**

Run: `cd app && npm run dev`
브라우저 개발자도구의 디바이스(모바일) 모드로 노트를 열고, 하단 툴바의 🔍 버튼을 탭 → 찾기 바가 열리는지 확인.

- [ ] **Step 8: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web
git add app/src/lib/editor/Toolbar.svelte app/src/routes/note/\[id\]/+page.svelte app/src/lib/desktop/NoteWindow.svelte
git commit -m "$(cat <<'EOF'
feat(find): 모바일 툴바 찾기 버튼

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- `Ctrl/Cmd+F` 로 열기 → Task 4 Step 5. ✓
- 녹색 하이라이팅 → Task 2 (데코레이션) + Task 4 Step 9 (CSS). ✓
- 매치 이동 `Enter`/`Shift+Enter` + 카운트 → Task 2 (nav 메타) + Task 3 (UI) + Task 4 (배선). ✓
- 활성 매치 스크롤 → Task 2 (`view` 훅). ✓
- 대소문자 무시 → Task 1 (`findMatches`). ✓
- 모바일 진입점 → Task 5. ✓
- `Esc`/✕ 닫기 → Task 3 + Task 4. ✓
- 데코레이션 전용 (XML 불변식) → Task 2 (`createFindPlugin` 주석 + 구현). ✓
- 노트 전환 시 닫기 → Task 4 Step 6. ✓
- 단위 테스트 → Task 1 + Task 2. ✓

**Type consistency:** `findMatches`/`FindMatch` (Task 1) ↔ `findPlugin` import (Task 2) 일치. `findPluginKey`/`createFindPlugin`/`FindState`/`FindMeta` (Task 2) ↔ `TomboyEditor`/테스트 사용 (Task 2·4) 일치. `openFind`/`handleFindQuery`/`handleFindNav`/`closeFind` (Task 4) ↔ `FindBar` props (Task 3) 일치. `onfind` prop (Task 5) ↔ `openFind()` (Task 4) 일치.

**Placeholder scan:** 모든 step 에 실제 코드/명령 포함. placeholder 없음.

**Scope check:** 단일 기능, 5개 태스크, 한 구현 플랜으로 적절.
