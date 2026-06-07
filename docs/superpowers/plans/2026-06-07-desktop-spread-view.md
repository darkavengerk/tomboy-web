# 데스크탑 펼쳐보기 (Spread View) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/desktop`에서 F4로 현재 작업공간에 열린 노트 창들을 실제 크기 그대로 겹치지 않게 정렬해 한 화면에 펼쳐 훑어보고, 클릭해 그 창으로 이동하는 읽기전용 오버레이를 추가한다.

**Architecture:** 전체화면 오버레이(`SpreadOverlay`)가 캔버스 위를 덮고, 현재 워크스페이스의 `kind==='note'` 창들을 실제 w/h 카드로 만든다. 카드 내용은 살아있는 창 콘텐츠 DOM을 `cloneNode`한 정적 스냅샷. 순수 함수 `packShelves`(First-Fit 선반 패킹)로 좌측 정렬 배치하고 세로 스크롤. 오른쪽 커스텀 스크롤바=갤러리 스크롤, 마우스 휠=카드 내용 스크롤(`overscroll-behavior: contain`). 기존 캔버스/창/영속성은 무손상.

**Tech Stack:** SvelteKit + Svelte 5 runes, TypeScript, vitest + @testing-library/svelte. 외부 라이브러리 없음(저장소의 no-lib 관례 — `dragResize.ts`와 동일).

**Spec:** `docs/superpowers/specs/2026-06-07-desktop-spread-view-design.md`

---

### Task 10: packShelves 순수 패커

**Goal:** 실제 크기를 유지하며 입력 순서를 보존하는 First-Fit 선반 패킹 순수 함수.

**Files:**
- Create: `app/src/lib/desktop/spreadView/packShelves.ts`
- Test: `app/tests/unit/desktop/packShelves.test.ts`

**Acceptance Criteria:**
- [ ] `packShelves(boxes, containerWidth, gap)` → `{ placed, totalHeight }`
- [ ] 좌측 정렬, 입력 순서 보존(높이 정렬 안 함)
- [ ] 폭 > `containerWidth`면 `containerWidth`로 클램프(단독 전체폭 행)
- [ ] `gap` 간격 적용, 빈 입력 → `totalHeight: 0`
- [ ] 모든 테스트 통과

**Verify:** `cd app && npm run test -- packShelves` → PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/desktop/packShelves.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { packShelves, type Box } from '$lib/desktop/spreadView/packShelves.js';

const box = (guid: string, w: number, h: number): Box => ({ guid, w, h });

describe('packShelves', () => {
	it('returns empty layout for no boxes', () => {
		expect(packShelves([], 1000, 16)).toEqual({ placed: [], totalHeight: 0 });
	});

	it('places boxes left-to-right on one shelf when they fit', () => {
		const r = packShelves([box('a', 300, 200), box('b', 300, 150)], 1000, 16);
		expect(r.placed).toEqual([
			{ guid: 'a', x: 0, y: 0, w: 300, h: 200 },
			{ guid: 'b', x: 316, y: 0, w: 300, h: 150 }
		]);
		expect(r.totalHeight).toBe(200); // shelf height = tallest box on the shelf
	});

	it('wraps to a new shelf below the tallest box of the previous shelf', () => {
		const r = packShelves(
			[box('a', 600, 200), box('b', 600, 150), box('c', 300, 100)],
			1000,
			16
		);
		// a + b: 600 + 16 + 600 = 1216 > 1000 → b wraps
		expect(r.placed[0]).toEqual({ guid: 'a', x: 0, y: 0, w: 600, h: 200 });
		expect(r.placed[1]).toEqual({ guid: 'b', x: 0, y: 216, w: 600, h: 150 });
		// c next to b on shelf 2: 600 + 16 + 300 = 916 <= 1000
		expect(r.placed[2]).toEqual({ guid: 'c', x: 616, y: 216, w: 300, h: 100 });
		expect(r.totalHeight).toBe(366); // 200 + 16 + max(150,100)
	});

	it('preserves input order (no height sorting)', () => {
		const r = packShelves([box('tall', 300, 900), box('short', 300, 50)], 1000, 16);
		expect(r.placed.map((p) => p.guid)).toEqual(['tall', 'short']);
	});

	it('clamps a box wider than the container to container width', () => {
		const r = packShelves([box('wide', 1400, 300)], 1000, 16);
		expect(r.placed[0]).toEqual({ guid: 'wide', x: 0, y: 0, w: 1000, h: 300 });
		expect(r.totalHeight).toBe(300);
	});

	it('keeps a full-width box on its own shelf', () => {
		const r = packShelves([box('a', 1000, 100), box('b', 200, 80)], 1000, 16);
		// a is exactly containerWidth → b can't fit (1000+16+200 > 1000) → wraps
		expect(r.placed[0]).toEqual({ guid: 'a', x: 0, y: 0, w: 1000, h: 100 });
		expect(r.placed[1]).toEqual({ guid: 'b', x: 0, y: 116, w: 200, h: 80 });
		expect(r.totalHeight).toBe(196);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- packShelves`
Expected: FAIL — `Failed to resolve import "$lib/desktop/spreadView/packShelves.js"`

- [ ] **Step 3: 구현 작성** — `app/src/lib/desktop/spreadView/packShelves.ts`

```ts
/**
 * Pure First-Fit "shelf" packing for the desktop 펼쳐보기 (spread view).
 *
 * Boxes keep their real width/height; we lay them left-to-right into rows
 * ("shelves") of fixed `containerWidth`. When the next box doesn't fit on the
 * current shelf, a new shelf starts below the tallest box of the previous one.
 * Input order is preserved (no height sorting) so visual order matches the
 * caller's order (row-major by original window position). A box wider than the
 * container is clamped to the container width (full-width row).
 *
 * Hand-rolled (no library) to match this repo's no-lib convention — see
 * `dragResize.ts`. Trade-off: real-size packing leaves a ragged right edge,
 * which is the accepted cost of preserving each note's true size.
 */
export interface Box {
	guid: string;
	w: number;
	h: number;
}

export interface PlacedBox extends Box {
	x: number;
	y: number;
}

export interface PackResult {
	placed: PlacedBox[];
	totalHeight: number;
}

export function packShelves(boxes: Box[], containerWidth: number, gap: number): PackResult {
	const placed: PlacedBox[] = [];
	let shelfX = 0;
	let shelfY = 0;
	let shelfH = 0;
	for (const box of boxes) {
		const w = Math.min(box.w, containerWidth);
		const h = box.h;
		// Start a new shelf when the box can't fit on the current one. The
		// `shelfX > 0` guard keeps the first box on shelf 0 even when it is
		// exactly `containerWidth` wide.
		if (shelfX > 0 && shelfX + w > containerWidth) {
			shelfY += shelfH + gap;
			shelfX = 0;
			shelfH = 0;
		}
		placed.push({ guid: box.guid, x: shelfX, y: shelfY, w, h });
		shelfX += w + gap;
		shelfH = Math.max(shelfH, h);
	}
	return { placed, totalHeight: boxes.length ? shelfY + shelfH : 0 };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- packShelves`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/desktop/spreadView/packShelves.ts app/tests/unit/desktop/packShelves.test.ts
git commit -m "feat(desktop): packShelves pure shelf-packing for spread view"
```

---

### Task 11: spreadView 상태 모듈

**Goal:** 펼쳐보기 열림 여부를 담는 휘발성 룬 상태 모듈.

**Files:**
- Create: `app/src/lib/desktop/spreadView/spreadView.svelte.ts`
- Test: `app/tests/unit/desktop/spreadView.test.ts`

**Acceptance Criteria:**
- [ ] `spreadView.isOpen` 게터
- [ ] `open()` / `close()` / `toggle()`
- [ ] 비영속(세션 한정), 모듈 싱글턴

**Verify:** `cd app && npm run test -- spreadView` → PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/desktop/spreadView.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { spreadView } from '$lib/desktop/spreadView/spreadView.svelte.js';

beforeEach(() => spreadView.close());

describe('spreadView', () => {
	it('starts closed and toggles open/closed', () => {
		expect(spreadView.isOpen).toBe(false);
		spreadView.open();
		expect(spreadView.isOpen).toBe(true);
		spreadView.close();
		expect(spreadView.isOpen).toBe(false);
		spreadView.toggle();
		expect(spreadView.isOpen).toBe(true);
		spreadView.toggle();
		expect(spreadView.isOpen).toBe(false);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- spreadView`
Expected: FAIL — cannot resolve `spreadView.svelte.js`

- [ ] **Step 3: 구현 작성** — `app/src/lib/desktop/spreadView/spreadView.svelte.ts`

```ts
/**
 * Module reactive state for the desktop 펼쳐보기 (spread view) overlay.
 *
 * Transient + session-only — never persisted. The overlay is a pure read-only
 * layer over the current workspace; closing it leaves every window untouched.
 */
let open = $state(false);

export const spreadView = {
	get isOpen(): boolean {
		return open;
	},
	open(): void {
		open = true;
	},
	close(): void {
		open = false;
	},
	toggle(): void {
		open = !open;
	}
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- spreadView`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/desktop/spreadView/spreadView.svelte.ts app/tests/unit/desktop/spreadView.test.ts
git commit -m "feat(desktop): spreadView open/close state module"
```

---

### Task 12: 스냅샷 소스 등록부 (+ NoteWindow 등록)

**Goal:** 창이 자기 콘텐츠 DOM과 제목을 등록해, 오버레이가 동기적으로 읽어 카드를 만들 수 있게 한다.

**Files:**
- Modify: `app/src/lib/desktop/session.svelte.ts` (등록부 + `SpreadSnapshot` 타입 + `getSnapshotSource` + `_reset` 정리)
- Modify: `app/src/lib/desktop/NoteWindow.svelte` (`.body` 바인딩 + onMount 등록)
- Test: `app/tests/unit/desktop/snapshotSource.test.ts`

**Acceptance Criteria:**
- [ ] `registerSnapshotSource(guid, () => SpreadSnapshot | null)` → 해제 함수
- [ ] `desktopSession.getSnapshotSource(guid)`가 등록 함수를 호출해 결과(또는 null) 반환
- [ ] `NoteWindow`가 onMount에서 `{ title, el }` 등록(에디터면 ProseMirror DOM, 아니면 `.body`), unmount에서 해제
- [ ] 기존 동작 무변경(순수 추가 API)

**Verify:** `cd app && npm run test -- snapshotSource && npm run check`

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/desktop/snapshotSource.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { registerSnapshotSource, desktopSession } from '$lib/desktop/session.svelte.js';

describe('snapshot source registry', () => {
	it('registers, resolves, and unregisters a source', () => {
		const el = document.createElement('div');
		const off = registerSnapshotSource('g1', () => ({ title: 'T', el }));
		expect(desktopSession.getSnapshotSource('g1')).toEqual({ title: 'T', el });
		off();
		expect(desktopSession.getSnapshotSource('g1')).toBeNull();
	});

	it('returns null for an unknown guid', () => {
		expect(desktopSession.getSnapshotSource('nope')).toBeNull();
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- snapshotSource`
Expected: FAIL — `registerSnapshotSource` / `getSnapshotSource` not exported

- [ ] **Step 3: session.svelte.ts에 등록부 추가**

`session.svelte.ts`의 reload-hook 블록 바로 뒤(현재 `const editorRegistry = new Map...` 줄 부근, 대략 line 122)에 추가:

```ts
/** Read-only snapshot descriptor a window exposes for 펼쳐보기 (spread view). */
export interface SpreadSnapshot {
	/** Note title for the card header. */
	title: string;
	/** Live content element to clone into the read-only card, or null. */
	el: HTMLElement | null;
}

const snapshotSources = new Map<string, () => SpreadSnapshot | null>();

/**
 * A note window registers a snapshot source so 펼쳐보기 can build a read-only
 * card from the window's live content (the ProseMirror DOM for editor notes, or
 * the window body for terminal/loading windows). Returns an unregister fn.
 */
export function registerSnapshotSource(
	guid: string,
	fn: () => SpreadSnapshot | null
): () => void {
	snapshotSources.set(guid, fn);
	return () => {
		if (snapshotSources.get(guid) === fn) snapshotSources.delete(guid);
	};
}
```

`desktopSession` 객체에 메서드 추가(예: `getEditorForGuid` 근처):

```ts
	/** Resolve the snapshot (title + clonable element) for an open window. */
	getSnapshotSource(guid: string): SpreadSnapshot | null {
		return snapshotSources.get(guid)?.() ?? null;
	},
```

`_reset()`의 `editorRegistry.clear();` 줄 바로 뒤에 추가:

```ts
		snapshotSources.clear();
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- snapshotSource`
Expected: PASS (2 tests)

- [ ] **Step 5: NoteWindow.svelte — import에 registerSnapshotSource 추가**

기존 import(대략 line 53-56)를 찾아:

```ts
		registerFlushHook,
		registerReloadHook,
```

다음으로 교체:

```ts
		registerFlushHook,
		registerReloadHook,
		registerSnapshotSource,
```

- [ ] **Step 6: NoteWindow.svelte — `.body` 엘리먼트 바인딩**

`editorComponent` 선언 부근(대략 line 123)에 ref 변수 추가:

```ts
	let bodyEl: HTMLDivElement | undefined;
```

템플릿의 `.body` 여는 태그(대략 line 873)를:

```svelte
	<div class="body" class:terminal-edit={(!!terminalSpec && !showTerminal) || (!!keysSpec && !showKeys)}>
```

다음으로 교체(`bind:this` 추가):

```svelte
	<div bind:this={bodyEl} class="body" class:terminal-edit={(!!terminalSpec && !showTerminal) || (!!keysSpec && !showKeys)}>
```

- [ ] **Step 7: NoteWindow.svelte — onMount에서 스냅샷 소스 등록**

onMount 안, reload 훅 등록(대략 line 263 `const unregisterReload = ...`) 바로 뒤에 추가:

```ts
		// Register a snapshot source so 펼쳐보기 can clone this window's live
		// content into a read-only card. Editor notes expose the ProseMirror
		// root (clean, full-height, no inner scroll); other kinds fall back to
		// the window body.
		const unregisterSnapshot = registerSnapshotSource(guid, () => ({
			title: note?.title?.trim() || '제목 없음',
			el: getEditor()?.view.dom ?? bodyEl ?? null
		}));
```

onMount cleanup의 `unregisterReload();` 바로 뒤에 추가:

```ts
			unregisterSnapshot();
```

- [ ] **Step 8: 타입/회귀 확인**

Run: `cd app && npm run check`
Expected: 0 errors (신규 코드 관련)

- [ ] **Step 9: 커밋**

```bash
git add app/src/lib/desktop/session.svelte.ts app/src/lib/desktop/NoteWindow.svelte app/tests/unit/desktop/snapshotSource.test.ts
git commit -m "feat(desktop): snapshot source registry for spread view cards"
```

---

### Task 13: SpreadScrollbar 커스텀 스크롤바

**Goal:** 오른쪽의 크고 두꺼운 커스텀 세로 스크롤바 — 스크롤 컨테이너에 바인딩해 thumb 위치/크기를 반영하고, 드래그로 `scrollTop`을 제어(Firefox에서 네이티브 스크롤바 폭을 못 키우는 제약 우회).

**Files:**
- Create: `app/src/lib/desktop/spreadView/SpreadScrollbar.svelte`

**Acceptance Criteria:**
- [ ] thumb 높이 = `clientHeight / scrollHeight`, 위치 = `scrollTop` 비율
- [ ] thumb 드래그 → 대상 `scrollTop` 설정
- [ ] 트랙 클릭 → 페이지 단위 이동
- [ ] 스크롤 불필요(콘텐츠가 짧음)하면 숨김

**Verify:** `cd app && npm run check` → 0 errors; 수동: `npm run dev` → `/desktop`에서 F4 후 thumb 드래그 동작

**Steps:**

- [ ] **Step 1: 구현 작성** — `app/src/lib/desktop/spreadView/SpreadScrollbar.svelte`

```svelte
<script lang="ts">
	/**
	 * Big custom vertical scrollbar bound to an external scroll container.
	 * Drives the gallery (page) scroll for 펼쳐보기. A custom widget (not a
	 * styled native scrollbar) so the "big" thumb renders identically in
	 * Firefox, which can't widen `::-webkit-scrollbar`.
	 */
	interface Props {
		target: HTMLElement | null;
	}
	let { target }: Props = $props();

	let trackEl: HTMLDivElement | undefined;
	let scrollTop = $state(0);
	let scrollHeight = $state(0);
	let clientHeight = $state(0);

	function sync() {
		if (!target) return;
		scrollTop = target.scrollTop;
		scrollHeight = target.scrollHeight;
		clientHeight = target.clientHeight;
	}

	$effect(() => {
		const el = target;
		if (!el) return;
		sync();
		el.addEventListener('scroll', sync, { passive: true });
		const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
		ro?.observe(el);
		return () => {
			el.removeEventListener('scroll', sync);
			ro?.disconnect();
		};
	});

	const scrollable = $derived(scrollHeight > clientHeight + 1);
	const thumbHeightPct = $derived(
		scrollable ? Math.max(8, (clientHeight / scrollHeight) * 100) : 100
	);
	const maxScroll = $derived(Math.max(1, scrollHeight - clientHeight));
	const thumbTopPct = $derived(
		scrollable ? (scrollTop / maxScroll) * (100 - thumbHeightPct) : 0
	);

	let dragging = false;
	let dragStartY = 0;
	let dragStartScroll = 0;

	function onThumbPointerDown(e: PointerEvent) {
		if (!target) return;
		e.preventDefault();
		e.stopPropagation();
		try {
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		} catch {
			/* test env / unsupported — drag still works */
		}
		dragging = true;
		dragStartY = e.clientY;
		dragStartScroll = target.scrollTop;
	}
	function onThumbPointerMove(e: PointerEvent) {
		if (!dragging || !target || !trackEl) return;
		const trackH = trackEl.clientHeight;
		const thumbPx = trackH * (thumbHeightPct / 100);
		const travel = Math.max(1, trackH - thumbPx);
		const dy = e.clientY - dragStartY;
		target.scrollTop = dragStartScroll + (dy / travel) * maxScroll;
	}
	function onThumbPointerUp(e: PointerEvent) {
		dragging = false;
		try {
			(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		} catch {
			/* noop */
		}
	}
	function onTrackPointerDown(e: PointerEvent) {
		if (!target || !trackEl) return;
		const rect = trackEl.getBoundingClientRect();
		const clickPct = ((e.clientY - rect.top) / rect.height) * 100;
		const thumbCenter = thumbTopPct + thumbHeightPct / 2;
		const dir = clickPct > thumbCenter ? 1 : -1;
		target.scrollBy({ top: dir * clientHeight * 0.9, behavior: 'smooth' });
	}
</script>

<div
	class="spread-scrollbar"
	class:hidden={!scrollable}
	bind:this={trackEl}
	onpointerdown={onTrackPointerDown}
	aria-hidden="true"
>
	<div
		class="thumb"
		style="height:{thumbHeightPct}%; top:{thumbTopPct}%;"
		onpointerdown={onThumbPointerDown}
		onpointermove={onThumbPointerMove}
		onpointerup={onThumbPointerUp}
		onpointercancel={onThumbPointerUp}
	></div>
</div>

<style>
	.spread-scrollbar {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: 22px;
		background: rgba(255, 255, 255, 0.06);
		cursor: pointer;
		z-index: 5;
	}
	.spread-scrollbar.hidden {
		display: none;
	}
	.thumb {
		position: absolute;
		right: 3px;
		width: 16px;
		min-height: 28px;
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.38);
		cursor: grab;
	}
	.thumb:active {
		cursor: grabbing;
		background: rgba(255, 255, 255, 0.6);
	}
</style>
```

- [ ] **Step 2: 타입 확인**

Run: `cd app && npm run check`
Expected: 0 errors (신규 코드 관련)

- [ ] **Step 3: 커밋**

```bash
git add app/src/lib/desktop/spreadView/SpreadScrollbar.svelte
git commit -m "feat(desktop): custom big scrollbar widget for spread view"
```

---

### Task 14: SpreadOverlay 오버레이

**Goal:** 현재 워크스페이스 노트 창을 수집·정렬·패킹해 실제크기 카드로 렌더하고, 2채널 스크롤·클릭 점프·Esc 종료를 묶는 핵심 컴포넌트.

**Files:**
- Create: `app/src/lib/desktop/spreadView/SpreadOverlay.svelte`
- Test: `app/tests/unit/desktop/SpreadOverlay.test.ts`

**Acceptance Criteria:**
- [ ] 현재 워크스페이스 `kind==='note'` 창만, row-major(y→x) 정렬
- [ ] `getSnapshotSource`로 `cloneNode` 카드, 소스 없으면 "미리보기 없음" 폴백
- [ ] `packShelves` 좌표로 absolute 배치, 스크롤 콘텐츠 height=`totalHeight`
- [ ] 카드 `overflow-y:auto` + `overscroll-behavior:contain`, 네이티브 스크롤바 숨김
- [ ] `SpreadScrollbar` 호스팅, 카드 클릭 → `close()`+`focusWindow`, Esc(capture) 종료
- [ ] 스모크 테스트 통과

**Verify:** `cd app && npm run test -- SpreadOverlay && npm run check`

**Steps:**

- [ ] **Step 1: 실패하는 스모크 테스트 작성** — `app/tests/unit/desktop/SpreadOverlay.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';

// jsdom lacks ResizeObserver (used by the child SpreadScrollbar).
class RO {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;

const focusWindow = vi.fn();
const close = vi.fn();
let fakeWindows: Array<{ guid: string; kind: string; x: number; y: number; width: number; height: number }> = [];
const sources: Record<string, { title: string; el: HTMLElement } | null> = {};

vi.mock('$lib/desktop/session.svelte.js', () => ({
	desktopSession: {
		get windows() {
			return fakeWindows;
		},
		getSnapshotSource: (g: string) => sources[g] ?? null,
		focusWindow
	}
}));
vi.mock('$lib/desktop/spreadView/spreadView.svelte.js', () => ({
	spreadView: {
		get isOpen() {
			return true;
		},
		open() {},
		close,
		toggle() {}
	}
}));

import SpreadOverlay from '$lib/desktop/spreadView/SpreadOverlay.svelte';

beforeEach(() => {
	focusWindow.mockClear();
	close.mockClear();
	const a = document.createElement('div');
	a.textContent = 'note one body';
	const b = document.createElement('div');
	b.textContent = 'note two body';
	sources['a'] = { title: 'Note A', el: a };
	sources['b'] = { title: 'Note B', el: b };
	fakeWindows = [
		{ guid: 'a', kind: 'note', x: 0, y: 0, width: 300, height: 200 },
		{ guid: 'b', kind: 'note', x: 0, y: 400, width: 300, height: 200 },
		{ guid: '__settings__', kind: 'settings', x: 0, y: 0, width: 400, height: 400 }
	];
});

describe('SpreadOverlay', () => {
	it('renders one card per note window (settings excluded) with title + cloned body', () => {
		const { getByText, queryByText } = render(SpreadOverlay);
		expect(getByText('Note A')).toBeInTheDocument();
		expect(getByText('Note B')).toBeInTheDocument();
		expect(getByText('note one body')).toBeInTheDocument();
		expect(getByText('note two body')).toBeInTheDocument();
		// settings window must NOT produce a card
		expect(queryByText('__settings__')).toBeNull();
	});

	it('clicking a card jumps to that window and closes the overlay', async () => {
		const { getByTitle } = render(SpreadOverlay);
		await fireEvent.click(getByTitle('Note A'));
		expect(focusWindow).toHaveBeenCalledWith('a');
		expect(close).toHaveBeenCalled();
	});

	it('Escape closes the overlay', async () => {
		render(SpreadOverlay);
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(close).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- SpreadOverlay`
Expected: FAIL — cannot resolve `SpreadOverlay.svelte`

- [ ] **Step 3: 구현 작성** — `app/src/lib/desktop/spreadView/SpreadOverlay.svelte`

```svelte
<script lang="ts">
	import { desktopSession } from '$lib/desktop/session.svelte.js';
	import { spreadView } from '$lib/desktop/spreadView/spreadView.svelte.js';
	import { packShelves, type Box } from '$lib/desktop/spreadView/packShelves.js';
	import SpreadScrollbar from '$lib/desktop/spreadView/SpreadScrollbar.svelte';

	const GAP = 16;
	const PADDING = 24;
	const SCROLLBAR_W = 22;

	let scrollEl: HTMLDivElement | undefined = $state(undefined);
	let containerWidth = $state(1000);

	// Current-workspace note windows, row-major by original position.
	const noteWindows = $derived(
		desktopSession.windows
			.filter((w) => w.kind === 'note')
			.slice()
			.sort((a, b) => a.y - b.y || a.x - b.x)
	);

	const layout = $derived.by(() => {
		const boxes: Box[] = noteWindows.map((w) => ({ guid: w.guid, w: w.width, h: w.height }));
		return packShelves(boxes, containerWidth, GAP);
	});

	function measure() {
		if (!scrollEl) return;
		containerWidth = Math.max(200, scrollEl.clientWidth - PADDING * 2);
	}

	$effect(() => {
		measure();
		if (typeof window === 'undefined') return;
		window.addEventListener('resize', measure);
		return () => window.removeEventListener('resize', measure);
	});

	// Esc closes the overlay first — capture beats NoteWindow's bubble-phase
	// Esc-to-close handler.
	$effect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopImmediatePropagation();
				spreadView.close();
			}
		};
		window.addEventListener('keydown', onKey, { capture: true });
		return () => window.removeEventListener('keydown', onKey, { capture: true });
	});

	function jumpTo(guid: string) {
		spreadView.close();
		desktopSession.focusWindow(guid);
	}

	function titleFor(guid: string): string {
		return desktopSession.getSnapshotSource(guid)?.title ?? '제목 없음';
	}

	// Svelte action: clone the live content element into the card body as an
	// inert read-only snapshot. pointer-events:none on the clone so clicks fall
	// through to the card (→ jumpTo) and wheel targets the scrollable body.
	function snapshot(node: HTMLElement, guid: string) {
		function mount(g: string) {
			node.replaceChildren();
			const src = desktopSession.getSnapshotSource(g);
			if (src?.el) {
				const clone = src.el.cloneNode(true) as HTMLElement;
				clone.style.pointerEvents = 'none';
				clone.style.userSelect = 'none';
				clone.setAttribute('contenteditable', 'false');
				clone
					.querySelectorAll('[contenteditable="true"]')
					.forEach((el) => el.setAttribute('contenteditable', 'false'));
				node.appendChild(clone);
			} else {
				const p = document.createElement('p');
				p.className = 'spread-empty';
				p.textContent = '미리보기 없음';
				node.appendChild(p);
			}
		}
		mount(guid);
		return {
			update(g: string) {
				mount(g);
			},
			destroy() {
				node.replaceChildren();
			}
		};
	}
</script>

<div class="spread-overlay" role="dialog" aria-modal="true" aria-label="펼쳐보기">
	<button
		type="button"
		class="spread-close"
		onclick={() => spreadView.close()}
		title="닫기 (Esc)"
		aria-label="펼쳐보기 닫기"
	>✕</button>

	<div class="spread-scroll" bind:this={scrollEl} style="--pad:{PADDING}px; --sb:{SCROLLBAR_W}px;">
		<div class="spread-content" style="height:{layout.totalHeight}px; width:{containerWidth}px;">
			{#each layout.placed as p (p.guid)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="spread-card"
					style="left:{p.x}px; top:{p.y}px; width:{p.w}px; height:{p.h}px;"
					role="button"
					tabindex="0"
					title={titleFor(p.guid)}
					onclick={() => jumpTo(p.guid)}
					onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && jumpTo(p.guid)}
				>
					<div class="spread-card-title">{titleFor(p.guid)}</div>
					<div class="spread-card-body" use:snapshot={p.guid}></div>
				</div>
			{/each}
		</div>
	</div>

	<SpreadScrollbar target={scrollEl ?? null} />
</div>

<style>
	.spread-overlay {
		position: fixed;
		inset: 0;
		/* Above pinned windows (1_000_000 + raw z in DesktopWorkspace). */
		z-index: 2000000;
		background: rgba(10, 10, 12, 0.92);
	}
	.spread-scroll {
		position: absolute;
		top: 0;
		left: 0;
		bottom: 0;
		right: var(--sb);
		overflow-y: auto;
		overflow-x: hidden;
		padding: var(--pad);
		scrollbar-width: none; /* hide native; the custom scrollbar drives it */
	}
	.spread-scroll::-webkit-scrollbar {
		display: none;
	}
	.spread-content {
		position: relative;
	}
	.spread-card {
		position: absolute;
		display: flex;
		flex-direction: column;
		background: #fff;
		color: #212529;
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid rgba(0, 0, 0, 0.15);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
		cursor: pointer;
	}
	.spread-card:hover {
		outline: 2px solid #4c8dff;
	}
	.spread-card-title {
		flex-shrink: 0;
		padding: 6px 10px;
		font-size: 0.82rem;
		font-weight: 600;
		background: #f1f3f5;
		border-bottom: 1px solid #e0e0e0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.spread-card-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		/* Wheel scrolling stays inside the card — never chains to the gallery
		   (page scroll is the right-side scrollbar's job). */
		overscroll-behavior: contain;
	}
	/* The cloned editor brings its own inner scroll; neutralize it so the card
	   body's scroll viewport drives the full content height. */
	.spread-card-body :global(.tomboy-editor) {
		overflow: visible !important;
		height: auto !important;
	}
	.spread-empty {
		padding: 16px;
		color: #888;
	}
	.spread-close {
		position: absolute;
		top: 12px;
		right: calc(var(--sb, 22px) + 12px);
		z-index: 6;
		width: 36px;
		height: 36px;
		border: none;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.15);
		color: #fff;
		font-size: 1.1rem;
		cursor: pointer;
	}
	.spread-close:hover {
		background: rgba(255, 255, 255, 0.3);
	}
</style>
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- SpreadOverlay`
Expected: PASS (3 tests)

- [ ] **Step 5: 타입 확인**

Run: `cd app && npm run check`
Expected: 0 errors (신규 코드 관련)

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/desktop/spreadView/SpreadOverlay.svelte app/tests/unit/desktop/SpreadOverlay.test.ts
git commit -m "feat(desktop): SpreadOverlay — packed read-only spread view"
```

---

### Task 15: DesktopWorkspace 배선 (F4 + 마운트)

**Goal:** 오버레이를 마운트하고 F4 토글 + SidePanel `onspread`를 연결한다.

**Files:**
- Modify: `app/src/lib/desktop/DesktopWorkspace.svelte`

**Acceptance Criteria:**
- [ ] `{#if spreadView.isOpen}<SpreadOverlay/>{/if}` 마운트
- [ ] `onKey`: 수정자 없는 F4 → `preventDefault` 후, 열려있거나 노트 창이 있을 때만 `spreadView.toggle()`
- [ ] SidePanel에 `onspread`(노트 있을 때 open) + `spreadDisabled`(노트 0개) 전달

**Verify:** `cd app && npm run check` → 0 errors; 수동: `npm run dev` → F4로 열고 닫힘, 레일 버튼 동작

**Steps:**

- [ ] **Step 1: import 추가**

`DesktopWorkspace.svelte` `<script>`의 import 블록(현재 session import 부근, 대략 line 7-12)에 추가:

```ts
	import SpreadOverlay from './spreadView/SpreadOverlay.svelte';
	import { spreadView } from './spreadView/spreadView.svelte.js';
```

- [ ] **Step 2: onspread 핸들러 + 파생값 추가**

`handleSwitchWorkspace`(대략 line 88-90) 바로 뒤에 추가:

```ts
	const hasNoteWindows = $derived(desktopSession.windows.some((w) => w.kind === 'note'));

	function handleSpread() {
		if (hasNoteWindows) spreadView.open();
	}
```

- [ ] **Step 3: onKey에 F4 분기 추가**

`function onKey(e: KeyboardEvent) {` 본문 첫 줄(대략 line 128-129, Ctrl+L 분기 앞)에 삽입:

```ts
		// F4 — toggle 펼쳐보기 (spread view). No modifiers. preventDefault so
		// no browser/OS default fires. Opens only when at least one note window
		// exists; always closable.
		if (
			e.key === 'F4' &&
			!e.ctrlKey &&
			!e.altKey &&
			!e.metaKey &&
			!e.shiftKey
		) {
			e.preventDefault();
			if (spreadView.isOpen || hasNoteWindows) spreadView.toggle();
			return;
		}
```

- [ ] **Step 4: SidePanel에 props 전달**

`<SidePanel`(대략 line 328-336) 호출에서 마지막 prop `onswitchworkspace={handleSwitchWorkspace}` 뒤에 추가:

```svelte
			onspread={handleSpread}
			spreadDisabled={!hasNoteWindows}
```

- [ ] **Step 5: 오버레이 마운트**

`</SidePanel>` 바로 뒤, `.desktop-root` 닫는 `</div>`(대략 line 337) 앞에 삽입:

```svelte
	{#if spreadView.isOpen}
		<SpreadOverlay />
	{/if}
```

- [ ] **Step 6: 타입 확인**

Run: `cd app && npm run check`
Expected: 0 errors. (SidePanel `onspread`/`spreadDisabled` prop은 Task 16에서 추가 — Task 16을 먼저/함께 적용해야 check 통과)

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/desktop/DesktopWorkspace.svelte
git commit -m "feat(desktop): mount SpreadOverlay + F4 toggle wiring"
```

---

### Task 16: SidePanel 펼쳐보기 버튼

**Goal:** 레일에 펼쳐보기 버튼을 추가하고, 노트 창이 0개면 비활성화한다.

**Files:**
- Modify: `app/src/lib/desktop/SidePanel.svelte`

**Acceptance Criteria:**
- [ ] `onspread: () => void` + `spreadDisabled?: boolean` props
- [ ] 레일에 "펼쳐보기" 버튼(다른 `rail-settings` 버튼과 동일 패턴)
- [ ] `spreadDisabled`면 disabled + 흐리게

**Verify:** `cd app && npm run check` → 0 errors; 수동: `npm run dev` → 버튼 클릭 시 펼쳐보기, 노트 없으면 흐림

**Steps:**

- [ ] **Step 1: Props 인터페이스에 추가**

`interface Props {`(line 36-44)의 `onswitchworkspace` 줄을:

```ts
		onswitchworkspace: (index: number) => void;
	}
```

다음으로 교체:

```ts
		onswitchworkspace: (index: number) => void;
		onspread: () => void;
		spreadDisabled?: boolean;
	}
```

- [ ] **Step 2: 구조분해에 추가**

`let { ... }: Props = $props();`(line 46-54)의 `onswitchworkspace` 줄을:

```ts
		onswitchworkspace
	}: Props = $props();
```

다음으로 교체:

```ts
		onswitchworkspace,
		onspread,
		spreadDisabled = false
	}: Props = $props();
```

- [ ] **Step 3: 레일 버튼 추가**

`관리자` 버튼 블록(line 259-265) 바로 뒤, `</div>`(line 266) 앞에 삽입:

```svelte
		<button
			type="button"
			class="rail-settings rail-spread"
			onclick={onspread}
			disabled={spreadDisabled}
			title="펼쳐보기 (F4)"
			aria-label="펼쳐보기"
		>펼쳐보기</button>
```

- [ ] **Step 4: 비활성 스타일 추가**

`<style>` 블록 안, 기존 `.rail-settings` 규칙 부근에 추가(없으면 새로 추가):

```css
	.rail-settings:disabled {
		opacity: 0.4;
		cursor: default;
		pointer-events: none;
	}
```

- [ ] **Step 5: 타입 확인**

Run: `cd app && npm run check`
Expected: 0 errors

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/desktop/SidePanel.svelte
git commit -m "feat(desktop): 펼쳐보기 rail button in SidePanel"
```

---

### Task 17: 설정 → 가이드 카드

**Goal:** CLAUDE.md 불변식대로 설정 → 가이드(환경/호환성)에 펼쳐보기 안내 카드를 추가한다.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte`

**Acceptance Criteria:**
- [ ] `env` 서브탭에 `<details class="guide-card">` 추가(기존 카드 패턴: summary + info-text + guide-list)
- [ ] F4/레일 버튼, 2채널 스크롤, 현재 워크스페이스·노트만, 읽기전용+클릭 이동, 지도 미리보기 한계 기재

**Verify:** `cd app && npm run check` → 0 errors; 수동: `npm run dev` → 설정 → 가이드 → 환경/호환성에 카드 노출

**Steps:**

- [ ] **Step 1: 카드 삽입**

`+page.svelte`의 env 서브탭 인트로(대략 line 2126)와 Firefox 카드(line 2128) 사이를 찾아:

```svelte
				<p class="info-text">이게 안 맞으면 해당 기능이 동작하지 않거나 깨져 보입니다.</p>

				<details class="guide-card" open>
					<summary>Firefox — 세로 칼럼 분할 활성화</summary>
```

다음으로 교체(새 `<details>`를 인트로와 Firefox 카드 사이에 삽입):

```svelte
				<p class="info-text">이게 안 맞으면 해당 기능이 동작하지 않거나 깨져 보입니다.</p>

				<details class="guide-card">
					<summary>데스크탑 — 펼쳐보기로 열린 노트 한눈에 보기</summary>
					<p class="info-text">
						데스크탑 작업공간에서 노트 창이 여러 개 겹쳐 잘 안 보일 때
						<strong>F4</strong>(또는 왼쪽 레일의 <strong>펼쳐보기</strong> 버튼)를 누르면,
						현재 작업공간에 열린 노트들이 실제 크기 그대로 겹치지 않게 정렬되어 한 화면에
						펼쳐집니다. 다시 F4나 Esc로 닫습니다.
					</p>
					<ul class="guide-list">
						<li>오른쪽의 큰 스크롤바로 전체를 위아래로 훑어보고, 마우스 휠은 커서가 놓인 개별 노트의 내용을 스크롤합니다.</li>
						<li>읽기 전용입니다. 노트를 클릭하면 펼쳐보기가 닫히고 그 노트 창으로 이동합니다.</li>
						<li>현재 작업공간에 열린 노트만 대상입니다(설정/관리자 창과 다른 작업공간은 제외).</li>
						<li>지도 같은 일부 임베드는 미리보기에서 빈칸으로 보일 수 있습니다 — 클릭해 열면 정상입니다.</li>
					</ul>
				</details>

				<details class="guide-card" open>
					<summary>Firefox — 세로 칼럼 분할 활성화</summary>
```

- [ ] **Step 2: 타입 확인**

Run: `cd app && npm run check`
Expected: 0 errors

- [ ] **Step 3: 커밋**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(settings): 펼쳐보기 guide card"
```

---

## 최종 통합 검증 (모든 태스크 후)

- [ ] 전체 테스트: `cd app && npm run test` → 신규 테스트(packShelves/spreadView/snapshotSource/SpreadOverlay) 포함 전부 PASS (기존 OCR teardown flake "1 error"는 알려진 무해 현상)
- [ ] 타입: `cd app && npm run check` → 0 errors
- [ ] 수동(`npm run dev` → `/desktop`):
  - 노트 여러 개 열고 겹친 뒤 **F4** → 겹치지 않게 펼쳐짐, 실제 크기 유지
  - 오른쪽 큰 스크롤바 드래그 → 갤러리 전체 스크롤
  - 카드 위 마우스 휠 → 그 노트 내용만 스크롤(페이지 안 움직임)
  - 카드 클릭 → 닫히고 그 창으로 포커스
  - **Esc** / 닫기 버튼 → 닫힘, 창 배치 그대로
  - 노트 0개일 때 레일 버튼 비활성, F4 무동작
  - 설정 → 가이드 → 환경/호환성에 펼쳐보기 카드
