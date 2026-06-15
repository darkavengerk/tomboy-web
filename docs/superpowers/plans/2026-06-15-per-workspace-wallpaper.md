# Per-Workspace Wallpaper + "바탕화면으로 지정" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a desktop-only image right-click action "바탕화면으로 지정" and make the desktop wallpaper per-workspace (4 workspaces, legacy global key as shared fallback).

**Architecture:** Reuse the existing wallpaper render in `DesktopWorkspace.svelte` and the existing `ImageActionMenu` right-click menu. Wallpaper Blobs move from one global appSettings key to per-workspace keys `desktop:wallpaper:{0..3}`, with the legacy `desktop:wallpaper` key kept as fallback. A module `wallpaperEpoch` counter signals changes; a `$effect` keyed on `currentWorkspace` + `wallpaperEpoch` reloads the canvas wallpaper.

**Tech Stack:** SvelteKit 2.57, Svelte 5 runes, TypeScript, vitest + fake-indexeddb, `$app/state` `page`.

**Spec:** `docs/superpowers/specs/2026-06-15-per-workspace-wallpaper-design.md`

---

### Task 1: Index-aware wallpaper functions + epoch signal (session.svelte.ts)

**Goal:** Make `loadWallpaper`/`setWallpaper`/`clearWallpaper` take a workspace index, add the `wallpaperEpoch` change signal and a `setWallpaperForCurrent` convenience, all unit-tested.

**Files:**
- Modify: `app/src/lib/desktop/session.svelte.ts` (module state ~line 119; `desktopSession` object ~line 461; wallpaper fns lines 1077–1088)
- Test: `app/tests/unit/desktop/wallpaper.test.ts` (create)

**Acceptance Criteria:**
- [ ] `setWallpaper(blob, i)` writes only `desktop:wallpaper:${i}` and bumps `wallpaperEpoch`.
- [ ] `loadWallpaper(i)` returns the per-workspace blob, else the legacy `desktop:wallpaper`, else null.
- [ ] `clearWallpaper(i)` deletes `desktop:wallpaper:${i}` and bumps `wallpaperEpoch`.
- [ ] `desktopSession.wallpaperEpoch` getter + `desktopSession.setWallpaperForCurrent(blob)` exist; the latter targets `currentWorkspace`.
- [ ] `npm run check` passes; new unit test passes.

**Verify:** `cd app && npm run test -- tests/unit/desktop/wallpaper.test.ts` → all pass; `npm run check` → 0 errors.

**Steps:**

- [ ] **Step 1: Write the failing test** — create `app/tests/unit/desktop/wallpaper.test.ts`

```ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { getSetting, setSetting } from '$lib/storage/appSettings.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import {
	loadWallpaper,
	setWallpaper,
	clearWallpaper,
	desktopSession
} from '$lib/desktop/session.svelte.js';

const WALLPAPER_KEY = 'desktop:wallpaper';
function blob(tag: string): Blob {
	return new Blob([tag], { type: 'image/png' });
}

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('per-workspace wallpaper', () => {
	it('setWallpaper writes only the per-workspace key', async () => {
		await setWallpaper(blob('w2'), 2);
		expect(await getSetting<Blob>(`${WALLPAPER_KEY}:2`)).toBeInstanceOf(Blob);
		expect(await getSetting<Blob>(`${WALLPAPER_KEY}:0`)).toBeUndefined();
		expect(await getSetting<Blob>(WALLPAPER_KEY)).toBeUndefined();
	});

	it('loadWallpaper returns the per-workspace blob when present', async () => {
		await setWallpaper(blob('w1'), 1);
		const b = await loadWallpaper(1);
		expect(b).toBeInstanceOf(Blob);
		expect(await b!.text()).toBe('w1');
	});

	it('loadWallpaper falls back to the legacy global key', async () => {
		await setSetting(WALLPAPER_KEY, blob('legacy'));
		const b = await loadWallpaper(3);
		expect(await b!.text()).toBe('legacy');
	});

	it('per-workspace blob overrides the legacy global', async () => {
		await setSetting(WALLPAPER_KEY, blob('legacy'));
		await setWallpaper(blob('own3'), 3);
		expect(await (await loadWallpaper(3))!.text()).toBe('own3');
	});

	it('loadWallpaper returns null when neither exists', async () => {
		expect(await loadWallpaper(0)).toBeNull();
	});

	it('setWallpaper bumps wallpaperEpoch', async () => {
		const before = desktopSession.wallpaperEpoch;
		await setWallpaper(blob('x'), 0);
		expect(desktopSession.wallpaperEpoch).toBe(before + 1);
	});

	it('clearWallpaper removes the per-workspace key and bumps epoch', async () => {
		await setWallpaper(blob('x'), 2);
		const before = desktopSession.wallpaperEpoch;
		await clearWallpaper(2);
		expect(await getSetting(`${WALLPAPER_KEY}:2`)).toBeUndefined();
		expect(desktopSession.wallpaperEpoch).toBe(before + 1);
	});

	it('setWallpaperForCurrent targets the current workspace', async () => {
		await desktopSession.setWallpaperForCurrent(blob('cur'));
		const i = desktopSession.currentWorkspace;
		expect(await getSetting<Blob>(`${WALLPAPER_KEY}:${i}`)).toBeInstanceOf(Blob);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm run test -- tests/unit/desktop/wallpaper.test.ts`
Expected: FAIL — `loadWallpaper`/`setWallpaper` reject the index arg / `wallpaperEpoch`/`setWallpaperForCurrent` undefined.

- [ ] **Step 3: Add the module epoch state**

In `app/src/lib/desktop/session.svelte.ts`, right after `let currentWorkspaceIndex = $state(0);` (line 119), add:

```ts
// Bumped whenever any workspace's wallpaper is set/cleared. DesktopWorkspace's
// $effect reads `desktopSession.wallpaperEpoch` so re-setting the SAME
// workspace's wallpaper (same currentWorkspace) still triggers a reload.
let wallpaperEpoch = $state(0);
```

- [ ] **Step 4: Add getter + `setWallpaperForCurrent` to the `desktopSession` object**

In the `desktopSession` export object, immediately after the `get currentWorkspace()` getter (lines 461–463), add:

```ts
	get wallpaperEpoch(): number {
		return wallpaperEpoch;
	},

	/** Set the wallpaper for the currently-active workspace. */
	async setWallpaperForCurrent(blob: Blob): Promise<void> {
		await setWallpaper(blob, currentWorkspaceIndex);
	},
```

(`setWallpaper` is a hoisted `export async function` declared later in the file, so this forward reference is safe.)

- [ ] **Step 5: Rewrite the wallpaper functions to be index-aware**

Replace the entire `// --- Wallpaper ---` block (lines 1077–1088):

```ts
export async function loadWallpaper(): Promise<Blob | null> {
	const blob = await getSetting<Blob>(WALLPAPER_KEY);
	return blob ?? null;
}

export async function setWallpaper(file: File): Promise<void> {
	await setSetting(WALLPAPER_KEY, file);
}

export async function clearWallpaper(): Promise<void> {
	await deleteSetting(WALLPAPER_KEY);
}
```

with:

```ts
/**
 * Load workspace `i`'s wallpaper. Falls back to the legacy global
 * `desktop:wallpaper` key (pre-per-workspace) when the workspace has none,
 * so existing users keep their wallpaper on every workspace until they set
 * a per-workspace one.
 */
export async function loadWallpaper(i: number): Promise<Blob | null> {
	const own = await getSetting<Blob>(`${WALLPAPER_KEY}:${i}`);
	if (own) return own;
	const legacy = await getSetting<Blob>(WALLPAPER_KEY);
	return legacy ?? null;
}

export async function setWallpaper(blob: Blob, i: number): Promise<void> {
	await setSetting(`${WALLPAPER_KEY}:${i}`, blob);
	wallpaperEpoch += 1;
}

export async function clearWallpaper(i: number): Promise<void> {
	await deleteSetting(`${WALLPAPER_KEY}:${i}`);
	wallpaperEpoch += 1;
}
```

(`File` ⊂ `Blob`, so callers passing a dropped `File` still type-check.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd app && npm run test -- tests/unit/desktop/wallpaper.test.ts`
Expected: PASS (8 tests). Then `npm run check` → 0 errors. (`check` will report the now-broken `DesktopWorkspace.svelte` `loadWallpaper()`/`setWallpaper(file)` call sites — those are fixed in Task 2. If running `check` here, expect those 2 errors; they clear after Task 2.)

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/desktop/session.svelte.ts app/tests/unit/desktop/wallpaper.test.ts
git commit -m "feat(desktop): per-workspace wallpaper storage + epoch signal"
```

---

### Task 2: Reactive per-workspace wallpaper render (DesktopWorkspace.svelte)

**Goal:** Load the wallpaper for the active workspace reactively (on workspace switch and on `wallpaperEpoch` change) with an async race guard, and make drag-drop target the current workspace.

**Files:**
- Modify: `app/src/lib/desktop/DesktopWorkspace.svelte` (imports line 8–13; `onMount` lines 30–36; add `$effect`; `onCanvasDrop` lines 268–279)

**Acceptance Criteria:**
- [ ] Wallpaper shown matches the active workspace; switching workspaces (Ctrl+Alt+arrow) swaps it.
- [ ] Fast switching never leaves a stale workspace's wallpaper (token guard).
- [ ] Dropping an image on the canvas sets only the current workspace's wallpaper.
- [ ] No ObjectURL leak (previous URL revoked on every swap and on unmount).
- [ ] `npm run check` passes.

**Verify:** `cd app && npm run check` → 0 errors. Manual: `npm run dev` → /desktop → drop an image on workspace 0, Ctrl+Alt+→ to workspace 1, drop a different image → each workspace keeps its own; switching back and forth shows the right one.

**Steps:**

- [ ] **Step 1: Remove the one-shot wallpaper load in `onMount`**

The `onMount` async IIFE (lines 30–36) currently is:

```ts
	onMount(() => {
		(async () => {
			await desktopSession.load();
			ready = true;
			const blob = await loadWallpaper();
			if (blob) wallpaperUrl = URL.createObjectURL(blob);
		})();
```

Change it to drop the wallpaper lines (the `$effect` added below now owns wallpaper loading):

```ts
	onMount(() => {
		(async () => {
			await desktopSession.load();
			ready = true;
		})();
```

Leave the rest of `onMount` (keydown/paste/modKey listeners and the return cleanup that revokes `wallpaperUrl` at lines 52–55) unchanged.

- [ ] **Step 2: Add the reactive wallpaper `$effect`**

Immediately after the `onMount(() => { ... });` block closes (after line 57), add:

```ts
	// Reload the canvas wallpaper for the active workspace. Re-runs on
	// workspace switch (currentWorkspace) and on any wallpaper set/clear
	// (wallpaperEpoch). The token guards against a fast switch resolving an
	// older load after a newer one.
	let wallpaperLoadToken = 0;
	$effect(() => {
		const ws = desktopSession.currentWorkspace;
		void desktopSession.wallpaperEpoch; // reactive dependency
		const token = ++wallpaperLoadToken;
		void (async () => {
			const blob = await loadWallpaper(ws);
			if (token !== wallpaperLoadToken) return; // superseded by a newer load
			const next = blob ? URL.createObjectURL(blob) : null;
			const prev = wallpaperUrl;
			wallpaperUrl = next;
			if (prev) URL.revokeObjectURL(prev);
		})();
	});
```

- [ ] **Step 3: Make drag-drop target the current workspace**

`onCanvasDrop` (lines 268–279) currently is:

```ts
	async function onCanvasDrop(e: DragEvent) {
		const file = e.dataTransfer?.files?.[0];
		if (!file || !file.type.startsWith('image/')) return;
		e.preventDefault();
		try {
			await setWallpaper(file);
		} catch {
			return;
		}
		const prev = wallpaperUrl;
		wallpaperUrl = URL.createObjectURL(file);
		if (prev) URL.revokeObjectURL(prev);
	}
```

Replace its body so the write is per-workspace and the `$effect` (via the epoch bump inside `setWallpaper`) performs the swap — no manual ObjectURL juggling:

```ts
	async function onCanvasDrop(e: DragEvent) {
		const file = e.dataTransfer?.files?.[0];
		if (!file || !file.type.startsWith('image/')) return;
		e.preventDefault();
		try {
			await setWallpaper(file, desktopSession.currentWorkspace);
		} catch {
			return;
		}
	}
```

- [ ] **Step 4: Verify types + manual behavior**

Run: `cd app && npm run check`
Expected: 0 errors (the Task 1 call-site errors are now resolved).

Manual smoke per the Verify line above.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/desktop/DesktopWorkspace.svelte
git commit -m "feat(desktop): reactive per-workspace wallpaper render + per-workspace drop"
```

---

### Task 3: "바탕화면으로 지정" right-click action (ImageActionMenu.svelte)

**Goal:** Add a desktop-only third item to the image right-click menu that sets the clicked image as the current workspace's wallpaper.

**Files:**
- Modify: `app/src/lib/components/ImageActionMenu.svelte` (script imports lines 1–4; handlers; menu markup lines 65–67)

**Acceptance Criteria:**
- [ ] On a `/desktop` route, right-clicking a note image shows "바탕화면으로 지정"; on mobile routes it is absent.
- [ ] Clicking it fetches the image bytes via `resolveImageBlob`, sets the current workspace's wallpaper, toasts `배경화면으로 지정했습니다`, and closes the menu.
- [ ] Fetch failure toasts `배경화면 지정 실패` (error kind) and leaves the wallpaper unchanged.
- [ ] `npm run check` passes; full test suite still green.

**Verify:** `cd app && npm run check` → 0 errors. Manual: `npm run dev` → /desktop → right-click a note image → 바탕화면으로 지정 → wallpaper updates + toast; open the same note on a mobile route (`/note/[id]`) and confirm the item is absent.

**Steps:**

- [ ] **Step 1: Add imports**

In `app/src/lib/components/ImageActionMenu.svelte`, extend the script imports (currently lines 1–4):

```svelte
	import { imageActionMenu } from '$lib/stores/imageActionMenu.svelte.js';
	import { copyImageToClipboard, copyImageUrlToClipboard, resolveImageBlob } from '$lib/editor/imageActions/copyImage.js';
	import { portal } from '$lib/utils/portal.js';
	import { page } from '$app/state';
	import { desktopSession } from '$lib/desktop/session.svelte.js';
	import { pushToast } from '$lib/stores/toast.js';
```

- [ ] **Step 2: Add the desktop gate + handler**

After the existing `doCopyUrl` function (line 45), add:

```svelte
	const isDesktop = $derived(page.url.pathname.startsWith('/desktop'));

	async function doSetWallpaper() {
		const href = menu?.href;
		close();
		if (!href) return;
		try {
			const blob = await resolveImageBlob(href);
			if (!blob) throw new Error('image bytes unavailable');
			await desktopSession.setWallpaperForCurrent(blob);
			pushToast('배경화면으로 지정했습니다');
		} catch {
			pushToast('배경화면 지정 실패', { kind: 'error' });
		}
	}
```

- [ ] **Step 3: Add the menu item (desktop only)**

In the menu markup, after the "이미지 주소 복사" button (line 66), add:

```svelte
			<button class="item" onclick={doCopyUrl}>이미지 주소 복사</button>
			{#if isDesktop}
				<button class="item" onclick={doSetWallpaper}>바탕화면으로 지정</button>
			{/if}
```

- [ ] **Step 4: Verify types + suite**

Run: `cd app && npm run check` → 0 errors.
Run: `cd app && npm run test` → suite green (no regressions).
Manual smoke per the Verify line above.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/components/ImageActionMenu.svelte
git commit -m "feat(desktop): right-click image → 바탕화면으로 지정 (current workspace)"
```

---

### Task 4: Guide card in 설정 → 가이드 (env sub-tab)

**Goal:** Document the feature in the user-facing guide (project mandate: user-facing features must live in 설정 → 가이드).

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (env sub-tab block; insert after the desktop F4 card that ends at line 2575)

**Acceptance Criteria:**
- [ ] A new `<details class="guide-card">` appears under the env guide sub-tab describing: desktop-only, per-workspace independence, right-click image → 바탕화면으로 지정, drag-drop also targets the current workspace, no per-workspace removal UI yet (replace by setting a new one).
- [ ] Matches the existing card pattern (`<summary>` + `<p class="info-text">` + `<ul class="guide-list">`).
- [ ] `npm run check` passes.

**Verify:** `cd app && npm run check` → 0 errors. Manual: `npm run dev` → 설정 → 가이드 → 환경/호환성 탭 → new card renders and reads correctly.

**Steps:**

- [ ] **Step 1: Insert the guide card**

In `app/src/routes/settings/+page.svelte`, immediately after the desktop "펼쳐보기" card's closing `</details>` (line 2575) and before the "Firefox — 세로 칼럼 분할 활성화" card, add:

```svelte
				<details class="guide-card">
					<summary>데스크탑 — 작업공간별 배경화면</summary>
					<p class="info-text">
						데스크탑 작업공간(2×2, <strong>Ctrl+Alt+방향키</strong>로 전환)마다
						<strong>각각 다른 배경화면</strong>을 둘 수 있습니다. 배경은 작업공간별로 따로
						기억되며, 따로 지정하지 않은 작업공간은 기존에 쓰던 공통 배경을 그대로 보여줍니다.
					</p>
					<ul class="guide-list">
						<li>노트 속 이미지를 <strong>우클릭</strong>하면 「바탕화면으로 지정」이 나옵니다 —
							누르면 그 이미지가 <strong>지금 보고 있는 작업공간</strong>의 배경이 됩니다(다른
							작업공간은 그대로).</li>
						<li>이미지 파일을 작업공간 빈 바탕에 <strong>드래그&amp;드롭</strong>해도 같은
							방식으로 현재 작업공간 배경으로 설정됩니다.</li>
						<li>원격 이미지(Dropbox / 임시 저장소)도 됩니다 — 내부 이미지 캐시를 통해 받아오므로
							CORS 문제 없이 적용됩니다.</li>
						<li>배경 <strong>제거</strong> 전용 버튼은 아직 없습니다 — 새 이미지를 지정하면
							교체됩니다. (모바일에는 배경화면 개념이 없습니다.)</li>
					</ul>
				</details>
```

- [ ] **Step 2: Verify**

Run: `cd app && npm run check` → 0 errors. Manual smoke per the Verify line.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(settings): guide card for per-workspace wallpaper"
```

---

## Self-Review

- **Spec coverage:** storage model (Task 1) ✓; session fns + epoch + setWallpaperForCurrent (Task 1) ✓; DesktopWorkspace $effect + race guard + per-ws drop (Task 2) ✓; ImageActionMenu desktop-gated item + handler + error toast (Task 3) ✓; guide card env tab (Task 4) ✓; session unit test (Task 1) ✓. Menu-gate automated render test was downgraded to manual verification per the spec's stated fallback (mocking `$app/state` in a render test is brittle; the session unit test is the load-bearing coverage) — noted, not a gap.
- **Type consistency:** `setWallpaper(blob: Blob, i: number)`, `loadWallpaper(i: number)`, `clearWallpaper(i: number)`, `desktopSession.wallpaperEpoch`, `desktopSession.setWallpaperForCurrent(blob)`, `resolveImageBlob(href)` used consistently across tasks. Call sites updated in Task 2 (DesktopWorkspace) and Task 3 (ImageActionMenu).
- **No placeholders:** every step has concrete code and exact commands.

## Order / Dependencies

- Task 1 → blocks Task 2 and Task 3 (both consume the new signatures/`wallpaperEpoch`/`setWallpaperForCurrent`).
- Task 2 and Task 3 are independent of each other.
- Task 4 (docs) independent; do last.
