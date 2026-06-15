# 제목 변경 시 전체 문서 링크 스윕 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 새 노트 생성에만 있던 결과 패널 + 전체 문서 링크 스윕을 제목 수정(다이얼로그 리네임 자동 + 어느 노트든 수동 액션)에도 확장한다.

**Architecture:** Approach 1 — 기존 `newNoteFlow` 결과-패널 스토어와 스윕 상태기계를 일반화(`openResult` 시드 + 동적 `heading`)하여 생성·다이얼로그 리네임·수동 액션 세 진입점이 같은 패널/스윕을 공유. 백링크 rename 캐스케이드는 이미 `renameNote` 안에서 자동 실행되므로, 리네임 패널은 그 결과(갱신 개수)를 완료 단계로 보여주고 새 제목 가산 스윕을 제안한다.

**Tech Stack:** SvelteKit + Svelte 5 runes, TipTap/ProseMirror(간접), IndexedDB(`idb`), vitest + @testing-library/svelte, `npm run check`(svelte-check).

**Spec:** `docs/superpowers/specs/2026-06-15-title-edit-link-sweep-design.md`

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `app/src/lib/stores/newNoteFlow.svelte.ts` | 결과 패널 + 스윕 상태기계(공용) | `target*` 개명 + `heading` + `openResult`; `submit` 리팩터 |
| `app/src/lib/components/NewNoteResultPanel.svelte` | 결과 패널 UI(공용) | 헤딩을 스토어에서 |
| `app/src/lib/core/noteManager.ts` | 노트 모델/리네임/캐스케이드 | `renameNote` 반환 `{ ok, backlinksUpdated }` |
| `app/src/routes/note/[id]/+page.svelte` | 모바일 단일 노트 편집 | `handleTitleSave` 구조분해+패널; `handleAction` `reflectTitle` |
| `app/src/lib/desktop/NoteWindow.svelte` | 데스크탑 노트 창 | `handleTitleSave` 구조분해+패널; `handleAction` `reflectTitle` |
| `app/src/lib/editor/NoteActionSheet.svelte` | 모바일 액션 시트 | `ActionKind`+`reflectTitle` 버튼 |
| `app/src/lib/editor/NoteContextMenu.svelte` | 데스크탑 컨텍스트 메뉴 | `ActionKind`+`reflectTitle` 항목 |
| `app/src/routes/settings/+page.svelte` | 설정 가이드 | 결과-패널 가이드 카드 확장 |

> 참고: 셸 cwd 가 `app/` 일 수 있다. 모든 명령은 `app/` 기준이며, git 은 워크트리 루트에서 실행한다(`git -C /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu ...`).

---

### Task 1: 플로우 스토어 일반화 + 패널 동적 헤딩

**Goal:** `newNoteFlow` 가 생성 전용에서 벗어나, 임의의 `(heading, title, guid, stages)` 로 결과 패널을 띄울 수 있는 공용 스토어가 된다.

**Files:**
- Modify: `app/src/lib/stores/newNoteFlow.svelte.ts`
- Modify: `app/src/lib/components/NewNoteResultPanel.svelte`
- Test: `app/tests/unit/stores/newNoteFlow.test.ts`

**Acceptance Criteria:**
- [ ] 내부 식별자 `createdTitle`/`createdGuid` 가 `targetTitle`/`targetGuid` 로 전부 개명됨(잔존 0).
- [ ] `heading` 상태 + `get heading()` 추가, `reset()` 이 `''` 로 초기화.
- [ ] `openResult({ heading, title, guid, stages? })` 가 `phase='result'`, `target*`, `heading`, 빈 sweep 을 시드하고, `stages` 는 **전달됐을 때만** 덮어쓴다.
- [ ] `submit()` 성공 경로가 `openResult({ heading:'새 노트 생성 완료', ... })` 를 경유하되 생성 단계(stages)는 보존.
- [ ] 패널 제목이 `{newNoteFlow.heading}` 로 렌더.
- [ ] 기존 newNoteFlow 테스트 전부 통과 + 신규 `openResult` 테스트 통과.

**Verify:** `cd app && npx vitest run tests/unit/stores/newNoteFlow.test.ts && npm run check` → 모두 통과, svelte-check 는 기존 `firebase/app.ts:80` 에러만(사전 존재).

**Steps:**

- [ ] **Step 1: 실패 테스트 추가** — `app/tests/unit/stores/newNoteFlow.test.ts` 의 `describe('result phase', ...)` 블록 안(닫는 `})` 직전)에 추가:

```ts
	it('openResult() seeds result phase with heading/target/stages', async () => {
		newNoteFlow.openResult({
			heading: '제목 변경 완료',
			title: '바뀐 제목',
			guid: 'guid-xyz',
			stages: [{ name: '백링크 2개 갱신', ms: 7, status: 'done' }]
		});
		expect(newNoteFlow.phase).toBe('result');
		expect(newNoteFlow.heading).toBe('제목 변경 완료');
		expect(newNoteFlow.stages).toHaveLength(1);
		expect(newNoteFlow.stages[0].name).toBe('백링크 2개 갱신');
		expect(newNoteFlow.sweep.status).toBe('idle');
		// sweep operates on the seeded target — count uses the mocked linkSweep
		await newNoteFlow.startSweepCount();
		expect(newNoteFlow.sweep.status).toBe('confirm');
		newNoteFlow.dismiss();
		expect(newNoteFlow.heading).toBe('');
	});

	it('openResult() without stages leaves existing stages untouched', async () => {
		newNoteFlow.dismiss();
		newNoteFlow.openResult({ heading: '전체 문서에 제목 반영', title: 't', guid: 'g' });
		expect(newNoteFlow.stages).toEqual([]);
		expect(newNoteFlow.heading).toBe('전체 문서에 제목 반영');
		newNoteFlow.dismiss();
	});
```

- [ ] **Step 2: 실패 확인** — `cd app && npx vitest run tests/unit/stores/newNoteFlow.test.ts`
  Expected: FAIL — `newNoteFlow.openResult is not a function`, `newNoteFlow.heading` undefined.

- [ ] **Step 3: 스토어 일반화** — `app/src/lib/stores/newNoteFlow.svelte.ts`.

  (a) 상태 선언부 — `createdGuid`/`createdTitle` 를 `targetGuid`/`targetTitle` 로 바꾸고 `heading` 추가:

```ts
let phase = $state<'idle' | 'input' | 'creating' | 'result'>('idle');
let stages = $state<Stage[]>([]);
let defaultNotebook = $state<string | null>(null);
let sweep = $state<SweepState>(emptySweep());
let heading = $state('');

let navigateFn: NavigateFn | null = null;
let pendingGuid: string | null = null;
let readyResolve: (() => void) | null = null;
let targetGuid: string | null = null;
let targetTitle: string | null = null;
let matchedGuids: string[] = [];
let cancelFlag: { cancelled: boolean } = { cancelled: false };
```

  (b) `reset()` 에 heading 초기화 추가, `createdGuid/createdTitle` → `targetGuid/targetTitle`:

```ts
function reset() {
	phase = 'idle';
	stages = [];
	heading = '';
	navigateFn = null;
	pendingGuid = null;
	readyResolve = null;
	targetGuid = null;
	targetTitle = null;
	matchedGuids = [];
	sweep = emptySweep();
}
```

  (c) 공개 객체에 `get heading()` + `openResult` 추가(`get sweep()` 아래에):

```ts
	get heading() { return heading; },

	/** 결과 패널을 임의의 (제목, guid)로 직접 띄운다(리네임/수동 액션 진입점).
	 *  stages 는 호출자가 만든 '이미 완료된' 단계 배열. 생략하면 기존 stages 유지. */
	openResult(opts: { heading: string; title: string; guid: string; stages?: Stage[] }) {
		heading = opts.heading;
		targetTitle = opts.title;
		targetGuid = opts.guid;
		matchedGuids = [];
		sweep = emptySweep();
		if (opts.stages) stages = opts.stages;
		phase = 'result';
	},
```

  (d) `submit()` 성공 분기를 `openResult` 경유로(생성 stages 는 보존 — `openResult` 에 stages 미전달):

```ts
		if (succeeded && noteGuid) {
			// Success path: hand off to the shared result-panel seeder. Null the
			// create-only handshake fields first (openResult doesn't touch them).
			navigateFn = null;
			pendingGuid = null;
			readyResolve = null;
			openResult({ heading: '새 노트 생성 완료', title: finalTitle, guid: noteGuid });
		} else {
```

  (e) `startSweepCount()` / `applySweep()` 안의 `createdTitle`/`createdGuid` 를 `targetTitle`/`targetGuid` 로 일괄 치환(가드 `if (!createdTitle || !createdGuid) return;` 포함 4곳).

- [ ] **Step 4: 패널 헤딩 동적화** — `app/src/lib/components/NewNoteResultPanel.svelte` 26행:

```svelte
	<div class="dlg-title" id="new-note-result-heading">{newNoteFlow.heading}</div>
```

  스크립트 상단 주석 한 줄 추가(컴포넌트가 더 이상 새-노트 전용이 아님을 명시):

```svelte
	// 결과 패널(공용): 생성·제목 변경·수동 "전체 문서 반영" 모두 newNoteFlow 가 구동.
	const s = $derived(newNoteFlow.sweep);
```

- [ ] **Step 5: 통과 확인** — `cd app && npx vitest run tests/unit/stores/newNoteFlow.test.ts && npm run check`
  Expected: 테스트 PASS, svelte-check 는 기존 `firebase/app.ts:80` 외 신규 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git -C /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu add app/src/lib/stores/newNoteFlow.svelte.ts app/src/lib/components/NewNoteResultPanel.svelte app/tests/unit/stores/newNoteFlow.test.ts
git -C /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu commit -m "feat(newNoteFlow): 결과 패널 일반화 — openResult + 동적 heading"
```

---

### Task 2: 리네임 경로 — `renameNote` 반환형 + 자동 패널(모바일+데스크탑) + 합성 테스트

**Goal:** 제목 변경 다이얼로그로 리네임하면 결과 패널이 자동으로 떠 백링크 갱신 개수를 보여주고 새 제목 가산 스윕을 제안한다.

**Files:**
- Modify: `app/src/lib/core/noteManager.ts:220-248`
- Modify: `app/src/routes/note/[id]/+page.svelte:773-789`
- Modify: `app/src/lib/desktop/NoteWindow.svelte:764-783`
- Test: `app/tests/unit/core/renameNote.test.ts`
- Test: `app/tests/unit/core/renameThenSweep.test.ts` (신규)

**Acceptance Criteria:**
- [ ] `renameNote` 반환형이 `Promise<{ ok: boolean; backlinksUpdated: number }>`; `backlinksUpdated` = 캐스케이드 `affected.length`(실패/충돌/빈 제목/no-op 시 0).
- [ ] `renameNote.test.ts` 가 새 반환형으로 갱신되고 캐스케이드 테스트가 `backlinksUpdated === 1` 을 확인.
- [ ] 두 `handleTitleSave` 가 `{ ok, backlinksUpdated }` 를 구조분해하고, 성공 시 기존 후처리 뒤 `newNoteFlow.openResult({ heading:'제목 변경 완료', title:r.title, guid:note.guid, stages:[{ name:`제목 변경 · 백링크 ${backlinksUpdated}개 갱신`, ms, status:'done' }] })` 호출(리네임 소요 ms 측정).
- [ ] 합성 테스트: 평문 멘션을 스윕으로 링크 → 타깃 리네임(캐스케이드가 링크 텍스트 재작성) → 새 제목으로 재-스윕 시 그 노트가 `matched` 에 없음(중복 링크 없음).
- [ ] `npm run check` 클린(두 호출 사이트가 새 반환형에 맞게 컴파일).

**Verify:** `cd app && npx vitest run tests/unit/core/renameNote.test.ts tests/unit/core/renameThenSweep.test.ts && npm run check`

**Steps:**

- [ ] **Step 1: 합성 실패 테스트 작성** — 신규 `app/tests/unit/core/renameThenSweep.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { createNote, renameNote } from '$lib/core/noteManager.js';
import { countLinkSweep, applyLinkSweep } from '$lib/core/linkSweep.js';
import * as noteStore from '$lib/storage/noteStore.js';

describe('rename → cascade → re-sweep 합성', () => {
	it('캐스케이드 후 같은 노트에 스윕을 돌려도 링크가 중복되지 않는다', async () => {
		const target = await createNote({ title: '원래 제목' });
		const source = await createNote({ title: '출처' });
		// 출처 노트가 타깃을 평문으로 멘션(아직 링크 아님)
		await noteStore.putNote({
			...source,
			xmlContent: '<note-content version="0.1">출처\n원래 제목 언급\n</note-content>'
		});

		// 1차 스윕: 평문 멘션이 링크가 된다
		const first = await countLinkSweep('원래 제목', target.guid);
		expect(first.matched).toContain(source.guid);
		await applyLinkSweep('원래 제목', target.guid, first.matched);

		// 타깃 리네임 → 캐스케이드가 출처의 링크 텍스트를 새 제목으로 재작성
		const { ok, backlinksUpdated } = await renameNote(target.guid, '바뀐 제목');
		expect(ok).toBe(true);
		expect(backlinksUpdated).toBe(1);

		// 새 제목으로 재-스윕: 멘션이 이미 링크라 변경 없음
		const second = await countLinkSweep('바뀐 제목', target.guid);
		expect(second.matched).not.toContain(source.guid);
	});
});
```

- [ ] **Step 2: 실패 확인** — `cd app && npx vitest run tests/unit/core/renameThenSweep.test.ts`
  Expected: FAIL — `renameNote(...)` 가 boolean 이라 `{ ok, backlinksUpdated }` 구조분해 시 `ok`/`backlinksUpdated` 가 `undefined`.

- [ ] **Step 3: `renameNote` 반환형 변경** — `app/src/lib/core/noteManager.ts`. 시그니처와 모든 `return` 을 객체로:

```ts
export async function renameNote(
	guid: string,
	newTitle: string
): Promise<{ ok: boolean; backlinksUpdated: number }> {
	const note = await noteStore.getNote(guid);
	if (!note) return { ok: false, backlinksUpdated: 0 };
	const trimmed = newTitle.trim();
	if (!trimmed) return { ok: false, backlinksUpdated: 0 };
	if (trimmed === note.title) return { ok: true, backlinksUpdated: 0 }; // no-op

	const existing = await noteStore.findNoteByTitle(trimmed);
	if (existing && existing.guid !== guid && !existing.deleted) {
		return { ok: false, backlinksUpdated: 0 };
	}

	const oldTitle = note.title;
	const now = formatTomboyDate(new Date());
	note.title = trimmed;
	note.xmlContent = rewriteTitleInNoteContentXml(note.xmlContent, trimmed);
	note.changeDate = now;
	note.metadataChangeDate = now;
	await noteStore.putNote(note);
	notifyNoteSaved(guid);
	noteMutated(note);

	const affected = await rewriteBacklinksForRename(oldTitle, trimmed, guid);
	if (affected.length > 0) invalidateCache();
	await emitNoteReload([guid, ...affected]);
	return { ok: true, backlinksUpdated: affected.length };
}
```

- [ ] **Step 4: 기존 `renameNote.test.ts` 갱신** — boolean 단언을 `.ok` 로, 캐스케이드 테스트에 `backlinksUpdated` 추가:

```ts
	it('첫 줄과 note.title 을 함께 갱신하고 라운드트립이 일치한다', async () => {
		const n = await createNote({ title: '예전 제목' });
		const { ok } = await renameNote(n.guid, '새 제목');
		expect(ok).toBe(true);
		// ...(이하 동일)
	});

	it('빈/동일 제목은 no-op, 충돌은 false', async () => {
		const a = await createNote({ title: 'A 노트' });
		await createNote({ title: 'B 노트' });
		expect((await renameNote(a.guid, '   ')).ok).toBe(false);
		expect((await renameNote(a.guid, 'A 노트')).ok).toBe(true); // 동일 → no-op 성공
		expect((await renameNote(a.guid, 'B 노트')).ok).toBe(false); // 충돌
	});

	it('백링크 캐스케이드: 소스 노트의 <link:internal> 이 새 타이틀로 재작성된다', async () => {
		// ...(target/source 생성 동일)
		const { ok, backlinksUpdated } = await renameNote(target.guid, '바뀐 타깃');
		expect(ok).toBe(true);
		expect(backlinksUpdated).toBe(1);
		// ...(이하 단언 동일)
	});
```

- [ ] **Step 5: 모바일 호출 사이트** — `app/src/routes/note/[id]/+page.svelte` `handleTitleSave`:

```ts
	async function handleTitleSave(r: { title: string; typeId: string; notebook: string | null }) {
		if (!note) return;
		titleDialogOpen = false;
		if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
		await flushSave();
		const t0 = performance.now();
		const { ok, backlinksUpdated } = await renameNote(note.guid, r.title);
		if (!ok) {
			pushToast('이미 같은 제목의 노트가 있거나 제목이 비어 있습니다.', { kind: 'error' });
			return;
		}
		const ms = Math.round(performance.now() - t0);
		if (r.notebook !== currentNotebook) {
			await assignNotebook(note.guid, r.notebook);
		}
		const updated = await getNote(note.guid);
		if (updated) note = updated;
		newNoteFlow.openResult({
			heading: '제목 변경 완료',
			title: r.title,
			guid: note.guid,
			stages: [{ name: `제목 변경 · 백링크 ${backlinksUpdated}개 갱신`, ms, status: 'done' }]
		});
	}
```

  (기존 `pushToast('제목이 변경되었습니다.')` 는 패널이 결과를 보여주므로 제거.)

- [ ] **Step 6: 데스크탑 호출 사이트** — `app/src/lib/desktop/NoteWindow.svelte` `handleTitleSave`:

```ts
	async function handleTitleSave(r: { title: string; typeId: string; notebook: string | null }) {
		if (!note) return;
		titleDialogOpen = false;
		if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
		await flushSave();
		const t0 = performance.now();
		const { ok, backlinksUpdated } = await renameNote(note.guid, r.title);
		if (!ok) {
			pushToast('이미 같은 제목의 노트가 있거나 제목이 비어 있습니다.', { kind: 'error' });
			return;
		}
		const ms = Math.round(performance.now() - t0);
		if (r.notebook !== currentNotebook) {
			await assignNotebook(note.guid, r.notebook);
		}
		const updated = await getNote(note.guid);
		if (updated) note = updated;
		newNoteFlow.openResult({
			heading: '제목 변경 완료',
			title: r.title,
			guid: note.guid,
			stages: [{ name: `제목 변경 · 백링크 ${backlinksUpdated}개 갱신`, ms, status: 'done' }]
		});
	}
```

- [ ] **Step 7: 통과 확인** — `cd app && npx vitest run tests/unit/core/renameNote.test.ts tests/unit/core/renameThenSweep.test.ts && npm run check`
  Expected: 테스트 PASS, svelte-check 클린(기존 firebase 에러만).

- [ ] **Step 8: 커밋**

```bash
git -C /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu add app/src/lib/core/noteManager.ts "app/src/routes/note/[id]/+page.svelte" app/src/lib/desktop/NoteWindow.svelte app/tests/unit/core/renameNote.test.ts app/tests/unit/core/renameThenSweep.test.ts
git -C /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu commit -m "feat(rename): 제목 변경 다이얼로그 → 결과 패널 자동 + 백링크 갱신 가시화"
```

---

### Task 3: 수동 액션 "전체 문서에 이 제목 반영"(두 메뉴 + 두 핸들러)

**Goal:** 어느 노트의 액션 메뉴에서든 현재 제목으로 전체 문서 스윕을 띄울 수 있다(인라인 편집 리네임 + 재-스윕 커버).

**Files:**
- Modify: `app/src/lib/editor/NoteActionSheet.svelte:4-14,79-83`
- Modify: `app/src/lib/editor/NoteContextMenu.svelte:5-14,75-78`
- Modify: `app/src/routes/note/[id]/+page.svelte` (`handleAction`)
- Modify: `app/src/lib/desktop/NoteWindow.svelte` (`handleAction`)
- Test: `app/tests/unit/editor/NoteActionSheet.test.ts` (신규)

**Acceptance Criteria:**
- [ ] 두 메뉴의 `ActionKind` 유니온에 `'reflectTitle'` 추가, 제목이 비지 않은 경우 "제목 수정" 옆에 "전체 문서에 이 제목 반영" 항목 렌더(`{#if note.title.trim()}` 가드).
- [ ] 두 `handleAction` 가 `reflectTitle` 처리: `newNoteFlow.openResult({ heading:'전체 문서에 제목 반영', title:note.title, guid:note.guid, stages:[] })` 후 `void newNoteFlow.startSweepCount()`; 제목 공백이면 early-return.
- [ ] NoteActionSheet 렌더 테스트: 새 버튼 클릭 시 `onaction('reflectTitle')` 호출.
- [ ] `npm run check` 클린.

**Verify:** `cd app && npx vitest run tests/unit/editor/NoteActionSheet.test.ts && npm run check`

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — 신규 `app/tests/unit/editor/NoteActionSheet.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import NoteActionSheet from '$lib/editor/NoteActionSheet.svelte';
import type { NoteData } from '$lib/core/note.js';

afterEach(() => cleanup());

function makeNote(title: string): NoteData {
	return {
		guid: 'g1', title, uri: 'note://tomboy/g1',
		xmlContent: `<note-content version="0.1">${title}</note-content>`,
		createDate: '', changeDate: '', metadataChangeDate: ''
	} as NoteData;
}

describe('NoteActionSheet reflectTitle', () => {
	it('제목이 있으면 "전체 문서에 이 제목 반영" 버튼이 onaction(reflectTitle)을 호출', async () => {
		const onaction = vi.fn();
		const { getByText } = render(NoteActionSheet, {
			props: { note: makeNote('어떤 제목'), dirty: false, onaction, onclose: () => {} }
		});
		await fireEvent.click(getByText('전체 문서에 이 제목 반영'));
		expect(onaction).toHaveBeenCalledWith('reflectTitle');
	});

	it('제목이 비면 반영 버튼을 렌더하지 않는다', () => {
		const { queryByText } = render(NoteActionSheet, {
			props: { note: makeNote('   '), dirty: false, onaction: () => {}, onclose: () => {} }
		});
		expect(queryByText('전체 문서에 이 제목 반영')).toBeNull();
	});
});
```

- [ ] **Step 2: 실패 확인** — `cd app && npx vitest run tests/unit/editor/NoteActionSheet.test.ts`
  Expected: FAIL — "전체 문서에 이 제목 반영" 텍스트가 없어 `getByText` 가 throw.

- [ ] **Step 3: NoteActionSheet 갱신** — `app/src/lib/editor/NoteActionSheet.svelte`.
  (a) `ActionKind` 에 추가:

```ts
	export type ActionKind =
		| 'delete'
		| 'redownload'
		| 'editTitle'
		| 'reflectTitle'
		| 'toggleFavorite'
		| 'setHome'
		| 'unsetHome'
		| 'pickNotebook'
		| 'toggleScrollBottom'
		| 'compareWithServer'
		| 'viewXml';
```

  (b) "제목 수정" 버튼 바로 아래에 항목 추가:

```svelte
				<button class="action-btn" onclick={() => onaction('editTitle')}>
					<span class="action-icon">✎</span>
					제목 수정
				</button>
				{#if note.title.trim()}
					<button class="action-btn" onclick={() => onaction('reflectTitle')}>
						<span class="action-icon">🔗</span>
						전체 문서에 이 제목 반영
					</button>
				{/if}
```

- [ ] **Step 4: NoteContextMenu 갱신(데스크탑, 동일 패턴)** — `app/src/lib/editor/NoteContextMenu.svelte`.
  (a) `ActionKind` 에 `| 'reflectTitle'` 추가(`'editTitle'` 다음).
  (b) "제목 수정" 항목 바로 아래:

```svelte
				<button class="item" onclick={() => onaction('editTitle')}>
					<span class="icon">✎</span>제목 수정
				</button>
				{#if note.title.trim()}
					<button class="item" onclick={() => onaction('reflectTitle')}>
						<span class="icon">🔗</span>전체 문서에 이 제목 반영
					</button>
				{/if}
				<div class="sep"></div>
```

- [ ] **Step 5: 모바일 handleAction 분기** — `app/src/routes/note/[id]/+page.svelte` `handleAction` 안, `editTitle` 분기 바로 뒤에:

```ts
		if (kind === 'reflectTitle') {
			if (!note!.title.trim()) return;
			newNoteFlow.openResult({
				heading: '전체 문서에 제목 반영',
				title: note!.title,
				guid: note!.guid,
				stages: []
			});
			void newNoteFlow.startSweepCount();
			return;
		}
```

- [ ] **Step 6: 데스크탑 handleAction 분기** — `app/src/lib/desktop/NoteWindow.svelte` `handleAction` 안, `if (kind === 'editTitle') { openTitleDialog(); return; }` 바로 뒤에:

```ts
		if (kind === 'reflectTitle') {
			if (!note.title.trim()) return;
			newNoteFlow.openResult({
				heading: '전체 문서에 제목 반영',
				title: note.title,
				guid: note.guid,
				stages: []
			});
			void newNoteFlow.startSweepCount();
			return;
		}
```

- [ ] **Step 7: 통과 확인** — `cd app && npx vitest run tests/unit/editor/NoteActionSheet.test.ts && npm run check`
  Expected: 테스트 PASS, svelte-check 클린.

- [ ] **Step 8: 커밋**

```bash
git -C /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu add app/src/lib/editor/NoteActionSheet.svelte app/src/lib/editor/NoteContextMenu.svelte "app/src/routes/note/[id]/+page.svelte" app/src/lib/desktop/NoteWindow.svelte app/tests/unit/editor/NoteActionSheet.test.ts
git -C /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu commit -m "feat(menu): '전체 문서에 이 제목 반영' 수동 액션(모바일+데스크탑)"
```

---

### Task 4: 설정 가이드 카드 확장

**Goal:** 설정 → 가이드(노트 탭)의 결과-패널 카드가 제목 변경 자동 패널 + 수동 반영 액션을 안내한다.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte:1954-1963`

**Acceptance Criteria:**
- [ ] 기존 결과-패널 가이드 카드가 (1) 제목 변경 다이얼로그 자동 패널 + 백링크 갱신 표시, (2) 액션 메뉴 "전체 문서에 이 제목 반영" 수동 항목을 설명하는 항목을 포함.
- [ ] `npm run check` 클린.

**Verify:** `cd app && npm run check` → svelte-check 클린(기존 firebase 에러만).

**Steps:**

- [ ] **Step 1: 가이드 카드 교체** — `app/src/routes/settings/+page.svelte` 1954–1963행의 `<details class="guide-card">` 블록을:

```svelte
				<details class="guide-card">
					<summary>결과 패널 · 전체 문서에 제목 반영</summary>
					<p class="info-text">새 노트를 만들거나 <b>제목 변경 다이얼로그로 제목을 바꾸면</b> 진행 팝업이 자동으로 닫히지 않고 각 단계 소요 시간을 보여줍니다. 원하면 이 제목을 기존 모든 노트에 링크로 반영할 수 있습니다.</p>
					<ul class="guide-list">
						<li>제목을 바꾸면 기존 링크는 <b>자동으로</b> 새 제목으로 갱신되고(백링크 N개 갱신), 패널에서 그 결과를 확인할 수 있습니다.</li>
						<li>"전체 문서에 이 제목 반영"을 누르면 먼저 <b>몇 개 노트가 업데이트되는지</b> 집계 후 확인을 받습니다.</li>
						<li>적용하면 제목과 일치하는 본문이 내부 링크가 되어 이 노트의 백링크로 잡힙니다.</li>
						<li>에디터 첫 줄을 직접 고쳐 제목을 바꿨거나 아무 때나 다시 반영하고 싶으면, 노트 <b>… 액션 메뉴 → "전체 문서에 이 제목 반영"</b>으로 직접 실행할 수 있습니다.</li>
						<li>업데이트된 노트는 다음 Dropbox "지금 동기화" 때 함께 올라갑니다.</li>
						<li>닫기 전까지 결과·소요 시간이 유지됩니다.</li>
					</ul>
				</details>
```

- [ ] **Step 2: 통과 확인** — `cd app && npm run check`
  Expected: svelte-check 클린(기존 firebase 에러만).

- [ ] **Step 3: 커밋**

```bash
git -C /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu add app/src/routes/settings/+page.svelte
git -C /var/home/umayloveme/workspace/tomboy-web/.worktrees/shifu commit -m "docs(guide): 결과 패널 가이드에 제목 변경 자동/수동 반영 추가"
```

---

## 최종 검증

전체 작업 후:

```bash
cd app && npm run check && npm run test
```

Expected: svelte-check 는 기존 `firebase/app.ts:80` 에러만, 단위 테스트 전부 통과(신규 포함).

브라우저 수동 확인(정적 분석으로 측정 불가):
- 모바일/데스크탑에서 제목 변경 다이얼로그로 리네임 → 결과 패널 자동 등장, "제목 변경 · 백링크 N개 갱신" 단계 표시, 스윕 확인→적용.
- 액션 메뉴 "전체 문서에 이 제목 반영" → 패널 등장 + 집계 자동 시작.
- 캐스케이드 후 재-스윕 시 링크 중복 없음.
