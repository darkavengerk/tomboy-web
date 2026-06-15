# 노트 리비전 히스토리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데스크탑에서 노트 `⋯` 메뉴 → 히스토리 버튼으로 원본 옆에 임시 창을 열고, Dropbox 리비전 드롭다운으로 과거 버전을 (선택 시에만 다운로드) 열람 + 라이브 노트와 diff 한다.

**Architecture:** 버전 열거는 `filesSearchV2`(파일명 검색) 한 번으로 `{guid}.note` 의 모든 rev-폴더 사본을 받아오고(날짜는 `server_modified` 에서 공짜), 실패 시 manifest 내림차순 스캔으로 폴백. 새 데스크탑 창 `kind:'history'` 가 원본 창 옆 동일 크기로 뜨고, 본문은 `readOnly` 모드 TomboyEditor 로 렌더하거나 `lineDiff` 평문 diff 를 보여준다. 본문은 드롭다운 선택 시에만 `fetchNoteAtRevision` 으로 받는다.

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap 3, Dropbox SDK(`filesSearchV2`), vitest + @testing-library/svelte.

---

## File Structure

신규:
- `app/src/lib/desktop/noteHistory.svelte.ts` — 윈도우별 히스토리 데이터 모듈(검색/폴백/본문 캐시 + 순수 헬퍼).
- `app/src/lib/desktop/HistoryWindow.svelte` — 히스토리 창 UI(툴바 + 읽기전용 에디터 / diff).
- `app/tests/unit/lib/sync/searchNoteRevisions.test.ts`
- `app/tests/unit/lib/desktop/noteHistory.test.ts`
- `app/tests/unit/lib/desktop/openHistory.test.ts`
- `app/tests/unit/lib/editor/tomboyEditorReadOnly.test.ts`

수정:
- `app/src/lib/sync/dropboxClient.ts` — `searchNoteRevisions` + 순수 헬퍼.
- `app/src/lib/desktop/session.svelte.ts` — `kind:'history'`, `openHistory`, persist 필터.
- `app/src/lib/desktop/DesktopWorkspace.svelte` — 렌더 분기.
- `app/src/lib/editor/NoteContextMenu.svelte` — `ActionKind 'history'` + 항목.
- `app/src/lib/desktop/NoteWindow.svelte` — `handleAction` 배선.
- `app/src/lib/editor/TomboyEditor.svelte` — `readOnly` prop.
- `app/src/routes/settings/+page.svelte` — 가이드 카드.

재사용(무변경): `fetchNoteAtRevision`(adminClient), `downloadServerManifest`/`downloadRevisionManifest`(dropboxClient), `getNoteEditorContent`(noteManager), `tiptapToPlainText`(copyFormatted), `lineDiff`(diffNote), `openRightOf` 클램프 로직(session).

---

### Task 1: Dropbox 파일명 검색으로 노트 리비전 열거

**Goal:** `dropboxClient.searchNoteRevisions(guid)` 가 `filesSearchV2` 로 한 노트의 전 버전 `{rev,date}` 를 rev 내림차순으로 반환한다. 파싱/수집 로직은 순수 함수로 분리해 테스트한다.

**Files:**
- Modify: `app/src/lib/sync/dropboxClient.ts` (export 추가; 기존 `withRetry`/`getClient`/`getNotesPath` 재사용)
- Test: `app/tests/unit/lib/sync/searchNoteRevisions.test.ts`

**Acceptance Criteria:**
- [ ] `parseNoteRevFromPath('/Notes/3/345/G.note','G')` → `345`; basename 불일치/비숫자 rev → `null`.
- [ ] `collectNoteRevisions(matches,'G')` 가 `{guid}.note` 가 아닌 match 제거, rev 중복 제거, rev 내림차순 정렬.
- [ ] `searchNoteRevisions` 가 `has_more`/`cursor` 페이지를 `filesSearchContinueV2` 로 이어 받는다.
- [ ] 미인증 시 throw `'Not authenticated'`.

**Verify:** `cd app && npm run test -- searchNoteRevisions` → PASS

**Steps:**

- [ ] **Step 1: Write the failing test**

`app/tests/unit/lib/sync/searchNoteRevisions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseNoteRevFromPath, collectNoteRevisions } from '$lib/sync/dropboxClient.js';
import type { files } from 'dropbox';

function fileMatch(path: string, server_modified: string): files.SearchMatchV2 {
	return {
		metadata: {
			'.tag': 'metadata',
			metadata: { '.tag': 'file', name: path.split('/').pop()!, path_display: path, server_modified } as unknown as files.FileMetadataReference
		}
	} as unknown as files.SearchMatchV2;
}

describe('parseNoteRevFromPath', () => {
	const G = '1c97d161-1489-4c32-93d9-d8c383330b9c';
	it('parses rev from a note path', () => {
		expect(parseNoteRevFromPath(`/Notes/3/345/${G}.note`, G)).toBe(345);
		expect(parseNoteRevFromPath(`/0/7/${G}.note`, G)).toBe(7);
	});
	it('rejects wrong basename', () => {
		expect(parseNoteRevFromPath(`/3/345/other.note`, G)).toBeNull();
	});
	it('rejects non-numeric rev', () => {
		expect(parseNoteRevFromPath(`/3/xx/${G}.note`, G)).toBeNull();
	});
});

describe('collectNoteRevisions', () => {
	const G = 'aaa';
	it('filters, dedupes, sorts desc', () => {
		const matches = [
			fileMatch(`/0/5/${G}.note`, '2026-01-05T00:00:00Z'),
			fileMatch(`/0/9/${G}.note`, '2026-01-09T00:00:00Z'),
			fileMatch(`/0/5/${G}.note`, '2026-01-05T00:00:00Z'), // dup rev
			fileMatch(`/0/9/other.note`, '2026-01-09T00:00:00Z') // wrong note
		];
		const refs = collectNoteRevisions(matches, G);
		expect(refs.map((r) => r.rev)).toEqual([9, 5]);
		expect(refs[0].date).toBe('2026-01-09T00:00:00Z');
	});
	it('skips non-file / non-metadata matches', () => {
		const folderMatch = { metadata: { '.tag': 'metadata', metadata: { '.tag': 'folder', name: 'x', path_display: '/0/9' } } } as unknown as files.SearchMatchV2;
		const otherMatch = { metadata: { '.tag': 'other' } } as unknown as files.SearchMatchV2;
		expect(collectNoteRevisions([folderMatch, otherMatch], G)).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm run test -- searchNoteRevisions`
Expected: FAIL — `parseNoteRevFromPath`/`collectNoteRevisions` not exported.

- [ ] **Step 3: Add the implementation to `dropboxClient.ts`**

기존 `import { Dropbox } ... ` 에 타입을 추가하되, 파일 상단 import 에 `files` 가 없으면 추가:
```ts
import { Dropbox, type files } from 'dropbox';
```
(이미 `Dropbox` 만 import 중이면 `, type files` 만 덧붙인다.)

파일 끝의 Tomboy 프로토콜 섹션(예: `downloadNoteAtRevision` 부근) 뒤에 추가:

```ts
// ─── Per-note revision enumeration (filesSearchV2) ───────────────────────────

export interface NoteRevisionRef {
	/** Server rev at which this version of the note was committed. */
	rev: number;
	/** Dropbox server_modified ISO timestamp of this version's .note file. */
	date: string;
}

/**
 * Parse the rev segment from a note file path `/.../{parent}/{rev}/{guid}.note`.
 * Returns null when the basename isn't `{guid}.note` or the rev segment is not
 * a finite integer.
 */
export function parseNoteRevFromPath(path: string, guid: string): number | null {
	const segs = path.split('/').filter(Boolean);
	if (segs.length < 2) return null;
	if (segs[segs.length - 1] !== `${guid}.note`) return null;
	const rev = parseInt(segs[segs.length - 2], 10);
	return Number.isFinite(rev) ? rev : null;
}

/**
 * Reduce raw filesSearchV2 matches to deduped, desc-sorted note revision refs.
 * Pure — exported for unit testing.
 */
export function collectNoteRevisions(
	matches: files.SearchMatchV2[],
	guid: string
): NoteRevisionRef[] {
	const out: NoteRevisionRef[] = [];
	const seen = new Set<number>();
	for (const match of matches) {
		if (match.metadata['.tag'] !== 'metadata') continue;
		const md = match.metadata.metadata;
		if (md['.tag'] !== 'file') continue;
		const path = md.path_display ?? md.path_lower ?? '';
		const rev = parseNoteRevFromPath(path, guid);
		if (rev === null || seen.has(rev)) continue;
		seen.add(rev);
		out.push({ rev, date: md.server_modified });
	}
	out.sort((a, b) => b.rev - a.rev);
	return out;
}

/**
 * Enumerate every stored revision of one note via Dropbox filename search.
 * One paginated call (continue-cursor only for deep history); returns paths +
 * dates, never downloads `.note` bodies. Caller post-injects the current rev if
 * the search index lagged, and falls back to a manifest scan on empty results.
 */
export async function searchNoteRevisions(guid: string): Promise<NoteRevisionRef[]> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');
	const notesPath = getNotesPath();
	const options: files.SearchOptions = { filename_only: true, max_results: 1000 };
	if (notesPath) options.path = notesPath;

	const all: files.SearchMatchV2[] = [];
	let res = await withRetry(() =>
		dbx.filesSearchV2({ query: `${guid}.note`, options })
	);
	all.push(...res.result.matches);
	let hasMore = res.result.has_more;
	let cursor = res.result.cursor;
	while (hasMore && cursor) {
		const c = cursor;
		res = await withRetry(() => dbx.filesSearchContinueV2({ cursor: c }));
		all.push(...res.result.matches);
		hasMore = res.result.has_more;
		cursor = res.result.cursor;
	}
	return collectNoteRevisions(all, guid);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm run test -- searchNoteRevisions`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

```bash
cd app && npm run check
git add app/src/lib/sync/dropboxClient.ts app/tests/unit/lib/sync/searchNoteRevisions.test.ts
git commit -m "feat(history): searchNoteRevisions via filesSearchV2"
```

---

### Task 2: 히스토리 데이터 모듈 `noteHistory.svelte.ts`

**Goal:** `createNoteHistory(guid)` 팩토리가 검색으로 versions 를 채우고(현재 rev 주입, 0건이면 manifest-스캔 폴백 + 더 불러오기), 본문을 lazy 캐시하며, 라벨/평문 순수 헬퍼를 제공한다.

**Files:**
- Create: `app/src/lib/desktop/noteHistory.svelte.ts`
- Test: `app/tests/unit/lib/desktop/noteHistory.test.ts`

**Acceptance Criteria:**
- [ ] `load()` 후 `versions` 가 rev 내림차순; 검색에 없던 현재 rev 가 맨 앞에 주입됨.
- [ ] 검색 0건 → 폴백 manifest 스캔으로 versions 채움, `usedFallback=true`.
- [ ] `fetchBody(rev)` 가 `fetchNoteAtRevision` 을 한 번만 호출하고 캐시(2회차 캐시 hit).
- [ ] `noteToPlainText(note)` 가 `getNoteEditorContent`→`tiptapToPlainText` 평문 반환.
- [ ] `formatVersionLabel({rev,date})` → `"rev N · {로컬날짜}"`, date 비면 `"rev N"`.

**Verify:** `cd app && npm run test -- noteHistory` → PASS

**Steps:**

- [ ] **Step 1: Write the failing test**

`app/tests/unit/lib/desktop/noteHistory.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NoteData } from '$lib/core/note.js';

const search = vi.fn();
const dlManifest = vi.fn();
const dlServerManifest = vi.fn();
const fetchRev = vi.fn();

vi.mock('$lib/sync/dropboxClient.js', () => ({
	searchNoteRevisions: (...a: unknown[]) => search(...a),
	downloadServerManifest: (...a: unknown[]) => dlServerManifest(...a),
	downloadRevisionManifest: (...a: unknown[]) => dlManifest(...a)
}));
vi.mock('$lib/sync/adminClient.js', () => ({
	fetchNoteAtRevision: (...a: unknown[]) => fetchRev(...a)
}));

import { createNoteHistory, formatVersionLabel, noteToPlainText } from '$lib/desktop/noteHistory.svelte.js';

const G = 'g1';
function note(partial: Partial<NoteData> = {}): NoteData {
	return {
		guid: G, title: 'T', xmlContent: '<note-content version="0.1">hi</note-content>',
		createDate: '', changeDate: '', metadataChangeDate: '', tags: [],
		open_on_startup: false, deleted: false, localDirty: false,
		...partial
	} as NoteData;
}

beforeEach(() => {
	search.mockReset(); dlManifest.mockReset(); dlServerManifest.mockReset(); fetchRev.mockReset();
	dlServerManifest.mockResolvedValue({ revision: 9, serverId: 's', notes: [{ guid: G, rev: 9 }] });
});

describe('createNoteHistory.load (search path)', () => {
	it('builds desc versions and injects missing current rev', async () => {
		search.mockResolvedValue([{ rev: 5, date: 'd5' }, { rev: 3, date: 'd3' }]); // 9 missing
		const h = createNoteHistory(G);
		await h.load();
		expect(h.versions.map((v) => v.rev)).toEqual([9, 5, 3]);
		expect(h.usedFallback).toBe(false);
	});
});

describe('createNoteHistory.load (fallback)', () => {
	it('scans manifests when search empty', async () => {
		search.mockResolvedValue([]);
		dlManifest.mockImplementation(async (rev: number) =>
			rev === 9 ? { revision: 9, serverId: 's', notes: [{ guid: G, rev: 9 }] }
			: rev === 8 ? { revision: 8, serverId: 's', notes: [{ guid: G, rev: 6 }] }
			: { revision: rev, serverId: 's', notes: [] }
		);
		const h = createNoteHistory(G);
		await h.load();
		expect(h.usedFallback).toBe(true);
		expect(h.versions.map((v) => v.rev)).toContain(9);
		expect(h.versions.map((v) => v.rev)).toContain(6);
	});
});

describe('fetchBody caches', () => {
	it('hits network once per rev', async () => {
		search.mockResolvedValue([{ rev: 9, date: 'd9' }]);
		fetchRev.mockResolvedValue(note());
		const h = createNoteHistory(G);
		await h.load();
		await h.fetchBody(9);
		await h.fetchBody(9);
		expect(fetchRev).toHaveBeenCalledTimes(1);
	});
});

describe('pure helpers', () => {
	it('noteToPlainText returns text', () => {
		expect(noteToPlainText(note())).toContain('hi');
	});
	it('formatVersionLabel', () => {
		expect(formatVersionLabel({ rev: 9, date: '' })).toBe('rev 9');
		expect(formatVersionLabel({ rev: 9, date: '2026-01-09T00:00:00Z' })).toMatch(/^rev 9 · /);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm run test -- noteHistory`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `app/src/lib/desktop/noteHistory.svelte.ts`**

```ts
import type { NoteData } from '$lib/core/note.js';
import {
	searchNoteRevisions,
	downloadServerManifest,
	downloadRevisionManifest,
	type NoteRevisionRef
} from '$lib/sync/dropboxClient.js';
import { fetchNoteAtRevision } from '$lib/sync/adminClient.js';
import { getNoteEditorContent } from '$lib/core/noteManager.js';
import { tiptapToPlainText } from '$lib/editor/copyFormatted.js';

/** How many manifests to pull per fallback-scan batch. */
const FALLBACK_BATCH = 30;

export function formatVersionLabel(ref: NoteRevisionRef): string {
	if (!ref.date) return `rev ${ref.rev}`;
	const d = new Date(ref.date);
	const label = isNaN(+d) ? ref.date : d.toLocaleString('ko-KR');
	return `rev ${ref.rev} · ${label}`;
}

export function noteToPlainText(note: NoteData): string {
	return tiptapToPlainText(getNoteEditorContent(note));
}

export interface NoteHistory {
	readonly versions: NoteRevisionRef[];
	readonly loading: boolean;
	readonly error: string;
	readonly usedFallback: boolean;
	readonly hasMore: boolean;
	load(): Promise<void>;
	loadMore(): Promise<void>;
	fetchBody(rev: number): Promise<NoteData | null>;
}

export function createNoteHistory(guid: string): NoteHistory {
	let versions = $state<NoteRevisionRef[]>([]);
	let loading = $state(false);
	let error = $state('');
	let usedFallback = $state(false);
	let hasMore = $state(false);

	const bodies = new Map<number, NoteData | null>();
	let currentRev = 0;
	let scanCursor = 0; // next rev to scan downward in fallback mode

	function upsert(refs: NoteRevisionRef[]) {
		const byRev = new Map(versions.map((v) => [v.rev, v]));
		for (const r of refs) if (!byRev.has(r.rev)) byRev.set(r.rev, r);
		versions = [...byRev.values()].sort((a, b) => b.rev - a.rev);
	}

	async function loadFallback() {
		usedFallback = true;
		versions = [];
		scanCursor = currentRev;
		await scanMore(FALLBACK_BATCH);
	}

	async function scanMore(count: number) {
		const seenNoteRev = new Set(versions.map((v) => v.rev));
		const start = scanCursor;
		const end = Math.max(1, start - count + 1);
		const refs: NoteRevisionRef[] = [];
		for (let rev = start; rev >= end; rev--) {
			const m = await downloadRevisionManifest(rev);
			if (!m) continue;
			const entry = m.notes.find((n) => n.guid === guid);
			if (!entry || seenNoteRev.has(entry.rev)) continue;
			seenNoteRev.add(entry.rev);
			refs.push({ rev: entry.rev, date: '' });
		}
		upsert(refs);
		scanCursor = end - 1;
		hasMore = scanCursor >= 1;
	}

	return {
		get versions() { return versions; },
		get loading() { return loading; },
		get error() { return error; },
		get usedFallback() { return usedFallback; },
		get hasMore() { return hasMore; },

		async load() {
			loading = true;
			error = '';
			versions = [];
			usedFallback = false;
			hasMore = false;
			try {
				const root = await downloadServerManifest();
				currentRev = root?.notes.find((n) => n.guid === guid)?.rev ?? root?.revision ?? 0;
				let refs: NoteRevisionRef[] = [];
				try {
					refs = await searchNoteRevisions(guid);
				} catch {
					refs = [];
				}
				if (refs.length === 0) {
					await loadFallback();
				} else {
					upsert(refs);
					// Inject the authoritative current rev if the search index lagged.
					if (currentRev > 0 && !versions.some((v) => v.rev === currentRev)) {
						upsert([{ rev: currentRev, date: '' }]);
					}
				}
			} catch (e) {
				error = String(e);
			} finally {
				loading = false;
			}
		},

		async loadMore() {
			if (!usedFallback || !hasMore) return;
			loading = true;
			try {
				await scanMore(FALLBACK_BATCH);
			} catch (e) {
				error = String(e);
			} finally {
				loading = false;
			}
		},

		async fetchBody(rev: number) {
			if (bodies.has(rev)) return bodies.get(rev) ?? null;
			const note = await fetchNoteAtRevision(guid, rev);
			bodies.set(rev, note);
			return note;
		}
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm run test -- noteHistory`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd app && npm run check
git add app/src/lib/desktop/noteHistory.svelte.ts app/tests/unit/lib/desktop/noteHistory.test.ts
git commit -m "feat(history): noteHistory data module (search + fallback + body cache)"
```

---

### Task 3: TomboyEditor `readOnly` prop

**Goal:** TomboyEditor 에 `readOnly?: boolean`(기본 false) 를 추가해 `editable: !readOnly` 로 생성하고 readOnly 면 autolink 스캔 스케줄링을 건너뛴다. 기존 호출부 동작은 불변.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (Props 인터페이스, `new Editor({...})`, `scheduleAutoLinkScan`)
- Test: `app/tests/unit/lib/editor/tomboyEditorReadOnly.test.ts`

**Acceptance Criteria:**
- [ ] `readOnly` 미지정 시 `.ProseMirror[contenteditable="true"]` (기존 동작).
- [ ] `readOnly` 지정 시 `.ProseMirror[contenteditable="false"]`.
- [ ] readOnly 일 때 `scheduleAutoLinkScan` 본문이 즉시 return.

**Verify:** `cd app && npm run test -- tomboyEditorReadOnly` → PASS

**Steps:**

- [ ] **Step 1: Write the failing test**

`app/tests/unit/lib/editor/tomboyEditorReadOnly.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import TomboyEditor from '$lib/editor/TomboyEditor.svelte';

const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] };

afterEach(() => cleanup());

describe('TomboyEditor readOnly', () => {
	it('is editable by default', async () => {
		const { container } = render(TomboyEditor, { props: { content } });
		await new Promise((r) => setTimeout(r, 0));
		const pm = container.querySelector('.ProseMirror');
		expect(pm?.getAttribute('contenteditable')).toBe('true');
	});

	it('is not editable when readOnly', async () => {
		const { container } = render(TomboyEditor, { props: { content, readOnly: true } });
		await new Promise((r) => setTimeout(r, 0));
		const pm = container.querySelector('.ProseMirror');
		expect(pm?.getAttribute('contenteditable')).toBe('false');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm run test -- tomboyEditorReadOnly`
Expected: FAIL — readOnly prop ignored, contenteditable always "true".

- [ ] **Step 3: Add the prop and wiring**

In `app/src/lib/editor/TomboyEditor.svelte` `interface Props` 에 추가(다른 prop 옆):
```ts
		/** 읽기 전용 렌더(히스토리 창). editable=false + autolink 스캔 skip. 기본 false. */
		readOnly?: boolean;
```
`let { ... }: Props = $props();` 디스트럭처에 `readOnly = false,` 추가.

`editor = new Editor({` 의 `element: editorElement,` 바로 다음 줄에 추가:
```ts
			editable: !readOnly,
```

`function scheduleAutoLinkScan(opts?: { full?: boolean }): void {` 의 본문 첫 줄에 추가:
```ts
		if (readOnly) return;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm run test -- tomboyEditorReadOnly`
Expected: PASS

- [ ] **Step 5: Regression + commit**

```bash
cd app && npm run check && npm run test -- TomboyEditor
git add app/src/lib/editor/TomboyEditor.svelte app/tests/unit/lib/editor/tomboyEditorReadOnly.test.ts
git commit -m "feat(editor): TomboyEditor readOnly prop (default false)"
```

---

### Task 4: 세션 `kind:'history'` + `openHistory` + persist 제외

**Goal:** 데스크탑 세션에 히스토리 창 종류를 추가하고, `openHistory(sourceGuid)` 가 원본 창 옆에 동일 크기로 싱글턴 히스토리 창을 연다. 히스토리 창은 localStorage 영속화에서 제외한다.

**Files:**
- Modify: `app/src/lib/desktop/session.svelte.ts` (`DesktopWindowKind`, `HISTORY_GUID_PREFIX`, `openHistory`, `persistNow` 필터)
- Test: `app/tests/unit/lib/desktop/openHistory.test.ts`

**Acceptance Criteria:**
- [ ] `openHistory(src)` 새 창: `kind==='history'`, guid===`__history__{src}`, `x===source.x+source.width`(클램프), `width/height===source.width/height`, `y===source.y`.
- [ ] 원본 창이 없으면 창을 만들지 않는다.
- [ ] 이미 열린 히스토리 창은 새로 만들지 않고 focus(z 상승).
- [ ] persist 스냅샷의 windows 에 `kind:'history'` 가 없다.

**Verify:** `cd app && npm run test -- openHistory` → PASS

**Steps:**

- [ ] **Step 1: Write the failing test**

`app/tests/unit/lib/desktop/openHistory.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { desktopSession, HISTORY_GUID_PREFIX } from '$lib/desktop/session.svelte.js';

beforeEach(async () => {
	// fresh workspace: close everything open (closeWindow is async — flushes hooks)
	for (const w of [...desktopSession.windows]) await desktopSession.closeWindow(w.guid);
});

describe('openHistory', () => {
	it('opens a history window beside the source with same size', () => {
		desktopSession.openWindowAt('src-guid', { x: 100, y: 80, width: 400, height: 360 });
		desktopSession.openHistory('src-guid');
		const hist = desktopSession.windows.find((w) => w.guid === `${HISTORY_GUID_PREFIX}src-guid`);
		expect(hist).toBeTruthy();
		expect(hist!.kind).toBe('history');
		expect(hist!.width).toBe(400);
		expect(hist!.height).toBe(360);
		expect(hist!.x).toBe(500); // 100 + 400 (within viewport)
		expect(hist!.y).toBe(80);
	});

	it('does nothing when source window is absent', () => {
		desktopSession.openHistory('ghost');
		expect(desktopSession.windows.find((w) => w.guid === `${HISTORY_GUID_PREFIX}ghost`)).toBeUndefined();
	});

	it('focuses an already-open history window instead of duplicating', () => {
		desktopSession.openWindowAt('src2', { x: 0, y: 0, width: 300, height: 300 });
		desktopSession.openHistory('src2');
		desktopSession.openHistory('src2');
		const all = desktopSession.windows.filter((w) => w.guid === `${HISTORY_GUID_PREFIX}src2`);
		expect(all.length).toBe(1);
	});
});
```

> 참고: 세션 close API 는 `async closeWindow(guid)` (확인됨). beforeEach 에서 await 로 정리.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm run test -- openHistory`
Expected: FAIL — `HISTORY_GUID_PREFIX`/`openHistory` 미존재.

- [ ] **Step 3: Edit `session.svelte.ts`**

종류 타입 확장:
```ts
export type DesktopWindowKind = 'note' | 'settings' | 'admin' | 'history';
```

상수 export 추가(`SETTINGS_WINDOW_GUID`/`ADMIN_WINDOW_GUID` 근처):
```ts
/** Prefix for ephemeral revision-history windows. Source note guid follows. */
export const HISTORY_GUID_PREFIX = '__history__';
```

`openAdmin()` 메서드 바로 뒤에 `openHistory` 추가(객체 메서드로):
```ts
	/**
	 * Open an ephemeral revision-history window for `sourceGuid`, placed
	 * directly to the right of the source window at the SAME size. Singleton
	 * per source note; reopening just focuses. No-ops if the source isn't open.
	 */
	openHistory(sourceGuid: string): void {
		const ws = current();
		const source = ws.windows.find((w) => w.guid === sourceGuid);
		if (!source) return;
		const guid = `${HISTORY_GUID_PREFIX}${sourceGuid}`;
		const existing = ws.windows.find((w) => w.guid === guid);
		if (existing) {
			bumpZ(ws, existing);
			focusRequest = { guid, token: ++focusRequestCounter };
			schedulePersist();
			return;
		}
		const width = source.width;
		const height = source.height;
		const viewportW =
			typeof window !== 'undefined' ? window.innerWidth - railWidth() : 1200;
		const maxX = Math.max(0, viewportW - width);
		const x = Math.max(0, Math.min(source.x + source.width, maxX));
		const y = Math.max(0, source.y);
		const win: DesktopWindowState = {
			guid,
			kind: 'history',
			x: Math.round(x),
			y: Math.round(y),
			width,
			height,
			z: ++ws.nextZ
		};
		ws.windows.push(win);
		// Intentionally NOT cacheGeometry'd / recorded in recents: ephemeral.
		focusRequest = { guid, token: ++focusRequestCounter };
		schedulePersist();
	},
```

persist 제외 — `persistNow()` 의 snapshot 생성을 history 창을 거른 사본으로 교체:
```ts
	const sanitizedWorkspaces = workspaces.map((ws) => ({
		...ws,
		windows: ws.windows.filter((w) => w.kind !== 'history')
	}));
	const snapshot: PersistedV3 = $state.snapshot({
		version: VERSION,
		currentWorkspace: currentWorkspaceIndex,
		workspaces: sanitizedWorkspaces
	}) as PersistedV3;
```

> `bumpZ`, `focusRequest`, `focusRequestCounter`, `railWidth`, `current`, `VERSION`, `currentWorkspaceIndex`, `workspaces` 는 모두 이 모듈에 이미 존재. 새 import 불필요.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm run test -- openHistory`
Expected: PASS (필요 시 beforeEach 의 close API 명만 실제 세션 메서드로 조정)

- [ ] **Step 5: Commit**

```bash
cd app && npm run check
git add app/src/lib/desktop/session.svelte.ts app/tests/unit/lib/desktop/openHistory.test.ts
git commit -m "feat(history): session kind 'history' + openHistory + persist exclude"
```

---

### Task 5: `HistoryWindow.svelte` 창 UI

**Goal:** 히스토리 창 컴포넌트 — 타이틀바(드래그/핀/닫기) + 툴바(버전 드롭다운 + diff 토글 + 폴백 "더 불러오기") + 본문(읽기전용 TomboyEditor 또는 라인 diff). 마운트 시 로드 → 기본 선택 `versions[1] ?? versions[0]` → 본문 fetch.

**Files:**
- Create: `app/src/lib/desktop/HistoryWindow.svelte`

**Acceptance Criteria:**
- [ ] `SettingsWindow` 패턴의 타이틀바/리사이즈 골격 사용(드래그/핀/닫기/ResizeHandles).
- [ ] 드롭다운 변경 시 해당 rev 본문을 `fetchBody` 로 받아 읽기전용 TomboyEditor 에 렌더.
- [ ] `↔ diff` 토글 시 `lineDiff(noteToPlainText(라이브노트), noteToPlainText(선택본))` 결과를 added/removed/equal 줄로 렌더.
- [ ] 라이브 노트 평문은 마운트 시 1회 캐시(`noteStore.getNote(sourceGuid)`).
- [ ] 로딩/에러/폴백 안내 + 폴백 모드에서만 "더 불러오기".

**Verify:** `cd app && npm run check` → no new errors (컴포넌트는 수동 검증; 로직 헬퍼는 Task 1·2 에서 테스트됨)

**Steps:**

- [ ] **Step 1: Write `app/src/lib/desktop/HistoryWindow.svelte`**

```svelte
<script lang="ts">
	import { startPointerDrag } from './dragResize.js';
	import ResizeHandles from './ResizeHandles.svelte';
	import {
		DESKTOP_WINDOW_MIN_WIDTH,
		DESKTOP_WINDOW_MIN_HEIGHT,
		HISTORY_GUID_PREFIX,
		desktopSession
	} from './session.svelte.js';
	import { createNoteHistory, formatVersionLabel, noteToPlainText } from './noteHistory.svelte.js';
	import TomboyEditor from '$lib/editor/TomboyEditor.svelte';
	import { getNoteEditorContent } from '$lib/core/noteManager.js';
	import { getNote } from '$lib/storage/noteStore.js';
	import { lineDiff, type DiffOp } from '$lib/sync/diffNote.js';
	import type { NoteData } from '$lib/core/note.js';
	import type { JSONContent } from '@tiptap/core';

	interface Props {
		guid: string; // history window guid: __history__<sourceGuid>
		x: number; y: number; width: number; height: number; z: number;
		pinned?: boolean; active?: boolean;
		onfocus: (guid: string) => void;
		onclose: (guid: string) => void;
		onmove: (guid: string, x: number, y: number) => void;
		onresize: (guid: string, width: number, height: number) => void;
	}
	let { guid, x, y, width, height, z, pinned = false, active = true,
		onfocus, onclose, onmove, onresize }: Props = $props();

	const sourceGuid = guid.slice(HISTORY_GUID_PREFIX.length);
	const history = createNoteHistory(sourceGuid);

	let selectedRev = $state<number | null>(null);
	let selectedNote = $state<NoteData | null>(null);
	let renderContent = $state<JSONContent | undefined>(undefined);
	let bodyLoading = $state(false);
	let showDiff = $state(false);
	let sourceTitle = $state('');
	let liveText = '';
	let diffOps = $state<DiffOp[]>([]);

	$effect(() => {
		// mount-only init
		void init();
	});

	async function init() {
		const live = await getNote(sourceGuid);
		sourceTitle = live?.title ?? '';
		liveText = live ? noteToPlainText(live) : '';
		await history.load();
		const def = history.versions[1] ?? history.versions[0];
		if (def) await selectRev(def.rev);
	}

	async function selectRev(rev: number) {
		selectedRev = rev;
		bodyLoading = true;
		try {
			const note = await history.fetchBody(rev);
			selectedNote = note;
			renderContent = note ? getNoteEditorContent(note) : undefined;
			recomputeDiff();
		} finally {
			bodyLoading = false;
		}
	}

	function recomputeDiff() {
		diffOps = selectedNote ? lineDiff(liveText, noteToPlainText(selectedNote)) : [];
	}

	function onSelectChange(e: Event) {
		const rev = parseInt((e.currentTarget as HTMLSelectElement).value, 10);
		if (Number.isFinite(rev)) void selectRev(rev);
	}

	const guidLocal = guid;
	function handleFocus() { onfocus(guidLocal); }
	function handleClose() { onclose(guidLocal); }
	function startDrag(e: PointerEvent) {
		const t = e.target as HTMLElement | null;
		if (t?.closest('[data-no-drag]')) return;
		onfocus(guidLocal);
		const ox = x, oy = y;
		startPointerDrag(e, { onMove: (dx, dy) => onmove(guidLocal, ox + dx, oy + dy) });
	}
	function handlePinToggle(e: MouseEvent) { e.stopPropagation(); desktopSession.togglePin(guidLocal); }
	function handleAux(e: MouseEvent) { if (e.button === 1) { e.preventDefault(); desktopSession.sendToBack(guidLocal); } }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="history-window"
	class:hidden={!active}
	style="left:{x}px; top:{y}px; width:{width}px; height:{height}px; z-index:{z};"
	onpointerdowncapture={handleFocus}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="title-bar" onpointerdown={startDrag} onauxclick={handleAux}>
		<span class="title-text">히스토리 — {sourceTitle}</span>
		<button type="button" class="pin-btn" class:pinned onclick={handlePinToggle}
			aria-label={pinned ? '항상 위 해제' : '항상 위'} title={pinned ? '항상 위 해제' : '항상 위'} data-no-drag>&#x1F4CC;</button>
		<button type="button" class="close-btn" onclick={handleClose} aria-label="창 닫기" data-no-drag>✕</button>
	</div>

	<div class="toolbar" data-no-drag>
		{#if history.loading && history.versions.length === 0}
			<span class="muted">버전 목록 불러오는 중…</span>
		{:else if history.error}
			<span class="error">오류: {history.error}</span>
		{:else if history.versions.length === 0}
			<span class="muted">이 노트의 Dropbox 히스토리가 없습니다.</span>
		{:else}
			<select class="ver-select" onchange={onSelectChange} value={selectedRev ?? ''}>
				{#each history.versions as v, i}
					<option value={v.rev}>
						{formatVersionLabel(v)}{i === 0 ? ' (현재)' : ''}
					</option>
				{/each}
			</select>
			<button type="button" class="diff-toggle" class:on={showDiff}
				onclick={() => { showDiff = !showDiff; if (showDiff) recomputeDiff(); }}>↔ diff</button>
			{#if history.usedFallback && history.hasMore}
				<button type="button" class="more-btn" onclick={() => history.loadMore()} disabled={history.loading}>
					{history.loading ? '…' : '더 불러오기'}
				</button>
			{/if}
		{/if}
	</div>

	<div class="body">
		{#if bodyLoading}
			<div class="muted pad">버전 불러오는 중…</div>
		{:else if selectedNote === null && selectedRev !== null}
			<div class="error pad">이 버전을 불러올 수 없습니다.</div>
		{:else if showDiff}
			<div class="diff">
				{#each diffOps as op}
					<div class="dl {op.type}">{op.type === 'added' ? '+' : op.type === 'removed' ? '−' : ' '} {op.text}</div>
				{/each}
			</div>
		{:else if renderContent}
			<TomboyEditor content={renderContent} readOnly={true} />
		{/if}
	</div>

	<ResizeHandles
		base={() => ({ x, y, width, height })}
		min={{ width: DESKTOP_WINDOW_MIN_WIDTH, height: DESKTOP_WINDOW_MIN_HEIGHT }}
		onresize={(g) => desktopSession.updateGeometry(guidLocal, g)}
	/>
</div>

<style>
	.history-window {
		position: absolute; display: flex; flex-direction: column;
		background: #fff; color: #111; border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); overflow: hidden;
		min-width: 280px; min-height: 240px;
	}
	.history-window.hidden { display: none; }
	.title-bar {
		display: flex; align-items: center; gap: 8px; padding: 6px 10px;
		background: #2a2a2a; color: #eee; cursor: grab; user-select: none;
		touch-action: none; flex-shrink: 0;
	}
	.title-bar:active { cursor: grabbing; }
	.title-text { flex: 1; font-size: 0.85rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.pin-btn, .close-btn {
		flex-shrink: 0; width: 22px; height: 22px; border: none; background: transparent;
		color: #ccc; font-size: 0.85rem; line-height: 1; cursor: pointer; border-radius: 3px;
	}
	.pin-btn { color: #888; opacity: 0.5; }
	.pin-btn:hover, .pin-btn.pinned { opacity: 1; background: rgba(255,255,255,0.15); color: #fff; }
	.close-btn:hover { background: #c0392b; color: #fff; }
	.toolbar {
		display: flex; align-items: center; gap: 8px; padding: 6px 10px;
		border-bottom: 1px solid #e4e8ec; background: #f7f7f8; flex-shrink: 0;
		font-size: 0.8rem;
	}
	.ver-select { flex: 1; min-width: 0; font-size: 0.8rem; padding: 3px 6px; }
	.diff-toggle, .more-btn {
		flex-shrink: 0; border: 1px solid #d0d7de; background: #fff; border-radius: 4px;
		padding: 3px 8px; font-size: 0.78rem; cursor: pointer;
	}
	.diff-toggle.on { background: #2563eb; color: #fff; border-color: #2563eb; }
	.body { flex: 1; min-height: 0; overflow: auto; }
	.pad { padding: 16px; }
	.muted { color: #6b7280; }
	.error { color: #b91c1c; }
	.diff { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; padding: 8px 0; }
	.dl { white-space: pre-wrap; padding: 0 10px; }
	.dl.added { background: #e6ffed; }
	.dl.removed { background: #ffeef0; }
	.dl.equal { color: #444; }
</style>
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npm run check`
Expected: no new errors. (`getNote(guid): Promise<NoteData | undefined>` 확인됨 — `live?.title` 로 undefined 처리.)

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/desktop/HistoryWindow.svelte
git commit -m "feat(history): HistoryWindow component (dropdown + read-only render + diff)"
```

---

### Task 6: 메뉴 항목 + 액션 배선 + 렌더 분기

**Goal:** `NoteContextMenu` 에 `🕘 히스토리` 항목(`ActionKind 'history'`)을 추가하고, `NoteWindow.handleAction` 에서 `desktopSession.openHistory(guid)` 를 호출하며, `DesktopWorkspace` 가 `kind:'history'` 를 `HistoryWindow` 로 렌더한다.

**Files:**
- Modify: `app/src/lib/editor/NoteContextMenu.svelte` (`ActionKind` 유니온, 메뉴 버튼)
- Modify: `app/src/lib/desktop/NoteWindow.svelte` (`handleAction` 분기)
- Modify: `app/src/lib/desktop/DesktopWorkspace.svelte` (렌더 분기 + import)

**Acceptance Criteria:**
- [ ] `⋯` 메뉴에 "🕘 히스토리" 항목이 보이고 클릭 시 `openHistory` 호출.
- [ ] `kind:'history'` 창이 `HistoryWindow` 로 렌더됨.
- [ ] `npm run check` 통과.

**Verify:** `cd app && npm run check` → no new errors; 수동: 데스크탑에서 메뉴→히스토리→옆에 창.

**Steps:**

- [ ] **Step 1: `NoteContextMenu.svelte` — ActionKind + 항목**

`export type ActionKind =` 유니온에 추가:
```ts
		| 'history'
```
"원본 XML 보기" 버튼(`onaction('viewXml')`) 바로 아래에 추가:
```svelte
			<button class="item" onclick={() => onaction('history')}>
				<span class="icon">🕘</span>히스토리
			</button>
```

- [ ] **Step 2: `NoteWindow.svelte` — handleAction 분기**

`handleAction` 안, `if (kind === 'viewXml') { ... }` 블록 바로 다음에 추가:
```ts
		if (kind === 'history') {
			desktopSession.openHistory(note.guid);
			return;
		}
```
(`desktopSession` 는 NoteWindow 에 이미 import 되어 있음 — 확인됨, 새 import 불필요.)

- [ ] **Step 3: `DesktopWorkspace.svelte` — 렌더 분기 + import**

상단 import 에 추가(`import AdminWindow ...` 옆):
```svelte
	import HistoryWindow from './HistoryWindow.svelte';
```
`{:else if win.kind === 'admin'}` 블록과 마지막 `{:else}`(NoteWindow) 사이에 새 분기 삽입:
```svelte
				{:else if win.kind === 'history'}
					<HistoryWindow
						guid={win.guid}
						x={win.x}
						y={win.y}
						width={win.width}
						height={win.height}
						z={(win.pinned ? DESKTOP_PINNED_Z : 0) + win.z}
						pinned={win.pinned}
						active={active}
						onfocus={handleFocus}
						onclose={handleClose}
						onmove={handleMove}
						onresize={handleResize}
					/>
```

- [ ] **Step 4: Typecheck + manual smoke**

Run: `cd app && npm run check`
Expected: no new errors.
Manual: `npm run dev` → `/desktop` → 노트 열기 → `⋯` → 히스토리 → 옆 창 + 드롭다운 + diff 토글 확인.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/NoteContextMenu.svelte app/src/lib/desktop/NoteWindow.svelte app/src/lib/desktop/DesktopWorkspace.svelte
git commit -m "feat(history): wire menu action + workspace render branch"
```

---

### Task 7: 가이드 카드 + 전체 검증

**Goal:** 설정 → 가이드에 히스토리 기능 카드를 추가(문서화 불변식)하고 전체 타입체크 + 테스트를 통과시킨다.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (`guideSubTab === 'notes'` 섹션에 `<details class="guide-card">` 추가)

**Acceptance Criteria:**
- [ ] 가이드 `notes` 탭에 히스토리 카드(요약/intro/constraints) 추가, 기존 카드 패턴(`<summary>` + `<p class="info-text">` + `<ul class="guide-list">`) 준수.
- [ ] `npm run check` 통과.
- [ ] `npm run test` 전체 통과.

**Verify:** `cd app && npm run check && npm run test` → 0 errors / all pass

**Steps:**

- [ ] **Step 1: 가이드 카드 추가**

`app/src/routes/settings/+page.svelte` 의 `guideSubTab === 'notes'` 블록 안 적당한 위치(다른 노트-포맷 카드들 옆)에 추가:

```svelte
				<details class="guide-card">
					<summary>노트 리비전 히스토리 (데스크탑)</summary>
					<p class="info-text">
						데스크탑 노트 창의 <strong>⋯ → 🕘 히스토리</strong> 를 누르면 노트 옆에
						같은 크기의 임시 창이 열립니다. 상단 드롭다운에서 Dropbox 에 저장된 과거
						버전을 고르면 그때 해당 버전만 내려받아 읽기 전용으로 보여줍니다.
					</p>
					<ul class="guide-list">
						<li>기본 선택은 현재 바로 직전 버전입니다.</li>
						<li><strong>↔ diff</strong> 버튼으로 지금 쓰고 있는 노트와의 줄 단위 차이를 볼 수 있습니다.</li>
						<li>Dropbox 동기화가 연결돼 있어야 합니다(히스토리는 Dropbox 리비전 기반).</li>
						<li>이 창은 임시이며 닫으면 사라집니다. 과거 버전으로 되돌리려면 고급 → admin 의 노트 히스토리에서 복원하세요.</li>
					</ul>
				</details>
```

> 구현 시 `guideSubTab` 분기와 클래스명(`guide-card`/`info-text`/`guide-list`)이 기존 카드와 일치하는지 한 카드를 참고해 맞춘다.

- [ ] **Step 2: 전체 검증**

Run: `cd app && npm run check && npm run test`
Expected: 타입 0 errors, 모든 테스트 PASS.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(history): 설정 가이드 카드 + final verify"
```

---

## Self-Review

**Spec coverage:**
- 검색 열거 + 폴백 → Task 1, 2. ✅
- 옆 동일 크기 임시 창 + 영속화 제외 → Task 4. ✅
- 읽기전용 렌더 → Task 3, 5. ✅
- diff(라이브 기준) → Task 5(`lineDiff` 재사용). ✅
- 드롭다운 lazy 본문 + rev/날짜 라벨 → Task 2, 5. ✅
- 메뉴 진입 → Task 6. ✅
- 가이드 카드 → Task 7. ✅
- 복원 없음(non-goal) — 어떤 태스크도 복원 버튼을 추가하지 않음. ✅

**Type consistency:** `NoteRevisionRef{rev,date}`, `createNoteHistory`/`formatVersionLabel`/`noteToPlainText`, `HISTORY_GUID_PREFIX`, `openHistory`, `readOnly`, `ActionKind 'history'`, `DiffOp` 모두 정의처와 사용처 일치.

**Resolved footholds (확인 완료):**
- 세션 close API = `async closeWindow(guid)` (Task 4 test).
- noteStore 읽기 = `getNote(guid): Promise<NoteData | undefined>` (Task 5).
- `desktopSession` 는 NoteWindow 에 이미 import 됨 (Task 6, 새 import 불필요).
모두 확인됨 — 남은 미확정 식별자 없음.
