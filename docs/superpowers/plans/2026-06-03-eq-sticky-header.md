# `===` 고정 헤더 (sticky header) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 한 라인 단독 `===`(3개 이상)를 굵은 수평선으로 렌더하고, 그 위 영역을 스크롤 시 상단에 고정되는 읽기 전용 미러 헤더로 표시한다.

**Architecture:** ProseMirror 플러그인이 `={3,}` 마커를 감지해 굵은-선 데코레이션을 부여하고 첫 번째(인덱스≥1) 마커를 "경계"로 통지한다. 에디터 DOM 밖 형제 오버레이(`StickyHeader.svelte`)가 경계 위 top-level 블록의 렌더된 DOM을 복제해 `position:fixed`로 고정한다. PM의 자식 DOM은 절대 래핑하지 않는다(미러는 별도 엘리먼트). 스크롤 컨테이너는 자동 감지(에디터의 가장 가까운 스크롤 조상, 없으면 window)한다.

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap 3 / ProseMirror, vitest + @testing-library/svelte.

---

## File Structure

신규:
- `app/src/lib/editor/eqHeader/eqHeaderPlugin.ts` — 마커 감지(`isEqualsParagraph`/`findEqBoundary`), 데코레이션, 경계/버전 통지 플러그인.
- `app/src/lib/editor/eqHeader/StickyHeader.svelte` — 고정 미러 오버레이.
- `app/tests/unit/editor/eqHeaderBoundary.test.ts` — 순수 함수 단위 테스트.

수정:
- `app/src/lib/editor/TomboyEditor.svelte` — 플러그인 등록, 상태 시딩, StickyHeader 마운트, 마커 CSS.
- `app/src/routes/settings/+page.svelte` — 가이드 카드(editor 서브탭).

스크롤 컨테이너 자동 감지로 `NoteWindow.svelte` 변경은 불필요(데스크톱은 `.tomboy-editor`가 `overflow-y:auto`라 자동으로 감지됨, 모바일은 window).

---

### Task 1: `eqHeaderPlugin.ts` — 마커 감지 + 데코레이션 + 통지

**Goal:** `={3,}` 마커를 감지하는 순수 함수와, 굵은-선 데코레이션을 부여하며 경계 인덱스/문서 버전을 통지하는 ProseMirror 플러그인을 만든다.

**Files:**
- Create: `app/src/lib/editor/eqHeader/eqHeaderPlugin.ts`
- Test: `app/tests/unit/editor/eqHeaderBoundary.test.ts`

**Acceptance Criteria:**
- [ ] `isEqualsParagraph`가 `===`/`====`는 true, `==`/`= =`/`=x=`/비-paragraph는 false.
- [ ] `findEqBoundary`가 인덱스 0(제목)은 무시하고 인덱스≥1의 첫 `===`를 반환, 다중 `===` 시 최상단, 없으면 `null`.
- [ ] 플러그인이 각 `===`(인덱스≥1)에 `.tomboy-eq-marker` node 데코레이션을, 경계에만 추가로 `.tomboy-eq-marker-active`를 부여.
- [ ] 문서 변경 시 `version`이 증가하고 경계/버전 변화 시 `onChange(boundary, version)` 호출.

**Verify:** `cd app && npm run test -- eqHeaderBoundary` → 모든 테스트 PASS.

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/editor/eqHeaderBoundary.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { isEqualsParagraph, findEqBoundary } from '$lib/editor/eqHeader/eqHeaderPlugin.js';

/** Build a doc from an array of paragraph text lines and return its PMNode. */
function docFromLines(lines: string[]) {
	const editor = new Editor({
		extensions: [StarterKit],
		content: {
			type: 'doc',
			content: lines.map((t) => ({
				type: 'paragraph',
				content: t === '' ? [] : [{ type: 'text', text: t }]
			}))
		}
	});
	const doc = editor.state.doc;
	editor.destroy();
	return doc;
}

describe('isEqualsParagraph', () => {
	it('matches 3+ equals', () => {
		expect(isEqualsParagraph(docFromLines(['==='])!.child(0))).toBe(true);
		expect(isEqualsParagraph(docFromLines(['====='])!.child(0))).toBe(true);
		expect(isEqualsParagraph(docFromLines(['  ===  '])!.child(0))).toBe(true);
	});
	it('rejects non-markers', () => {
		expect(isEqualsParagraph(docFromLines(['=='])!.child(0))).toBe(false);
		expect(isEqualsParagraph(docFromLines(['= ='])!.child(0))).toBe(false);
		expect(isEqualsParagraph(docFromLines(['=x='])!.child(0))).toBe(false);
		expect(isEqualsParagraph(docFromLines(['text'])!.child(0))).toBe(false);
	});
});

describe('findEqBoundary', () => {
	it('returns null when no marker', () => {
		expect(findEqBoundary(docFromLines(['제목', 'body', 'more']))).toBe(null);
	});
	it('ignores index 0 (title)', () => {
		// `===` as the very first line is the title, not a marker.
		expect(findEqBoundary(docFromLines(['===', 'body']))).toBe(null);
	});
	it('returns first marker index >= 1', () => {
		expect(findEqBoundary(docFromLines(['제목', '===', 'body']))).toBe(1);
		expect(findEqBoundary(docFromLines(['제목', '부제', '===', 'body']))).toBe(2);
	});
	it('returns topmost when multiple', () => {
		expect(findEqBoundary(docFromLines(['제목', '===', 'a', '===', 'b']))).toBe(1);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- eqHeaderBoundary`
Expected: FAIL — `eqHeaderPlugin.js` 가 존재하지 않음 / export 없음.

- [ ] **Step 3: 플러그인 구현** — `app/src/lib/editor/eqHeader/eqHeaderPlugin.ts`

```ts
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

/** Shared plugin key so the host (TomboyEditor) can seed initial state. */
export const eqHeaderPluginKey = new PluginKey<EqHeaderState>('tomboyEqHeader');

/**
 * A top-level child is an `===` marker if it's a paragraph whose entire
 * trimmed text is 3+ '=' characters. Mirrors `isDashParagraph` in the
 * hrSplit plugin (`-{3,}`).
 */
export function isEqualsParagraph(node: PMNode): boolean {
	if (node.type.name !== 'paragraph') return false;
	return /^={3,}$/.test(node.textContent.trim());
}

/**
 * Top-level index (>= 1) of the FIRST `===` marker, or null. Index 0 is the
 * title line and is never a boundary — the sticky header must contain at
 * least the title. When multiple `===` exist, the topmost wins; the rest
 * render as plain bold lines (see buildDecos).
 */
export function findEqBoundary(doc: PMNode): number | null {
	let result: number | null = null;
	doc.forEach((node, _offset, idx) => {
		if (result !== null) return;
		if (idx >= 1 && isEqualsParagraph(node)) result = idx;
	});
	return result;
}

export interface EqHeaderState {
	/** Top-level index of the active boundary marker, or null. */
	boundary: number | null;
	/** Bumped on every doc change so the host knows when to re-clone. */
	version: number;
	decos: DecorationSet;
}

/** Every `===` (index >= 1) gets `.tomboy-eq-marker`; the boundary also gets
 *  `.tomboy-eq-marker-active`. Index 0 is the title — never decorated. */
function buildDecos(doc: PMNode, boundary: number | null): DecorationSet {
	const decos: Decoration[] = [];
	doc.forEach((node, offset, idx) => {
		if (idx < 1 || !isEqualsParagraph(node)) return;
		const cls =
			idx === boundary
				? 'tomboy-eq-marker tomboy-eq-marker-active'
				: 'tomboy-eq-marker';
		decos.push(Decoration.node(offset, offset + node.nodeSize, { class: cls }));
	});
	return DecorationSet.create(doc, decos);
}

export interface EqHeaderOptions {
	/** Fired after editor view init and whenever the boundary or doc version
	 *  changes. The host re-seeds its reactive state from this. */
	onChange?: (boundary: number | null, version: number) => void;
}

export function createEqHeaderPlugin(options: EqHeaderOptions = {}): Plugin<EqHeaderState> {
	return new Plugin<EqHeaderState>({
		key: eqHeaderPluginKey,
		state: {
			init(_config, state: EditorState) {
				const boundary = findEqBoundary(state.doc);
				return { boundary, version: 0, decos: buildDecos(state.doc, boundary) };
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				const boundary = findEqBoundary(newState.doc);
				return {
					boundary,
					version: prev.version + 1,
					decos: buildDecos(newState.doc, boundary)
				};
			}
		},
		props: {
			decorations(state) {
				return eqHeaderPluginKey.getState(state)?.decos ?? null;
			}
		},
		view(view) {
			// Emit once on mount so a note that already contains `===` shows the
			// sticky header without waiting for an edit.
			const init = eqHeaderPluginKey.getState(view.state);
			if (init) options.onChange?.(init.boundary, init.version);
			return {
				update(v, prevState) {
					const cur = eqHeaderPluginKey.getState(v.state);
					const old = eqHeaderPluginKey.getState(prevState);
					if (!cur) return;
					if (!old || cur.version !== old.version || cur.boundary !== old.boundary) {
						options.onChange?.(cur.boundary, cur.version);
					}
				}
			};
		}
	});
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- eqHeaderBoundary`
Expected: PASS (모든 케이스).

- [ ] **Step 5: 타입 체크**

Run: `cd app && npm run check`
Expected: 신규 파일 관련 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/eqHeader/eqHeaderPlugin.ts app/tests/unit/editor/eqHeaderBoundary.test.ts
git commit -m "feat(editor): === 마커 감지 + 경계 통지 플러그인 (eqHeader)"
```

---

### Task 2: `StickyHeader.svelte` — 고정 미러 오버레이

**Goal:** 경계 위 top-level 블록의 렌더된 DOM을 복제해 스크롤 시 상단에 고정 표시하고, 클릭 시 맨 위로 스크롤하는 읽기 전용 오버레이 컴포넌트.

**Files:**
- Create: `app/src/lib/editor/eqHeader/StickyHeader.svelte`

**Acceptance Criteria:**
- [ ] `boundaryIndex == null`이면 아무것도 렌더하지 않음.
- [ ] 스크롤 컨테이너를 자동 감지(에디터 엘리먼트의 가장 가까운 `overflow-y: auto|scroll` 조상, 없으면 window).
- [ ] 경계 마커가 컨테이너 상단 위로 스크롤된 경우에만 미러 표시(최상단에선 숨김 → 중복 없음).
- [ ] 미러는 `position: fixed`, `max-height: 40vh` + 내부 스크롤, 불투명 배경.
- [ ] 미러 클릭 시 컨테이너를 맨 위로 smooth scroll.
- [ ] `version`/`boundaryIndex` 변화 시 헤더 DOM 재복제.

**Verify:** Task 3에서 배선 후 `cd app && npm run dev` → 모바일 뷰 + 데스크톱 NoteWindow에서 수동 검증(이 컴포넌트만으론 독립 실행 불가, Task 3과 함께 검증). `npm run check` 타입 통과는 이 태스크에서 단독 확인 가능.

**Steps:**

- [ ] **Step 1: 컴포넌트 구현** — `app/src/lib/editor/eqHeader/StickyHeader.svelte`

```svelte
<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import { onMount } from 'svelte';

	interface Props {
		/** Live editor (DOM source for cloning). */
		editor: Editor | null;
		/** The `.tomboy-editor` element — used to detect the scroll container
		 *  and to align the mirror's left/width to the editor column. */
		editorEl: HTMLElement | null;
		/** Active boundary top-level index, or null when no `===` present. */
		boundaryIndex: number | null;
		/** Bumped by the plugin on every doc change → triggers re-clone. */
		version: number;
	}
	let { editor, editorEl, boundaryIndex, version }: Props = $props();

	let contentEl: HTMLDivElement | null = $state(null);
	let visible = $state(false);
	let pinTop = $state(0);
	let pinLeft = $state(0);
	let pinWidth = $state(0);

	let scrollTarget: HTMLElement | Window = window;
	let lastClonedVersion = -1;
	let lastClonedBoundary: number | null = null;
	let rafId = 0;

	/** Nearest scrollable ancestor of `el` (inclusive), else window. */
	function findScrollContainer(el: HTMLElement | null): HTMLElement | Window {
		let cur: HTMLElement | null = el;
		while (cur && cur !== document.body) {
			const oy = getComputedStyle(cur).overflowY;
			if (oy === 'auto' || oy === 'scroll') return cur;
			cur = cur.parentElement;
		}
		return window;
	}

	/** On the mobile route the global TopNav is `position: sticky; top:0`, so
	 *  the free viewport for note content begins at its bottom edge. Chromeless
	 *  desktop windows (element scroll containers) have no such nav. */
	function navOffset(): number {
		const nav = document.querySelector('.topnav') as HTMLElement | null;
		if (!nav) return 0;
		const pos = getComputedStyle(nav).position;
		if (pos !== 'sticky' && pos !== 'fixed') return 0;
		const r = nav.getBoundingClientRect();
		return r.top <= 0.5 ? Math.max(0, r.bottom) : 0;
	}

	function cloneHeader() {
		if (!editor || !contentEl || boundaryIndex == null) return;
		const dom = editor.view.dom as HTMLElement;
		contentEl.replaceChildren();
		const n = Math.min(boundaryIndex, dom.children.length);
		for (let i = 0; i < n; i++) {
			const clone = dom.children[i].cloneNode(true) as HTMLElement;
			clone.removeAttribute('contenteditable');
			clone
				.querySelectorAll('[contenteditable]')
				.forEach((el) => (el as HTMLElement).removeAttribute('contenteditable'));
			contentEl.appendChild(clone);
		}
		lastClonedVersion = version;
		lastClonedBoundary = boundaryIndex;
	}

	function measure() {
		rafId = 0;
		if (!editor || !editorEl || boundaryIndex == null) {
			visible = false;
			return;
		}
		const dom = editor.view.dom as HTMLElement;
		const markerEl = dom.children[boundaryIndex] as HTMLElement | undefined;
		if (!markerEl) {
			visible = false;
			return;
		}
		const top =
			scrollTarget === window
				? navOffset()
				: (scrollTarget as HTMLElement).getBoundingClientRect().top;
		const markerTop = markerEl.getBoundingClientRect().top;
		const shouldShow = markerTop <= top + 0.5;
		if (shouldShow) {
			const er = editorEl.getBoundingClientRect();
			pinTop = top;
			pinLeft = er.left;
			pinWidth = er.width;
			if (lastClonedVersion !== version || lastClonedBoundary !== boundaryIndex) {
				cloneHeader();
			}
		}
		visible = shouldShow;
	}

	function schedule() {
		if (rafId) return;
		rafId = requestAnimationFrame(measure);
	}

	function scrollToTop() {
		if (scrollTarget === window) window.scrollTo({ top: 0, behavior: 'smooth' });
		else (scrollTarget as HTMLElement).scrollTo({ top: 0, behavior: 'smooth' });
	}

	let ro: ResizeObserver | null = null;
	onMount(() => {
		scrollTarget = findScrollContainer(editorEl);
		scrollTarget.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule, { passive: true });
		if (editorEl) {
			ro = new ResizeObserver(schedule);
			ro.observe(editorEl);
		}
		schedule();
		return () => {
			scrollTarget.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
			ro?.disconnect();
			if (rafId) cancelAnimationFrame(rafId);
		};
	});

	// Re-measure (and re-clone) whenever the doc version or boundary changes.
	$effect(() => {
		version;
		boundaryIndex;
		schedule();
	});
</script>

{#if boundaryIndex != null}
	<div
		class="tomboy-eq-sticky"
		class:visible
		style="top:{pinTop}px; left:{pinLeft}px; width:{pinWidth}px;"
		role="button"
		tabindex="0"
		title="맨 위로"
		onclick={scrollToTop}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				scrollToTop();
			}
		}}
	>
		<div class="tomboy-eq-sticky-content" bind:this={contentEl}></div>
	</div>
{/if}

<style>
	.tomboy-eq-sticky {
		position: fixed;
		z-index: 15; /* below TopNav (20), above editor content */
		display: none;
		max-height: 40vh;
		overflow-y: auto;
		background: #fff;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
		border-bottom: 3px solid #333;
		cursor: pointer;
		box-sizing: border-box;
		padding: 0.25rem 0.5rem;
	}
	.tomboy-eq-sticky.visible {
		display: block;
	}
	/* Cloned blocks are read-only; clicks bubble to the container (scroll-to-top). */
	.tomboy-eq-sticky-content {
		pointer-events: none;
		font-size: 16px;
		line-height: 1.4;
		color: #222;
	}
	.tomboy-eq-sticky-content :global(p) {
		margin: 0.2em 0;
	}
	.tomboy-eq-sticky-content :global(img) {
		max-width: 100%;
		height: auto;
	}
</style>
```

- [ ] **Step 2: 타입 체크**

Run: `cd app && npm run check`
Expected: StickyHeader 관련 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add app/src/lib/editor/eqHeader/StickyHeader.svelte
git commit -m "feat(editor): === 고정 헤더 미러 오버레이 컴포넌트"
```

---

### Task 3: TomboyEditor 배선 + 마커 CSS

**Goal:** `eqHeaderPlugin`을 등록하고 경계/버전을 reactive 상태로 받아 `StickyHeader`를 마운트하며, `===`를 굵은 수평선으로 그리는 CSS를 추가한다.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte`

**Acceptance Criteria:**
- [ ] `===` 단독 라인(인덱스≥1)이 문서 내에서 굵은(`---`보다 두꺼운) 회색/검정 수평선으로 렌더.
- [ ] 노트에 `===`가 있으면 그 위로 스크롤할 때 헤더 미러가 상단에 나타나고, 최상단에선 사라짐.
- [ ] 미러 클릭 시 맨 위로 스크롤.
- [ ] `===`가 2개 이상이면 첫 번째만 경계로 동작(미러 1개), 나머지는 굵은 선만.
- [ ] 모바일 라우트(window 스크롤)와 데스크톱 NoteWindow(`.tomboy-editor` 스크롤) 양쪽에서 동작.

**Verify:** `cd app && npm run dev` → (1) 모바일 뷰포트의 `/note/[id]`에서 제목 아래 `===` 입력 후 본문 채우고 스크롤 → 상단 미러 등장/클릭 시 top 이동, (2) `/desktop`의 NoteWindow에서 동일 노트 열어 동일 동작 확인. `npm run check` 통과.

**Steps:**

- [ ] **Step 1: import 추가** — 기존 hrSplit import 근처(파일 상단 import 블록)

```ts
import { createEqHeaderPlugin, eqHeaderPluginKey } from './eqHeader/eqHeaderPlugin.js';
import StickyHeader from './eqHeader/StickyHeader.svelte';
```

- [ ] **Step 2: reactive 상태 선언** — `let editor: Editor | null = $state(null);` 선언 근처에 추가

```ts
	// `===` 고정 헤더: 경계(top-level 인덱스)와 doc 버전. eqHeaderPlugin 의
	// onChange 가 갱신하고 StickyHeader 가 소비한다.
	let eqBoundary = $state<number | null>(null);
	let eqVersion = $state(0);
```

- [ ] **Step 3: 플러그인 등록** — 기존 `name: "tomboyHrSplit"` Extension 블록 바로 다음에 새 Extension 추가

```ts
				Extension.create({
					name: "tomboyEqHeader",
					addProseMirrorPlugins() {
						return [
							createEqHeaderPlugin({
								onChange: (boundary, version) => {
									eqBoundary = boundary;
									eqVersion = version;
								},
							}),
						];
					},
				}),
```

- [ ] **Step 4: 초기 상태 시딩** — `editor` 가 생성된 직후(onMount 안에서 `editor = new Editor({...})` 완료 지점). 플러그인 view() 가 onChange 를 호출하지만, 클로저가 늦게 바인딩되는 경우를 대비해 직접 시딩한다.

editor 생성 직후 다음을 추가:

```ts
		// Seed `===` boundary/version from the freshly-created plugin state so a
		// note that already contains `===` shows the sticky header immediately,
		// regardless of view()/onChange ordering.
		{
			const st = eqHeaderPluginKey.getState(editor.state);
			if (st) {
				eqBoundary = st.boundary;
				eqVersion = st.version;
			}
		}
```

(만약 editor 생성이 `onMount` 가 아닌 다른 위치라면, 생성 직후/`editor` 할당 직후 동일 블록을 둔다.)

- [ ] **Step 5: StickyHeader 마운트** — markup의 `.tomboy-editor-shell` 안, 에디터 div 다음에 추가

기존:
```svelte
	<div
		bind:this={editorElement}
		class="tomboy-editor"
		class:tomboy-todo-ctrl-hold={ctrlHeld}
		oncontextmenu={handleContextMenu}
	></div>
</div>
```
변경:
```svelte
	<div
		bind:this={editorElement}
		class="tomboy-editor"
		class:tomboy-todo-ctrl-hold={ctrlHeld}
		oncontextmenu={handleContextMenu}
	></div>
	<StickyHeader
		{editor}
		editorEl={editorElement}
		boundaryIndex={eqBoundary}
		version={eqVersion}
	/>
</div>
```

- [ ] **Step 6: 마커 CSS 추가** — `.tomboy-editor :global(.tomboy-hr-marker)` 블록들 근처(`<style>` 안)에 추가

```css
	/* `===` 단독 라인 → 굵은 수평선. `---`(.tomboy-hr-marker)보다 두껍고
	   진하게. 인덱스 0(제목)은 데코레이션되지 않으므로 영향 없음. 첫 마커는
	   고정 헤더 경계(.tomboy-eq-marker-active)이며 살짝 더 진하다. 미러
	   오버레이 자체의 스타일은 StickyHeader.svelte 안에 있다. */
	.tomboy-editor :global(.tomboy-eq-marker) {
		position: relative;
		color: transparent;
		caret-color: #333;
		min-height: 1.2em;
		margin: 0.8em 0;
		padding: 0;
	}
	.tomboy-editor :global(.tomboy-eq-marker::before) {
		content: "";
		position: absolute;
		inset: 0;
		background: linear-gradient(
			to bottom,
			transparent calc(50% - 2px),
			#555 calc(50% - 2px),
			#555 calc(50% + 2px),
			transparent calc(50% + 2px)
		);
		pointer-events: none;
	}
	.tomboy-editor :global(.tomboy-eq-marker-active::before) {
		background: linear-gradient(
			to bottom,
			transparent calc(50% - 2.5px),
			#222 calc(50% - 2.5px),
			#222 calc(50% + 2.5px),
			transparent calc(50% + 2.5px)
		);
	}
```

- [ ] **Step 7: 타입 체크 + 빌드 확인**

Run: `cd app && npm run check`
Expected: 에러 없음.

- [ ] **Step 8: 수동 검증 (Verify 항목 전부)**

Run: `cd app && npm run dev` — 브라우저에서 모바일 뷰 + 데스크톱 NoteWindow 양쪽 확인.
- 제목 라인 다음 라인에 `===` 입력 → 굵은 선 렌더.
- 본문을 충분히 길게 채우고 아래로 스크롤 → 상단에 헤더 미러 등장.
- 미러 클릭 → 맨 위로 smooth scroll, 미러 사라짐.
- `===`를 하나 더 추가 → 두 번째는 굵은 선만, 미러는 여전히 1개(첫 경계 기준).

> 참고(알려진 튜닝 항목): 복제된 헤더는 `.tomboy-editor` 밖이라 에디터 타이포그래피 글로벌 규칙이 캐스케이드되지 않는다. 본문 구조(굵게/링크/이미지)는 보존되지만 폰트/여백이 다를 수 있어 StickyHeader의 미러 CSS로 최소 보정만 한다. 모바일에서 미러 상단 위치가 TopNav와 겹치면 `navOffset()`이 `.topnav` 하단으로 핀하는지 확인.

- [ ] **Step 9: 커밋**

```bash
git add app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(editor): === 고정 헤더 플러그인 배선 + 굵은 선 CSS"
```

---

### Task 4: 설정 가이드 카드

**Goal:** 설정 → 가이드(editor 서브탭)에 `===` 고정 헤더 기능을 설명하는 카드를 추가한다(CLAUDE.md의 "user-facing features must be documented in 설정 → 가이드" 규칙).

**Files:**
- Modify: `app/src/routes/settings/+page.svelte`

**Acceptance Criteria:**
- [ ] editor 서브탭(`{:else if guideSubTab === 'editor'}` 블록, 약 line 1706 이후)에 `<details class="guide-card">` 1장 추가.
- [ ] 기존 카드 패턴(짧은 `<summary>`, `<p class="info-text">`, `<pre class="snippet">`, `<ul class="guide-list">`)을 따른다.
- [ ] 제약을 명시: 굵은 선·위쪽이 상단 고정·문서당 1개(2개 이상이면 최상단만)·클릭 시 맨 위로·동기화/저장 상태 없음.

**Verify:** `cd app && npm run dev` → 설정 → 가이드 → 편집 탭에서 카드가 보이고 펼쳐짐.

**Steps:**

- [ ] **Step 1: 가이드 카드 추가** — editor 서브탭의 다른 카드들 사이(예: HR/표 관련 카드 근처)에 삽입

```svelte
				<details class="guide-card">
					<summary>=== 고정 헤더 — 위쪽을 상단에 고정</summary>
					<p class="info-text">
						한 라인에 단독으로 <code>===</code>(등호 3개 이상)를 두면 굵은 수평선이 그려지고,
						그 선보다 <strong>위쪽 내용이 스크롤해도 항상 상단에 고정</strong>되는 헤더가 됩니다.
						고정된 헤더를 누르면 문서 맨 위로 이동합니다.
					</p>
					<pre class="snippet">제목 라인
===
여기부터 본문 (스크롤 영역)</pre>
					<ul class="guide-list">
						<li><code>===</code>는 <strong>제목 바로 다음 줄부터</strong> 인식됩니다(제목 줄 자체는 마커가 아님).</li>
						<li>한 문서에 <strong>하나만</strong> 적용됩니다. 두 개 이상이면 <strong>가장 위의 것만</strong> 고정 경계가 되고, 나머지는 그냥 굵은 선으로만 표시됩니다.</li>
						<li>헤더가 길면 화면의 일정 높이(약 40%)까지만 보이고 내부에서 스크롤됩니다.</li>
						<li>고정 헤더는 <strong>읽기 전용 미러</strong>입니다. 편집은 위로 스크롤해 원래 위치에서 하세요.</li>
						<li><code>===</code>는 노트 내용에 그대로 저장됩니다(별도 토글·동기화 설정 없음).</li>
					</ul>
				</details>
```

- [ ] **Step 2: 수동 확인**

Run: `cd app && npm run dev` → 설정 → 가이드 → 편집 탭에서 카드 표시 확인.

- [ ] **Step 3: 커밋**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(guide): === 고정 헤더 가이드 카드 추가"
```

---

## Self-Review

- **Spec coverage:** 마커/경계(Task 1) · 미러 오버레이(Task 2) · 배선+굵은 선 CSS(Task 3) · 가이드 카드(Task 4) — spec의 모든 섹션 매핑. 영속성 없음(추가 코드 불필요), NoteWindow 변경은 자동 감지로 생략(spec의 prop 안을 단순화 — 기능 동일).
- **Placeholder scan:** 모든 코드 스텝에 실제 코드 포함, 명령·기대 출력 명시. 플레이스홀더 없음.
- **Type consistency:** `eqHeaderPluginKey`/`EqHeaderState`/`createEqHeaderPlugin`/`isEqualsParagraph`/`findEqBoundary` 이름이 Task 1 정의와 Task 3 사용에서 일치. StickyHeader props(`editor`/`editorEl`/`boundaryIndex`/`version`)가 Task 2 정의와 Task 3 마운트에서 일치.
- **테스트:** 순수 함수는 자동(vitest), 미러/스크롤/CSS는 spec대로 수동 검증.
