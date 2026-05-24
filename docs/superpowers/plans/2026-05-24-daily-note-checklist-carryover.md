# 일일노트 체크리스트 시드 + 어제 미체크 캐리오버 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 일일노트(`yyyy-mm-dd` 제목) 생성 시 시드되는 항목을 인터랙티브 체크리스트로 만들고, 어제 일일노트의 미체크 항목을 함께 캐리오버한다.

**Architecture:** `app/src/lib/schedule/dateNoteSeed.ts` 한 파일 안에서 함수만 잘게 분해 — `buildTodoBlocks` 를 `buildChecklistBlocks` 로 교체(헤더 `체크리스트:`), 신규 순수 함수 `extractUncheckedFromDoc` + IDB 어댑터 `extractUncheckedFromYesterdayNote` 추가, `buildDateNoteScheduleSeed` 내부에서 둘을 합쳐 호출. 외부 API 시그니처(`buildDateNoteScheduleSeed(y, m, d)`)는 유지하므로 `noteManager.createNote` 호출자는 무수정.

**Tech Stack:** TypeScript, Vitest, fake-indexeddb, TipTap JSONContent.

**Spec:** [docs/superpowers/specs/2026-05-24-daily-note-checklist-carryover-design.md](../specs/2026-05-24-daily-note-checklist-carryover-design.md)

---

## File Structure

**Modified:**
- `app/src/lib/schedule/dateNoteSeed.ts` — 함수 분해 + 신규 추출 함수 추가
- `app/tests/unit/schedule/dateNoteSeed.test.ts` — `buildTodoBlocks` 섹션을 `buildChecklistBlocks` 로 갱신, `extractUncheckedFromDoc` 단위 테스트 추가
- `app/tests/unit/schedule/dateNoteScheduleSeed.test.ts` — `TODO:` → `체크리스트:` 헤더 갱신, 어제 노트 carryover 시나리오 추가

**Unchanged (no edit required):**
- `app/src/lib/core/noteManager.ts` — `buildDateNoteScheduleSeed` 호출 시그니처 유지
- `app/src/lib/editor/checklist/regions.ts` — 헤더 규칙(`체크리스트:`) 그대로 재사용
- `app/src/lib/core/noteContentArchiver.ts` — 체크박스 ↔ XML 라운드트립(`[ ]`/`[X]` 마커) 그대로 재사용

---

## Task 0: `buildTodoBlocks` → `buildChecklistBlocks` 교체

**Goal:** 시드 헤더 텍스트를 `TODO:` 에서 `체크리스트:` 로 바꾸고, listItem 에 `attrs.checked: false` 를 명시. 신규 carryover 인자를 받되 본 태스크에서는 빈 배열만 전달. 사용자가 보는 변화: 일정만 있는 일일노트의 시드가 인터랙티브 체크박스로 렌더링됨.

**Files:**
- Modify: `app/src/lib/schedule/dateNoteSeed.ts:29-43` (`buildTodoBlocks`), `:57-76` (`buildDateNoteScheduleSeed`)
- Modify: `app/tests/unit/schedule/dateNoteSeed.test.ts:103-120` (`buildTodoBlocks` describe block)
- Modify: `app/tests/unit/schedule/dateNoteScheduleSeed.test.ts:85-116` (헤더 텍스트 assertion)

**Acceptance Criteria:**
- [ ] `buildTodoBlocks` 제거됨, `buildChecklistBlocks(scheduleLabels: string[], carryoverItems: JSONContent[]): JSONContent[]` 로 교체.
- [ ] 헤더 텍스트가 `체크리스트:` 로 시리얼라이즈됨.
- [ ] schedule label listItem 에 `attrs: { checked: false }` 가 명시됨.
- [ ] schedule 빈 + carryover 빈 → `[]` 반환.
- [ ] schedule 있음 + carryover 빈 → 헤더 + bulletList 시퀀스 반환.
- [ ] `buildDateNoteScheduleSeed` 가 신규 함수를 빈 carryover 로 호출. 외부 시그니처 동일.
- [ ] `dateNoteSeed.test.ts` 와 `dateNoteScheduleSeed.test.ts` 모두 통과.

**Verify:** `cd app && npm run test -- schedule/dateNoteSeed schedule/dateNoteScheduleSeed` → 모든 테스트 통과.

**Steps:**

- [ ] **Step 1: 기존 `buildTodoBlocks` 테스트를 `buildChecklistBlocks` 로 재작성 (failing)**

`app/tests/unit/schedule/dateNoteSeed.test.ts` 의 import 와 buildTodoBlocks describe 를 다음으로 교체.

import 줄:
```ts
import {
	extractScheduleLabelsForDate,
	buildChecklistBlocks
} from '$lib/schedule/dateNoteSeed.js';
```

파일 상단 `li(text)` 헬퍼 옆에 체크 listItem 헬퍼 추가:
```ts
function liChecked(text: string, checked: boolean): JSONContent {
	return { type: 'listItem', attrs: { checked }, content: [p(text)] };
}
```

기존 `describe('buildTodoBlocks', ...)` 블록(파일 103-120) 을 통째로 교체:
```ts
describe('buildChecklistBlocks', () => {
	it('empty schedule + empty carryover → []', () => {
		expect(buildChecklistBlocks([], [])).toEqual([]);
	});

	it('one schedule label → [paragraph("체크리스트:"), bulletList(listItem(checked:false, label))]', () => {
		const blocks = buildChecklistBlocks(['독서모임 7시'], []);
		expect(blocks).toEqual([
			p('체크리스트:'),
			ul(liChecked('독서모임 7시', false))
		]);
	});

	it('multiple schedule labels preserve order, all checked:false', () => {
		const blocks = buildChecklistBlocks(['독서', '독서모임 7시', '산책 8시'], []);
		expect(blocks).toEqual([
			p('체크리스트:'),
			ul(
				liChecked('독서', false),
				liChecked('독서모임 7시', false),
				liChecked('산책 8시', false)
			)
		]);
	});
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `cd app && npm run test -- schedule/dateNoteSeed`
Expected: 위 3개 케이스가 `buildChecklistBlocks is not exported` 또는 유사 오류로 실패.

- [ ] **Step 3: `dateNoteSeed.ts` 에서 `buildTodoBlocks` 를 `buildChecklistBlocks` 로 교체**

`app/src/lib/schedule/dateNoteSeed.ts:29-43` 의 `buildTodoBlocks` 를 통째로 교체:

```ts
/**
 * 시드 체크리스트 블록을 만든다. 일정 라벨이 먼저, 캐리오버 항목이 그
 * 다음에 배치된다. 둘 다 비면 [] (시드 자체 생략).
 *
 * 헤더 텍스트는 `체크리스트:` — 이건 editor/checklist/regions.ts 의
 * isChecklistHeaderText 가 인식하는 토큰이고, ProseMirror 플러그인이
 * 영역 안 listItem 을 체크박스로 렌더링하는 트리거다. 동일 규칙이
 * noteContentArchiver.ts 의 applyChecklistMarkersOnParse 에도 있다.
 */
export function buildChecklistBlocks(
	scheduleLabels: string[],
	carryoverItems: JSONContent[]
): JSONContent[] {
	if (scheduleLabels.length === 0 && carryoverItems.length === 0) return [];
	const scheduleItems: JSONContent[] = scheduleLabels.map((label) => ({
		type: 'listItem',
		attrs: { checked: false },
		content: [{ type: 'paragraph', content: [{ type: 'text', text: label }] }]
	}));
	return [
		{ type: 'paragraph', content: [{ type: 'text', text: '체크리스트:' }] },
		{
			type: 'bulletList',
			content: [...scheduleItems, ...carryoverItems]
		}
	];
}
```

- [ ] **Step 4: `buildDateNoteScheduleSeed` 가 새 함수를 호출하도록 변경**

`app/src/lib/schedule/dateNoteSeed.ts:57-76` 의 함수 본문에서 `buildTodoBlocks(labels)` 호출을 다음으로 교체:

```ts
		const labels = extractScheduleLabelsForDate(entries, year, month, day);
		return buildChecklistBlocks(labels, []);
```

(carryover 인자는 Task 3 에서 실제 추출 결과로 교체된다.)

- [ ] **Step 5: `dateNoteScheduleSeed.test.ts` 의 헤더 텍스트 갱신**

`app/tests/unit/schedule/dateNoteScheduleSeed.test.ts` 에서 `p('TODO:')` 두 곳을 `p('체크리스트:')` 로 교체하고, `li(...)` 호출도 `liChecked(..., false)` 로 갱신.

파일 상단 헬퍼 옆에 추가:
```ts
function liChecked(text: string, checked: boolean): JSONContent {
	return { type: 'listItem', attrs: { checked }, content: [p(text)] };
}
```

테스트 본문 두 곳:
```ts
// "returns TODO blocks for matching entries (single match)" 케이스
expect(result).toEqual([
	p('체크리스트:'),
	ul(liChecked('독서모임 7시', false))
]);

// "returns TODO blocks for multiple matches" 케이스
expect(result).toEqual([
	p('체크리스트:'),
	ul(
		liChecked('독서', false),
		liChecked('독서모임 7시', false),
		liChecked('산책 8시', false)
	)
]);
```

테스트 케이스 제목의 `TODO` 단어는 그대로 두어도 상관 없지만, 일관성을 위해 `returns checklist blocks for matching entries (single match)` 등으로 갱신해도 무방.

- [ ] **Step 6: 전체 테스트 실행**

Run: `cd app && npm run test -- schedule/dateNoteSeed schedule/dateNoteScheduleSeed`
Expected: 양쪽 파일의 모든 테스트 통과.

- [ ] **Step 7: 타입 체크**

Run: `cd app && npm run check`
Expected: 에러 없음.

- [ ] **Step 8: 커밋**

```bash
git add app/src/lib/schedule/dateNoteSeed.ts \
       app/tests/unit/schedule/dateNoteSeed.test.ts \
       app/tests/unit/schedule/dateNoteScheduleSeed.test.ts
git commit -m "feat(date-note): TODO 시드 → 체크리스트 헤더로 교체"
```

---

## Task 1: `extractUncheckedFromDoc` 순수 함수

**Goal:** 어제 노트의 deserialize 된 JSONContent doc 에서 `체크리스트:` 영역을 모두 찾아 미체크 listItem 가지만 추출. 순수 함수 — IDB 의존 없음. Task 2 의 IDB 어댑터가 이 함수를 호출한다.

**Files:**
- Modify: `app/src/lib/schedule/dateNoteSeed.ts` (신규 함수 추가, 파일 하단)
- Modify: `app/tests/unit/schedule/dateNoteSeed.test.ts` (신규 describe 블록 추가)

**Acceptance Criteria:**
- [ ] `extractUncheckedFromDoc(doc: JSONContent): JSONContent[]` 가 export 됨.
- [ ] doc 에 `체크리스트:` 헤더 없음 → `[]`.
- [ ] 미체크 listItem 하나 → 그 listItem 하나 반환 (`checked: false` 보존).
- [ ] 부모 체크 / 자식 미체크 → 자식만 평탄화로 최상위 결과에 끌어올림.
- [ ] 부모 미체크 / 자식 일부 체크 → 부모 보존, 자식 bulletList 에 미체크 자식만 남김. 자식이 다 사라지면 자식 list 자체 제거.
- [ ] doc 안 영역 2 개 이상 → 발견 순서대로 모두 합쳐 결과 반환.
- [ ] 헤더 직후가 bulletList 가 아닌 블록(예: paragraph) → 그 헤더의 영역은 비어 있음으로 처리, 그 뒤 영역은 정상 인식.
- [ ] 헤더 규칙(`체크리스트:` 로 시작 + 연속 bulletList) 이 `editor/checklist/regions.ts` / `noteContentArchiver.ts:applyChecklistMarkersOnParse` 와 의미적으로 동일하다는 점이 코멘트에 명시됨.

**Verify:** `cd app && npm run test -- schedule/dateNoteSeed` → 신규 describe 블록의 모든 케이스 통과.

**Steps:**

- [ ] **Step 1: failing 테스트 작성**

`app/tests/unit/schedule/dateNoteSeed.test.ts` 상단 import 에 `extractUncheckedFromDoc` 추가:
```ts
import {
	extractScheduleLabelsForDate,
	buildChecklistBlocks,
	extractUncheckedFromDoc
} from '$lib/schedule/dateNoteSeed.js';
```

파일 헬퍼 영역에 다음 도우미 추가 (기존 `liChecked` 와 함께):
```ts
function ulChecked(...items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}
function liNested(text: string, checked: boolean, ...children: JSONContent[]): JSONContent {
	return {
		type: 'listItem',
		attrs: { checked },
		content: [p(text), ...children]
	};
}
function doc(...blocks: JSONContent[]): JSONContent {
	return { type: 'doc', content: blocks };
}
```

파일 끝에 다음 describe 블록 추가:

```ts
describe('extractUncheckedFromDoc', () => {
	it('empty doc → []', () => {
		expect(extractUncheckedFromDoc(doc())).toEqual([]);
	});

	it('doc without 체크리스트 header → []', () => {
		const d = doc(p('제목'), p('본문'), ulChecked(liChecked('할 일', false)));
		expect(extractUncheckedFromDoc(d)).toEqual([]);
	});

	it('header + single unchecked → [that listItem]', () => {
		const d = doc(
			p('제목'),
			p('체크리스트:'),
			ulChecked(liChecked('할 일', false))
		);
		expect(extractUncheckedFromDoc(d)).toEqual([liChecked('할 일', false)]);
	});

	it('header + mix of checked/unchecked → unchecked only', () => {
		const d = doc(
			p('제목'),
			p('체크리스트:'),
			ulChecked(
				liChecked('완료', true),
				liChecked('미완 1', false),
				liChecked('미완 2', false)
			)
		);
		expect(extractUncheckedFromDoc(d)).toEqual([
			liChecked('미완 1', false),
			liChecked('미완 2', false)
		]);
	});

	it('parent checked / child unchecked → child lifted to top', () => {
		const d = doc(
			p('제목'),
			p('체크리스트:'),
			ulChecked(
				liNested('부모완료', true, ulChecked(liChecked('자식미완', false)))
			)
		);
		expect(extractUncheckedFromDoc(d)).toEqual([liChecked('자식미완', false)]);
	});

	it('parent unchecked / child partially checked → parent preserved, only unchecked children kept', () => {
		const d = doc(
			p('체크리스트:'),
			ulChecked(
				liNested(
					'부모미완',
					false,
					ulChecked(
						liChecked('자식완료', true),
						liChecked('자식미완', false)
					)
				)
			)
		);
		expect(extractUncheckedFromDoc(d)).toEqual([
			liNested('부모미완', false, ulChecked(liChecked('자식미완', false)))
		]);
	});

	it('parent unchecked / all children checked → parent preserved, nested list removed', () => {
		const d = doc(
			p('체크리스트:'),
			ulChecked(
				liNested(
					'부모미완',
					false,
					ulChecked(liChecked('자식완료1', true), liChecked('자식완료2', true))
				)
			)
		);
		expect(extractUncheckedFromDoc(d)).toEqual([liChecked('부모미완', false)]);
	});

	it('two checklist regions → concatenated in document order', () => {
		const d = doc(
			p('체크리스트:'),
			ulChecked(liChecked('A1', false)),
			p('중간 본문'),
			p('체크리스트:'),
			ulChecked(liChecked('B1', false), liChecked('B2', true))
		);
		expect(extractUncheckedFromDoc(d)).toEqual([
			liChecked('A1', false),
			liChecked('B1', false)
		]);
	});

	it('header followed by paragraph (no bulletList) → that header empty, later region still works', () => {
		const d = doc(
			p('체크리스트:'),
			p('직후가 리스트가 아님'),
			p('체크리스트:'),
			ulChecked(liChecked('정상', false))
		);
		expect(extractUncheckedFromDoc(d)).toEqual([liChecked('정상', false)]);
	});

	it('header + two consecutive bulletLists → both treated as the same region', () => {
		const d = doc(
			p('체크리스트:'),
			ulChecked(liChecked('A', false)),
			ulChecked(liChecked('B', false))
		);
		expect(extractUncheckedFromDoc(d)).toEqual([
			liChecked('A', false),
			liChecked('B', false)
		]);
	});

	it('grandchild lifted through two checked ancestors', () => {
		const d = doc(
			p('체크리스트:'),
			ulChecked(
				liNested(
					'조부완료',
					true,
					ulChecked(
						liNested(
							'부완료',
							true,
							ulChecked(liChecked('손미완', false))
						)
					)
				)
			)
		);
		expect(extractUncheckedFromDoc(d)).toEqual([liChecked('손미완', false)]);
	});
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `cd app && npm run test -- schedule/dateNoteSeed`
Expected: 위 describe 블록의 모든 케이스가 `extractUncheckedFromDoc is not exported` 등으로 실패.

- [ ] **Step 3: 구현 — `extractUncheckedFromDoc` 와 트리 헬퍼 추가**

`app/src/lib/schedule/dateNoteSeed.ts` 파일 끝에 다음을 추가:

```ts
// 주의: 체크리스트 영역 감지(헤더 + 연속 bulletList)는 세 곳에서 각각
// 구현된다 — editor/checklist/regions.ts 의 findChecklistRegions(라이브
// PM 노드), noteContentArchiver.ts 의 applyChecklistMarkersOnParse(역직
// 렬화 후 처리), 그리고 아래 extractUncheckedFromDoc(시드 빌드 시 JSON).
// 규칙을 바꾸면 세 곳을 함께 고쳐야 한다.

/** "체크리스트:" 로 시작 (콜론 필수, trim 후). */
function isChecklistHeader(p: JSONContent): boolean {
	if (p.type !== 'paragraph') return false;
	const text = (p.content ?? [])
		.map((n) => (n.type === 'text' && typeof n.text === 'string' ? n.text : ''))
		.join('');
	return /^체크리스트:/.test(text.trim());
}

/**
 * listItem 트리에서 미체크 가지만 추출.
 *
 * 반환:
 * - `null` → 자기/자식 모두 체크라 버린다
 * - 길이 1+ 배열 → 결과로 (자기 보존) 또는 (자식들 끌어올림) 의 listItem 들
 */
function extractUncheckedFromListItem(li: JSONContent): JSONContent[] | null {
	if (li.type !== 'listItem') return null;
	const checked = li.attrs?.checked === true;

	// 자식 bulletList 들에서 미체크 listItem 들을 재귀로 모음.
	const carriedChildItems: JSONContent[] = [];
	const filteredChildLists: JSONContent[] = [];
	const nonListChildren: JSONContent[] = []; // paragraph 등 자식의 자식 외 블록
	for (const child of li.content ?? []) {
		if (child.type === 'bulletList') {
			const kept: JSONContent[] = [];
			for (const sub of child.content ?? []) {
				const res = extractUncheckedFromListItem(sub);
				if (res) {
					if (checked) {
						// 자기가 체크면 자식의 살아남은 미체크 항목을 끌어올린다.
						carriedChildItems.push(...res);
					} else {
						// 자기가 미체크면 자식들 살린 채 자식 list 안에 유지.
						kept.push(...res);
					}
				}
			}
			if (!checked && kept.length > 0) {
				filteredChildLists.push({ type: 'bulletList', content: kept });
			}
		} else {
			nonListChildren.push(child);
		}
	}

	if (checked) {
		// 자기 버리고 살아남은 자식 미체크들만 반환.
		return carriedChildItems.length > 0 ? carriedChildItems : null;
	}

	// 자기 미체크 → 자기 보존. 자식 list 들은 필터링된 결과로 교체.
	const newContent: JSONContent[] = [...nonListChildren, ...filteredChildLists];
	return [{ ...li, attrs: { ...(li.attrs ?? {}), checked: false }, content: newContent }];
}

/**
 * doc 안의 모든 「체크리스트:」 영역에서 미체크 가지를 추출하여 평탄화한
 * listItem 배열로 반환한다. 영역 = 헤더 paragraph + 그 직후 연속 bulletList.
 * 영역이 없거나 모두 체크되어 있으면 [].
 */
export function extractUncheckedFromDoc(doc: JSONContent): JSONContent[] {
	const blocks = doc.content ?? [];
	const out: JSONContent[] = [];
	let i = 0;
	while (i < blocks.length) {
		const b = blocks[i];
		if (!isChecklistHeader(b)) {
			i++;
			continue;
		}
		// 헤더 직후 오는 연속 bulletList 들이 영역.
		let j = i + 1;
		while (j < blocks.length && blocks[j].type === 'bulletList') {
			const list = blocks[j];
			for (const li of list.content ?? []) {
				const res = extractUncheckedFromListItem(li);
				if (res) out.push(...res);
			}
			j++;
		}
		i = j;
	}
	return out;
}
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `cd app && npm run test -- schedule/dateNoteSeed`
Expected: 모든 케이스 통과 (Task 0 + Task 1 합쳐서).

- [ ] **Step 5: 타입 체크**

Run: `cd app && npm run check`
Expected: 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/schedule/dateNoteSeed.ts \
       app/tests/unit/schedule/dateNoteSeed.test.ts
git commit -m "feat(date-note): extractUncheckedFromDoc — 체크리스트 영역 미체크 가지 추출"
```

---

## Task 2: `extractUncheckedFromYesterdayNote` IDB 어댑터

**Goal:** 어제 날짜(`yyyy-mm-dd - 1day`) 제목의 노트를 IDB 에서 찾고, deserialize 후 `extractUncheckedFromDoc` 를 호출. 노트 없음 / soft-delete / deserialize 에러 / 영역 없음 → 모두 `[]`. 일일노트 생성을 절대 막지 않도록 모든 예외 swallow.

**Files:**
- Modify: `app/src/lib/schedule/dateNoteSeed.ts` (신규 함수 추가)
- Modify: `app/tests/unit/schedule/dateNoteScheduleSeed.test.ts` (신규 describe 블록 추가)

**Acceptance Criteria:**
- [ ] `extractUncheckedFromYesterdayNote(year, month, day): Promise<JSONContent[]>` 가 export 됨.
- [ ] 어제 노트 없음 → `[]`.
- [ ] 어제 노트 `deleted: true` → `[]`.
- [ ] 어제 노트는 있지만 체크리스트 영역 없음 → `[]`.
- [ ] 어제 노트의 미체크 항목들이 정상적으로 추출됨.
- [ ] 어제 = 전월 마지막 일 (월 경계): 2026-05-01 → 2026-04-30 으로 룩업.
- [ ] 어제 = 전년 마지막 일 (년 경계): 2026-01-01 → 2025-12-31 으로 룩업.
- [ ] `xmlContent` 가 망가져 deserialize 가 throw 해도 `[]` 반환 + `console.warn` 호출 (테스트는 throw 안 함만 확인).

**Verify:** `cd app && npm run test -- schedule/dateNoteScheduleSeed` → 신규 describe 블록 모두 통과.

**Steps:**

- [ ] **Step 1: failing 테스트 작성**

`app/tests/unit/schedule/dateNoteScheduleSeed.test.ts` 상단 import 에 추가:
```ts
import {
	buildDateNoteScheduleSeed,
	extractUncheckedFromYesterdayNote
} from '$lib/schedule/dateNoteSeed.js';
```

파일 헬퍼 영역에 `liChecked`, `liNested`, `docFrom` 헬퍼가 없으면 추가:
```ts
function liChecked(text: string, checked: boolean): JSONContent {
	return { type: 'listItem', attrs: { checked }, content: [p(text)] };
}
function checklistDoc(title: string, ...items: JSONContent[]): JSONContent {
	return {
		type: 'doc',
		content: [p(title), p('체크리스트:'), { type: 'bulletList', content: items }]
	};
}
```

파일 끝에 신규 describe 추가:

```ts
describe('extractUncheckedFromYesterdayNote', () => {
	it('returns [] when yesterday note does not exist', async () => {
		const result = await extractUncheckedFromYesterdayNote(2026, 5, 24);
		expect(result).toEqual([]);
	});

	it('returns [] when yesterday note is soft-deleted', async () => {
		const note = makeNote(
			'y-guid',
			checklistDoc('2026-05-23', liChecked('할 일', false)),
			{ title: '2026-05-23', deleted: true }
		);
		await putNote(note);
		const result = await extractUncheckedFromYesterdayNote(2026, 5, 24);
		expect(result).toEqual([]);
	});

	it('returns [] when yesterday note has no checklist region', async () => {
		const note = makeNote(
			'y-guid',
			{ type: 'doc', content: [p('2026-05-23'), p('그냥 메모')] },
			{ title: '2026-05-23' }
		);
		await putNote(note);
		const result = await extractUncheckedFromYesterdayNote(2026, 5, 24);
		expect(result).toEqual([]);
	});

	it('extracts unchecked items from yesterday note', async () => {
		const note = makeNote(
			'y-guid',
			checklistDoc(
				'2026-05-23',
				liChecked('완료된 일', true),
				liChecked('남은 일 1', false),
				liChecked('남은 일 2', false)
			),
			{ title: '2026-05-23' }
		);
		await putNote(note);
		const result = await extractUncheckedFromYesterdayNote(2026, 5, 24);
		expect(result).toEqual([
			liChecked('남은 일 1', false),
			liChecked('남은 일 2', false)
		]);
	});

	it('month boundary: 2026-05-01 → looks up 2026-04-30', async () => {
		const note = makeNote(
			'y-guid',
			checklistDoc('2026-04-30', liChecked('월말 미완', false)),
			{ title: '2026-04-30' }
		);
		await putNote(note);
		const result = await extractUncheckedFromYesterdayNote(2026, 5, 1);
		expect(result).toEqual([liChecked('월말 미완', false)]);
	});

	it('year boundary: 2026-01-01 → looks up 2025-12-31', async () => {
		const note = makeNote(
			'y-guid',
			checklistDoc('2025-12-31', liChecked('연말 미완', false)),
			{ title: '2025-12-31' }
		);
		await putNote(note);
		const result = await extractUncheckedFromYesterdayNote(2026, 1, 1);
		expect(result).toEqual([liChecked('연말 미완', false)]);
	});

	it('returns [] (does not throw) when yesterday note xmlContent is corrupt', async () => {
		const note = makeNote(
			'y-guid',
			checklistDoc('2026-05-23', liChecked('할 일', false)),
			{ title: '2026-05-23' }
		);
		note.xmlContent = '<note-content version="0.1"><<broken<<';
		await putNote(note);
		const result = await extractUncheckedFromYesterdayNote(2026, 5, 24);
		expect(result).toEqual([]);
	});
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `cd app && npm run test -- schedule/dateNoteScheduleSeed`
Expected: 신규 describe 의 모든 케이스가 import 에러로 실패.

- [ ] **Step 3: 구현 추가**

`app/src/lib/schedule/dateNoteSeed.ts` 상단 import 에 추가:
```ts
import { findNoteByTitle } from '$lib/storage/noteStore.js';
```

파일 끝에 다음 함수 추가:

```ts
/** `yyyy-mm-dd` 포맷터 (생성된 `Date` 의 로컬 필드 기준). */
function formatDateTitle(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 오늘 (year, month, day) 기준 캘린더상 정확히 1일 전 노트에서
 * 미체크 항목을 추출한다.
 *
 * 실패 모드 (모두 [] 반환):
 *  - 어제 제목의 노트가 IDB 에 없음
 *  - 그 노트가 soft-delete (deleted=true) 상태
 *  - 그 노트에 체크리스트 영역이 없거나 다 체크됨
 *  - deserialize 실패 (xmlContent 손상 등)
 *
 * 어떤 경우에도 throw 하지 않는다 — 일일노트 생성을 막아서는 안 된다.
 */
export async function extractUncheckedFromYesterdayNote(
	year: number,
	month: number,
	day: number
): Promise<JSONContent[]> {
	try {
		const yesterday = new Date(year, month - 1, day - 1);
		const title = formatDateTitle(yesterday);
		const note = await findNoteByTitle(title);
		if (!note || note.deleted) return [];
		const doc = deserializeContent(note.xmlContent);
		return extractUncheckedFromDoc(doc);
	} catch (err) {
		console.warn('[dateNoteSeed] yesterday carryover failed', err);
		return [];
	}
}
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `cd app && npm run test -- schedule/dateNoteScheduleSeed`
Expected: 신규 케이스 모두 통과, 기존 케이스도 그대로 통과.

- [ ] **Step 5: 타입 체크**

Run: `cd app && npm run check`
Expected: 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/schedule/dateNoteSeed.ts \
       app/tests/unit/schedule/dateNoteScheduleSeed.test.ts
git commit -m "feat(date-note): extractUncheckedFromYesterdayNote — 어제 노트 미체크 캐리오버 어댑터"
```

---

## Task 3: `buildDateNoteScheduleSeed` 통합 + 중복 제거

**Goal:** `buildDateNoteScheduleSeed` 내부에서 schedule 추출 + 어제 캐리오버를 합쳐 호출. `buildChecklistBlocks` 에 중복 제거 로직 추가 (schedule label 과 정확히 같은 텍스트의 carryover 최상위 항목은 통째 스킵). 두 일일노트가 함께 있을 때의 통합 시나리오를 integration 테스트로 검증.

**Files:**
- Modify: `app/src/lib/schedule/dateNoteSeed.ts:buildChecklistBlocks` (중복 제거), `:buildDateNoteScheduleSeed` (carryover 호출)
- Modify: `app/tests/unit/schedule/dateNoteSeed.test.ts` (중복 제거 케이스 추가)
- Modify: `app/tests/unit/schedule/dateNoteScheduleSeed.test.ts` (통합 시나리오 추가)

**Acceptance Criteria:**
- [ ] `buildChecklistBlocks(['a'], [{li('x')}])` → 헤더 + `[li('a',false), li('x',false)]`.
- [ ] `buildChecklistBlocks(['a'], [{li('a', children...)}])` → 헤더 + `[li('a',false)]` (carryover 통째 스킵, 자식 포함).
- [ ] `buildChecklistBlocks([], [{li('x')}])` → 헤더 + `[li('x',false)]`.
- [ ] `buildChecklistBlocks` 가 carryover listItem 의 `attrs.checked` 를 `false` 로 강제 (잠재적 누락 방지).
- [ ] `buildDateNoteScheduleSeed` 가 schedule + 어제 캐리오버를 모두 시드. 둘 다 비면 `[]`.
- [ ] Integration 테스트: 어제 노트만 있어도 시드 생성 / 두 노트 다 있으면 합쳐짐 / 중복 라벨 한 번만.

**Verify:** `cd app && npm run test -- schedule/dateNoteSeed schedule/dateNoteScheduleSeed` → 모든 테스트 통과. 그리고 `cd app && npm run check`.

**Steps:**

- [ ] **Step 1: `buildChecklistBlocks` 중복 제거 케이스 추가 (failing)**

`app/tests/unit/schedule/dateNoteSeed.test.ts` 의 `describe('buildChecklistBlocks', ...)` 블록에 다음 케이스들 추가:

```ts
	it('carryover only → header + carryover items (checked forced false)', () => {
		const carryover: JSONContent[] = [
			{ type: 'listItem', attrs: { checked: false }, content: [p('어제 미완')] }
		];
		expect(buildChecklistBlocks([], carryover)).toEqual([
			p('체크리스트:'),
			ul(liChecked('어제 미완', false))
		]);
	});

	it('schedule + carryover → schedule first, carryover after', () => {
		const carryover: JSONContent[] = [
			{ type: 'listItem', attrs: { checked: false }, content: [p('어제 미완')] }
		];
		expect(buildChecklistBlocks(['오늘 일정'], carryover)).toEqual([
			p('체크리스트:'),
			ul(liChecked('오늘 일정', false), liChecked('어제 미완', false))
		]);
	});

	it('dedup: carryover top-level text equals schedule label → carryover skipped', () => {
		const carryover: JSONContent[] = [
			{ type: 'listItem', attrs: { checked: false }, content: [p('회의')] }
		];
		expect(buildChecklistBlocks(['회의'], carryover)).toEqual([
			p('체크리스트:'),
			ul(liChecked('회의', false))
		]);
	});

	it('dedup compares trimmed text only', () => {
		const carryover: JSONContent[] = [
			{ type: 'listItem', attrs: { checked: false }, content: [p('  회의  ')] }
		];
		expect(buildChecklistBlocks(['회의'], carryover)).toEqual([
			p('체크리스트:'),
			ul(liChecked('회의', false))
		]);
	});

	it('dedup skips carryover with nested children too (entire subtree dropped)', () => {
		const carryover: JSONContent[] = [
			{
				type: 'listItem',
				attrs: { checked: false },
				content: [
					p('회의'),
					{
						type: 'bulletList',
						content: [
							{ type: 'listItem', attrs: { checked: false }, content: [p('자식 미완')] }
						]
					}
				]
			}
		];
		expect(buildChecklistBlocks(['회의'], carryover)).toEqual([
			p('체크리스트:'),
			ul(liChecked('회의', false))
		]);
	});

	it('carryover with checked:true at top level still gets forced to false', () => {
		// 정상 경로에서는 extractUncheckedFromDoc 이 미체크만 주지만,
		// 방어적으로 강제.
		const carryover: JSONContent[] = [
			{ type: 'listItem', attrs: { checked: true }, content: [p('항목')] }
		];
		expect(buildChecklistBlocks([], carryover)).toEqual([
			p('체크리스트:'),
			ul(liChecked('항목', false))
		]);
	});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `cd app && npm run test -- schedule/dateNoteSeed`
Expected: 신규 케이스 실패 (특히 dedup 케이스에서 carryover 가 그대로 들어가서 길이가 안 맞음).

- [ ] **Step 3: `buildChecklistBlocks` 에 중복 제거 + checked-false 강제 추가**

`app/src/lib/schedule/dateNoteSeed.ts` 의 `buildChecklistBlocks` 를 다음으로 교체:

```ts
/**
 * 시드 체크리스트 블록을 만든다. 일정 라벨이 먼저, 캐리오버 항목이 그
 * 다음에 배치된다. 둘 다 비면 [] (시드 자체 생략).
 *
 * 중복 제거: carryover 의 최상위 listItem 의 첫 paragraph 텍스트(trim)
 * 가 어떤 schedule label 과 정확히 일치하면 그 listItem 통째(자식 포함)
 * 스킵. 사용자가 schedule 에서 이미 보고 있는 라벨을 두 번 보이게 하지
 * 않기 위함. 필요없는 caryyover 는 수동 삭제 정책이라 더 정교한 중복
 * 휴리스틱은 두지 않는다.
 *
 * 헤더 텍스트는 `체크리스트:` — editor/checklist/regions.ts 와
 * noteContentArchiver.ts:applyChecklistMarkersOnParse 에 동일 규칙.
 */
export function buildChecklistBlocks(
	scheduleLabels: string[],
	carryoverItems: JSONContent[]
): JSONContent[] {
	const scheduleSet = new Set(scheduleLabels.map((s) => s.trim()));
	const filteredCarryover: JSONContent[] = [];
	for (const item of carryoverItems) {
		const topText = firstParagraphText(item).trim();
		if (scheduleSet.has(topText)) continue;
		filteredCarryover.push({
			...item,
			attrs: { ...(item.attrs ?? {}), checked: false }
		});
	}

	if (scheduleLabels.length === 0 && filteredCarryover.length === 0) return [];

	const scheduleItems: JSONContent[] = scheduleLabels.map((label) => ({
		type: 'listItem',
		attrs: { checked: false },
		content: [{ type: 'paragraph', content: [{ type: 'text', text: label }] }]
	}));
	return [
		{ type: 'paragraph', content: [{ type: 'text', text: '체크리스트:' }] },
		{
			type: 'bulletList',
			content: [...scheduleItems, ...filteredCarryover]
		}
	];
}

/** listItem 의 첫 paragraph 안의 모든 text 노드를 이어붙여 반환. */
function firstParagraphText(li: JSONContent): string {
	const para = (li.content ?? []).find((c) => c.type === 'paragraph');
	if (!para) return '';
	return (para.content ?? [])
		.map((n) => (n.type === 'text' && typeof n.text === 'string' ? n.text : ''))
		.join('');
}
```

- [ ] **Step 4: `buildDateNoteScheduleSeed` 가 carryover 를 실제로 가져오도록 변경**

`app/src/lib/schedule/dateNoteSeed.ts` 의 `buildDateNoteScheduleSeed` 본문에서 마지막 두 줄을 교체:

기존:
```ts
		const labels = extractScheduleLabelsForDate(entries, year, month, day);
		return buildChecklistBlocks(labels, []);
```

변경:
```ts
		const labels = extractScheduleLabelsForDate(entries, year, month, day);
		const carryover = await extractUncheckedFromYesterdayNote(year, month, day);
		return buildChecklistBlocks(labels, carryover);
```

또한 같은 함수의 try 블록에서 schedule note 가 없는 짧은-경로 (`if (!guid) return [];` / `if (!note || note.deleted) return [];`) 도 carryover 만 있는 시드를 지원해야 한다. 함수 본문을 다음으로 교체:

```ts
export async function buildDateNoteScheduleSeed(
	year: number,
	month: number,
	day: number
): Promise<JSONContent[]> {
	try {
		const carryover = await extractUncheckedFromYesterdayNote(year, month, day);

		let labels: string[] = [];
		const guid = await getScheduleNoteGuid();
		if (guid) {
			const note = await getNote(guid);
			if (note && !note.deleted) {
				const doc = deserializeContent(note.xmlContent);
				const now = new Date(year, month - 1, day);
				const entries = parseScheduleNote(doc, now);
				labels = extractScheduleLabelsForDate(entries, year, month, day);
			}
		}

		return buildChecklistBlocks(labels, carryover);
	} catch (err) {
		console.warn('[dateNoteSeed] failed', err);
		return [];
	}
}
```

- [ ] **Step 5: Integration 테스트 — 통합 시나리오 추가**

`app/tests/unit/schedule/dateNoteScheduleSeed.test.ts` 의 `describe('buildDateNoteScheduleSeed', ...)` 블록 안에 케이스 추가:

```ts
	it('returns carryover-only seed when no schedule note but yesterday has unchecked', async () => {
		const y = makeNote(
			'y-guid',
			checklistDoc('2026-05-23', liChecked('어제 미완', false)),
			{ title: '2026-05-23' }
		);
		await putNote(y);
		const result = await buildDateNoteScheduleSeed(2026, 5, 24);
		expect(result).toEqual([
			p('체크리스트:'),
			ul(liChecked('어제 미완', false))
		]);
	});

	it('merges schedule labels (first) and yesterday carryover (after)', async () => {
		await setScheduleNote('sched-guid');
		const sched = makeNote(
			'sched-guid',
			noteDoc(['24(일) 회의 10시'])
		);
		await putNote(sched);
		const y = makeNote(
			'y-guid',
			checklistDoc('2026-05-23', liChecked('어제 미완', false)),
			{ title: '2026-05-23' }
		);
		await putNote(y);
		const result = await buildDateNoteScheduleSeed(2026, 5, 24);
		expect(result).toEqual([
			p('체크리스트:'),
			ul(liChecked('회의 10시', false), liChecked('어제 미완', false))
		]);
	});

	it('deduplicates: schedule label == carryover top text → carryover skipped', async () => {
		await setScheduleNote('sched-guid');
		const sched = makeNote(
			'sched-guid',
			noteDoc(['24(일) 회의'])
		);
		await putNote(sched);
		const y = makeNote(
			'y-guid',
			checklistDoc('2026-05-23', liChecked('회의', false), liChecked('병원', false)),
			{ title: '2026-05-23' }
		);
		await putNote(y);
		const result = await buildDateNoteScheduleSeed(2026, 5, 24);
		expect(result).toEqual([
			p('체크리스트:'),
			ul(liChecked('회의', false), liChecked('병원', false))
		]);
	});

	it('returns [] when neither schedule note nor yesterday note has anything', async () => {
		const result = await buildDateNoteScheduleSeed(2026, 5, 24);
		expect(result).toEqual([]);
	});

	it('returns schedule-only when yesterday note is fully checked', async () => {
		await setScheduleNote('sched-guid');
		const sched = makeNote(
			'sched-guid',
			noteDoc(['24(일) 회의'])
		);
		await putNote(sched);
		const y = makeNote(
			'y-guid',
			checklistDoc('2026-05-23', liChecked('어제 완료', true)),
			{ title: '2026-05-23' }
		);
		await putNote(y);
		const result = await buildDateNoteScheduleSeed(2026, 5, 24);
		expect(result).toEqual([
			p('체크리스트:'),
			ul(liChecked('회의', false))
		]);
	});
```

- [ ] **Step 6: 테스트 실행 — 통과 확인**

Run: `cd app && npm run test -- schedule/dateNoteSeed schedule/dateNoteScheduleSeed`
Expected: 모든 케이스 통과.

- [ ] **Step 7: 전체 테스트 + 타입 체크**

Run: `cd app && npm run test`
Expected: 모든 테스트 통과 (회귀 없음).

Run: `cd app && npm run check`
Expected: 에러 없음.

- [ ] **Step 8: 커밋**

```bash
git add app/src/lib/schedule/dateNoteSeed.ts \
       app/tests/unit/schedule/dateNoteSeed.test.ts \
       app/tests/unit/schedule/dateNoteScheduleSeed.test.ts
git commit -m "feat(date-note): 어제 미체크 캐리오버를 일일노트 시드에 합치기"
```

---

## Task 4: 수동 검증 (개발 서버)

**Goal:** 실제 앱에서 일일노트 두 개 만들어 시드 동작을 확인. 자동 테스트로는 잡히지 않는 ProseMirror 렌더링 / IDB / 시리얼라이즈 통합 동작 검증.

**Files:** 없음 (검증 전용 태스크).

**Acceptance Criteria:**
- [ ] 어제 일일노트(예: 제목 = 어제 yyyy-mm-dd) 생성, 「체크리스트:」 헤더 + bulletList 가 자동으로 시드되는지 확인 (schedule 노트에 어제 일정이 있는 경우).
- [ ] 어제 노트에서 일부 항목 체크 / 일부 미체크로 둠.
- [ ] 오늘 일일노트(제목 = 오늘 yyyy-mm-dd) 생성. 시드 본문에 다음이 보이는지 확인:
  - schedule 노트의 오늘 일정 (있다면) 가 listItem 들 앞에.
  - 어제의 미체크 항목들이 그 뒤에. 어제 체크했던 항목은 없어야 함.
- [ ] 체크박스 UI 가 클릭 가능하고, 클릭하면 체크 상태가 바뀌고 페이지 새로고침 후에도 유지됨 (XML 라운드트립 검증).

**Verify:** 사용자가 dev 서버에서 직접 확인. 본 태스크는 자동 verify 명령 없음.

**Steps:**

- [ ] **Step 1: 개발 서버 실행**

```bash
cd app && npm run dev
```

브라우저에서 표시되는 로컬 URL 열기 (기본 `http://localhost:5173`).

- [ ] **Step 2: 어제 일일노트 시나리오 셋업**

a. 새 노트 작성 (홈 화면의 + 버튼). 자동 생성된 `yyyy-mm-dd HH:mm` 제목을 어제 날짜 `yyyy-mm-dd` 형식으로 변경 (예: 2026-05-23).
b. 빈 본문에 `체크리스트:` 헤더를 직접 추가 (또는 schedule 노트에 어제용 일정 라벨을 미리 추가해 두면 새 어제 노트 생성 시 자동 시드).
c. bulletList 로 항목 3 개 추가 — 1 개는 체크, 2 개는 미체크.

- [ ] **Step 3: 오늘 일일노트 생성**

a. + 버튼으로 새 노트 작성. 제목을 오늘 `yyyy-mm-dd` 로 변경 (자동 생성된 dateTime 제목에서 시간 부분 제거).
b. 본문 시드 확인:
   - 「체크리스트:」 헤더 paragraph 존재
   - 그 다음 bulletList 에 schedule 일정 (있다면) 먼저, 어제 미체크 항목 (체크 안 했던 2 개) 다음.
   - 어제 체크했던 1 개는 안 보여야 함.

- [ ] **Step 4: 체크박스 UI 라운드트립 검증**

a. 시드된 항목 중 하나를 클릭해서 체크.
b. 다른 노트로 이동 후 다시 오늘 노트로 복귀 → 체크 상태가 유지되어야 함 (XML 라운드트립).
c. 페이지 새로고침 → 체크 상태가 유지되어야 함 (IDB 영속).

- [ ] **Step 5: 어제 노트 없는 경우 동작 확인**

a. 새 노트 생성, 제목을 오늘에서 멀리 떨어진 미래 날짜 (예: 2027-01-01) 로 변경.
b. 어제 (2026-12-31) 노트가 없으므로 carryover 없음. schedule 도 없으면 빈 본문이어야 함.

- [ ] **Step 6: 결과 보고**

위 시나리오들이 모두 통과하면 사용자에게 보고. 통과 안 하는 게 있으면 어디서 어떻게 실패했는지 보고하고 추가 조사 필요.

본 태스크는 자동 verify 명령 없음 — 사용자가 시각적으로 확인하는 단계.
