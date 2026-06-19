# 데스크탑 SidePanel 레일 개편 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데스크탑 `/desktop` SidePanel을 호버 미리보기 + 작업공간별 고정 활성 노트북 + 무한 스크롤 + 배경 클릭 잠금 열기로 개편한다.

**Architecture:** 신규 `activeNotebooks.svelte.ts` 런 모듈이 작업공간별 활성(고정) 노트북 셋(영구)과 런타임 `lockedOpen` 토글을 보유. `SidePanel.svelte`는 `selectedNotebook`을 호버 래치 + `displayedNotebook` 파생으로 대체하고, 고정 스트립/무한 스크롤/잠금-열림 reveal을 추가. `DesktopWorkspace.svelte`는 빈 캔버스 클릭으로 `lockedOpen`을 토글.

**Tech Stack:** SvelteKit, Svelte 5 runes(`$state`/`$derived`/`$effect`), TypeScript, vitest + fake-indexeddb, appSettings(IDB) 영속.

설계 문서: `docs/superpowers/specs/2026-06-19-desktop-sidepanel-rail-redesign-design.md`

---

## File Structure

- **Create** `app/src/lib/desktop/activeNotebooks.svelte.ts` — 작업공간별 활성 노트북 셋(영구) + `lockedOpen`(런타임). UI 의존 없는 순수 상태/영속 모듈.
- **Create** `app/tests/unit/desktop/activeNotebooks.test.ts` — 모듈 단위 테스트.
- **Modify** `app/src/lib/desktop/session.svelte.ts` — `desktopSession.load()`의 `Promise.all`에 `activeNotebooks.load()` 추가.
- **Modify** `app/src/lib/desktop/SidePanel.svelte` — 호버 래치/표시 노트북/칩 토글/고정 스트립/무한 스크롤/잠금-열림 클래스.
- **Modify** `app/src/lib/desktop/DesktopWorkspace.svelte` — 캔버스 배경 클릭 → `toggleLockedOpen`.

---

### Task 1: `activeNotebooks.svelte.ts` 모듈 + 단위 테스트

**Goal:** 작업공간별 활성 노트북 셋(영구) + 런타임 `lockedOpen`을 제공하는 런 모듈을 TDD로 구현한다.

**Files:**
- Create: `app/src/lib/desktop/activeNotebooks.svelte.ts`
- Test: `app/tests/unit/desktop/activeNotebooks.test.ts`

**Acceptance Criteria:**
- [ ] `toggle`은 새 키를 배열 맨 앞에 추가(최신=topmost), 이미 있으면 제거한다.
- [ ] `list`/`top`/`isActive`가 작업공간별로 독립 동작한다.
- [ ] `clear(ws)`는 해당 작업공간만 비운다.
- [ ] 영속 후 `_reset()` + `load()` 라운드트립으로 셋이 복원된다.
- [ ] `lockedOpen`은 토글되고 영속되지 않는다(라운드트립 후 false).

**Verify:** `cd app && npx vitest run tests/unit/desktop/activeNotebooks.test.ts` → 전부 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/desktop/activeNotebooks.test.ts`

```ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { getSetting } from '$lib/storage/appSettings.js';
import { activeNotebooks } from '$lib/desktop/activeNotebooks.svelte.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	activeNotebooks._reset();
});

describe('activeNotebooks', () => {
	it('toggle adds newest key to the front (topmost)', () => {
		activeNotebooks.toggle(0, 'A');
		activeNotebooks.toggle(0, 'B');
		expect(activeNotebooks.list(0)).toEqual(['B', 'A']);
		expect(activeNotebooks.top(0)).toBe('B');
	});

	it('toggle removes an existing key', () => {
		activeNotebooks.toggle(0, 'A');
		activeNotebooks.toggle(0, 'A');
		expect(activeNotebooks.list(0)).toEqual([]);
		expect(activeNotebooks.top(0)).toBeUndefined();
	});

	it('isActive reflects membership; sets are per-workspace', () => {
		activeNotebooks.toggle(0, 'A');
		expect(activeNotebooks.isActive(0, 'A')).toBe(true);
		expect(activeNotebooks.isActive(1, 'A')).toBe(false);
	});

	it('clear empties one workspace only', () => {
		activeNotebooks.toggle(0, 'A');
		activeNotebooks.toggle(1, 'B');
		activeNotebooks.clear(0);
		expect(activeNotebooks.list(0)).toEqual([]);
		expect(activeNotebooks.list(1)).toEqual(['B']);
	});

	it('persists and reloads round-trip', async () => {
		activeNotebooks.toggle(0, 'A');
		activeNotebooks.toggle(2, 'X');
		await new Promise((r) => setTimeout(r, 400)); // 300ms 디바운스 flush
		const raw = await getSetting<Record<number, string[]>>('desktop:activeNotebooks');
		expect(raw).toBeTruthy();

		activeNotebooks._reset();
		await activeNotebooks.load();
		expect(activeNotebooks.list(0)).toEqual(['A']);
		expect(activeNotebooks.list(2)).toEqual(['X']);
	});

	it('lockedOpen toggles and is not persisted', () => {
		expect(activeNotebooks.lockedOpen).toBe(false);
		activeNotebooks.toggleLockedOpen();
		expect(activeNotebooks.lockedOpen).toBe(true);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/desktop/activeNotebooks.test.ts`
Expected: FAIL — `activeNotebooks.svelte.ts` 모듈 없음(import 에러).

- [ ] **Step 3: 모듈 구현** — `app/src/lib/desktop/activeNotebooks.svelte.ts`

```ts
/**
 * Per-workspace "active" (pinned) notebook sets for the desktop SidePanel,
 * plus the runtime background-click "locked open" toggle.
 *
 * Notebook keys mirror the existing selectedNotebook domain:
 *  - '' = 미분류 (uncategorised)
 *  - non-empty string = notebook name
 *  - 전체 (the "all" filter) is NOT stored here — it is the permanent
 *    fallback and the "clear all" action, never a member of an active set.
 *
 * `sets` is persisted per workspace index (appSettings), mirroring the
 * debounce pattern in sidePanelLayout.svelte.ts. `lockedOpen` is pure
 * runtime state (resets on reload) shared by SidePanel (reveal class) and
 * DesktopWorkspace (canvas background click).
 */
import { getSetting, setSetting } from '$lib/storage/appSettings.js';

const STORAGE_KEY = 'desktop:activeNotebooks';
const PERSIST_DEBOUNCE_MS = 300;

let sets = $state<Record<number, string[]>>({});
let lockedOpen = $state(false);
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		// Snapshot to a plain object so the persisted value carries no proxies.
		void setSetting(STORAGE_KEY, { ...sets });
	}, PERSIST_DEBOUNCE_MS);
}

export const activeNotebooks = {
	get lockedOpen(): boolean {
		return lockedOpen;
	},

	list(ws: number): string[] {
		return sets[ws] ?? [];
	},

	top(ws: number): string | undefined {
		return sets[ws]?.[0];
	},

	isActive(ws: number, key: string): boolean {
		return (sets[ws] ?? []).includes(key);
	},

	toggle(ws: number, key: string): void {
		const cur = sets[ws] ?? [];
		const next = cur.includes(key)
			? cur.filter((k) => k !== key)
			: [key, ...cur]; // newest pin becomes topmost (= default displayed)
		sets = { ...sets, [ws]: next };
		schedulePersist();
	},

	clear(ws: number): void {
		if (!sets[ws]?.length) return;
		sets = { ...sets, [ws]: [] };
		schedulePersist();
	},

	toggleLockedOpen(): void {
		lockedOpen = !lockedOpen;
	},

	setLockedOpen(v: boolean): void {
		lockedOpen = v;
	},

	async load(): Promise<void> {
		if (loaded) return;
		loaded = true;
		const stored = await getSetting<Record<number, string[]>>(STORAGE_KEY);
		if (stored && typeof stored === 'object') {
			const clean: Record<number, string[]> = {};
			for (const [k, v] of Object.entries(stored)) {
				const idx = Number(k);
				if (Number.isInteger(idx) && Array.isArray(v)) {
					clean[idx] = v.filter((x): x is string => typeof x === 'string');
				}
			}
			sets = clean;
		}
	},

	_reset(): void {
		sets = {};
		lockedOpen = false;
		loaded = false;
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
	}
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/desktop/activeNotebooks.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/desktop/activeNotebooks.svelte.ts app/tests/unit/desktop/activeNotebooks.test.ts
git commit -m "feat(desktop): activeNotebooks 모듈 — 작업공간별 고정 노트북 셋 + lockedOpen"
```

---

### Task 2: `activeNotebooks.load()`를 데스크탑 세션 로드에 연결

**Goal:** `/desktop` 진입 시 영구 활성 노트북 셋이 로드되도록 `desktopSession.load()`에 `activeNotebooks.load()`를 추가한다.

**Files:**
- Modify: `app/src/lib/desktop/session.svelte.ts:7`(import), `:582`(Promise.all)

**Acceptance Criteria:**
- [ ] `desktopSession.load()`가 `activeNotebooks.load()`를 다른 로드와 병렬로 await한다.
- [ ] `cd app && npm run check`가 타입 통과한다.

**Verify:** `cd app && npm run check` → 에러 0

**Steps:**

- [ ] **Step 1: import 추가** — `app/src/lib/desktop/session.svelte.ts`, 기존 `sidePanelLayout` import(7번 줄) 아래에:

```ts
import { activeNotebooks } from './activeNotebooks.svelte.js';
```

- [ ] **Step 2: Promise.all에 로드 추가** — 582번 줄 부근:

기존:
```ts
		await Promise.all([loadPersisted(), recentOpens.load(), sidePanelLayout.load()]);
```
변경:
```ts
		await Promise.all([
			loadPersisted(),
			recentOpens.load(),
			sidePanelLayout.load(),
			activeNotebooks.load()
		]);
```

- [ ] **Step 3: 타입 체크**

Run: `cd app && npm run check`
Expected: 에러 0

- [ ] **Step 4: 커밋**

```bash
git add app/src/lib/desktop/session.svelte.ts
git commit -m "feat(desktop): 세션 로드에 activeNotebooks.load() 연결"
```

---

### Task 3: SidePanel — 호버 래치 + 표시 노트북 + 칩 토글 + 고정 스트립

**Goal:** `selectedNotebook`을 호버 래치 기반 `displayedNotebook`으로 대체하고, 칩 클릭=고정 토글(전체=전부 해제), 음악 컨트롤 밑 고정 스트립을 추가한다.

**Files:**
- Modify: `app/src/lib/desktop/SidePanel.svelte`

**Acceptance Criteria:**
- [ ] 노트북 칩 호버 시 `.main` 목록이 그 노트북으로 미리보기되고, 패널을 벗어나면 기본값(슬립박스 ws / 최상단 활성 / 전체)으로 복귀한다.
- [ ] 미분류·노트북 칩 클릭=고정 토글, `전체` 클릭=활성 전부 해제.
- [ ] 고정된 노트북이 음악 컨트롤 밑 `전체` 위 스트립에 표시되며, 원래 칩 위치에도 녹색 활성 표시로 남는다.
- [ ] 현재 표시 중 노트북 칩에 `.viewing` 강조가 적용된다.
- [ ] 새 노트 생성 대상이 현재 표시 노트북(슬립박스/미분류/전체 특례 포함)이다.
- [ ] `cd app && npm run check` 타입 통과.

**Verify:** `cd app && npm run check` → 에러 0; 이후 수동(`npm run dev` → /desktop)으로 호버 미리보기·고정·전체 해제 확인.

**Steps:**

- [ ] **Step 1: import 추가** — `<script>` 상단 import 블록에:

```ts
	import { activeNotebooks } from './activeNotebooks.svelte.js';
```

- [ ] **Step 2: `selectedNotebook` 상태/함수/effect 제거**

다음을 삭제:
```ts
	let selectedNotebook = $state<string | null>(null);
```
```ts
	function selectNotebook(name: string | null) {
		selectedNotebook = name;
	}

	// Workspace switch resets the notebook filter: ws 1 snaps to
	// [0] Slip-Box, every other workspace snaps to "전체" (null). The
	// effect re-runs only when currentWorkspace changes, so manual chip
	// clicks within a workspace are respected until the next switch.
	$effect(() => {
		selectedNotebook =
			currentWorkspace === SLIPNOTE_WORKSPACE_INDEX ? SLIPBOX_NOTEBOOK : null;
	});
```

- [ ] **Step 3: 호버 래치 상태 + 표시 노트북 + 고정 스트립 파생 추가**

기존 `const alwaysOpen = $derived(currentWorkspace === SLIPNOTE_WORKSPACE_INDEX);` **바로 아래**에 추가:

```ts
	// 호버 래치: 마지막으로 호버한 노트북 칩 키(undefined=없음). 칩에서 목록으로
	// 마우스를 옮겨도 패널(aside)을 벗어나기 전까지 유지되어 그 목록의 노트를
	// 클릭할 수 있다. null=전체, ''=미분류, string=노트북. "없음"은 undefined.
	let latched = $state<string | null | undefined>(undefined);

	// .main에 표시할 노트북. 래치가 있으면 그것, 없으면 작업공간 기본값
	// (슬립노트 ws=슬립박스, 그 외=최상단 활성 노트북, 없으면 전체=null).
	const displayedNotebook = $derived(
		latched !== undefined
			? latched
			: alwaysOpen
				? SLIPBOX_NOTEBOOK
				: (activeNotebooks.top(currentWorkspace) ?? null)
	);

	// 고정 스트립에 그릴 활성 노트북(삭제/이름변경된 키는 제외).
	const pinnedNotebooks = $derived(
		activeNotebooks
			.list(currentWorkspace)
			.filter((k) => k === '' || notebooks.includes(k))
	);
```

- [ ] **Step 4: `filteredNotes`가 `displayedNotebook`을 쓰도록 변경**

기존:
```ts
		const filtered = filterByNotebook(allNotes, selectedNotebook);
```
변경:
```ts
		const filtered = filterByNotebook(allNotes, displayedNotebook);
```

- [ ] **Step 5: `handleNew`를 `displayedNotebook` 기반으로 변경**

기존 `handleNew` 전체를 교체:
```ts
	function handleNew() {
		if (displayedNotebook === SLIPBOX_NOTEBOOK) {
			// 슬립노트는 전용 생성 경로 유지(다이얼로그 미사용).
			void createSlipNote().then((note) => {
				void assignNotebook(note.guid, SLIPBOX_NOTEBOOK);
				onopen(note.guid);
			});
			return;
		}
		const target =
			displayedNotebook && displayedNotebook !== '' ? displayedNotebook : null;
		newNoteFlow.open({
			notebook: target,
			navigate: (n) => onopen(n.guid)
		});
	}
```

- [ ] **Step 6: `aside`에 패널-이탈 시 래치 해제 추가**

기존 `<aside ... >` 여는 태그(현 `style="width: ..."` 줄 다음)에 속성 추가:
```svelte
	onpointerleave={() => (latched = undefined)}
```

- [ ] **Step 7: 고정 스트립 마크업 추가** — `<RailMusicControls />` 와 `<div class="rail-chips" ...>` **사이**에 삽입:

```svelte
		{#if pinnedNotebooks.length > 0}
			<div class="rail-pinned" role="group" aria-label="고정한 노트북">
				{#each pinnedNotebooks as key (key)}
					<button
						type="button"
						class="rail-chip active"
						class:viewing={displayedNotebook === key}
						title={key === '' ? '미분류' : key}
						onpointerenter={() => (latched = key)}
						onclick={() => activeNotebooks.toggle(currentWorkspace, key)}
					>{key === '' ? '미분류' : key}</button>
				{/each}
			</div>
		{/if}
```

- [ ] **Step 8: rail-chips(전체/미분류/노트북) 클릭·호버·강조 변경**

기존 `.rail-chips` 블록 전체를 교체:
```svelte
		<div class="rail-chips" role="tablist" aria-label="노트북 필터">
			<button
				type="button"
				role="tab"
				class="rail-chip"
				class:viewing={displayedNotebook === null}
				aria-selected={displayedNotebook === null}
				title="전체"
				onpointerenter={() => (latched = null)}
				onclick={() => activeNotebooks.clear(currentWorkspace)}
			>전체</button>
			<button
				type="button"
				role="tab"
				class="rail-chip"
				class:active={activeNotebooks.isActive(currentWorkspace, '')}
				class:viewing={displayedNotebook === ''}
				aria-selected={displayedNotebook === ''}
				title="미분류"
				onpointerenter={() => (latched = '')}
				onclick={() => activeNotebooks.toggle(currentWorkspace, '')}
			>미분류</button>
			{#each notebooks as nb (nb)}
				<button
					type="button"
					role="tab"
					class="rail-chip"
					class:active={activeNotebooks.isActive(currentWorkspace, nb)}
					class:viewing={displayedNotebook === nb}
					aria-selected={displayedNotebook === nb}
					title={nb}
					onpointerenter={() => (latched = nb)}
					onclick={() => activeNotebooks.toggle(currentWorkspace, nb)}
				>{nb}</button>
			{/each}
		</div>
```

- [ ] **Step 9: CSS 추가** — `<style>` 내 `.rail-chip.active { ... }` 규칙 **아래**에:

```css
	/* 고정 스트립: 음악 컨트롤 밑, 노트북 칩 위. 같은 칩 스타일 재사용. */
	.rail-pinned {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 4px;
		width: 100%;
		padding: 0 6px;
		flex-shrink: 0;
	}

	/* 현재 .main에 표시 중인 노트북 칩 강조(고정=녹색 배경과 구분되는 청록 테두리). */
	.rail-chip.viewing {
		border-color: #5a9;
		box-shadow: inset 0 0 0 1px #5a9;
	}
```

- [ ] **Step 10: 타입 체크**

Run: `cd app && npm run check`
Expected: 에러 0

- [ ] **Step 11: 커밋**

```bash
git add app/src/lib/desktop/SidePanel.svelte
git commit -m "feat(desktop): SidePanel 호버 미리보기 + 고정 활성 노트북 스트립"
```

---

### Task 4: SidePanel — 무한 스크롤

**Goal:** 50개 캡을 제거하고, 목록 바닥 근처 스크롤 시 50개씩 추가 렌더한다. 표시 노트북/검색어 변경 시 리셋.

**Files:**
- Modify: `app/src/lib/desktop/SidePanel.svelte`

**Acceptance Criteria:**
- [ ] 초기 50개 렌더, `.list` 바닥 근처 스크롤 시 50개씩 증가.
- [ ] `displayedNotebook` 또는 `query` 변경 시 50으로 리셋.
- [ ] 빈 상태("노트가 없습니다.")는 전체 결과가 0일 때만 표시.
- [ ] `cd app && npm run check` 타입 통과.

**Verify:** `cd app && npm run check` → 에러 0; 수동으로 50개 초과 노트북에서 스크롤 추가 로드 확인.

**Steps:**

- [ ] **Step 1: `filteredNotes`를 `fullList`(슬라이스 없음)로 변경**

기존 `const filteredNotes = $derived.by(() => { ... });` 의 마지막 줄을 교체:
```ts
		keyed.sort((a, b) => b.key - a.key);
		return keyed.slice(0, 50).map((x) => x.n);
	});
```
변경(이름도 `fullList`로):
```ts
		keyed.sort((a, b) => b.key - a.key);
		return keyed.map((x) => x.n);
	});
```
그리고 선언부 `const filteredNotes = $derived.by(() => {` → `const fullList = $derived.by(() => {`.

- [ ] **Step 2: 페이지네이션 상태 + 표시 슬라이스 + 리셋 effect 추가**

`fullList` 선언 **아래**에:
```ts
	// 무한 스크롤: 초기 50개, 바닥 근처에서 50개씩 증가.
	const PAGE = 50;
	let visibleCount = $state(PAGE);
	const visibleNotes = $derived(fullList.slice(0, visibleCount));

	// 표시 노트북/검색어가 바뀌면 처음부터 다시. (visibleCount는 읽지 않고
	// 쓰기만 하므로 effect 갱신 루프 없음.)
	$effect(() => {
		void displayedNotebook;
		void query;
		visibleCount = PAGE;
	});

	function onListScroll(e: Event) {
		const el = e.currentTarget as HTMLElement;
		if (
			el.scrollTop + el.clientHeight >= el.scrollHeight - 200 &&
			visibleCount < fullList.length
		) {
			visibleCount += PAGE;
		}
	}
```

- [ ] **Step 3: 목록 마크업이 `visibleNotes`/`fullList`를 쓰도록 변경 + 스크롤 핸들러 부착**

기존:
```svelte
		<div class="list">
			{#if loading}
				<div class="empty">로딩 중...</div>
			{:else if filteredNotes.length === 0}
				<div class="empty">노트가 없습니다.</div>
			{:else}
				<ul>
					{#each filteredNotes as n (n.guid)}
```
변경:
```svelte
		<div class="list" onscroll={onListScroll}>
			{#if loading}
				<div class="empty">로딩 중...</div>
			{:else if fullList.length === 0}
				<div class="empty">노트가 없습니다.</div>
			{:else}
				<ul>
					{#each visibleNotes as n (n.guid)}
```

- [ ] **Step 4: 타입 체크**

Run: `cd app && npm run check`
Expected: 에러 0

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/desktop/SidePanel.svelte
git commit -m "feat(desktop): SidePanel 노트 목록 무한 스크롤(50개 캡 제거)"
```

---

### Task 5: 배경 클릭 잠금 열기 (SidePanel reveal + DesktopWorkspace 캔버스)

**Goal:** 빈 캔버스 클릭으로 `.main`을 잠금 열기/닫기 토글한다.

**Files:**
- Modify: `app/src/lib/desktop/SidePanel.svelte` (reveal 클래스 + CSS)
- Modify: `app/src/lib/desktop/DesktopWorkspace.svelte` (캔버스 onclick)

**Acceptance Criteria:**
- [ ] 빈 캔버스(노트 창 아님) 클릭 시 `.main`이 잠겨 열리고, 다시 클릭하면 닫힌다.
- [ ] 노트 창을 클릭해도 토글되지 않는다(`e.target === e.currentTarget` 가드).
- [ ] 잠금 열림 상태에서 표시 목록은 기본값(최상단 활성/전체/슬립박스)이며, 호버 시 래치 미리보기가 그 위를 덮는다.
- [ ] `cd app && npm run check` 타입 통과.

**Verify:** `cd app && npm run check` → 에러 0; 수동으로 빈 배경 클릭 토글 + 창 클릭 무반응 확인.

**Steps:**

- [ ] **Step 1: SidePanel `aside`에 잠금-열림 클래스 추가**

기존:
```svelte
<aside
	class="side-panel"
	class:always-open={alwaysOpen}
```
변경(클래스 한 줄 추가):
```svelte
<aside
	class="side-panel"
	class:always-open={alwaysOpen}
	class:locked-open={activeNotebooks.lockedOpen}
```

- [ ] **Step 2: SidePanel CSS에 잠금-열림 reveal 규칙 추가**

`<style>` 내 기존 reveal 규칙
```css
	.side-panel:hover .main,
	.main:focus-within,
	.side-panel.always-open .main {
		clip-path: inset(0 0 0 0);
		pointer-events: auto;
	}
```
의 셀렉터에 `.side-panel.locked-open .main`을 추가:
```css
	.side-panel:hover .main,
	.main:focus-within,
	.side-panel.always-open .main,
	.side-panel.locked-open .main {
		clip-path: inset(0 0 0 0);
		pointer-events: auto;
	}
```

- [ ] **Step 3: DesktopWorkspace에 import + 캔버스 클릭 핸들러 추가**

`app/src/lib/desktop/DesktopWorkspace.svelte` `<script>`의 `sidePanelLayout` import 아래:
```ts
	import { activeNotebooks } from './activeNotebooks.svelte.js';
```
`onCanvasDrop` 함수 아래(또는 wallpaper drop 핸들러 근처)에 추가:
```ts
	// 빈 캔버스 배경 클릭 → SidePanel .main 잠금 열기/닫기 토글. 노트 창을
	// 클릭하면 e.target이 창 내부라 currentTarget(.canvas)과 달라 무시된다.
	// 벽지 div는 pointer-events:none이라 그 위 클릭도 target=.canvas로 도달.
	function onCanvasClick(e: MouseEvent) {
		if (e.target === e.currentTarget) activeNotebooks.toggleLockedOpen();
	}
```

- [ ] **Step 4: `.canvas` div에 클릭 핸들러 + a11y 무시 주석 갱신**

기존:
```svelte
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="canvas"
			aria-label="노트 작업 공간"
			ondragover={onCanvasDragOver}
			ondrop={onCanvasDrop}
		>
```
변경:
```svelte
		<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
		<div
			class="canvas"
			aria-label="노트 작업 공간"
			ondragover={onCanvasDragOver}
			ondrop={onCanvasDrop}
			onclick={onCanvasClick}
		>
```

- [ ] **Step 5: 타입 체크**

Run: `cd app && npm run check`
Expected: 에러 0

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/desktop/SidePanel.svelte app/src/lib/desktop/DesktopWorkspace.svelte
git commit -m "feat(desktop): 빈 캔버스 클릭으로 SidePanel 잠금 열기 토글"
```

---

## Self-Review (작성자 점검 완료)

- **Spec coverage:** 사양 4요건 모두 매핑 — ①호버 미리보기(Task3 래치), ②클릭=고정/스트립(Task3), ③무한 스크롤(Task4), ④배경 클릭 잠금(Task5). 결정사항(래치/작업공간별 영구/스트립 위치/전체=해제/새노트 대상) 모두 Task1·3에 반영. 영속 로드(Task2).
- **Placeholder scan:** TBD/TODO/"적절히 처리" 없음. 모든 코드 스텝에 실제 코드 포함.
- **Type consistency:** `activeNotebooks` API(`list`/`top`/`isActive`/`toggle`/`clear`/`lockedOpen`/`toggleLockedOpen`/`load`/`_reset`)가 Task1 정의와 Task2·3·5 사용에서 일치. `displayedNotebook`/`fullList`/`visibleNotes`/`visibleCount`/`latched`/`pinnedNotebooks` 이름 Task3·4에서 일관. `onListScroll`/`onCanvasClick` 정의=사용 일치.

## 수동 검증 체크리스트 (전 태스크 후)

1. `/desktop`에서 레일 노트북 칩 호버 → 그 노트북 목록 미리보기, 다른 칩으로 옮기면 전환.
2. 칩 호버 후 목록으로 마우스 이동 → 목록 유지(래치), 노트 클릭 가능.
3. 노트북 클릭 → 음악 밑 스트립에 추가 + 원래 칩 녹색, 다시 클릭 → 제거.
4. `전체` 클릭 → 스트립 비워짐.
5. 50개 초과 노트북에서 목록 바닥 스크롤 → 추가 로드.
6. 빈 캔버스 클릭 → `.main` 잠금 열림, 다시 클릭 → 닫힘. 노트 창 클릭은 무반응.
7. 새로고침 후 작업공간별 고정 셋 유지. 슬립노트 ws는 슬립박스 기본 + always-open 유지.
