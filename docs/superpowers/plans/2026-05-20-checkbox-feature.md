# 체크박스(체크리스트) 기능 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `체크리스트:` 헤더 줄 다음의 리스트 항목을 클릭 가능한 체크박스로 표시하고, 체크 상태를 `.note` XML 에 `[ ]`/`[X]` 마커로 저장한다.

**Architecture:** 라이브 ProseMirror 문서에서 체크 상태는 `listItem.checked` 불리언 속성으로 산다. `noteContentArchiver.ts` 가 `.note` XML 직렬화 시 체크리스트 영역 항목에 `[ ]`/`[X]` 텍스트 마커를 합성하고, 역직렬화 시 떼어내며 `checked` 를 설정한다. 데코레이션 전용 ProseMirror 플러그인이 영역 항목마다 불릿을 숨기고 체크박스 위젯을 그린다. 기존 `todoRegion`/`autoWeekday` 모듈 구조를 미러링한다.

**Tech Stack:** SvelteKit · Svelte 5 · TipTap 3 (ProseMirror) · TypeScript · vitest

설계 문서: `docs/superpowers/specs/2026-05-20-checkbox-feature-design.md`

---

### Task 1: 체크리스트 데이터 모델 — 영역 감지 + `checked` 속성

**Goal:** 체크리스트 영역/항목을 감지하는 순수 함수 모듈과, `listItem` 의 `checked` 스키마 속성을 만든다.

**Files:**
- Create: `app/src/lib/editor/checklist/regions.ts`
- Modify: `app/src/lib/editor/extensions/TomboyListItem.ts`
- Test: `app/tests/unit/editor/checklistRegions.test.ts`

**Acceptance Criteria:**
- [ ] `isChecklistHeaderText` 가 `체크리스트:`, `  체크리스트: 장보기 ` 는 true, `체크리스트`(콜론 없음)·`TODO`·`할일` 은 false 를 반환한다.
- [ ] `findChecklistRegions` 가 헤더 다음의 연속 리스트를 한 영역으로 묶고, 제목 줄은 헤더로 보지 않으며, 리스트 없는 헤더는 영역에서 제외한다.
- [ ] `findChecklistItems` 가 중첩 항목을 깊이 제한 없이 모두 수집하고, 각 항목의 `checked` 를 `listItem.attrs.checked` 에서 읽는다.
- [ ] `TomboyListItem` 이 `checked` 속성을 가져 `setContent` → `getJSON` 라운드트립에서 값이 보존된다.

**Verify:** `cd app && npm run test -- checklistRegions` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: `checked` 속성을 `TomboyListItem` 에 추가**

`app/src/lib/editor/extensions/TomboyListItem.ts` 의 `addAttributes` 반환 객체에 `checked` 를 추가한다. 기존 `tomboyTrailingNewline` 바로 다음에:

```ts
export const TomboyListItem = ListItem.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			tomboyTrailingNewline: {
				default: null,
				rendered: false
			},
			checked: {
				// 체크리스트 항목의 완료 여부. 체크리스트 영역 밖의 일반
				// 리스트 항목에서는 의미 없이 false 로 남는다. 화면 표시는
				// checklist 플러그인이 데코레이션으로 처리하므로 DOM 에
				// 렌더링하지 않는다(rendered: false).
				default: false,
				rendered: false
			}
		};
	}
});
```

- [ ] **Step 2: `checklistRegions.test.ts` 작성 (failing tests)**

`app/tests/unit/editor/checklistRegions.test.ts` 를 생성한다. `todoRegion.test.ts` 의 헬퍼 패턴을 미러링한다:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import {
	isChecklistHeaderText,
	findChecklistRegions,
	findChecklistItems,
	findChecklistItemAt
} from '$lib/editor/checklist/regions.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(doc: JSONContent): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem
		],
		content: doc
	});
	currentEditor = editor;
	return editor;
}

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});
const LI = (text: string, checked = false): JSONContent => ({
	type: 'listItem',
	attrs: { checked },
	content: [P(text)]
});
const UL = (...items: JSONContent[]): JSONContent => ({
	type: 'bulletList',
	content: items
});

describe('isChecklistHeaderText', () => {
	it('accepts 체크리스트: with and without trailing description', () => {
		expect(isChecklistHeaderText('체크리스트:')).toBe(true);
		expect(isChecklistHeaderText('  체크리스트: 장보기 ')).toBe(true);
		expect(isChecklistHeaderText('체크리스트:2026 목표')).toBe(true);
	});
	it('rejects missing colon and unrelated headers', () => {
		expect(isChecklistHeaderText('체크리스트')).toBe(false);
		expect(isChecklistHeaderText('체크리스트입니다')).toBe(false);
		expect(isChecklistHeaderText('TODO')).toBe(false);
		expect(isChecklistHeaderText('할일')).toBe(false);
	});
});

describe('findChecklistRegions', () => {
	it('returns empty when there is no header', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), P('본문')] });
		expect(findChecklistRegions(e.state.doc)).toHaveLength(0);
	});
	it('finds a 체크리스트: header followed by a list', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트: 장보기'), UL(LI('우유'), LI('빵'))]
		});
		const regions = findChecklistRegions(e.state.doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].lists).toHaveLength(1);
	});
	it('merges consecutive lists into one region', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), UL(LI('a')), UL(LI('b'))]
		});
		expect(findChecklistRegions(e.state.doc)[0].lists).toHaveLength(2);
	});
	it('rejects a header with no following list', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), P('그냥 글')]
		});
		expect(findChecklistRegions(e.state.doc)).toHaveLength(0);
	});
	it('never treats the title paragraph as a header', () => {
		const e = makeEditor({ type: 'doc', content: [P('체크리스트:'), UL(LI('a'))] });
		expect(findChecklistRegions(e.state.doc)).toHaveLength(0);
	});
});

describe('findChecklistItems', () => {
	it('collects depth-1 items with their checked state', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				P('체크리스트:'),
				UL(LI('우유', false), LI('빵', true))
			]
		});
		const items = findChecklistItems(findChecklistRegions(e.state.doc));
		expect(items).toHaveLength(2);
		expect(items.map((it) => it.checked)).toEqual([false, true]);
		expect(items.map((it) => it.liNode.firstChild!.textContent)).toEqual([
			'우유',
			'빵'
		]);
	});
	it('collects nested items at any depth', () => {
		const nested: JSONContent = {
			type: 'listItem',
			attrs: { checked: false },
			content: [P('상위'), UL(LI('하위1'), LI('하위2', true))]
		};
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), UL(nested)]
		});
		const items = findChecklistItems(findChecklistRegions(e.state.doc));
		// 상위 + 하위1 + 하위2 = 3
		expect(items).toHaveLength(3);
		expect(items.some((it) => it.checked)).toBe(true);
	});
	it('findChecklistItemAt returns the item at a liPos, null otherwise', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), UL(LI('우유'))]
		});
		const items = findChecklistItems(findChecklistRegions(e.state.doc));
		expect(findChecklistItemAt(items, items[0].liPos)).toBe(items[0]);
		expect(findChecklistItemAt(items, 0)).toBeNull();
	});
});

describe('TomboyListItem checked attribute', () => {
	it('survives setContent → getJSON', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), UL(LI('우유', true))]
		});
		const json = e.getJSON();
		const li = json.content![2].content![0];
		expect(li.attrs!.checked).toBe(true);
	});
});
```

- [ ] **Step 3: 테스트 실행 → 실패 확인**

Run: `cd app && npm run test -- checklistRegions`
Expected: FAIL — `regions.js` 가 없어서 import 에러.

- [ ] **Step 4: `regions.ts` 구현**

`app/src/lib/editor/checklist/regions.ts` 를 생성한다:

```ts
/**
 * 체크리스트 영역 감지.
 *
 * "체크리스트:" 로 시작하는 최상위 문단(제목 줄 제외)이 헤더이고, 그 바로
 * 다음에 오는 1개 이상의 연속된 리스트 블록이 그 영역의 리스트가 된다.
 * 구조는 todoRegion/regions.ts 의 findTodoRegions 를 미러링한다.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

/** "체크리스트:" 로 시작하면 true (콜론 필수, 앞뒤 공백 무시). */
export function isChecklistHeaderText(text: string): boolean {
	return /^체크리스트:/.test(text.trim());
}

export interface ChecklistRegionList {
	/** 리스트 노드의 절대 위치(여는 토큰). */
	pos: number;
	node: PMNode;
	/** 문서 최상위 자식 중 인덱스. */
	childIndex: number;
}

export interface ChecklistRegion {
	/** 헤더 문단 노드의 절대 위치. */
	headerPos: number;
	headerChildIndex: number;
	/** 영역을 이루는 연속 리스트 블록 (항상 >= 1). */
	lists: ChecklistRegionList[];
}

export function findChecklistRegions(doc: PMNode): ChecklistRegion[] {
	const regions: ChecklistRegion[] = [];
	const childCount = doc.childCount;
	if (childCount === 0) return regions;

	const positions: number[] = [];
	let offset = 0;
	doc.forEach((child) => {
		positions.push(offset);
		offset += child.nodeSize;
	});

	let i = 1; // 제목(0번) 건너뜀
	while (i < childCount) {
		const child = doc.child(i);
		if (child.type.name !== 'paragraph') {
			i++;
			continue;
		}
		if (!isChecklistHeaderText(child.textContent)) {
			i++;
			continue;
		}

		const lists: ChecklistRegionList[] = [];
		let j = i + 1;
		while (j < childCount) {
			const c = doc.child(j);
			const name = c.type.name;
			if (name === 'bulletList' || name === 'orderedList') {
				lists.push({ pos: positions[j], node: c, childIndex: j });
				j++;
			} else {
				break;
			}
		}

		if (lists.length > 0) {
			regions.push({
				headerPos: positions[i],
				headerChildIndex: i,
				lists
			});
			i = j;
		} else {
			i++;
		}
	}

	return regions;
}

/**
 * 영역 안의 모든 listItem (중첩 포함, 깊이 제한 없음).
 *
 * `contentStart` 는 항목 첫 문단의 내용 시작 위치 = liPos + 2
 * (listItem 여는 토큰 +1, 첫 문단 여는 토큰 +1). 첫 자식이 문단인
 * listItem 만 항목으로 본다 (정상 listItem 은 항상 그렇다).
 */
export interface ChecklistItemRef {
	/** listItem 노드의 절대 위치(여는 토큰 앞). */
	liPos: number;
	liNode: PMNode;
	/** 첫 문단 내용 시작 위치 = liPos + 2. */
	contentStart: number;
	checked: boolean;
}

export function findChecklistItems(
	regions: ChecklistRegion[]
): ChecklistItemRef[] {
	const items: ChecklistItemRef[] = [];
	for (const region of regions) {
		for (const list of region.lists) {
			collectChecklistItems(list.node, list.pos, items);
		}
	}
	return items;
}

function collectChecklistItems(
	listNode: PMNode,
	listPos: number,
	out: ChecklistItemRef[]
): void {
	// listPos 는 리스트 노드 위치 → +1 이 첫 listItem 위치.
	let offset = listPos + 1;
	listNode.forEach((li) => {
		if (li.type.name === 'listItem') {
			const liPos = offset;
			const firstChild = li.firstChild;
			if (firstChild && firstChild.type.name === 'paragraph') {
				out.push({
					liPos,
					liNode: li,
					contentStart: liPos + 2,
					checked: li.attrs?.checked === true
				});
			}
			// 이 listItem 안의 중첩 리스트로 재귀.
			let inLiOffset = liPos + 1;
			li.forEach((sub) => {
				if (
					sub.type.name === 'bulletList' ||
					sub.type.name === 'orderedList'
				) {
					collectChecklistItems(sub, inLiOffset, out);
				}
				inLiOffset += sub.nodeSize;
			});
		}
		offset += li.nodeSize;
	});
}

export function findChecklistItemAt(
	items: ChecklistItemRef[],
	liPos: number
): ChecklistItemRef | null {
	for (const it of items) {
		if (it.liPos === liPos) return it;
	}
	return null;
}
```

- [ ] **Step 5: 테스트 실행 → 통과 확인**

Run: `cd app && npm run test -- checklistRegions`
Expected: PASS — 모든 테스트 통과.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/checklist/regions.ts \
        app/src/lib/editor/extensions/TomboyListItem.ts \
        app/tests/unit/editor/checklistRegions.test.ts
git commit -m "feat(checklist): 영역 감지 모듈 + listItem checked 속성"
```

---

### Task 2: 아카이버 마커 합성 — `.note` XML ↔ JSON 라운드트립

**Goal:** `noteContentArchiver.ts` 가 직렬화 시 체크리스트 영역 항목에 `[ ]`/`[X]` 마커를 붙이고, 역직렬화 시 떼어내며 `checked` 를 설정하게 한다.

**Files:**
- Modify: `app/src/lib/core/noteContentArchiver.ts`
- Test: `app/tests/unit/editor/checklistArchiver.test.ts`

**Acceptance Criteria:**
- [ ] `serializeContent` 가 `체크리스트:` 영역의 listItem 을 `checked` 에 따라 `[X] `/`[ ] ` 접두 마커와 함께 직렬화한다 (중첩 항목 포함).
- [ ] `deserializeContent` 가 영역 항목 첫 문단의 `[ ]`/`[x]`/`[X]` 마커를 떼고 `attrs.checked` 를 설정한다.
- [ ] 체크리스트 영역 XML 의 XML→JSON→XML 라운드트립이 바이트 동일하다.
- [ ] 체크리스트 영역 **밖**의 일반 리스트는 마커 변환을 거치지 않아 라운드트립이 종전과 동일하다.

**Verify:** `cd app && npm run test -- checklistArchiver` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: `checklistArchiver.test.ts` 작성 (failing tests)**

`app/tests/unit/editor/checklistArchiver.test.ts` 를 생성한다:

```ts
import { describe, it, expect } from 'vitest';
import {
	deserializeContent,
	serializeContent
} from '$lib/core/noteContentArchiver.js';

/** note-content 래퍼로 감싼다. */
const wrap = (inner: string) =>
	`<note-content version="0.1">${inner}</note-content>`;

describe('checklist marker serialization', () => {
	it('XML→JSON strips markers and sets checked', () => {
		const xml = wrap(
			'제목\n체크리스트:\n<list>' +
				'<list-item dir="ltr">[X] 우유\n</list-item>' +
				'<list-item dir="ltr">[ ] 빵</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		const list = doc.content![2];
		expect(list.type).toBe('bulletList');
		const [li0, li1] = list.content!;
		expect(li0.attrs!.checked).toBe(true);
		expect(li1.attrs!.checked).toBe(false);
		expect(li0.content![0].content![0].text).toBe('우유');
		expect(li1.content![0].content![0].text).toBe('빵');
	});

	it('lowercase [x] is accepted as checked', () => {
		const xml = wrap(
			'제목\n체크리스트:\n<list>' +
				'<list-item dir="ltr">[x] 우유</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		expect(doc.content![2].content![0].attrs!.checked).toBe(true);
	});

	it('JSON→XML adds markers for checklist-region items', () => {
		const xml = serializeContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [{ type: 'text', text: '체크리스트:' }]
				},
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							attrs: { checked: true },
							content: [
								{ type: 'paragraph', content: [{ type: 'text', text: '우유' }] }
							]
						},
						{
							type: 'listItem',
							attrs: { checked: false },
							content: [
								{ type: 'paragraph', content: [{ type: 'text', text: '빵' }] }
							]
						}
					]
				}
			]
		});
		expect(xml).toContain('[X] 우유');
		expect(xml).toContain('[ ] 빵');
	});

	it('XML→JSON→XML round-trips byte-identically for a checklist region', () => {
		const xml = wrap(
			'제목\n체크리스트: 장보기\n<list>' +
				'<list-item dir="ltr">[X] 우유\n</list-item>' +
				'<list-item dir="ltr">[ ] 빵</list-item>' +
				'</list>'
		);
		expect(serializeContent(deserializeContent(xml))).toBe(xml);
	});

	it('round-trips nested checklist items', () => {
		const xml = wrap(
			'제목\n체크리스트:\n<list>' +
				'<list-item dir="ltr">[ ] 상위\n<list>' +
				'<list-item dir="ltr">[X] 하위</list-item>' +
				'</list></list-item>' +
				'</list>'
		);
		expect(serializeContent(deserializeContent(xml))).toBe(xml);
	});

	it('leaves non-region lists untouched ([ ] stays literal text)', () => {
		const xml = wrap(
			'제목\n그냥 목록\n<list>' +
				'<list-item dir="ltr">[ ] 우유</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		// 영역이 아니므로 마커가 본문 텍스트로 남는다.
		expect(doc.content![2].content![0].content![0].content![0].text).toBe(
			'[ ] 우유'
		);
		expect(serializeContent(doc)).toBe(xml);
	});

	it('adds [ ] markers to a bare checklist region on serialize', () => {
		// 마커 없이 체크리스트 영역에 직접 타이핑한 기존 노트 — 저장 시 마커 획득.
		const xml = wrap(
			'제목\n체크리스트:\n<list>' +
				'<list-item dir="ltr">우유</list-item>' +
				'</list>'
		);
		const out = serializeContent(deserializeContent(xml));
		expect(out).toContain('[ ] 우유');
	});
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd app && npm run test -- checklistArchiver`
Expected: FAIL — 마커가 직렬화/역직렬화되지 않음.

- [ ] **Step 3: 역직렬화 후처리 추가**

`app/src/lib/core/noteContentArchiver.ts` 상단 import 에 추가:

```ts
import { isChecklistHeaderText } from '../editor/checklist/regions.js';
```

> 참고: `core/` 가 `editor/checklist/regions.ts` 를 import 한다. `regions.ts`
> 는 부수효과가 없고 PM 타입만 import 하므로 안전하며, 헤더 판정 로직의
> 단일 출처를 유지하기 위함이다.

같은 파일에 마커 정규식 상수와 후처리 함수를 추가한다 (`escapeXmlContent` 함수 정의 부근, 파일 하단의 helper 영역):

```ts
// 체크리스트 항목 마커: [ ] 미체크 / [X] 체크 (소문자 x 도 체크로 인정).
const CHECKLIST_MARKER_RE = /^\[([ xX])\] /;

/**
 * parseBlocks 결과를 후처리해 체크리스트 영역 항목의 마커를 떼고
 * `attrs.checked` 를 설정한다. 헤더 다음의 연속 리스트가 영역이다.
 */
function applyChecklistMarkersOnParse(blocks: JSONContent[]): void {
	for (let i = 1; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.type !== 'paragraph') continue;
		if (!isChecklistHeaderText(getPlainText(b))) continue;
		let j = i + 1;
		while (
			j < blocks.length &&
			(blocks[j].type === 'bulletList' || blocks[j].type === 'orderedList')
		) {
			stripChecklistMarkersInList(blocks[j]);
			j++;
		}
		i = j - 1;
	}
}

function stripChecklistMarkersInList(listNode: JSONContent): void {
	for (const li of listNode.content ?? []) {
		if (li.type !== 'listItem') continue;
		stripChecklistMarkerInItem(li);
		for (const child of li.content ?? []) {
			if (child.type === 'bulletList' || child.type === 'orderedList') {
				stripChecklistMarkersInList(child);
			}
		}
	}
}

function stripChecklistMarkerInItem(li: JSONContent): void {
	const para = li.content?.[0];
	let checked = false;
	if (para && para.type === 'paragraph' && para.content) {
		const first = para.content[0];
		if (first && first.type === 'text' && typeof first.text === 'string') {
			const m = CHECKLIST_MARKER_RE.exec(first.text);
			if (m) {
				checked = m[1] === 'x' || m[1] === 'X';
				const rest = first.text.slice(4);
				if (rest.length === 0) {
					para.content.shift();
				} else {
					first.text = rest;
				}
			}
		}
	}
	li.attrs = { ...(li.attrs ?? {}), checked };
}
```

`deserializeContent` 안에서 `parseBlocks` 결과를 반환하기 직전에 후처리를 끼운다. 현재:

```ts
	const blocks = parseBlocks(root);

	if (blocks.length === 0) {
		return { type: 'doc', content: [{ type: 'paragraph' }] };
	}

	return { type: 'doc', content: blocks };
```

를 다음으로 바꾼다:

```ts
	const blocks = parseBlocks(root);

	if (blocks.length === 0) {
		return { type: 'doc', content: [{ type: 'paragraph' }] };
	}

	applyChecklistMarkersOnParse(blocks);
	return { type: 'doc', content: blocks };
```

- [ ] **Step 4: 직렬화에 영역 추적 + 마커 합성 추가**

`serializeContent` 의 메인 루프에 `inChecklistRegion` 플래그를 추가한다. 현재 루프 (`for (let i = 0; i < nodes.length; i++)`) 직전에 플래그를 선언하고, 루프 안에서 갱신한다.

`for` 루프 시작 직전에 추가:

```ts
	// 체크리스트 영역 추적: 헤더 문단을 만나면 켜지고, 그 뒤 연속 리스트
	// 동안 유지되며, 헤더 아닌 문단/헤딩을 만나면 꺼진다.
	let inChecklistRegion = false;
```

루프 안에서 `bulletList` 분기를 다음으로 바꾼다. 현재:

```ts
		if (node.type === 'bulletList') {
			closeAll();
			result += serializeBulletList(node, /*isTopLevel=*/ true);
		} else if (node.type === 'paragraph' || node.type === 'heading') {
```

를:

```ts
		if (node.type === 'bulletList') {
			closeAll();
			result += serializeBulletList(
				node,
				/*isTopLevel=*/ true,
				inChecklistRegion
			);
			// 연속 리스트는 같은 영역 — inChecklistRegion 유지.
		} else if (node.type === 'paragraph' || node.type === 'heading') {
```

같은 분기의 `paragraph`/`heading` 처리 블록 끝(인라인 직렬화 `for` 루프 닫는 `}` 직후, `}` 로 분기 닫기 전)에 플래그 갱신을 추가한다:

```ts
		} else if (node.type === 'paragraph' || node.type === 'heading') {
			for (const inline of node.content ?? []) {
				if (inline.type === 'text') {
					writeTextNode(inline);
				} else if (inline.type === 'hardBreak') {
					closeAll();
					result += '\n';
				}
			}
			// 헤더 문단이면 영역 시작, 그 외 문단/헤딩이면 영역 종료.
			inChecklistRegion =
				i > 0 &&
				node.type === 'paragraph' &&
				isChecklistHeaderText(getPlainText(node));
		}
```

- [ ] **Step 5: `serializeBulletList` / `serializeListItem` 에 `checklist` 인자 추가**

`serializeBulletList` 시그니처에 `checklist` 인자를 추가하고 항목·중첩에 전달한다:

```ts
function serializeBulletList(
	node: JSONContent,
	isTopLevel: boolean,
	checklist: boolean
): string {
	let result = '<list>';

	const items = node.content ?? [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item.type === 'listItem') {
			const isLastTopLevel = isTopLevel && i === items.length - 1;
			result += serializeListItem(item, isLastTopLevel, checklist);
		}
	}

	result += '</list>';
	return result;
}
```

`serializeListItem` 시그니처에 `checklist` 를 추가하고, `checklist` 이면 여는 태그 직후에 마커를 붙인다. 중첩 리스트 직렬화에도 `checklist` 를 전달한다. 현재 함수 시작:

```ts
function serializeListItem(item: JSONContent, isLastTopLevel: boolean): string {
	let result = '<list-item dir="ltr">';
```

를:

```ts
function serializeListItem(
	item: JSONContent,
	isLastTopLevel: boolean,
	checklist: boolean
): string {
	let result = '<list-item dir="ltr">';
	if (checklist) {
		// 체크리스트 영역 항목: 첫 문단 내용 앞에 마커 텍스트를 박는다.
		// '[', ']', 공백, 'X' 는 XML 안전 문자라 이스케이프 불필요.
		result += item.attrs?.checked ? '[X] ' : '[ ] ';
	}
```

같은 함수 안 중첩 리스트 직렬화 호출을 찾아 `checklist` 를 전달한다. 현재:

```ts
			for (const child of children) {
				if (child.type === 'bulletList') {
					result += serializeBulletList(child, /*isTopLevel=*/ false);
				}
			}
```

를:

```ts
			for (const child of children) {
				if (child.type === 'bulletList') {
					result += serializeBulletList(
						child,
						/*isTopLevel=*/ false,
						checklist
					);
				}
			}
```

- [ ] **Step 6: 테스트 실행 → 통과 확인**

Run: `cd app && npm run test -- checklistArchiver`
Expected: PASS — 모든 테스트 통과.

- [ ] **Step 7: 회귀 확인 — 기존 아카이버 테스트 통과**

Run: `cd app && npm run test`
Expected: PASS — `loadIdempotence`, `trailingParagraph`, `autoLinkRoundtrip`, `todoRegion` 등 기존 테스트 전부 그대로 통과 (체크리스트 변경이 비영역 노트 라운드트립을 깨지 않음).

- [ ] **Step 8: 커밋**

```bash
git add app/src/lib/core/noteContentArchiver.ts \
        app/tests/unit/editor/checklistArchiver.test.ts
git commit -m "feat(checklist): .note XML 마커 합성 직렬화/역직렬화"
```

---

### Task 3: 체크박스 플러그인 — 데코레이션 렌더 + 위젯

**Goal:** 체크리스트 영역 항목마다 불릿을 숨기는 노드 데코와 클릭 가능한 체크박스 위젯을 그리는 ProseMirror 플러그인, 그리고 이를 감싸는 `TomboyChecklist` TipTap Extension 을 만든다.

**Files:**
- Create: `app/src/lib/editor/checklist/plugin.ts`
- Create: `app/src/lib/editor/checklist/index.ts`
- Test: `app/tests/unit/editor/checklistPlugin.test.ts`

**Acceptance Criteria:**
- [ ] 플러그인이 체크리스트 영역의 각 listItem 에 `tomboy-checkbox-item` 클래스 노드 데코를 단다 (체크된 항목은 `is-checked` 추가).
- [ ] 항목 첫 문단 시작 위치에 체크박스 `<button>` 위젯이 렌더된다.
- [ ] 체크박스 클릭 시 해당 listItem 의 `liPos` 로 `onToggle` 콜백이 호출된다.
- [ ] 영역 밖의 일반 리스트에는 데코·위젯이 붙지 않는다.

**Verify:** `cd app && npm run test -- checklistPlugin` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: `checklistPlugin.test.ts` 작성 (failing tests)**

`app/tests/unit/editor/checklistPlugin.test.ts` 를 생성한다:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyChecklist } from '$lib/editor/checklist/index.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(doc: JSONContent, onToggle = () => {}): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem,
			TomboyChecklist.configure({ onToggle })
		],
		content: doc
	});
	currentEditor = editor;
	return editor;
}

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});
const LI = (text: string, checked = false): JSONContent => ({
	type: 'listItem',
	attrs: { checked },
	content: [P(text)]
});
const UL = (...items: JSONContent[]): JSONContent => ({
	type: 'bulletList',
	content: items
});

describe('TomboyChecklist plugin', () => {
	it('decorates checklist-region items with checkbox class + widget', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), UL(LI('우유'), LI('빵', true))]
		});
		const dom = e.view.dom;
		expect(dom.querySelectorAll('li.tomboy-checkbox-item')).toHaveLength(2);
		expect(dom.querySelectorAll('.tomboy-checkbox-box')).toHaveLength(2);
		expect(
			dom.querySelectorAll('li.tomboy-checkbox-item.is-checked')
		).toHaveLength(1);
		expect(
			dom.querySelectorAll('.tomboy-checkbox-box.is-checked')
		).toHaveLength(1);
	});

	it('does not decorate a list outside any checklist region', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('그냥 목록'), UL(LI('우유'))]
		});
		expect(
			e.view.dom.querySelectorAll('li.tomboy-checkbox-item')
		).toHaveLength(0);
		expect(e.view.dom.querySelectorAll('.tomboy-checkbox-box')).toHaveLength(
			0
		);
	});

	it('clicking a checkbox invokes onToggle with the listItem position', () => {
		const onToggle = vi.fn();
		const e = makeEditor(
			{
				type: 'doc',
				content: [P('제목'), P('체크리스트:'), UL(LI('우유'))]
			},
			onToggle
		);
		const box = e.view.dom.querySelector(
			'.tomboy-checkbox-box'
		) as HTMLElement;
		box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(onToggle).toHaveBeenCalledTimes(1);
		// liPos: 제목 문단 size + 헤더 문단 size + (리스트 여는 토큰 1) 이후.
		const liPos = onToggle.mock.calls[0][0] as number;
		const node = e.state.doc.nodeAt(liPos);
		expect(node?.type.name).toBe('listItem');
	});
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd app && npm run test -- checklistPlugin`
Expected: FAIL — `index.js` / `plugin.js` 없음.

- [ ] **Step 3: `plugin.ts` 구현**

`app/src/lib/editor/checklist/plugin.ts` 를 생성한다:

```ts
/**
 * ProseMirror 플러그인: 체크리스트 영역의 각 listItem 에 체크박스 위젯과
 * 불릿 숨김 노드 클래스를 데코레이션으로 단다. 체크 상태는 listItem 의
 * `checked` 속성에서 읽으며, 이 플러그인은 문서를 변형하지 않는다.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

import { findChecklistRegions, findChecklistItems } from './regions.js';

export interface ChecklistPluginOptions {
	/** 체크박스 클릭 시 호출. liPos 는 listItem 노드 위치. */
	onToggle: (liPos: number) => void;
}

export const checklistPluginKey = new PluginKey<DecorationSet>(
	'tomboyChecklist'
);

function buildCheckbox(
	view: EditorView,
	getPos: () => number | undefined,
	checked: boolean,
	onToggle: ChecklistPluginOptions['onToggle']
): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = checked
		? 'tomboy-checkbox-box is-checked'
		: 'tomboy-checkbox-box';
	btn.setAttribute('contenteditable', 'false');
	btn.setAttribute('data-no-drag', '');
	btn.setAttribute('aria-label', checked ? '체크 해제' : '체크');
	btn.addEventListener('mousedown', (e) => {
		// PM 이 포커스/선택을 위젯으로 가져가지 못하게.
		e.preventDefault();
		e.stopPropagation();
	});
	btn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		const p = getPos();
		if (p == null) return;
		// 위젯은 contentStart(liPos+2)에 놓임 → listItem 은 2 앞.
		const liPos = p - 2;
		const node = view.state.doc.nodeAt(liPos);
		if (!node || node.type.name !== 'listItem') return;
		onToggle(liPos);
	});
	return btn;
}

function buildDecorations(
	doc: PMNode,
	onToggle: ChecklistPluginOptions['onToggle']
): DecorationSet {
	const decos: Decoration[] = [];
	const regions = findChecklistRegions(doc);
	const items = findChecklistItems(regions);
	for (const it of items) {
		const liEnd = it.liPos + it.liNode.nodeSize;
		decos.push(
			Decoration.node(it.liPos, liEnd, {
				class: it.checked
					? 'tomboy-checkbox-item is-checked'
					: 'tomboy-checkbox-item'
			})
		);
		decos.push(
			Decoration.widget(
				it.contentStart,
				(view, getPos) =>
					buildCheckbox(view, getPos, it.checked, onToggle),
				{
					side: -1,
					ignoreSelection: true,
					key: `tomboy-checkbox-${it.checked ? 'on' : 'off'}`
				}
			)
		);
	}
	return DecorationSet.create(doc, decos);
}

export function createChecklistPlugin(
	options: ChecklistPluginOptions
): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: checklistPluginKey,
		state: {
			init(_, state) {
				return buildDecorations(state.doc, options.onToggle);
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				return buildDecorations(newState.doc, options.onToggle);
			}
		},
		props: {
			decorations(state) {
				return checklistPluginKey.getState(state) ?? null;
			}
		}
	});
}
```

- [ ] **Step 4: `index.ts` 구현**

`app/src/lib/editor/checklist/index.ts` 를 생성한다 (이 시점에는 commands 재export 없음 — Task 4 에서 추가):

```ts
import { Extension } from '@tiptap/core';

import {
	createChecklistPlugin,
	checklistPluginKey,
	type ChecklistPluginOptions
} from './plugin.js';

export {
	isChecklistHeaderText,
	findChecklistRegions,
	findChecklistItems,
	findChecklistItemAt
} from './regions.js';
export type {
	ChecklistRegion,
	ChecklistRegionList,
	ChecklistItemRef
} from './regions.js';
export { checklistPluginKey };
export type { ChecklistPluginOptions };

export const TomboyChecklist = Extension.create<ChecklistPluginOptions>({
	name: 'tomboyChecklist',
	addOptions() {
		return {
			onToggle: () => {}
		};
	},
	addProseMirrorPlugins() {
		return [createChecklistPlugin(this.options)];
	}
});
```

- [ ] **Step 5: 테스트 실행 → 통과 확인**

Run: `cd app && npm run test -- checklistPlugin`
Expected: PASS — 모든 테스트 통과.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/checklist/plugin.ts \
        app/src/lib/editor/checklist/index.ts \
        app/tests/unit/editor/checklistPlugin.test.ts
git commit -m "feat(checklist): 체크박스 데코레이션 플러그인 + Extension"
```

---

### Task 4: 명령 — 체크 토글 + `Ctrl+P` 블록 삽입

**Goal:** 체크박스 토글(`toggleCheckboxAt`)과 체크리스트 블록 삽입(`insertChecklistBlock`) 명령을 만들고 `index.ts` 에서 재export 한다.

**Files:**
- Create: `app/src/lib/editor/checklist/commands.ts`
- Modify: `app/src/lib/editor/checklist/index.ts`
- Test: `app/tests/unit/editor/checklistCommands.test.ts`

**Acceptance Criteria:**
- [ ] `toggleCheckboxAt(editor, liPos)` 가 해당 listItem 의 `checked` 속성을 반전한다.
- [ ] `insertChecklistBlock(editor)` 가 커서 블록 다음에 `체크리스트:` 문단 + 항목 1개짜리 bulletList 를 삽입하고 커서를 그 항목 안에 둔다.
- [ ] 커서가 빈 비제목 문단에 있으면 그 문단을 대체한다.
- [ ] 제목(0번 블록)은 절대 대체하지 않는다.

**Verify:** `cd app && npm run test -- checklistCommands` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: `checklistCommands.test.ts` 작성 (failing tests)**

`app/tests/unit/editor/checklistCommands.test.ts` 를 생성한다:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import {
	toggleCheckboxAt,
	insertChecklistBlock
} from '$lib/editor/checklist/commands.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(doc: JSONContent): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem
		],
		content: doc
	});
	currentEditor = editor;
	return editor;
}

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});

/** 첫 listItem 의 절대 위치. */
function firstLiPos(editor: Editor): number {
	let pos = -1;
	editor.state.doc.descendants((node, p) => {
		if (pos >= 0) return false;
		if (node.type.name === 'listItem') {
			pos = p;
			return false;
		}
		return true;
	});
	return pos;
}

describe('toggleCheckboxAt', () => {
	it('flips checked from false to true and back', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				P('체크리스트:'),
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							attrs: { checked: false },
							content: [P('우유')]
						}
					]
				}
			]
		});
		const liPos = firstLiPos(e);
		expect(toggleCheckboxAt(e, liPos)).toBe(true);
		expect(e.state.doc.nodeAt(liPos)!.attrs.checked).toBe(true);
		expect(toggleCheckboxAt(e, liPos)).toBe(true);
		expect(e.state.doc.nodeAt(liPos)!.attrs.checked).toBe(false);
	});

	it('returns false for a non-listItem position', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목')] });
		expect(toggleCheckboxAt(e, 0)).toBe(false);
	});
});

describe('insertChecklistBlock', () => {
	it('inserts 체크리스트: + empty bullet after the caret block', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), P('본문')] });
		const bodyStart = e.state.doc.child(0).nodeSize + 1;
		e.commands.setTextSelection(bodyStart + 1);
		insertChecklistBlock(e);
		expect(e.state.doc.childCount).toBe(4);
		expect(e.state.doc.child(2).textContent).toBe('체크리스트:');
		expect(e.state.doc.child(3).type.name).toBe('bulletList');
		expect(e.state.doc.child(3).firstChild!.textContent).toBe('');
	});

	it('replaces an empty non-title paragraph in place', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), P(''), P('')] });
		const targetStart = e.state.doc.child(0).nodeSize + 1;
		e.commands.setTextSelection(targetStart);
		insertChecklistBlock(e);
		expect(e.state.doc.childCount).toBe(4);
		expect(e.state.doc.child(1).textContent).toBe('체크리스트:');
		expect(e.state.doc.child(2).type.name).toBe('bulletList');
	});

	it('never replaces the title (index 0)', () => {
		const e = makeEditor({ type: 'doc', content: [P('')] });
		e.commands.setTextSelection(1);
		insertChecklistBlock(e);
		expect(e.state.doc.childCount).toBe(3);
		expect(e.state.doc.child(0).textContent).toBe('');
		expect(e.state.doc.child(1).textContent).toBe('체크리스트:');
		expect(e.state.doc.child(2).type.name).toBe('bulletList');
	});
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd app && npm run test -- checklistCommands`
Expected: FAIL — `commands.js` 없음.

- [ ] **Step 3: `commands.ts` 구현**

`app/src/lib/editor/checklist/commands.ts` 를 생성한다. `insertChecklistBlock` 은 `todoRegion/commands.ts` 의 `insertTodoBlock` 을 미러링한다 (`SKIP_TRAILING_NODE` 메타 포함):

```ts
/**
 * 체크리스트 명령: 항목 체크 토글, Ctrl+P 체크리스트 블록 삽입.
 */
import type { Editor } from '@tiptap/core';
import { TextSelection } from 'prosemirror-state';

import { SKIP_TRAILING_NODE } from '../listItemDepth.js';

/**
 * `liPos` 의 listItem 의 `checked` 속성을 반전한다. 해당 위치가 listItem
 * 이 아니면 false 를 반환하고 아무것도 하지 않는다.
 */
export function toggleCheckboxAt(editor: Editor, liPos: number): boolean {
	const { state } = editor;
	const node = state.doc.nodeAt(liPos);
	if (!node || node.type.name !== 'listItem') return false;
	const tr = state.tr.setNodeMarkup(liPos, undefined, {
		...node.attrs,
		checked: !node.attrs.checked
	});
	editor.view.dispatch(tr);
	return true;
}

/**
 * Ctrl/Cmd+P 핸들러. 커서의 최상위 블록 다음에 `체크리스트:` 문단 +
 * 빈 항목 하나짜리 bulletList 를 삽입하고 커서를 그 항목 안으로 옮긴다.
 * 커서 블록이 빈 비제목 문단이면 그 문단을 대체한다.
 */
export function insertChecklistBlock(editor: Editor): void {
	const { state } = editor;
	const schema = state.schema;
	const { $from } = state.selection;
	if ($from.depth < 1) return;

	const topIdx = $from.index(0);
	const topNode = state.doc.child(topIdx);
	const topStart = $from.before(1);
	const topEnd = $from.after(1);

	const headerPara = schema.nodes.paragraph.create(
		null,
		schema.text('체크리스트:')
	);
	const emptyLi = schema.nodes.listItem.create(
		null,
		schema.nodes.paragraph.create()
	);
	const newList = schema.nodes.bulletList.create(null, emptyLi);

	const tr = state.tr;
	const currentIsEmptyPara =
		topNode.type.name === 'paragraph' &&
		topNode.content.size === 0 &&
		topIdx > 0;

	let insertedAt: number;
	if (currentIsEmptyPara) {
		tr.replaceWith(topStart, topEnd, [headerPara, newList]);
		insertedAt = topStart;
	} else {
		tr.insert(topEnd, [headerPara, newList]);
		insertedAt = topEnd;
	}

	// 커서를 빈 항목의 문단 안에 둔다:
	//   insertedAt              -> headerPara 앞
	//   + headerPara.nodeSize   -> newList 앞 (bulletList 여는 토큰)
	//   + 1                     -> bulletList 안, listItem 앞
	//   + 1                     -> listItem 안, paragraph 앞
	//   + 1                     -> paragraph 안 (커서)
	const caret = insertedAt + headerPara.nodeSize + 3;
	const clamped = Math.max(1, Math.min(caret, tr.doc.content.size - 1));
	try {
		tr.setSelection(TextSelection.near(tr.doc.resolve(clamped)));
	} catch {
		// 실패 시 선택 그대로 둔다.
	}
	tr.setMeta(SKIP_TRAILING_NODE, true);
	editor.view.dispatch(tr);
	editor.view.focus();
}
```

- [ ] **Step 4: `index.ts` 에 명령 재export 추가**

`app/src/lib/editor/checklist/index.ts` 의 `export { checklistPluginKey };` 줄 바로 다음에 추가:

```ts
export { toggleCheckboxAt, insertChecklistBlock } from './commands.js';
```

- [ ] **Step 5: 테스트 실행 → 통과 확인**

Run: `cd app && npm run test -- checklistCommands`
Expected: PASS — 모든 테스트 통과.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/checklist/commands.ts \
        app/src/lib/editor/checklist/index.ts \
        app/tests/unit/editor/checklistCommands.test.ts
git commit -m "feat(checklist): 토글/삽입 명령 + Ctrl+P 핸들러"
```

---

### Task 5: 에디터 연결 — 확장 등록 · `Ctrl+P` · CSS

**Goal:** `TomboyEditor.svelte` 에 `TomboyChecklist` 확장을 등록하고, `Ctrl+P` 키 처리와 체크리스트 CSS 를 추가한다.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte`

**Acceptance Criteria:**
- [ ] `TomboyChecklist` 확장이 에디터에 등록되고 `onToggle` 이 `toggleCheckboxAt` 으로 연결된다.
- [ ] `Ctrl/Cmd+P` 가 `insertChecklistBlock` 을 호출하고 브라우저 인쇄 대화상자를 막는다.
- [ ] 체크리스트 영역 항목의 불릿이 사라지고 체크박스 위젯이 보이며, 체크된 항목 문단이 흐려진다.
- [ ] `npm run check` (svelte-check) 와 `npm run test` 가 모두 통과한다.

**Verify:** `cd app && npm run check && npm run test` → 통과. 추가로 아래 Step 5 의 수동 확인.

**Steps:**

- [ ] **Step 1: import 추가**

`TomboyEditor.svelte` `<script>` 상단, `todoRegion/index.js` import 블록(`import { TomboyTodoRegion, moveTodoItem, insertTodoBlock } from "./todoRegion/index.js";`) 바로 다음에 추가:

```ts
	import {
		TomboyChecklist,
		toggleCheckboxAt,
		insertChecklistBlock,
	} from "./checklist/index.js";
```

- [ ] **Step 2: 확장 등록**

확장 배열에서 `TomboyTodoRegion.configure({ ... })` 블록 바로 다음(닫는 `}),` 다음)에 추가:

```ts
				TomboyChecklist.configure({
					onToggle: (liPos) => {
						const ed = editor;
						if (!ed || ed.isDestroyed) return;
						toggleCheckboxAt(ed, liPos);
					},
				}),
```

- [ ] **Step 3: `Ctrl+P` 키 처리**

`handleKeyDown` 의 Ctrl/Cmd `switch (event.key)` 블록에서 `case "o":` 블록(`insertTodoBlock(ed); return true;`) 바로 다음에 추가:

```ts
							case "p":
								event.preventDefault();
								insertChecklistBlock(ed);
								return true;
```

- [ ] **Step 4: CSS 추가**

`<style>` 영역에서 TODO/Done 버튼 CSS 블록 다음(`@media (hover: none)...` 로 끝나는 todo 관련 블록의 닫는 `}` 다음, CSV/TSV 테이블 블록 주석 앞)에 추가:

```css
	/* 체크리스트 영역 항목 — 불릿 대신 체크박스 위젯. checklist 플러그인이
	   영역 안의 각 listItem 에 .tomboy-checkbox-item 노드 데코와 첫 문단
	   시작 위치에 .tomboy-checkbox-box 위젯을 단다. */
	.tomboy-editor :global(li.tomboy-checkbox-item) {
		list-style: none;
	}
	/* 체크된 항목은 자기 직계 문단만 흐리게 — 중첩 자식 항목은 제외. */
	.tomboy-editor :global(li.tomboy-checkbox-item.is-checked > p) {
		opacity: 0.6;
	}
	.tomboy-editor :global(.tomboy-checkbox-box) {
		display: inline-block;
		width: 1em;
		height: 1em;
		margin-right: 0.4em;
		padding: 0;
		vertical-align: -0.12em;
		border: 1.5px solid #888;
		border-radius: 3px;
		background: #fff;
		cursor: pointer;
	}
	.tomboy-editor :global(.tomboy-checkbox-box.is-checked) {
		border-color: #2e7d32;
		background-color: #2e7d32;
		background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M6.4 11.2L3 7.8l1.1-1.1 2.3 2.3L11.9 4l1.1 1.1z' fill='white'/></svg>");
		background-repeat: no-repeat;
		background-position: center;
	}
```

- [ ] **Step 5: 타입 체크 · 테스트 · 수동 확인**

Run: `cd app && npm run check`
Expected: PASS — svelte-check 타입 에러 0.

Run: `cd app && npm run test`
Expected: PASS — 전체 단위 테스트 통과.

수동 확인 (`cd app && npm run dev` 후 브라우저):
1. 새 노트를 만들고 본문에 `체크리스트:` 한 줄을 입력한 뒤 Enter.
2. 다음 줄에서 불릿 리스트를 만들고 항목 몇 개를 입력 → 각 항목 앞에 빈 체크박스가 보이고 불릿은 사라진다.
3. 체크박스를 클릭 → ☑ 로 바뀌고 그 항목 문단이 흐려진다. 다시 클릭 → 원래대로.
4. 빈 줄에서 `Ctrl+P` → `체크리스트:` 헤더 + 빈 체크박스 항목이 생기고 커서가 그 항목 안에 들어간다. 브라우저 인쇄 대화상자는 뜨지 않는다.
5. 노트를 저장하고 다시 열어도 체크 상태가 유지된다 (메뉴 → "원본 XML 보기" 로 본문에 `[X]`/`[ ]` 마커가 있는지 확인 가능).

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(checklist): 에디터 연결 — 확장 등록·Ctrl+P·CSS"
```

---

## 자체 검토 메모

- **스펙 커버리지**: 설계 문서 2절(감지)→Task 1, 3절(데이터 모델)→Task 1+2,
  4절(화면)→Task 3+5, 5절(커서: 처리 불필요)→해당 없음, 6절(자동 부착)→
  Task 2+3 에서 파생, 7절(Ctrl+P)→Task 4+5, 8절(파일)→Task 1–5 전부.
- **타입 일관성**: `ChecklistItemRef`, `ChecklistRegion`, `ChecklistPluginOptions`,
  `findChecklistRegions`/`findChecklistItems`/`findChecklistItemAt`,
  `toggleCheckboxAt`/`insertChecklistBlock`, `createChecklistPlugin`,
  `checklistPluginKey`, `TomboyChecklist` — 모든 태스크에서 동일 시그니처 사용.
- **플레이스홀더 없음**: 모든 스텝에 실제 코드/명령/기대 출력 포함.
