# 노트 묶음 v2 — 타이틀 윈도우 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 노트 묶음 스택에 5칸 타이틀 윈도우(활성 위·아래 모두 표시), 숨김 카운트 배지, 더블탭 노트 열기, Ctrl+wheel 전역 플립, prefix 트리거(`Done:[ ]노트묶음:`), 슬라이드 flip 애니메이션을 추가한다.

**Architecture:** v1 구조(위젯 데코레이션 + 임베디드 TomboyEditor) 불변. `stackMath.ts` 를 윈도우 대수(`clampWindow`/`stepWindow`)로 재작성, `parser.ts` 의 키워드 인식만 완화, `NoteBundleStack.svelte` 레이아웃을 단일 keyed `{#each}` + flex `order` 트릭으로 재작업(콘텐츠 패널은 단일 인스턴스 유지 — 에디터 리마운트 없음). 플러그인/저장 경로/격벽/중첩 가드는 손대지 않는다.

**Tech Stack:** Svelte 5 runes, `svelte/animate` flip, TipTap 3 / ProseMirror, vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-note-bundle-v2-design.md` (v1: `2026-06-12-note-bundle-design.md`)

**브랜치:** `po` worktree (`.worktrees/po`), 커밋은 po 에 바로.

**⚠️ 이 컴포넌트의 3대 런타임 함정 (v1 에서 라이브 브라우저로만 발견됨 — 반드시 준수):**
1. Svelte 템플릿 이벤트 속성(`onclick` 등)은 document 루트 위임이라 격벽 stopPropagation 에 죽는다 → 스택 내부 인터랙션은 전부 기존 `direct` 액션으로 addEventListener.
2. setPointerCapture 중 파생 click 은 캡처 엘리먼트로 retarget → 탭/더블탭 판정은 pointerup 에서 수동.
3. `$effect` 가 자기 자신이 읽는 `$state` 를 쓰면 effect_update_depth_exceeded → `untrack()` 필수.

---

### Task 1: stackMath 윈도우 대수 재작성

**Goal:** `MAX_COLLAPSED_BARS`/`collapsedBarStart` 를 폐기하고 타이틀 윈도우 순수 함수(`windowWidth`/`clampWindow`/`stepWindow`/`initialWindow`)로 교체한다.

**Files:**
- Modify: `app/src/lib/editor/noteBundle/stackMath.ts`
- Test: `app/tests/unit/editor/noteBundle/stackMath.test.ts`

**Acceptance Criteria:**
- [ ] `clampWindow` 가 활성 위치를 [1, W-2] 로 강제하되 양 끝([0, N-W]) 클램프가 우선
- [ ] 아래 연속 스크롤 정상상태 = 활성 위 1 / 아래 3, 위 스크롤 = 위 3 / 아래 1
- [ ] broken 스킵 멀티 점프에도 prev/next 가시성 불변 유지
- [ ] N ≤ 5 면 start 항상 0 (전부 표시)
- [ ] `nextValidIndex` / `firstValidIndex` 시그니처·동작 불변
- [ ] `collapsedBarStart` 참조가 repo 에 남지 않음 (Task 3 전까지 NoteBundleStack 이 깨지므로, 이 태스크에서는 stackMath+테스트만 커밋하고 svelte-check 는 Task 3 후에 통과하면 됨 — vitest 는 stackMath/parser 테스트 파일 단위로 green)

**Verify:** `cd app && npx vitest run tests/unit/editor/noteBundle/stackMath.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 테스트 먼저 — 기존 stackMath.test.ts 전체 교체**

```ts
import { describe, it, expect } from 'vitest';
import {
	WINDOW_SIZE,
	windowWidth,
	clampWindow,
	stepWindow,
	initialWindow,
	firstValidIndex,
	nextValidIndex
} from '$lib/editor/noteBundle/stackMath.js';

const e = (broken: boolean) => ({ broken });

describe('windowWidth', () => {
	it('min(5, N)', () => {
		expect(WINDOW_SIZE).toBe(5);
		expect(windowWidth(0)).toBe(0);
		expect(windowWidth(3)).toBe(3);
		expect(windowWidth(5)).toBe(5);
		expect(windowWidth(12)).toBe(5);
	});
});

describe('clampWindow', () => {
	it('N ≤ W → 항상 0', () => {
		expect(clampWindow(3, 2, 4)).toBe(0);
		expect(clampWindow(0, 0, 5)).toBe(0);
		expect(clampWindow(0, 0, 1)).toBe(0);
	});
	it('활성 위치를 [1, W-2] 로 강제 (prev/next 가시)', () => {
		// N=10, W=5: start ∈ [active-3, active-1]
		expect(clampWindow(0, 7, 10)).toBe(4); // 점프: 아래로 당김
		expect(clampWindow(5, 2, 10)).toBe(1); // 점프: 위로 당김
		expect(clampWindow(2, 3, 10)).toBe(2); // 이미 유효 → 그대로 (최소 이동)
	});
	it('양 끝 고정이 우선', () => {
		expect(clampWindow(0, 0, 10)).toBe(0); // active=0: prev 없음
		expect(clampWindow(5, 9, 10)).toBe(5); // active=N-1: next 없음
		expect(clampWindow(9, 9, 10)).toBe(5); // maxStart=5 초과 클램프
	});
});

describe('stepWindow — eager 슬라이드 + 불변', () => {
	it('아래 연속 스크롤: 정상상태 active 위치 1 (위1/아래3)', () => {
		let start = 0;
		const seq: number[] = [];
		for (let a = 1; a <= 9; a++) {
			start = stepWindow(start, a, 1, 10);
			seq.push(start);
		}
		expect(seq).toEqual([0, 1, 2, 3, 4, 5, 5, 5, 5]);
	});
	it('위 연속 스크롤: 정상상태 active 위치 3 (위3/아래1)', () => {
		let start = 5;
		const seq: number[] = [];
		for (let a = 8; a >= 0; a--) {
			start = stepWindow(start, a, -1, 10);
			seq.push(start);
		}
		expect(seq).toEqual([5, 4, 3, 2, 1, 0, 0, 0, 0]);
	});
	it('broken 스킵 멀티 점프도 불변 유지', () => {
		// active 2 → 6 (3,4,5 broken 스킵)
		expect(stepWindow(1, 6, 1, 10)).toBe(3); // [3..7]: prev 5 ✓ next 7 ✓
	});
});

describe('initialWindow — 활성 위 1개', () => {
	it('마운트 초기값', () => {
		expect(initialWindow(0, 10)).toBe(0);
		expect(initialWindow(4, 10)).toBe(3);
		expect(initialWindow(9, 10)).toBe(5);
		expect(initialWindow(2, 4)).toBe(0); // N<5
	});
});

describe('nextValidIndex / firstValidIndex — v1 불변', () => {
	it('broken 건너뜀, 끝이면 from 유지', () => {
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

- [ ] **Step 2: 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/noteBundle/stackMath.test.ts`
Expected: FAIL — `windowWidth` 등 export 없음

- [ ] **Step 3: stackMath.ts 전체 교체**

```ts
/** 노트 묶음 스택 인덱스 계산 — 순수 함수. */
export const WINDOW_SIZE = 5;

/** 타이틀 윈도우 폭 = min(5, N). */
export function windowWidth(n: number): number {
	return Math.min(WINDOW_SIZE, Math.max(0, n));
}

function clamp(x: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, x));
}

/**
 * 불변 강제 클램프 — active 의 prev/next 가 윈도우 안에 들어오도록 start 를
 * 최소 이동. 활성 윈도우 내 위치 ∈ [1, W-2], 단 양 끝([0, N-W]) 고정이 우선.
 * 점프(바 탭 / 외부 라디오 변경 / 항목 수 변화)에 그대로 사용.
 */
export function clampWindow(start: number, active: number, n: number): number {
	const w = windowWidth(n);
	if (n <= w) return 0;
	const s = clamp(start, active - (w - 2), active - 1);
	return clamp(s, 0, n - w);
}

/**
 * 한 칸 이동: eager 슬라이드 1 + 불변 클램프.
 * 내려갈 땐 정상상태 위1/아래3, 올라갈 땐 위3/아래1 — 진행 방향이 미리 보인다.
 * nextActive 가 broken 스킵으로 여러 칸 점프해도 클램프가 따라잡는다.
 */
export function stepWindow(start: number, nextActive: number, dir: 1 | -1, n: number): number {
	return clampWindow(start + dir, nextActive, n);
}

/** 마운트 초기 윈도우 — 활성 위 1개. */
export function initialWindow(active: number, n: number): number {
	return clamp(active - 1, 0, Math.max(0, n - windowWidth(n)));
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

- [ ] **Step 4: 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/noteBundle/stackMath.test.ts`
Expected: PASS (이 파일만; NoteBundleStack 는 Task 3 에서 따라옴 — `npm run check` 는 아직 돌리지 말 것)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/noteBundle/stackMath.ts app/tests/unit/editor/noteBundle/stackMath.test.ts
git commit -m "feat(noteBundle): rewrite stackMath as title-window algebra (clampWindow/stepWindow)"
```

---

### Task 2: parser prefix 트리거 완화

**Goal:** `[ ]노트 묶음:` 앞에 `:` 로 끝나는 prefix 텍스트(`Done:`, `A:B:`)를 허용한다 — 체크박스가 첫 자식이어야 한다는 제약 제거.

**Files:**
- Modify: `app/src/lib/editor/noteBundle/parser.ts` (`parseKeywordParagraph` 만)
- Test: `app/tests/unit/editor/noteBundle/parser.test.ts` (케이스 추가)

**Acceptance Criteria:**
- [ ] `Done:[ ]노트 묶음:30` 인식, digits 범위가 정확히 "30" (prefix 길이 반영)
- [ ] `A:B:[ ]노트묶음:` 인식 (다중 세그먼트)
- [ ] `메모 [ ]노트묶음:` 미인식 (`:` 로 안 끝남)
- [ ] `[x]Done:[ ]노트묶음:` → 두 번째 체크박스 채택 (`checked` = 두 번째 것)
- [ ] prefix 에 marks(bold) 있어도 인식
- [ ] 기존 parser 테스트 전부 그대로 통과 (빈 prefix 경로 불변, index 0 제외 유지)

**Verify:** `cd app && npx vitest run tests/unit/editor/noteBundle/parser.test.ts` → all pass

**Steps:**

- [ ] **Step 1: 테스트 추가 — parser.test.ts 의 `describe('parseNoteBundles', …)` 안에 추가**

기존 빌더 옆에 prefix 빌더 추가 (`kw` 빌더 아래):

```ts
/** prefix 텍스트(체크박스 앞) 포함 키워드 라인. nodes 로 임의 inline 배열도 허용 */
const kwWith = (nodes: object[]) => ({ type: 'paragraph', content: nodes });
const cb = (checked = false) => ({ type: 'inlineCheckbox', attrs: { checked } });
const txt = (text: string, marks?: object[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
```

테스트 케이스:

```ts
	it('prefix 트리거: Done:[ ]노트 묶음:30 — digits 오프셋 prefix 반영', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kwWith([txt('Done:'), cb(true), txt('노트 묶음:30')]),
				list(li('노트A', null))
			)
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(1);
		expect(bundles[0].checked).toBe(true);
		expect(bundles[0].heightPct).toBe(30);
		expect(ed.state.doc.textBetween(bundles[0].digitsFrom, bundles[0].digitsTo)).toBe('30');
	});

	it('prefix 다중 세그먼트 A:B: 인식, 콜론 없는 prefix 미인식', () => {
		const ok = makeEditor(
			doc(titleLine('호스트'), kwWith([txt('A:B:'), cb(), txt('노트묶음:')]), list(li('노트A', null)))
		);
		expect(parseNoteBundles(ok.state.doc)).toHaveLength(1);
		ok.destroy();
		const bad = makeEditor(
			doc(titleLine('호스트'), kwWith([txt('메모 '), cb(), txt('노트묶음:')]), list(li('노트A', null)))
		);
		expect(parseNoteBundles(bad.state.doc)).toHaveLength(0);
	});

	it('체크박스 2개 라인: 키워드 앞 체크박스 채택', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kwWith([cb(true), txt('Done:'), cb(false), txt('노트묶음:')]),
				list(li('노트A', null))
			)
		);
		const bundles = parseNoteBundles(ed.state.doc);
		expect(bundles).toHaveLength(1);
		expect(bundles[0].checked).toBe(false); // 두 번째 체크박스
		// checkboxPos 가 두 번째 체크박스를 가리킴: 토글 시 그 노드가 inlineCheckbox 여야 함
		expect(ed.state.doc.nodeAt(bundles[0].checkboxPos)?.type.name).toBe('inlineCheckbox');
		expect(ed.state.doc.nodeAt(bundles[0].checkboxPos)?.attrs.checked).toBe(false);
	});

	it('marks 있는 prefix 도 인식', () => {
		const ed = makeEditor(
			doc(
				titleLine('호스트'),
				kwWith([txt('Done:', [{ type: 'bold' }]), cb(), txt('노트묶음:')]),
				list(li('노트A', null))
			)
		);
		expect(parseNoteBundles(ed.state.doc)).toHaveLength(1);
	});
```

주의: `makeEditor` 는 `currentEditor` 전역을 덮어쓰므로 한 테스트에서 에디터 2개를 만들면 첫 번째는 직접 `destroy()` 호출 (위 두 번째 케이스처럼).

- [ ] **Step 2: 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/noteBundle/parser.test.ts`
Expected: 새 케이스 4개 FAIL (prefix 라인 미인식), 기존 케이스 PASS

- [ ] **Step 3: parser.ts — `parseKeywordParagraph` 교체**

기존 `parseKeywordParagraph` 함수를 다음 두 함수로 교체 (다른 부분 불변):

```ts
function keywordAfterCheckbox(
	para: PMNode,
	paraPos: number,
	cbIndex: number,
	checkboxPos: number
): KeywordInfo | null {
	const cb = para.child(cbIndex);
	let text = '';
	for (let i = cbIndex + 1; i < para.childCount; i++) {
		const c = para.child(i);
		if (!c.isText) return null;
		text += c.text ?? '';
	}
	const m = KEYWORD_RE.exec(text);
	if (!m) return null;
	const colonIdx = text.indexOf(':');
	const digitsLen = m[1]?.length ?? 0;
	// 키워드 텍스트 시작 abs pos = 체크박스 pos + nodeSize(1)
	const textBase = checkboxPos + 1;
	return {
		checkboxPos,
		checked: cb.attrs.checked === true,
		heightPct: m[1] ? clampHeightPct(parseInt(m[1], 10)) : DEFAULT_HEIGHT_PCT,
		digitsFrom: textBase + colonIdx + 1,
		digitsTo: textBase + colonIdx + 1 + digitsLen,
		keywordEnd: paraPos + para.nodeSize
	};
}

function parseKeywordParagraph(para: PMNode, paraPos: number): KeywordInfo | null {
	if (para.childCount < 2) return null;
	// prefix(체크박스 앞 텍스트)가 trim 후 비었거나 ':' 로 끝나고, 뒤따르는
	// 텍스트가 KEYWORD_RE 에 매칭되는 첫 inlineCheckbox 를 찾는다 —
	// `Done:[ ]노트 묶음:` 같은 TODO/Process prefix 조합 허용.
	// atom(앞쪽의 다른 체크박스 등)은 prefix 텍스트에 기여하지 않는다.
	let prefix = '';
	let offset = 0;
	for (let i = 0; i < para.childCount; i++) {
		const child = para.child(i);
		if (child.type.name === 'inlineCheckbox') {
			const trimmed = prefix.trim();
			if (trimmed === '' || trimmed.endsWith(':')) {
				const info = keywordAfterCheckbox(para, paraPos, i, paraPos + 1 + offset);
				if (info) return info;
			}
		}
		if (child.isText) prefix += child.text ?? '';
		offset += child.nodeSize;
	}
	return null;
}
```

파일 헤더 주석의 트리거 설명도 갱신: `` `[ ]노트 묶음:N` `` → `` `[prefix:]<체크박스>노트 묶음:N` (prefix 는 비었거나 ':' 로 끝나는 텍스트) ``.

- [ ] **Step 4: 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/noteBundle/parser.test.ts`
Expected: PASS 전체 (기존 + 신규)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/noteBundle/parser.ts app/tests/unit/editor/noteBundle/parser.test.ts
git commit -m "feat(noteBundle): allow ':'-suffixed prefix before bundle trigger (Done:[ ]노트묶음:)"
```

---

### Task 3: NoteBundleStack 타이틀 윈도우 레이아웃 재작업

**Goal:** 스택 레이아웃을 5칸 타이틀 윈도우(상·하 분할)로 재작업 — 배지, 더블탭 열기, Ctrl+wheel 전역 플립, flip 애니메이션 포함. 임베디드 에디터 로드/저장/격벽 코드는 불변.

**Files:**
- Modify: `app/src/lib/editor/noteBundle/NoteBundleStack.svelte`

**Acceptance Criteria:**
- [ ] 윈도우 5칸: 상단 바들 + 활성 바 + 콘텐츠 + 하단 바들 + 리사이즈 핸들 순
- [ ] 휠/스와이프 정상상태: 내려갈 때 위1/아래3, 올라갈 때 위3/아래1, 양 끝 고정
- [ ] 최상단 바 `+{위 숨김}`, 최하단 바 `+{아래 숨김}` 배지 (0이면 없음), 타이틀 ellipsis 유지
- [ ] 바 더블탭/더블클릭(<300ms, 같은 바) → `oninternallink(title)` (broken 무시)
- [ ] Ctrl(또는 Cmd)+wheel 이 스택 어디서든(콘텐츠 위 포함) 플립 + 브라우저 줌 차단
- [ ] 일반 wheel: 바 위 = 플립, 콘텐츠 위 = 임베디드 스크롤 (v1 유지)
- [ ] 윈도우 슬라이드 시 바 `animate:flip` 150ms
- [ ] 임베디드 에디터(.bundle-body) 단일 인스턴스 — 플립 중 리마운트 없음
- [ ] 윈도우 follow `$effect` 는 `untrack` 사용 — effect_update_depth 콘솔 에러 없음
- [ ] 모든 인터랙션은 `direct` 액션 (Svelte 템플릿 이벤트 속성 금지)

**Verify:** `cd app && npm run check` → noteBundle 관련 에러 0; `npx vitest run tests/unit/editor/noteBundle/` → 전부 PASS

**Steps:**

- [ ] **Step 1: script 변경**

(1) import 교체/추가:

```ts
import { onMount, onDestroy, untrack } from 'svelte';
import { flip } from 'svelte/animate';
import {
	windowWidth,
	clampWindow,
	stepWindow,
	initialWindow,
	firstValidIndex,
	nextValidIndex
} from './stackMath.js';
```

(`collapsedBarStart` import 제거.)

(2) 파일 상단 주석 갱신: "접힌 제목 바(≤4) + 펼친 노트" → "5칸 타이틀 윈도우(활성 위·아래) + 펼친 노트". 격벽/전체 교체 계약 설명 유지.

(3) `k`/`expanded` derived 는 유지, `barStart`/`bars` derived 를 삭제하고 윈도우 상태로 교체:

```ts
// --- 타이틀 윈도우 ---------------------------------------------------------
// winStart 는 컴포넌트 로컬 — 영속 안 함 (라디오=활성만 영속).
let winStart = $state(0);
let winInit = false;
let lastK = -1;
/** step() 이 기록한 직전 이동 방향 — follow effect 가 1회 소비 */
let pendingDir: 1 | -1 | null = null;

// k(활성)·N 변화를 따라 윈도우를 이동. winStart 를 읽고 쓰므로 untrack 필수
// (effect_update_depth 함정 — feedback_svelte_effect_store_mutator_loop).
$effect(() => {
	const n = resolved.length;
	const kk = k;
	untrack(() => {
		const dir = pendingDir;
		pendingDir = null;
		if (kk < 0) {
			lastK = kk;
			winInit = false;
			return;
		}
		if (!winInit) {
			winStart = initialWindow(kk, n);
			winInit = true;
		} else if (kk !== lastK && dir !== null) {
			winStart = stepWindow(winStart, kk, dir, n);
		} else {
			winStart = clampWindow(winStart, kk, n);
		}
		lastK = kk;
	});
});

const W = $derived(windowWidth(resolved.length));
const winEntries = $derived(resolved.slice(winStart, winStart + W));
const hiddenAbove = $derived(winStart);
const hiddenBelow = $derived(Math.max(0, resolved.length - (winStart + W)));
```

(4) `step` 에 pendingDir 기록 (moveTo 는 불변):

```ts
function step(dir: 1 | -1) {
	if (k < 0) return;
	const target = nextValidIndex(resolved, k, dir);
	if (target === k) return;
	pendingDir = dir;
	moveTo(target);
}
```

(5) wheel 핸들러 교체 — `handleBarsWheel` 을 분리:

```ts
let wheelAcc = 0;
function flipWheel(e: WheelEvent) {
	e.preventDefault(); // ctrl+wheel 브라우저 줌 차단 겸용
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
	wheelAcc = Math.max(-49, Math.min(49, wheelAcc));
}
function handleListWheel(e: Event) {
	const we = e as WheelEvent;
	if (we.ctrlKey || we.metaKey) {
		flipWheel(we);
		return;
	}
	// 콘텐츠 위 일반 wheel = 임베디드 스크롤 그대로
	if ((we.target as HTMLElement).closest?.('.bundle-body')) return;
	flipWheel(we);
}
/** 루트 폴백 — 리사이즈 핸들 등 .bundle-list 밖에서의 ctrl+wheel.
 *  바/콘텐츠 위 ctrl+wheel 은 handleListWheel 이 stopPropagation 으로 선점. */
function handleRootWheel(e: Event) {
	const we = e as WheelEvent;
	if (we.ctrlKey || we.metaKey) flipWheel(we);
}
```

(6) 포인터 핸들러 교체 — 바 판정 + 더블탭:

```ts
let swipeY: number | null = null;
let downBarIdx: number | null = null;
let downBarY = 0;
let swiped = false;
let lastTapIdx: number | null = null;
let lastTapTime = 0;

function handleListPointerDown(e: PointerEvent) {
	const t = e.target as HTMLElement;
	if (t.closest?.('.bundle-body')) return; // 임베디드 에디터 — 손대지 않음
	const bar = t.closest?.('.bundle-bar') as HTMLElement | null;
	if (!bar) return;
	swipeY = e.clientY;
	downBarY = e.clientY;
	swiped = false;
	downBarIdx = bar.dataset.idx != null ? Number(bar.dataset.idx) : null;
	try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
}
function handleListPointerMove(e: PointerEvent) {
	if (swipeY === null) return;
	const dy = e.clientY - swipeY;
	if (Math.abs(dy) >= 30) {
		swiped = true;
		step(dy < 0 ? 1 : -1); // 위로 끌면 다음 파일철
		swipeY = e.clientY;
	}
}
function handleListPointerUp(e: Event) {
	const pe = e as PointerEvent;
	// 캡처가 click 을 컨테이너로 retarget 하므로 click/dblclick 대신
	// pointerup 에서 탭·더블탭을 수동 판정한다.
	if (!swiped && downBarIdx !== null && Math.abs(pe.clientY - downBarY) < 8) {
		const now = performance.now();
		if (lastTapIdx === downBarIdx && now - lastTapTime < 300) {
			const entry = resolved[downBarIdx];
			if (entry && !entry.broken) oninternallink?.(entry.title);
			lastTapIdx = null;
		} else {
			moveTo(downBarIdx);
			lastTapIdx = downBarIdx;
			lastTapTime = now;
		}
	}
	swipeY = null;
	downBarIdx = null;
}
```

(기존 `handleBarsWheel`/`handleBarsPointerDown`/`handleBarsPointerMove`/`handleBarsPointerUp` 제거.)

- [ ] **Step 2: 템플릿 교체** — `{#if resolved.length === 0}` 분기 내부의 `.bundle-bars` + body 블록을 단일 `.bundle-list` 로:

```svelte
<div class="bundle-stack" bind:this={rootEl} style:height={`${stackH}px`} use:direct={{ wheel: handleRootWheel }}>
	{#if resolved.length === 0}
		<div class="bundle-empty">묶을 노트 없음</div>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="bundle-list"
			use:direct={{
				wheel: handleListWheel,
				pointerdown: handleListPointerDown as (e: Event) => void,
				pointermove: handleListPointerMove as (e: Event) => void,
				pointerup: handleListPointerUp,
				pointercancel: handleListPointerUp
			}}
		>
			{#each winEntries as e, i (e.originalIndex)}
				<!-- animate:flip 은 keyed each 직계 자식이어야 한다 → 활성도 button 으로 통일 -->
				<button
					type="button"
					class="bundle-bar"
					class:broken={e.broken}
					class:expanded-bar={winStart + i === k}
					data-idx={winStart + i}
					style:order={i * 2}
					animate:flip={{ duration: 150 }}
				>
					<span class="bar-title">{e.title}</span>
					{#if i === 0 && hiddenAbove > 0}
						<span class="bar-badge">+{hiddenAbove}</span>
					{:else if i === winEntries.length - 1 && hiddenBelow > 0}
						<span class="bar-badge">+{hiddenBelow}</span>
					{/if}
				</button>
			{/each}
			{#if expanded && editorContent && loadedGuid}
				<div class="bundle-body" style:order={(k - winStart) * 2 + 1}>
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
				<div class="bundle-empty" style:order={(k - winStart) * 2 + 1}>로딩…</div>
			{:else}
				<div class="bundle-empty">펼칠 수 있는 노트 없음</div>
			{/if}
		</div>
	{/if}
	<!-- 리사이즈 핸들 블록 불변 -->
	…
</div>
```

콘텐츠 패널은 each **바깥** 단일 요소 — flex `order` 로 활성 바 바로 아래 배치 (에디터 리마운트 방지).

- [ ] **Step 3: CSS 교체** — `.bundle-bars` 룰 삭제, 추가/수정:

```css
.bundle-list {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
}
.bundle-bar {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	border: none;
	border-bottom: 1px solid #1a1a1a;
	padding: clamp(4px, 1vw, 6px) clamp(8px, 2vw, 12px);
	background: #2a2a2a;
	color: #eee;
	font-size: 0.85rem;
	font-weight: 500;
	cursor: pointer;
	touch-action: none; /* 바에서 시작한 스와이프가 pointercancel 로 죽지 않게 */
	user-select: none;
}
.bar-title {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	text-align: left;
}
.bar-badge {
	flex-shrink: 0;
	color: #999;
	font-size: 0.75rem;
}
.bundle-bar.broken { color: #777; cursor: default; }
.bundle-bar.expanded-bar { background: #2d5a3d; cursor: grab; }
```

(`.bundle-body` / `.bundle-empty` / `.bundle-resize` 룰 불변. 기존 `.bundle-bar` 의 `display:block`/`text-align`/`overflow`/`ellipsis`/`white-space` 는 `.bar-title` 로 이동했음에 주의.)

- [ ] **Step 4: 검증**

Run: `cd app && npm run check`
Expected: noteBundle 관련 에러 0 (repo 기존 에러 수 변화 없음)

Run: `cd app && npx vitest run tests/unit/editor/noteBundle/`
Expected: 전부 PASS (plugin 테스트는 컴포넌트 마운트 안 하므로 영향 없음)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/noteBundle/NoteBundleStack.svelte
git commit -m "feat(noteBundle): title window layout — badges, double-tap open, ctrl+wheel, flip animation"
```

---

### Task 4: 가이드 카드 갱신 + 전체 검증

**Goal:** 설정 → 가이드 → 에디터 탭의 노트 묶음 카드를 v2 동작(타이틀 윈도우, prefix, 더블클릭, ctrl+wheel)으로 갱신하고 전체 테스트를 돌린다.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (노트 묶음 guide-card, 현재 2313–2332행)

**Acceptance Criteria:**
- [ ] 카드에 타이틀 윈도우(위·아래, 항상 5개) 설명
- [ ] prefix 문법 (`Done:[ ]노트 묶음:`) 안내 + 스니펫 예시
- [ ] 더블클릭/더블탭 열기, Ctrl+휠 안내
- [ ] `cd app && npx vitest run` 전체 green (기존 실패 0 기준)
- [ ] `npm run check` noteBundle 관련 에러 0

**Verify:** `cd app && npx vitest run` → 전체 PASS

**Steps:**

- [ ] **Step 1: guide-card 의 `<ul class="guide-list">` 항목 교체**

기존 `<li>제목 바는 최대 5개 — 휠/스와이프로 파일철 넘기듯 이동</li>` 를 다음으로 교체하고, 그 아래에 신규 항목 3개 추가:

```html
<li>제목 바는 항상 5개(노트가 적으면 전부) — 활성 노트 위·아래로 나뉘어 표시, 가장자리 바에 +N 으로 숨은 노트 수 표시</li>
<li>휠/스와이프 = 파일철 넘기기. Ctrl(⌘)+휠은 묶음 안 어디서든 동작</li>
<li>제목 바 더블클릭(더블탭) = 그 노트를 단독으로 열기</li>
<li>"할일:" 처럼 ':' 로 끝나는 글을 키워드 앞에 붙일 수 있음 — 예: Done:[ ]노트 묶음:</li>
```

- [ ] **Step 2: 전체 검증**

Run: `cd app && npx vitest run`
Expected: 전체 PASS

Run: `cd app && npm run check`
Expected: noteBundle/settings 관련 신규 에러 0

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(guide): note bundle v2 — title window, prefix trigger, double-tap, ctrl+wheel"
```

---

## 플랜 후 검증 (태스크 외)

브라우저 스모크 — fake host mode + 네트워크 차단 (`/tmp/nb-verify/h.js` 패턴, `project_notebundle_editor_in_editor` 메모리 레시피):
윈도우 슬라이드(아래 위1/아래3 · 위 위3/아래1), 배지 숫자, 더블탭 열기, ctrl+wheel(콘텐츠 위 포함), prefix 트리거(`Done:[ ]노트묶음:`), flip 애니메이션, 임베디드 편집·저장 회귀, effect_update_depth 콘솔 에러 없음.
