# 즐겨찾기 로컬 전용화 + 정렬 우선순위 제거 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 즐겨찾기 상태를 `.note` 태그(`system:pinned`)에서 로컬 IDB(`appSettings/local:favorites`)로 옮기고, 노트 목록 정렬에서 즐겨찾기 우선순위를 제거한다.

**Architecture:** `recentOpens.svelte.ts`와 동일 패턴의 신규 모듈 `favoriteStore.svelte.ts`가 단일 진실 공급원. `noteManager.ts`의 `toggleFavorite`/`isFavorite`/`sortForList`는 시그니처를 (대부분) 유지하면서 내부만 새 스토어로 교체. 기존 `system:pinned` 태그는 dead data로 잔존 (일괄 strip 없음).

**Tech Stack:** SvelteKit + Svelte 5 runes (`$state`), TypeScript, IndexedDB(`idb` via `appSettings`), Vitest + fake-indexeddb.

**Spec:** `docs/superpowers/specs/2026-05-23-local-favorites-design.md`

---

## 파일 구조 (영향 받는 파일)

신규:
- `app/src/lib/storage/favoriteStore.svelte.ts` — 로컬 즐겨찾기 set, `$state` 기반 반응형, debounce persist
- `app/tests/unit/storage/favoriteStore.test.ts` — 신규 스토어 unit tests

수정:
- `app/src/lib/core/noteManager.ts` — `toggleFavorite`/`isFavorite`/`sortForList` 본체 교체
- `app/tests/unit/favorite.test.ts` — 기존 태그 기반 가정 제거, 로컬 스토어 기반으로 재작성
- `app/src/routes/note/[id]/+page.svelte` — `toggleFavorite` `await` 제거, 토스트 분기 단순화
- `app/src/lib/desktop/NoteWindow.svelte` — 동일
- `app/src/lib/desktop/SidePanel.svelte` — `keyed.sort`에서 pinned 가산 제거
- `app/src/routes/+layout.svelte` — `favoriteStore.load()` 호출 추가

호출처 변경 불필요 (시그니처 유지):
- `app/src/lib/components/NoteList.svelte`, `app/src/lib/components/TopNav.svelte`, `app/src/lib/editor/NoteContextMenu.svelte`, `app/src/lib/editor/NoteActionSheet.svelte`

---

## Task 1: favoriteStore 모듈 + unit tests

**Goal:** 로컬 전용 즐겨찾기 `Record<string, true>` 저장소를 `$state` + appSettings persist로 제공한다. `recentOpens.svelte.ts`와 같은 패턴.

**Files:**
- Create: `app/src/lib/storage/favoriteStore.svelte.ts`
- Create: `app/tests/unit/storage/favoriteStore.test.ts`

**Acceptance Criteria:**
- [ ] `favoriteStore.load()` 호출 전에 `has(guid)`는 `false`를 반환 (사전 빈 상태)
- [ ] `favoriteStore.toggle(guid)`가 없는 guid에 대해 `true`를 반환하고, 이후 `has(guid)`가 `true`
- [ ] 두 번째 `toggle(guid)`가 `false`를 반환하고, 이후 `has(guid)`가 `false`
- [ ] `forget(guid)`는 멤버십 제거 + persist 반영, 멤버가 아닌 guid에는 no-op
- [ ] persist는 debounce(300ms)되어 같은 tick의 다중 `toggle`이 단일 `setSetting` 호출로 합쳐짐
- [ ] `load()`를 두 번 호출해도 IDB read는 한 번만 수행(idempotent)
- [ ] 새 인스턴스로 `load()` 시 기존 appSettings 데이터 복원
- [ ] `_reset()` 호출 후 메모리/loaded 플래그가 깨끗해짐 (테스트 전용)

**Verify:** `cd app && npm run test -- favoriteStore` → 모든 케이스 PASS

**Steps:**

- [ ] **Step 1: Write the failing test file**

```ts
// app/tests/unit/storage/favoriteStore.test.ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import { getSetting, setSetting } from '$lib/storage/appSettings.js';
import { favoriteStore } from '$lib/storage/favoriteStore.svelte.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	favoriteStore._reset();
});

describe('favoriteStore', () => {
	it('has() returns false before load()', () => {
		expect(favoriteStore.has('any-guid')).toBe(false);
	});

	it('toggle() adds when absent and returns true', async () => {
		await favoriteStore.load();
		const next = favoriteStore.toggle('g1');
		expect(next).toBe(true);
		expect(favoriteStore.has('g1')).toBe(true);
	});

	it('toggle() removes when present and returns false', async () => {
		await favoriteStore.load();
		favoriteStore.toggle('g1');
		const next = favoriteStore.toggle('g1');
		expect(next).toBe(false);
		expect(favoriteStore.has('g1')).toBe(false);
	});

	it('forget() removes a guid; no-op for unknown', async () => {
		await favoriteStore.load();
		favoriteStore.toggle('g1');
		favoriteStore.forget('g1');
		expect(favoriteStore.has('g1')).toBe(false);
		// no throw for unknown
		expect(() => favoriteStore.forget('never-existed')).not.toThrow();
	});

	it('persist is debounced — multiple toggles within window write once', async () => {
		vi.useFakeTimers();
		try {
			await favoriteStore.load();
			favoriteStore.toggle('a');
			favoriteStore.toggle('b');
			favoriteStore.toggle('c');
			// Before debounce expires, nothing persisted
			expect(await getSetting<Record<string, true>>('local:favorites')).toBeUndefined();
			await vi.advanceTimersByTimeAsync(350);
			const stored = await getSetting<Record<string, true>>('local:favorites');
			expect(stored).toEqual({ a: true, b: true, c: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it('load() is idempotent — second call does not re-read from IDB', async () => {
		await setSetting('local:favorites', { seed: true });
		await favoriteStore.load();
		expect(favoriteStore.has('seed')).toBe(true);
		// Mutate IDB directly; second load() must not pick this up
		await setSetting('local:favorites', { other: true });
		await favoriteStore.load();
		expect(favoriteStore.has('seed')).toBe(true);
		expect(favoriteStore.has('other')).toBe(false);
	});

	it('load() restores existing appSettings data', async () => {
		await setSetting('local:favorites', { x: true, y: true });
		await favoriteStore.load();
		expect(favoriteStore.has('x')).toBe(true);
		expect(favoriteStore.has('y')).toBe(true);
		expect(favoriteStore.has('z')).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm run test -- favoriteStore`
Expected: FAIL with module resolution error (`favoriteStore.svelte.ts` doesn't exist).

- [ ] **Step 3: Create the implementation**

```ts
// app/src/lib/storage/favoriteStore.svelte.ts
/**
 * Local-only favorite-note set.
 *
 * Favorites used to live as a `system:pinned` tag on the .note XML,
 * which made them sync across all devices via Dropbox / Firebase.
 * They are now per-device — stored in appSettings under
 * `local:favorites` as a `Record<guid, true>` and never propagated.
 *
 * Pattern matches `lib/desktop/recentOpens.svelte.ts`: a Svelte 5
 * `$state` module with debounced persistence.
 *
 * No automatic LRU/cap: favorites are explicit user actions, not
 * background telemetry. The set won't grow without the user pressing
 * the toggle.
 */
import { getSetting, setSetting } from './appSettings.js';

const STORAGE_KEY = 'local:favorites';
const PERSIST_DEBOUNCE_MS = 300;

let members = $state<Record<string, true>>({});
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		const snapshot = $state.snapshot(members) as Record<string, true>;
		void setSetting(STORAGE_KEY, snapshot);
	}, PERSIST_DEBOUNCE_MS);
}

export const favoriteStore = {
	/** Reactive membership check. */
	has(guid: string): boolean {
		return members[guid] === true;
	},

	/** Toggle membership; returns the new state. */
	toggle(guid: string): boolean {
		if (members[guid]) {
			delete members[guid];
			schedulePersist();
			return false;
		}
		members[guid] = true;
		schedulePersist();
		return true;
	},

	/** Drop a guid (e.g. when its note is deleted). No-op if absent. */
	forget(guid: string): void {
		if (members[guid]) {
			delete members[guid];
			schedulePersist();
		}
	},

	/** One-shot lazy load. Safe to call multiple times. */
	async load(): Promise<void> {
		if (loaded) return;
		loaded = true;
		const stored = await getSetting<Record<string, true>>(STORAGE_KEY);
		if (stored && typeof stored === 'object') {
			const next: Record<string, true> = {};
			for (const [k, v] of Object.entries(stored)) {
				if (v === true) next[k] = true;
			}
			members = next;
		}
	},

	/** Test-only reset. */
	_reset(): void {
		members = {};
		loaded = false;
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
	}
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm run test -- favoriteStore`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Typecheck**

Run: `cd app && npm run check`
Expected: PASS with no new errors in the new files.

- [ ] **Step 6: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web
git add app/src/lib/storage/favoriteStore.svelte.ts app/tests/unit/storage/favoriteStore.test.ts
git commit -m "feat(favorites): add local-only favoriteStore module

Mirrors lib/desktop/recentOpens.svelte.ts: \$state module backed by
appSettings 'local:favorites' key with 300ms debounced persist.
Provides has/toggle/forget/load. Not wired to noteManager yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: noteManager favorite API 재작성 + 모든 호출처 + 테스트 갱신

**Goal:** `toggleFavorite`/`isFavorite`/`sortForList`를 새 스토어 기반으로 교체하고, 시그니처 변경(`async ⇒ sync`, return `NoteData ⇒ boolean`)에 따른 callers를 한 번에 수정한다. 기존 `favorite.test.ts`는 새 의도로 재작성한다.

**Files:**
- Modify: `app/src/lib/core/noteManager.ts:261-292`
- Modify: `app/tests/unit/favorite.test.ts` (전체 재작성)
- Modify: `app/src/routes/note/[id]/+page.svelte:572-577`
- Modify: `app/src/lib/desktop/NoteWindow.svelte:723-730`
- Modify: `app/src/lib/desktop/SidePanel.svelte:90-95` (pinned 가산 제거)

**Acceptance Criteria:**
- [ ] `toggleFavorite(guid)`가 `boolean`을 반환 (즐겨찾기 추가됨=true / 제거됨=false)
- [ ] `toggleFavorite`가 IDB의 `note.tags`를 건드리지 않음 (태그 무수정)
- [ ] `toggleFavorite`가 `notifyNoteSaved` / `invalidateCache` / `metadataChangeDate` bump을 호출하지 않음
- [ ] `isFavorite(n)`이 `favoriteStore.has(n.guid)`와 동치
- [ ] `sortForList(notes, by)`가 즐겨찾기 여부와 무관하게 순수 `by` desc로만 정렬
- [ ] `favorite.test.ts`의 모든 케이스가 새 동작 기준으로 PASS
- [ ] `note/[id]/+page.svelte`, `NoteWindow.svelte`의 토글 핸들러가 sync 호출로 바뀌고 토스트 메시지가 반환값 기반으로 결정됨
- [ ] `SidePanel.svelte`의 `keyed.sort`에서 pinned 가산 비교 3줄(`pa`/`pb`/`if (pa !== pb)`) 삭제
- [ ] `npm run check`(svelte-check)가 통과
- [ ] `npm run test`(전체)가 통과

**Verify:** 
```
cd app && npm run test && npm run check
```
→ 둘 다 0 errors.

**Steps:**

- [ ] **Step 1: Rewrite favorite.test.ts for new contract**

전체 내용을 다음으로 교체:

```ts
// app/tests/unit/favorite.test.ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { toggleFavorite, isFavorite, sortForList, createNote } from '$lib/core/noteManager.js';
import { getNote } from '$lib/storage/noteStore.js';
import { _resetDBForTest } from '$lib/storage/db.js';
import { favoriteStore } from '$lib/storage/favoriteStore.svelte.js';
import type { NoteData } from '$lib/core/note.js';

beforeEach(async () => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	favoriteStore._reset();
	await favoriteStore.load();
});

describe('favorite (local-only)', () => {
	it('toggleFavorite returns true when adding and false when removing', async () => {
		const n = await createNote('test');
		expect(toggleFavorite(n.guid)).toBe(true);
		expect(toggleFavorite(n.guid)).toBe(false);
	});

	it('isFavorite reflects favoriteStore membership', async () => {
		const n = await createNote('test');
		expect(isFavorite(n)).toBe(false);
		toggleFavorite(n.guid);
		expect(isFavorite(n)).toBe(true);
		toggleFavorite(n.guid);
		expect(isFavorite(n)).toBe(false);
	});

	it('toggleFavorite does NOT modify note.tags or metadataChangeDate', async () => {
		const n = await createNote('test');
		const before = await getNote(n.guid);
		toggleFavorite(n.guid);
		const after = await getNote(n.guid);
		expect(after?.tags).toEqual(before?.tags);
		expect(after?.metadataChangeDate).toBe(before?.metadataChangeDate);
	});

	it('isFavorite ignores legacy system:pinned tag', async () => {
		const n = await createNote('test');
		// Simulate a note that still carries the old dead tag
		const stale: NoteData = { ...n, tags: ['system:pinned'] };
		expect(isFavorite(stale)).toBe(false);
	});

	it('sortForList sorts purely by changeDate desc, ignoring favorites', async () => {
		const a = await createNote('a'); // older
		await new Promise((r) => setTimeout(r, 5));
		const b = await createNote('b'); // newer
		toggleFavorite(a.guid); // favorite the older one

		const sorted = sortForList([a, b], 'changeDate');
		// b is newer → must come first, even though a is favorited
		expect(sorted[0].guid).toBe(b.guid);
		expect(sorted[1].guid).toBe(a.guid);
	});

	it('sortForList handles missing dates gracefully', () => {
		const n1 = { guid: '1', changeDate: '', createDate: '' } as NoteData;
		const n2 = { guid: '2', changeDate: '2026-01-01T00:00:00.0000000+09:00', createDate: '' } as NoteData;
		const sorted = sortForList([n1, n2], 'changeDate');
		expect(sorted[0].guid).toBe('2'); // non-empty date wins
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm run test -- favorite.test`
Expected: FAIL — old `toggleFavorite` returns `NoteData | undefined` not `boolean`; sort still prioritizes favorites; etc.

- [ ] **Step 3: Refactor `noteManager.ts` favorite API**

Replace lines 261–292 (the `toggleFavorite`, `isFavorite`, `sortForList` block) with:

```ts
import { favoriteStore } from '$lib/storage/favoriteStore.svelte.js';

// ...

/** Toggle local-only favorite for this note. Returns the new state. */
export function toggleFavorite(guid: string): boolean {
	return favoriteStore.toggle(guid);
}

/** Check if a note is favorited on THIS device (local-only). */
export function isFavorite(n: NoteData): boolean {
	return favoriteStore.has(n.guid);
}

/** Sort notes by the given date field descending. No favorite priority. */
export function sortForList(notes: NoteData[], by: 'changeDate' | 'createDate'): NoteData[] {
	return [...notes].sort((a, b) => (b[by] ?? '').localeCompare(a[by] ?? ''));
}
```

Confirm the import line is added near the top of the file alongside the other `$lib/storage/...` imports. Remove now-unused imports if any (`formatTomboyDate` may still be used elsewhere — keep unless TS reports unused).

- [ ] **Step 4: Update `routes/note/[id]/+page.svelte` toggle handler**

Replace lines 572–577 (the `if (kind === 'toggleFavorite')` block):

```ts
if (kind === 'toggleFavorite') {
	const nowFav = toggleFavorite(note!.guid);
	pushToast(nowFav ? '즐겨찾기에 추가되었습니다.' : '즐겨찾기에서 제거되었습니다.');
	return;
}
```

`await` 제거, `updated` 사용 제거. `isFavorite(note!)` 재계산 라인은 더 이상 필요 없음 (반응형 store가 `isFavoriteNote` `$derived`를 자동 갱신).

- [ ] **Step 5: Update `lib/desktop/NoteWindow.svelte` toggle handler**

Replace lines 723–730:

```ts
if (kind === 'toggleFavorite') {
	const nowFav = toggleFavorite(note.guid);
	pushToast(nowFav ? '즐겨찾기에 추가되었습니다.' : '즐겨찾기에서 제거되었습니다.');
	return;
}
```

- [ ] **Step 6: Update `lib/desktop/SidePanel.svelte` sort**

Replace lines 90–95 (the `keyed.sort` call):

```ts
keyed.sort((a, b) => b.key - a.key);
```

`isFavorite` import는 `keyed.sort`에서는 더 이상 안 쓰이지만, ⭐ 배지나 미래 사용 가능성에 대비해 그대로 두지 않음 — 현재 사용처가 SidePanel 안에 따로 없으므로 import에서 제거하여 TS unused warning 방지.

확인: `grep -n "isFavorite" app/src/lib/desktop/SidePanel.svelte` → sort 외에 사용처 없으면 import도 제거.

- [ ] **Step 7: Run tests + typecheck**

```bash
cd app
npm run test
npm run check
```

Expected: 모두 PASS. `favorite.test.ts`의 새 케이스 모두 green, `favoriteStore.test.ts`도 여전히 green. svelte-check 0 errors.

- [ ] **Step 8: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web
git add app/src/lib/core/noteManager.ts \
        app/tests/unit/favorite.test.ts \
        app/src/routes/note/\[id\]/+page.svelte \
        app/src/lib/desktop/NoteWindow.svelte \
        app/src/lib/desktop/SidePanel.svelte
git commit -m "refactor(favorites): swap noteManager API to favoriteStore + drop pinned sort priority

toggleFavorite is now sync and returns boolean. Body no longer touches
note.tags / metadataChangeDate / notifyNoteSaved / invalidateCache —
favorites never propagate to Dropbox or Firebase anymore. sortForList
is pure date-desc; SidePanel sort drops pinned bonus. Existing
system:pinned tags on notes are ignored (dead data, not stripped).

favorite.test.ts rewritten for the new contract: tags untouched on
toggle, sort ignores favorites, legacy system:pinned not picked up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `+layout.svelte`에 `favoriteStore.load()` 연결 + 최종 수동 검증

**Goal:** 앱 부팅 시 favoriteStore가 한 번 로드되도록 wire한다. 수동으로 dev 서버에서 즐겨찾기 토글/정렬/시트 동작을 확인한다.

**Files:**
- Modify: `app/src/routes/+layout.svelte` (onMount 블록에 한 줄 추가)

**Acceptance Criteria:**
- [ ] `+layout.svelte`의 onMount에서 `favoriteStore.load()`가 호출됨
- [ ] `npm run check` PASS
- [ ] `npm run test` PASS (전체)
- [ ] Dev 서버 수동 검증: 노트 토글 → ⭐ 배지 즉시 표시 / 새로고침해도 유지 / 정렬은 changeDate 기준 (즐겨찾기가 상단으로 가지 않음)

**Verify:**
```
cd app && npm run test && npm run check
```
→ 모두 PASS. 수동: `npm run dev` 후 (a) 노트 우상단 메뉴에서 즐겨찾기 토글, (b) 전체 목록 페이지에서 ⭐ 배지가 보이는지, (c) 즐겨찾기된 노트가 가장 최근 항목보다 위로 가지 *않는지*, (d) TopNav ⭐ 시트가 그 노트를 포함하는지 확인.

**Steps:**

- [ ] **Step 1: Add the import + load() call**

`app/src/routes/+layout.svelte`의 상단 import 블록(line 13 근처)에 추가:

```ts
import { favoriteStore } from '$lib/storage/favoriteStore.svelte.js';
```

onMount 본문 (line 117 이후, `bindViewportHeight` 라인 근처)에 한 줄 추가:

```ts
void favoriteStore.load();
```

배치 권장 위치: `installOnlineFlushListener();` 직전 (다른 lazy-load 초기화들과 모임).

- [ ] **Step 2: Typecheck + run all tests**

```bash
cd app
npm run check
npm run test
```

Expected: PASS. `favoriteStore.test.ts` (7개), `favorite.test.ts` (6개), 다른 기존 테스트 영향 없음.

- [ ] **Step 3: 수동 검증 — dev 서버**

```bash
cd app && npm run dev
```

브라우저에서 (예: http://localhost:5173):

1. `/notes` 페이지에서 아무 노트나 열어 우상단 액션 메뉴 → "즐겨찾기" 토글. 토스트 "즐겨찾기에 추가되었습니다." 확인.
2. 다시 `/notes` 로 돌아가 해당 노트 옆 ⭐ 배지 확인.
3. **중요**: 그 노트가 changeDate 기준으로 최상단이 아니어야 함 (즐겨찾기가 정렬에 영향 없음을 확인).
4. TopNav ⭐ 버튼 → 시트에 그 노트가 들어있음.
5. 브라우저 새로고침(`F5` 또는 `Ctrl+R`) → ⭐ 배지/시트가 유지됨.
6. 같은 노트를 다시 토글 → 토스트 "즐겨찾기에서 제거되었습니다.", 배지 사라짐.
7. **(선택) 다른 기기/세션 시뮬레이션**: DevTools → Application → IndexedDB → `tomboy-web` → `appSettings` 에 `local:favorites` row가 있고 `value: { <guid>: true }` 인지 직접 확인. `note.tags` 에는 `system:pinned`이 *없음*도 확인 (별도 store는 `notes`).

- [ ] **Step 4: Commit**

```bash
cd /var/home/umayloveme/workspace/tomboy-web
git add app/src/routes/+layout.svelte
git commit -m "feat(favorites): wire favoriteStore.load() into app boot

Loads the per-device favorite set from appSettings 'local:favorites'
during +layout.svelte onMount, before any UI reads isFavorite().

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## 자기-검토 체크

- 스펙의 모든 항목이 task에 매핑됨:
  - 신규 `favoriteStore.svelte.ts` → Task 1
  - `noteManager` API 교체 → Task 2
  - 모든 callers 변경 → Task 2 (한 번에)
  - SidePanel sort에서 pinned 가산 제거 → Task 2
  - `favorite.test.ts` 재작성 → Task 2
  - `+layout.svelte`의 `favoriteStore.load()` → Task 3
  - 삭제 cascade는 의도적으로 미구현 (스펙에 명시) — task 없음 ✅
  - 마이그레이션은 의도적으로 미구현 (스펙에 명시) — task 없음 ✅
- placeholder 없음 (모든 step에 실제 코드/명령 포함).
- 시그니처 일관성: `toggleFavorite(guid: string): boolean`, `isFavorite(n: NoteData): boolean`, `sortForList(notes, by): NoteData[]` — 모든 task에서 동일.
- 의존성: Task 2는 Task 1을 import. Task 3는 Task 1을 import. Task 2 → Task 3 순서는 strict하지 않지만 Task 1을 먼저 끝내야 import가 깨지지 않음.
