# 리스트 마커 체크박스/라디오 (`[[ ]]` / `(( ))`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 리스트 항목 시작에서 `[[ ]]`/`[[x]]` · `(( ))`/`((o))` 입력 → 그 항목의 불릿을 항목 단위 체크박스/라디오로 교체 (영역 헤더 불필요, XML 라운드트립 보존).

**Architecture:** `TomboyListItem`에 `boxKind` attr 추가 + 기존 체크리스트 데코레이션 패턴 재사용. 신규 `lib/editor/listBox/` 모듈(InputRule + Backspace + 데코 플러그인 + 라디오 토글). 아카이버는 기존 `[[ ]]` 마커 문법 재사용 + 라디오 `(( ))` 신규 마커. Enter 상속은 TipTap `keepOnSplit`으로 해결.

**Tech Stack:** SvelteKit, Svelte 5 runes, TipTap 3 / ProseMirror, vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-list-marker-checkbox-radio-design.md`

---

### Task 1: inlineRadio `(( ))` 보호 — lookbehind/lookahead

**Goal:** 인라인 라디오의 3개 정규식에 lookbehind/lookahead를 추가해 `(( ))`가 인라인 라디오로 먼저 변환되는 충돌 제거 (인라인 체크박스가 `[[ ]]`에 쓰는 정책과 동일).

**Files:**
- Modify: `app/src/lib/editor/inlineRadio/node.ts` (InputRule find, `RADIO_PASTE_RE`)
- Modify: `app/src/lib/core/noteContentArchiver.ts` (`INLINE_RADIO_SPLIT_RE`, ~line 142)
- Test: `app/tests/unit/editor/inlineRadio/node.test.ts` (확장)
- Test: `app/tests/unit/core/archiverInlineRadio.test.ts` (확장)

**Acceptance Criteria:**
- [ ] `(( ))` 타이핑 시 인라인 라디오 atom이 생기지 않고 평문 유지
- [ ] `( )`/`(o)` 단독 입력·붙여넣기·아카이버 split은 기존대로 동작
- [ ] `(( )) 빵` deserialize 시 inlineRadio 노드 0개 (평문 유지)

**Verify:** `cd app && npx vitest run tests/unit/editor/inlineRadio tests/unit/core/archiverInlineRadio.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/editor/inlineRadio/node.test.ts`의 `describe('inlineRadio input rule')` 안에 추가 (기존 `makeEditor`/`typeText` 헬퍼 재사용, 기존 테스트들과 같은 doc 형태 — 제목 문단 + 빈 문단, 커서는 빈 문단):

```ts
	it('does not convert ( ) inside (( )) — 리스트 마커 보호', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(7); // 빈 문단 안
		typeText(editor, '(( ))');
		let radios = 0;
		editor.state.doc.descendants((n) => {
			if (n.type.name === 'inlineRadio') radios++;
		});
		expect(radios).toBe(0);
		editor.destroy();
	});
```

paste 보호 테스트 (같은 파일, transformPasted 테스트하는 기존 describe 패턴에 추가 — 기존 paste 테스트가 쓰는 Slice 구성 방식을 그대로 따른다):

```ts
	it('paste transform skips (( )) — 리스트 마커 보호', () => {
		const editor = makeEditor();
		const slice = new Slice(
			Fragment.from(editor.schema.text('(( )) 빵 ( ) 밥')),
			0,
			0
		);
		const out = editor.view.someProp('transformPasted', (f: any) =>
			f(slice, editor.view)
		) as Slice;
		let radios = 0;
		let text = '';
		out.content.forEach((n) => {
			if (n.type.name === 'inlineRadio') radios++;
			if (n.isText) text += n.text;
		});
		expect(radios).toBe(1); // ( ) 밥 쪽만
		expect(text).toContain('(( )) 빵');
		editor.destroy();
	});
```

`app/tests/unit/core/archiverInlineRadio.test.ts`에 추가 (기존 import/wrap 패턴 따름):

```ts
	it('(( )) 마커 후보는 인라인 라디오로 split 되지 않는다', () => {
		const doc = deserializeContent(
			'<note-content version="0.1">제목\n\n(( )) 그대로</note-content>'
		);
		const json = JSON.stringify(doc);
		expect(json).not.toContain('inlineRadio');
		expect(json).toContain('(( )) 그대로');
	});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/inlineRadio tests/unit/core/archiverInlineRadio.test.ts`
Expected: 새 테스트 3개 FAIL (radios가 0이 아님 / inlineRadio 포함)

- [ ] **Step 3: 정규식 3곳 수정**

`app/src/lib/editor/inlineRadio/node.ts` InputRule:

```ts
				new InputRule({
					// `(( ))` (리스트 항목 마커) 안 `( )` 는 잡지 않음 —
					// 좌측 `(` lookbehind 로 차단. archiver split 정규식과 정책 일치
					// (inlineCheckbox 의 `[[ ]]` 보호와 동일).
					find: /(?<!\()\(([ oO])\)$/,
```

같은 파일 paste 정규식:

```ts
// `(( ))` 안 `( )` 는 변환하지 않음 — 리스트 항목 마커 보존.
// archiver 의 INLINE_RADIO_SPLIT_RE / InputRule find 와 동일 정책.
const RADIO_PASTE_RE = /(?<!\()\(([ oO])\)(?!\))/g;
```

`app/src/lib/core/noteContentArchiver.ts`:

```ts
// Inline-radio 패턴. `( )` (공백 1 개) 또는 `(o)` / `(O)`.
// lookbehind/lookahead 로 `(( ))` 안 `( )` 는 건드리지 않음 — 항목 단위
// 라디오 마커 `(( )) ` 를 보존하기 위함 (INLINE_CHECKBOX_SPLIT_RE 와
// 동일 정책). 마커는 applyListBoxMarkersOnParse 가 strip.
const INLINE_RADIO_SPLIT_RE = /(?<!\()\(([ oO])\)(?!\))/g;
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/inlineRadio tests/unit/core/archiverInlineRadio.test.ts`
Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/inlineRadio/node.ts app/src/lib/core/noteContentArchiver.ts app/tests/unit/editor/inlineRadio/node.test.ts app/tests/unit/core/archiverInlineRadio.test.ts
git commit -m "fix(editor): inlineRadio 정규식에 (( )) 보호 lookaround 추가"
```

---

### Task 2: TomboyListItem `boxKind` attr + `checked` keepOnSplit

**Goal:** listItem 스키마에 `boxKind` attr를 추가하고 `checked`에 `keepOnSplit: false`를 줘서 Enter 분할 시 종류 상속 + 체크 리셋을 스키마 레벨에서 해결.

**Files:**
- Modify: `app/src/lib/editor/extensions/TomboyListItem.ts`
- Test: Create `app/tests/unit/editor/listBox/splitInheritance.test.ts`

**Acceptance Criteria:**
- [ ] `boxKind` attr 존재 (default null, rendered false)
- [ ] boxKind+checked 항목에서 splitListItem → 새 항목 boxKind 동일, checked false
- [ ] 기존 항목의 attrs는 분할 후에도 유지

**Verify:** `cd app && npx vitest run tests/unit/editor/listBox/splitInheritance.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

Create `app/tests/unit/editor/listBox/splitInheritance.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';

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

function docWith(li: JSONContent): JSONContent {
	return {
		type: 'doc',
		content: [P('제목'), { type: 'bulletList', content: [li] }]
	};
}

/** '우유' 텍스트 끝으로 커서 이동. */
function caretAfter(e: Editor, text: string): void {
	let pos = 0;
	e.state.doc.descendants((node, p) => {
		if (node.isText && node.text === text) pos = p + node.nodeSize;
	});
	e.commands.setTextSelection(pos);
}

describe('boxKind split inheritance', () => {
	it('checkbox 항목 분할 → 새 항목 boxKind 상속, checked 리셋', () => {
		const e = makeEditor(
			docWith({
				type: 'listItem',
				attrs: { boxKind: 'checkbox', checked: true },
				content: [P('우유')]
			})
		);
		caretAfter(e, '우유');
		e.commands.splitListItem('listItem');
		const list = e.state.doc.child(1);
		expect(list.childCount).toBe(2);
		expect(list.child(0).attrs.boxKind).toBe('checkbox');
		expect(list.child(0).attrs.checked).toBe(true);
		expect(list.child(1).attrs.boxKind).toBe('checkbox');
		expect(list.child(1).attrs.checked).toBe(false);
	});

	it('radio 항목 분할 → 새 항목 radio, 미선택', () => {
		const e = makeEditor(
			docWith({
				type: 'listItem',
				attrs: { boxKind: 'radio', checked: true },
				content: [P('밥')]
			})
		);
		caretAfter(e, '밥');
		e.commands.splitListItem('listItem');
		const list = e.state.doc.child(1);
		expect(list.child(1).attrs.boxKind).toBe('radio');
		expect(list.child(1).attrs.checked).toBe(false);
	});

	it('일반 항목 분할은 boxKind null 유지', () => {
		const e = makeEditor(docWith({ type: 'listItem', content: [P('빵')] }));
		caretAfter(e, '빵');
		e.commands.splitListItem('listItem');
		const list = e.state.doc.child(1);
		expect(list.child(1).attrs.boxKind).toBeNull();
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/listBox/splitInheritance.test.ts`
Expected: FAIL — `boxKind` undefined / checked가 true로 상속됨

- [ ] **Step 3: TomboyListItem.ts 수정**

`addAttributes`의 `checked`를 교체하고 `boxKind` 추가:

```ts
			checked: {
				// 체크리스트/항목 단위 박스의 완료(선택) 여부. 박스 없는 일반
				// 항목에서는 의미 없이 false 로 남는다. 화면 표시는 checklist /
				// listBox 플러그인이 데코레이션으로 처리하므로 DOM 에
				// 렌더링하지 않는다(rendered: false). keepOnSplit: false —
				// Enter 분할로 생긴 새 항목은 항상 미체크로 시작한다.
				default: false,
				rendered: false,
				keepOnSplit: false
			},
			boxKind: {
				// 항목 단위 박스 마커: 'checkbox' | 'radio' | null.
				// 체크리스트: 영역과 무관하게 li 단독으로 불릿을 체크박스/
				// 라디오로 교체한다(listBox 모듈). keepOnSplit 기본값(true)
				// 이라 Enter 로 만든 새 항목에 종류가 상속된다.
				default: null,
				rendered: false
			}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/listBox/splitInheritance.test.ts`
Expected: PASS. 회귀 확인: `npx vitest run tests/unit/editor/checklistPlugin.test.ts tests/unit/editor/checklistCommands.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/extensions/TomboyListItem.ts app/tests/unit/editor/listBox/splitInheritance.test.ts
git commit -m "feat(editor): listItem boxKind attr + checked keepOnSplit:false"
```

---

### Task 3: 아카이버 라운드트립 — per-item 마커 직렬화/파싱

**Goal:** 영역 밖 boxKind 항목을 `[[ ]] `/`[[X]] `(checkbox), `(( )) `/`((O)) `(radio) 마커로 직렬화하고, 파싱 시 영역 패스가 소비하지 않은 리스트에서 마커를 떼어 boxKind를 복원.

**Files:**
- Modify: `app/src/lib/core/noteContentArchiver.ts`
  - `serializeContent` bulletList 분기 (~line 346)
  - `serializeBulletList` / `serializeListItem` 시그니처 (+`allowItemMarkers`)
  - `deserializeContent` 패스 체인 (~line 234)
  - `applyProcessMarkersOnParse` 반환형 변경
  - 신규 `applyListBoxMarkersOnParse` 패스
- Test: Create `app/tests/unit/core/archiverListBox.test.ts`

**Acceptance Criteria:**
- [ ] 영역 밖 boxKind 항목 직렬화 시 마커 emit; round-trip byte-identical
- [ ] 영역 안(체크리스트/프로세스)은 기존 동작 그대로, boxKind 미설정
- [ ] 마커가 인라인 atom으로 쪼개지지 않음; 중첩 리스트 마커도 동작
- [ ] 텍스트 중간 `(( ))`는 마커 아님 (평문 유지)

**Verify:** `cd app && npx vitest run tests/unit/core/archiverListBox.test.ts tests/unit/editor/checklistArchiver.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

Create `app/tests/unit/core/archiverListBox.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	deserializeContent,
	serializeContent
} from '$lib/core/noteContentArchiver.js';

const wrap = (inner: string) =>
	`<note-content version="0.1">${inner}</note-content>`;

const LI = (
	text: string,
	attrs?: Record<string, unknown>
): Record<string, unknown> => ({
	type: 'listItem',
	...(attrs ? { attrs } : {}),
	content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
});

describe('listBox per-item marker serialization', () => {
	it('영역 밖 checkbox/radio 항목에 마커를 붙인다', () => {
		const xml = serializeContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'bulletList',
					content: [
						LI('우유', { boxKind: 'checkbox', checked: true }),
						LI('빵', { boxKind: 'checkbox', checked: false }),
						LI('밥', { boxKind: 'radio', checked: true }),
						LI('면', { boxKind: 'radio', checked: false }),
						LI('그냥불릿')
					]
				}
			]
		});
		expect(xml).toContain('[[X]] 우유');
		expect(xml).toContain('[[ ]] 빵');
		expect(xml).toContain('((O)) 밥');
		expect(xml).toContain('(( )) 면');
		expect(xml).toContain('>그냥불릿');
	});

	it('XML→JSON: 영역 밖 마커를 떼고 boxKind/checked 설정', () => {
		const xml = wrap(
			'제목\n\n<list>' +
				'<list-item dir="ltr">[[X]] 우유\n</list-item>' +
				'<list-item dir="ltr">(( )) 밥\n</list-item>' +
				'<list-item dir="ltr">((o)) 면</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		const list = doc.content!.find((b) => b.type === 'bulletList')!;
		const [li0, li1, li2] = list.content!;
		expect(li0.attrs!.boxKind).toBe('checkbox');
		expect(li0.attrs!.checked).toBe(true);
		expect(li0.content![0].content![0].text).toBe('우유');
		expect(li1.attrs!.boxKind).toBe('radio');
		expect(li1.attrs!.checked).toBe(false);
		expect(li2.attrs!.boxKind).toBe('radio');
		expect(li2.attrs!.checked).toBe(true);
		expect(li2.content![0].content![0].text).toBe('면');
	});

	it('round-trip byte-identical', () => {
		const xml = wrap(
			'제목\n\n<list>' +
				'<list-item dir="ltr">[[ ]] 우유\n</list-item>' +
				'<list-item dir="ltr">((O)) 밥</list-item>' +
				'</list>'
		);
		expect(serializeContent(deserializeContent(xml))).toBe(xml);
	});

	it('중첩 리스트 항목 마커도 동작', () => {
		const xml = wrap(
			'제목\n\n<list>' +
				'<list-item dir="ltr">부모\n<list>' +
				'<list-item dir="ltr">(( )) 자식\n</list-item>' +
				'</list>\n</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		const list = doc.content!.find((b) => b.type === 'bulletList')!;
		const nested = list.content![0].content!.find(
			(c) => c.type === 'bulletList'
		)!;
		expect(nested.content![0].attrs!.boxKind).toBe('radio');
		expect(serializeContent(doc)).toBe(xml);
	});

	it('체크리스트: 영역 안은 기존 동작 — boxKind 미설정', () => {
		const xml = wrap(
			'제목\n체크리스트:\n<list>' +
				'<list-item dir="ltr">[[X]] 우유</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		const li = doc.content![2].content![0];
		expect(li.attrs!.checked).toBe(true);
		expect(li.attrs!.boxKind ?? null).toBeNull();
		expect(serializeContent(doc)).toBe(xml);
	});

	it('텍스트 중간 (( )) 는 마커가 아니다', () => {
		const xml = wrap(
			'제목\n\n<list>' +
				'<list-item dir="ltr">점심 (( )) 미정</list-item>' +
				'</list>'
		);
		const doc = deserializeContent(xml);
		const li = doc.content!.find((b) => b.type === 'bulletList')!.content![0];
		expect(li.attrs?.boxKind ?? null).toBeNull();
		expect(li.content![0].content![0].text).toBe('점심 (( )) 미정');
		expect(serializeContent(doc)).toBe(xml);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/core/archiverListBox.test.ts`
Expected: FAIL (마커 미emit / boxKind 미설정)

- [ ] **Step 3: 직렬화 수정**

`serializeContent`의 bulletList 분기 (~line 346) 교체:

```ts
		if (node.type === 'bulletList') {
			closeAll();
			const isProcessList = processStageLists.has(i);
			result += serializeBulletList(
				node,
				/*isTopLevel=*/ true,
				inChecklistRegion
					? MARKER_ALL_DEPTHS
					: isProcessList
						? MARKER_PROCESS_DEPTH3
						: MARKER_NONE,
				// 항목 단위(boxKind) 마커는 영역 리스트에선 emit 하지 않는다 —
				// 영역 마커가 우선이고, 파싱 쪽 전역 패스도 영역 리스트를
				// 건너뛰므로 비대칭 라운드트립을 막는다.
				/*allowItemMarkers=*/ !inChecklistRegion && !isProcessList
			);
			// 연속 리스트는 같은 영역 — inChecklistRegion 유지.
		}
```

`serializeBulletList` 시그니처 + 호출 전달:

```ts
function serializeBulletList(
	node: JSONContent,
	isTopLevel: boolean,
	markerAt: MarkerDepthFn,
	allowItemMarkers: boolean,
	depth = 1
): string {
```

내부 호출: `serializeListItem(item, isLastTopLevel, markerAt, allowItemMarkers, depth)`.

`serializeListItem` 시그니처에 `allowItemMarkers: boolean` 추가 (markerAt 다음), 마커 블록 교체:

```ts
	let result = '<list-item dir="ltr">';
	if (markerAt(depth)) {
		// 통째-체크박스 항목: 첫 문단 내용 앞에 마커 텍스트를 박는다.
		// '[', ']', 공백, 'X' 는 XML 안전 문자라 이스케이프 불필요.
		// `[[X]]` / `[[ ]]` 은 inline checkbox atom `[x]` 과 구분되는 문법.
		result += item.attrs?.checked ? '[[X]] ' : '[[ ]] ';
	} else if (allowItemMarkers && item.attrs?.boxKind === 'checkbox') {
		// 항목 단위 체크박스 — 영역 밖에서도 같은 [[ ]] 문법.
		result += item.attrs?.checked ? '[[X]] ' : '[[ ]] ';
	} else if (allowItemMarkers && item.attrs?.boxKind === 'radio') {
		// 항목 단위 라디오. '(', ')', 'O', 공백 모두 XML-safe.
		result += item.attrs?.checked ? '((O)) ' : '(( )) ';
	}
```

중첩 리스트 호출 (~line 1002)에 전달:

```ts
				result += serializeBulletList(
					child,
					/*isTopLevel=*/ false,
					markerAt,
					allowItemMarkers,
					depth + 1
				);
```

- [ ] **Step 4: 파싱 수정**

`deserializeContent` (~line 234):

```ts
	const checklistLists = applyChecklistMarkersOnParse(blocks);
	const processLists = applyProcessMarkersOnParse(blocks, checklistLists);
	applyListBoxMarkersOnParse(
		blocks,
		new Set([...checklistLists, ...processLists])
	);
```

`applyProcessMarkersOnParse` 반환형 변경:

```ts
function applyProcessMarkersOnParse(
	blocks: JSONContent[],
	skip: Set<number>
): Set<number> {
	const stageListIndices = findProcessStageListIndices(blocks);
	for (const idx of stageListIndices) {
		if (skip.has(idx)) continue;
		stripProcessMarkersInList(blocks[idx], 1);
	}
	return stageListIndices;
}
```

신규 패스 (CHECKLIST_MARKER_RE 정의부 근처에 추가):

```ts
// 항목 단위 라디오 마커: (( )) 미선택 / ((O)) 선택 (소문자 o 도 인정).
// 체크박스 쪽은 CHECKLIST_MARKER_RE([[ ]]/[[X]]) 를 그대로 재사용한다.
const LISTBOX_RADIO_MARKER_RE = /^\(\(([ oO])\)\) /;
const LISTBOX_MARKER_LEN = 6; // '((O)) '.length === '[[X]] '.length

/**
 * 체크리스트/프로세스 패스가 소비하지 않은 최상위 리스트에서 li 첫머리
 * 마커를 떼고 항목 단위 `boxKind`+`checked` 를 설정한다 (listBox 기능).
 * 마커 없는 li 는 attrs 를 건드리지 않는다.
 */
function applyListBoxMarkersOnParse(
	blocks: JSONContent[],
	skip: Set<number>
): void {
	for (let i = 1; i < blocks.length; i++) {
		if (blocks[i].type !== 'bulletList' || skip.has(i)) continue;
		stripListBoxMarkersInList(blocks[i]);
	}
}

function stripListBoxMarkersInList(listNode: JSONContent): void {
	for (const li of listNode.content ?? []) {
		if (li.type !== 'listItem') continue;
		stripListBoxMarkerInItem(li);
		for (const child of li.content ?? []) {
			// 중첩 <list> 도 parseList 가 bulletList 로 만든다.
			if (child.type === 'bulletList') stripListBoxMarkersInList(child);
		}
	}
}

function stripListBoxMarkerInItem(li: JSONContent): void {
	const para = li.content?.[0];
	if (!para || para.type !== 'paragraph' || !para.content) return;
	const first = para.content[0];
	if (!first || first.type !== 'text' || typeof first.text !== 'string') return;
	let boxKind: 'checkbox' | 'radio';
	let stateChar: string;
	const cb = CHECKLIST_MARKER_RE.exec(first.text);
	if (cb) {
		boxKind = 'checkbox';
		stateChar = cb[1];
	} else {
		const rd = LISTBOX_RADIO_MARKER_RE.exec(first.text);
		if (!rd) return; // 마커 없음 — attrs 그대로 둔다.
		boxKind = 'radio';
		stateChar = rd[1];
	}
	const checked = /[xXoO]/.test(stateChar);
	const rest = first.text.slice(LISTBOX_MARKER_LEN);
	if (rest.length === 0) {
		para.content.shift();
	} else {
		first.text = rest;
	}
	li.attrs = { ...(li.attrs ?? {}), boxKind, checked };
}
```

영역 그룹핑 "네 곳" 경고 주석(~line 1108)에 한 줄 추가:

```ts
// 항목 단위 listBox 마커(전역 패스 applyListBoxMarkersOnParse / 직렬화
// allowItemMarkers)는 위 영역들이 소비하지 않은 리스트에만 적용된다 —
// 영역 그룹핑 규칙이 바뀌면 skip Set 전달도 함께 확인할 것.
```

- [ ] **Step 5: 테스트 통과 + 회귀 확인**

Run: `cd app && npx vitest run tests/unit/core tests/unit/editor/checklistArchiver.test.ts`
Expected: PASS (아카이버 전체 회귀 없음)

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/core/noteContentArchiver.ts app/tests/unit/core/archiverListBox.test.ts
git commit -m "feat(core): 항목 단위 boxKind 마커 직렬화/파싱 라운드트립"
```

---

### Task 4: listBox 모듈 — 영역 제외 helper + InputRule + Backspace

**Goal:** `[[ ]]`/`(( ))` 입력 → boxKind 설정 + 마커 삭제; 내용 맨 앞 Backspace → 불릿 복원. 영역 리스트에서는 비활성.

**Files:**
- Create: `app/src/lib/editor/listBox/regions.ts`
- Create: `app/src/lib/editor/listBox/inputRules.ts`
- Create: `app/src/lib/editor/listBox/index.ts`
- Test: Create `app/tests/unit/editor/listBox/inputRules.test.ts`

**Acceptance Criteria:**
- [ ] li 첫 문단 시작에서 `[[ ]]`/`[[x]]`/`(( ))`/`((o))` → attr 설정 + 텍스트 삭제
- [ ] 일반 문단·체크리스트: 영역·프로세스 리스트에서 무반응
- [ ] boxKind 항목 내용 맨 앞 Backspace → boxKind/checked 클리어

**Verify:** `cd app && npx vitest run tests/unit/editor/listBox/inputRules.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

Create `app/tests/unit/editor/listBox/inputRules.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyInlineRadio } from '$lib/editor/inlineRadio';
import { TomboyInlineCheckbox } from '$lib/editor/inlineCheckbox';
import { TomboyListBox } from '$lib/editor/listBox/index.js';

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
			TomboyListItem,
			...TomboyInlineCheckbox,
			...TomboyInlineRadio,
			TomboyListBox
		],
		content: doc
	});
	currentEditor = editor;
	return editor;
}

function typeText(editor: Editor, text: string) {
	for (const ch of text) {
		const { from, to } = editor.state.selection;
		const handled = editor.view.someProp('handleTextInput', (f: any) =>
			f(editor.view, from, to, ch)
		);
		if (!handled) {
			editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
		}
	}
}

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});
const LI = (text: string, attrs?: Record<string, unknown>): JSONContent => ({
	type: 'listItem',
	...(attrs ? { attrs } : {}),
	content: [P(text)]
});
const UL = (...items: JSONContent[]): JSONContent => ({
	type: 'bulletList',
	content: items
});

/** 주어진 텍스트를 가진 li 의 첫 문단 내용 시작 위치로 커서 이동. */
function caretAtItemStart(e: Editor, text: string): void {
	let pos = 0;
	e.state.doc.descendants((node, p) => {
		if (node.isText && node.text === text) pos = p;
	});
	e.commands.setTextSelection(pos);
}

function firstLi(e: Editor) {
	return e.state.doc.child(1).child(0);
}

describe('listBox input rules', () => {
	it('[[ ]] at li start → boxKind checkbox, 텍스트 삭제', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), UL(LI('우유'))] });
		caretAtItemStart(e, '우유');
		typeText(e, '[[ ]]');
		const li = firstLi(e);
		expect(li.attrs.boxKind).toBe('checkbox');
		expect(li.attrs.checked).toBe(false);
		expect(li.textContent).toBe('우유');
	});

	it('[[x]] → checked checkbox', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), UL(LI('우유'))] });
		caretAtItemStart(e, '우유');
		typeText(e, '[[x]]');
		expect(firstLi(e).attrs.boxKind).toBe('checkbox');
		expect(firstLi(e).attrs.checked).toBe(true);
	});

	it('(( )) → radio, ((o)) → selected radio', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), UL(LI('밥'), LI('면'))]
		});
		caretAtItemStart(e, '밥');
		typeText(e, '(( ))');
		caretAtItemStart(e, '면');
		typeText(e, '((o))');
		const list = e.state.doc.child(1);
		expect(list.child(0).attrs.boxKind).toBe('radio');
		expect(list.child(0).attrs.checked).toBe(false);
		expect(list.child(1).attrs.boxKind).toBe('radio');
		expect(list.child(1).attrs.checked).toBe(true);
		// 인라인 라디오 atom 으로 새지 않았는지
		let radios = 0;
		e.state.doc.descendants((n) => {
			if (n.type.name === 'inlineRadio') radios++;
		});
		expect(radios).toBe(0);
	});

	it('일반 문단에서는 무반응', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), P('본문')] });
		// 본문 문단 시작으로
		let pos = 0;
		e.state.doc.descendants((node, p) => {
			if (node.isText && node.text === '본문') pos = p;
		});
		e.commands.setTextSelection(pos);
		typeText(e, '[[ ]]');
		expect(e.state.doc.child(1).textContent).toBe('[[ ]]본문');
	});

	it('체크리스트: 영역 안에서는 무반응', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), UL(LI('우유'))]
		});
		caretAtItemStart(e, '우유');
		typeText(e, '(( ))');
		const li = e.state.doc.child(2).child(0);
		expect(li.attrs.boxKind).toBeNull();
		expect(li.textContent).toBe('(( ))우유');
	});

	it('li 중간에서는 무반응', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), UL(LI('우유'))] });
		// '우유' 끝으로
		let pos = 0;
		e.state.doc.descendants((node, p) => {
			if (node.isText && node.text === '우유') pos = p + node.nodeSize;
		});
		e.commands.setTextSelection(pos);
		typeText(e, '[[ ]]');
		expect(firstLi(e).attrs.boxKind).toBeNull();
	});
});

describe('listBox Backspace 해제', () => {
	it('내용 맨 앞 Backspace → 일반 불릿 복원', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				UL(LI('우유', { boxKind: 'checkbox', checked: true }))
			]
		});
		caretAtItemStart(e, '우유');
		const handled = e.commands.keyboardShortcut('Backspace');
		expect(handled).toBe(true);
		const li = firstLi(e);
		expect(li.attrs.boxKind).toBeNull();
		expect(li.attrs.checked).toBe(false);
		expect(li.textContent).toBe('우유'); // 텍스트는 안 지워짐
	});

	it('boxKind 없는 항목에서는 기본 동작으로 폴스루', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), UL(LI('우유'))] });
		caretAtItemStart(e, '우유');
		// TomboyListBox 의 Backspace 핸들러는 false 를 반환해야 한다 —
		// 직접 확인: boxKind 가 없으니 attrs 변화 없음.
		e.commands.keyboardShortcut('Backspace');
		expect(firstLi(e).attrs.boxKind).toBeNull();
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/listBox/inputRules.test.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: regions.ts 작성**

Create `app/src/lib/editor/listBox/regions.ts`:

```ts
/**
 * listBox 가 손대면 안 되는 리스트 범위.
 *
 * 체크리스트: 영역과 프로세스 블록 스테이지 리스트는 각자의 의미론
 * (영역 데코레이션 / [[ ]] 마커)이 소유한다 — 그 안에서 항목 단위
 * boxKind 를 켜면 이중 위젯·마커 충돌이 나므로 입력 규칙과 데코
 * 플러그인 양쪽에서 제외한다. 아카이버 쪽 대응은
 * noteContentArchiver 의 allowItemMarkers / skip Set.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

import { findChecklistRegions } from '../checklist/index.js';
import { findProcessBlocks } from '../processRegion/regions.js';

export interface ExcludedRange {
	from: number;
	to: number;
}

export function getExcludedListRanges(doc: PMNode): ExcludedRange[] {
	const out: ExcludedRange[] = [];
	for (const region of findChecklistRegions(doc)) {
		for (const list of region.lists) {
			out.push({ from: list.pos, to: list.pos + list.node.nodeSize });
		}
	}
	for (const block of findProcessBlocks(doc)) {
		for (const stage of block.stages) {
			for (const list of stage.lists) {
				out.push({ from: list.pos, to: list.pos + list.node.nodeSize });
			}
		}
	}
	return out;
}

export function posInExcludedList(
	ranges: ExcludedRange[],
	pos: number
): boolean {
	for (const r of ranges) {
		if (pos >= r.from && pos < r.to) return true;
	}
	return false;
}
```

- [ ] **Step 4: inputRules.ts 작성**

Create `app/src/lib/editor/listBox/inputRules.ts`:

```ts
/**
 * 리스트 항목 첫 문단 시작에서 [[ ]]/[[x]] → boxKind='checkbox',
 * (( ))/((o)) → boxKind='radio'. 마커 텍스트는 삭제되고 불릿이
 * 체크박스/라디오로 교체된다 (렌더는 plugin.ts 데코레이션).
 * 인라인 atom 규칙과의 충돌은 inlineCheckbox/inlineRadio 쪽
 * lookbehind 가 막는다.
 */
import { InputRule } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';

import { getExcludedListRanges, posInExcludedList } from './regions.js';

type BoxKind = 'checkbox' | 'radio';

/**
 * 마커 입력 위치가 "li 첫 문단의 블록 시작"이면 그 listItem 위치를,
 * 아니면 null 을 반환. 체크리스트: 영역/프로세스 리스트는 제외.
 */
function liPosForMarker(state: EditorState, from: number): number | null {
	const $from = state.doc.resolve(from);
	if ($from.parentOffset !== 0) return null;
	if ($from.parent.type.name !== 'paragraph') return null;
	if ($from.depth < 2) return null;
	const li = $from.node(-1);
	if (li.type.name !== 'listItem') return null;
	if ($from.index(-1) !== 0) return null; // li 의 첫 문단만
	const liPos = $from.before(-1);
	if (posInExcludedList(getExcludedListRanges(state.doc), liPos)) return null;
	return liPos;
}

function makeRule(find: RegExp, kind: BoxKind): InputRule {
	return new InputRule({
		find,
		handler: ({ state, range, match }) => {
			const liPos = liPosForMarker(state, range.from);
			if (liPos == null) return null;
			const li = state.doc.nodeAt(liPos);
			if (!li) return null;
			const checked = /[xXoO]/.test(match[1]);
			state.tr
				.delete(range.from, range.to)
				.setNodeMarkup(liPos, undefined, {
					...li.attrs,
					boxKind: kind,
					checked
				});
		}
	});
}

export function createListBoxInputRules(): InputRule[] {
	return [
		makeRule(/^\[\[([ xX])\]\]$/, 'checkbox'),
		makeRule(/^\(\(([ oO])\)\)$/, 'radio')
	];
}
```

- [ ] **Step 5: index.ts 작성 (Extension + Backspace)**

Create `app/src/lib/editor/listBox/index.ts`:

```ts
/**
 * 항목 단위 체크박스/라디오 (listBox).
 *
 * 리스트 항목 첫머리에서 [[ ]]/(( )) 입력 → 불릿이 통째 체크박스/
 * 라디오로 교체된다. 체크리스트: 영역(헤더 단위)과 독립 공존.
 * 상태는 listItem attrs(boxKind/checked), 렌더는 데코레이션,
 * XML 라운드트립은 noteContentArchiver 의 per-item 마커.
 */
import { Extension } from '@tiptap/core';

import { createListBoxInputRules } from './inputRules.js';

export { getExcludedListRanges, posInExcludedList } from './regions.js';

export const TomboyListBox = Extension.create({
	name: 'tomboyListBox',

	addInputRules() {
		return createListBoxInputRules();
	},

	addKeyboardShortcuts() {
		return {
			// 내용 맨 앞 Backspace → 박스 제거(일반 불릿 복원). 그 외엔
			// false 반환으로 기존 리스트 Backspace 체인에 폴스루.
			Backspace: () => {
				const { state } = this.editor;
				const { $from, empty } = state.selection;
				if (!empty || $from.parentOffset !== 0) return false;
				if ($from.parent.type.name !== 'paragraph' || $from.depth < 2)
					return false;
				const li = $from.node(-1);
				if (li.type.name !== 'listItem' || !li.attrs.boxKind) return false;
				if ($from.index(-1) !== 0) return false;
				const liPos = $from.before(-1);
				return this.editor.commands.command(({ tr, dispatch }) => {
					if (dispatch) {
						tr.setNodeMarkup(liPos, undefined, {
							...li.attrs,
							boxKind: null,
							checked: false
						});
					}
					return true;
				});
			}
		};
	}
});
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/listBox/inputRules.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/editor/listBox app/tests/unit/editor/listBox/inputRules.test.ts
git commit -m "feat(editor): listBox 입력 규칙([[ ]]/(( ))) + Backspace 해제"
```

---

### Task 5: listBox 데코 플러그인 + 라디오 토글 + CSS + 에디터 등록

**Goal:** boxKind 항목에 불릿 숨김 + 체크박스/라디오 위젯 데코레이션을 달고, 라디오 직계-형제 상호배타 토글을 구현, TomboyEditor에 등록.

**Files:**
- Create: `app/src/lib/editor/listBox/plugin.ts`
- Create: `app/src/lib/editor/listBox/commands.ts`
- Modify: `app/src/lib/editor/listBox/index.ts` (옵션 + 플러그인 등록)
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (확장 등록 ~line 677 + CSS ~line 2640)
- Test: Create `app/tests/unit/editor/listBox/plugin.test.ts`

**Acceptance Criteria:**
- [ ] checkbox 항목: `li.tomboy-checkbox-item`(+`.is-checked`) + `.tomboy-checkbox-box` 위젯
- [ ] radio 항목: `li.tomboy-radio-item`(+`.is-selected`) + `.tomboy-radio-box` 위젯
- [ ] `toggleRadioAt`: 직계 형제 상호배타, 재클릭 해제, 중첩 리스트 독립
- [ ] 체크리스트: 영역 항목엔 listBox 데코 미적용 (이중 위젯 없음)

**Verify:** `cd app && npx vitest run tests/unit/editor/listBox` → PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

Create `app/tests/unit/editor/listBox/plugin.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyChecklist } from '$lib/editor/checklist/index.js';
import { TomboyListBox } from '$lib/editor/listBox/index.js';
import { toggleRadioAt } from '$lib/editor/listBox/commands.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(
	doc: JSONContent,
	onToggleRadio: (liPos: number) => void = () => {}
): Editor {
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
			TomboyChecklist,
			TomboyListBox.configure({ onToggleRadio })
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
const LI = (text: string, attrs?: Record<string, unknown>): JSONContent => ({
	type: 'listItem',
	...(attrs ? { attrs } : {}),
	content: [P(text)]
});
const UL = (...items: JSONContent[]): JSONContent => ({
	type: 'bulletList',
	content: items
});

/** doc 의 i 번째 최상위 리스트에서 j 번째 li 의 절대 위치. */
function liPosAt(e: Editor, listIdx: number, itemIdx: number): number {
	let pos = 0;
	for (let i = 0; i < listIdx; i++) pos += e.state.doc.child(i).nodeSize;
	pos += 1; // 리스트 여는 토큰
	const list = e.state.doc.child(listIdx);
	for (let j = 0; j < itemIdx; j++) pos += list.child(j).nodeSize;
	return pos;
}

describe('listBox decoration plugin', () => {
	it('checkbox 항목에 클래스 + 위젯', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				UL(LI('우유', { boxKind: 'checkbox', checked: true }), LI('빵'))
			]
		});
		const dom = e.view.dom;
		expect(dom.querySelectorAll('li.tomboy-checkbox-item')).toHaveLength(1);
		expect(
			dom.querySelectorAll('li.tomboy-checkbox-item.is-checked')
		).toHaveLength(1);
		expect(dom.querySelectorAll('.tomboy-checkbox-box')).toHaveLength(1);
	});

	it('radio 항목에 클래스 + 위젯', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				UL(
					LI('밥', { boxKind: 'radio', checked: true }),
					LI('면', { boxKind: 'radio', checked: false })
				)
			]
		});
		const dom = e.view.dom;
		expect(dom.querySelectorAll('li.tomboy-radio-item')).toHaveLength(2);
		expect(
			dom.querySelectorAll('li.tomboy-radio-item.is-selected')
		).toHaveLength(1);
		expect(dom.querySelectorAll('.tomboy-radio-box')).toHaveLength(2);
		expect(dom.querySelectorAll('.tomboy-radio-box.is-selected')).toHaveLength(1);
	});

	it('체크리스트: 영역 항목엔 listBox 데코 미적용 (이중 위젯 없음)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				P('체크리스트:'),
				// 영역 안 li 에 boxKind 가 남아 있어도 위젯은 checklist 쪽 1개
				UL(LI('우유', { boxKind: 'checkbox', checked: false }))
			]
		});
		const dom = e.view.dom;
		expect(dom.querySelectorAll('.tomboy-checkbox-box')).toHaveLength(1);
	});

	it('radio 위젯 클릭 → onToggleRadio(liPos)', () => {
		const spy = vi.fn();
		const e = makeEditor(
			{
				type: 'doc',
				content: [P('제목'), UL(LI('밥', { boxKind: 'radio', checked: false }))]
			},
			spy
		);
		const btn = e.view.dom.querySelector(
			'.tomboy-radio-box'
		) as HTMLButtonElement;
		btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(spy).toHaveBeenCalledWith(liPosAt(e, 1, 0));
	});
});

describe('toggleRadioAt', () => {
	it('형제 상호배타 — 선택 시 다른 형제 해제', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				UL(
					LI('밥', { boxKind: 'radio', checked: true }),
					LI('면', { boxKind: 'radio', checked: false }),
					LI('빵', { boxKind: 'checkbox', checked: true })
				)
			]
		});
		expect(toggleRadioAt(e, liPosAt(e, 1, 1))).toBe(true);
		const list = e.state.doc.child(1);
		expect(list.child(0).attrs.checked).toBe(false);
		expect(list.child(1).attrs.checked).toBe(true);
		// checkbox 형제는 건드리지 않는다
		expect(list.child(2).attrs.checked).toBe(true);
	});

	it('선택된 항목 재토글 → 해제 (none-selected 허용)', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), UL(LI('밥', { boxKind: 'radio', checked: true }))]
		});
		toggleRadioAt(e, liPosAt(e, 1, 0));
		expect(e.state.doc.child(1).child(0).attrs.checked).toBe(false);
	});

	it('중첩 리스트는 별도 그룹', () => {
		const nested = UL(LI('자식A', { boxKind: 'radio', checked: true }));
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							attrs: { boxKind: 'radio', checked: false },
							content: [P('부모'), nested]
						},
						LI('형제', { boxKind: 'radio', checked: true })
					]
				}
			]
		});
		// 부모 li 선택 → 같은 깊이의 '형제'만 해제, 중첩 '자식A' 는 유지
		toggleRadioAt(e, liPosAt(e, 1, 0));
		const list = e.state.doc.child(1);
		expect(list.child(0).attrs.checked).toBe(true);
		expect(list.child(1).attrs.checked).toBe(false);
		const childLi = list.child(0).child(1).child(0);
		expect(childLi.attrs.checked).toBe(true);
	});

	it('radio 가 아닌 위치는 false', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), UL(LI('빵', { boxKind: 'checkbox' }))]
		});
		expect(toggleRadioAt(e, liPosAt(e, 1, 0))).toBe(false);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/listBox/plugin.test.ts`
Expected: FAIL (plugin.ts / commands.ts 없음)

- [ ] **Step 3: commands.ts 작성**

Create `app/src/lib/editor/listBox/commands.ts`:

```ts
/**
 * 항목 단위 라디오 토글. 체크박스 쪽은 checklist/commands.ts 의
 * toggleCheckboxAt 를 그대로 재사용한다 (같은 checked attr).
 */
import type { Editor } from '@tiptap/core';

/**
 * `liPos` 의 라디오 항목을 토글한다 — 같은 bulletList 직계 형제
 * 라디오와 상호배타. 선택된 항목 재토글은 해제(none-selected 허용,
 * 인라인 라디오와 동일 규칙). 라디오 항목이 아니면 false.
 */
export function toggleRadioAt(editor: Editor, liPos: number): boolean {
	const { state } = editor;
	const node = state.doc.nodeAt(liPos);
	if (
		!node ||
		node.type.name !== 'listItem' ||
		node.attrs.boxKind !== 'radio'
	) {
		return false;
	}
	const $li = state.doc.resolve(liPos);
	const parentList = $li.parent;
	const tr = state.tr;
	if (node.attrs.checked === true) {
		tr.setNodeMarkup(liPos, undefined, { ...node.attrs, checked: false });
	} else {
		let offset = $li.start();
		parentList.forEach((child) => {
			const childPos = offset;
			offset += child.nodeSize;
			if (child.type.name !== 'listItem' || child.attrs.boxKind !== 'radio')
				return;
			if (childPos === liPos) {
				tr.setNodeMarkup(childPos, undefined, {
					...child.attrs,
					checked: true
				});
			} else if (child.attrs.checked === true) {
				tr.setNodeMarkup(childPos, undefined, {
					...child.attrs,
					checked: false
				});
			}
		});
	}
	editor.view.dispatch(tr);
	return true;
}
```

- [ ] **Step 4: plugin.ts 작성**

Create `app/src/lib/editor/listBox/plugin.ts`:

```ts
/**
 * ProseMirror 플러그인: boxKind 가 설정된 listItem 에 불릿 숨김 노드
 * 클래스와 체크박스/라디오 위젯을 데코레이션으로 단다. 체크리스트
 * 영역 플러그인(checklist/plugin.ts)과 같은 패턴 — 문서는 변형하지
 * 않고, 상태는 listItem attrs 에서 읽는다. 영역 리스트는 통째로
 * 건너뛴다 (이중 위젯 방지).
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

import { buildCheckbox } from '../checklist/plugin.js';
import { getExcludedListRanges, posInExcludedList } from './regions.js';

export interface ListBoxPluginOptions {
	/** 체크박스 위젯 클릭. liPos 는 listItem 노드 위치. */
	onToggleCheck: (liPos: number) => void;
	/** 라디오 위젯 클릭. liPos 는 listItem 노드 위치. */
	onToggleRadio: (liPos: number) => void;
}

export const listBoxPluginKey = new PluginKey<DecorationSet>('tomboyListBox');

/** 원형 라디오 위젯 — buildCheckbox 와 같은 contentStart(liPos+2) 전제. */
function buildRadio(
	view: EditorView,
	getPos: () => number | undefined,
	selected: boolean,
	onToggle: (liPos: number) => void
): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = selected
		? 'tomboy-radio-box is-selected'
		: 'tomboy-radio-box';
	btn.setAttribute('contenteditable', 'false');
	btn.setAttribute('data-no-drag', '');
	btn.setAttribute('aria-label', selected ? '선택 해제' : '선택');
	btn.addEventListener('mousedown', (e) => {
		e.preventDefault();
		e.stopPropagation();
	});
	btn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		const p = getPos();
		if (p == null) return;
		const liPos = p - 2; // 위젯은 contentStart(liPos+2)에 놓임
		const node = view.state.doc.nodeAt(liPos);
		if (!node || node.type.name !== 'listItem') return;
		onToggle(liPos);
	});
	return btn;
}

function buildDecorations(
	doc: PMNode,
	options: ListBoxPluginOptions
): DecorationSet {
	const decos: Decoration[] = [];
	const excluded = getExcludedListRanges(doc);
	doc.descendants((node, pos) => {
		if (
			node.type.name === 'bulletList' &&
			posInExcludedList(excluded, pos)
		) {
			return false; // 영역 리스트 통째 skip (중첩 자식 포함)
		}
		if (node.type.name !== 'listItem') return true;
		const kind = node.attrs?.boxKind;
		if (kind !== 'checkbox' && kind !== 'radio') return true;
		const firstChild = node.firstChild;
		if (!firstChild || firstChild.type.name !== 'paragraph') return true;
		const liPos = pos;
		const liEnd = liPos + node.nodeSize;
		const contentStart = liPos + 2;
		const checked = node.attrs.checked === true;
		if (kind === 'checkbox') {
			decos.push(
				Decoration.node(liPos, liEnd, {
					class: checked
						? 'tomboy-checkbox-item is-checked'
						: 'tomboy-checkbox-item'
				})
			);
			decos.push(
				Decoration.widget(
					contentStart,
					(view, getPos) =>
						buildCheckbox(view, getPos, checked, options.onToggleCheck),
					{
						side: -1,
						ignoreSelection: true,
						key: `tomboy-listbox-cb-${liPos}-${checked ? 'on' : 'off'}`
					}
				)
			);
		} else {
			decos.push(
				Decoration.node(liPos, liEnd, {
					class: checked
						? 'tomboy-radio-item is-selected'
						: 'tomboy-radio-item'
				})
			);
			decos.push(
				Decoration.widget(
					contentStart,
					(view, getPos) =>
						buildRadio(view, getPos, checked, options.onToggleRadio),
					{
						side: -1,
						ignoreSelection: true,
						key: `tomboy-listbox-rd-${liPos}-${checked ? 'on' : 'off'}`
					}
				)
			);
		}
		return true;
	});
	return DecorationSet.create(doc, decos);
}

export function createListBoxPlugin(
	options: ListBoxPluginOptions
): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: listBoxPluginKey,
		state: {
			init(_, state) {
				return buildDecorations(state.doc, options);
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				return buildDecorations(newState.doc, options);
			}
		},
		props: {
			decorations(state) {
				return listBoxPluginKey.getState(state) ?? null;
			}
		}
	});
}
```

- [ ] **Step 5: index.ts에 옵션 + 플러그인 등록**

`app/src/lib/editor/listBox/index.ts` — Extension을 옵션형으로 확장:

```ts
import { Extension } from '@tiptap/core';

import { createListBoxInputRules } from './inputRules.js';
import {
	createListBoxPlugin,
	listBoxPluginKey,
	type ListBoxPluginOptions
} from './plugin.js';

export { getExcludedListRanges, posInExcludedList } from './regions.js';
export { toggleRadioAt } from './commands.js';
export { listBoxPluginKey };
export type { ListBoxPluginOptions };

export const TomboyListBox = Extension.create<ListBoxPluginOptions>({
	name: 'tomboyListBox',

	addOptions() {
		return {
			onToggleCheck: () => {},
			onToggleRadio: () => {}
		};
	},

	addInputRules() {
		return createListBoxInputRules();
	},

	addKeyboardShortcuts() {
		return {
			// 내용 맨 앞 Backspace → 박스 제거(일반 불릿 복원). 그 외엔
			// false 반환으로 기존 리스트 Backspace 체인에 폴스루.
			Backspace: () => {
				const { state } = this.editor;
				const { $from, empty } = state.selection;
				if (!empty || $from.parentOffset !== 0) return false;
				if ($from.parent.type.name !== 'paragraph' || $from.depth < 2)
					return false;
				const li = $from.node(-1);
				if (li.type.name !== 'listItem' || !li.attrs.boxKind) return false;
				if ($from.index(-1) !== 0) return false;
				const liPos = $from.before(-1);
				return this.editor.commands.command(({ tr, dispatch }) => {
					if (dispatch) {
						tr.setNodeMarkup(liPos, undefined, {
							...li.attrs,
							boxKind: null,
							checked: false
						});
					}
					return true;
				});
			}
		};
	},

	addProseMirrorPlugins() {
		return [createListBoxPlugin(this.options)];
	}
});
```

(파일 헤더 주석은 그대로 유지 — Task 4 대비 변경점은 addOptions / plugin re-export / addProseMirrorPlugins 추가뿐. Backspace 핸들러는 Task 4와 동일.)

- [ ] **Step 6: TomboyEditor.svelte 등록 + CSS**

import 블록 (~line 129 근처)에 추가:

```ts
	import { TomboyListBox, toggleRadioAt } from './listBox/index.js';
```

`TomboyChecklist.configure({...})` 바로 다음에 추가 (~line 677):

```ts
				TomboyListBox.configure({
					onToggleCheck: (liPos) => {
						const ed = editor;
						if (!ed || ed.isDestroyed) return;
						toggleCheckboxAt(ed, liPos);
					},
					onToggleRadio: (liPos) => {
						const ed = editor;
						if (!ed || ed.isDestroyed) return;
						toggleRadioAt(ed, liPos);
					},
				}),
```

체크리스트 CSS 블록 끝(`.tomboy-checkbox-box.is-checked` 룰 다음, ~line 2640)에 추가:

```css
	/* 항목 단위 라디오 — listBox 플러그인이 boxKind='radio' listItem 에
	   .tomboy-radio-item 노드 데코와 첫 문단 시작에 .tomboy-radio-box
	   위젯을 단다. checkbox kind 는 위 체크리스트 CSS 를 그대로 재사용. */
	.tomboy-editor :global(li.tomboy-radio-item) {
		list-style: none;
	}
	.tomboy-editor :global(.tomboy-radio-box) {
		display: inline-block;
		width: 1em;
		height: 1em;
		margin-right: 0.4em;
		padding: 0;
		vertical-align: -0.12em;
		border: 1.5px solid #888;
		border-radius: 50%;
		background: #fff;
		cursor: pointer;
	}
	.tomboy-editor :global(.tomboy-radio-box.is-selected) {
		border-color: #1565c0;
		background: radial-gradient(
			circle,
			#1565c0 0%,
			#1565c0 45%,
			#fff 55%
		);
	}
```

- [ ] **Step 7: 테스트 통과 + 타입 확인**

Run: `cd app && npx vitest run tests/unit/editor/listBox tests/unit/editor/checklistPlugin.test.ts && npm run check`
Expected: 테스트 PASS, svelte-check 에러 0

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/editor/listBox app/src/lib/editor/TomboyEditor.svelte app/tests/unit/editor/listBox/plugin.test.ts
git commit -m "feat(editor): listBox 데코 플러그인 + 라디오 토글 + 에디터 등록"
```

---

### Task 6: copyFormatted 4종 직렬화기 boxKind 지원

**Goal:** 복사 시 boxKind 항목이 마커로 표현되게 — Markdown은 `- [ ]` 태스크 문법, plain/structured는 `[ ] `/`( ) ` 접두, HTML은 `<input>`.

**Files:**
- Modify: `app/src/lib/editor/copyFormatted.ts`
- Test: `app/tests/unit/editor/copyFormatted.test.ts` (확장)

**Acceptance Criteria:**
- [ ] Markdown: `- [x] 우유` / `- (o) 밥` (라디오는 리터럴)
- [ ] Plain: `[x] 우유`, Structured: 불릿 글리프 대신 `[x] ` 마커
- [ ] HTML: `<li><input type="checkbox" disabled checked> …` / `type="radio"`
- [ ] boxKind 없는 항목 출력은 기존과 동일 (회귀 없음)

**Verify:** `cd app && npx vitest run tests/unit/editor/copyFormatted.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/editor/copyFormatted.test.ts`에 추가 (기존 import/헬퍼 패턴 따름):

```ts
describe('boxKind 항목 단위 체크박스/라디오', () => {
	const boxDoc: JSONContent = {
		type: 'doc',
		content: [
			{
				type: 'bulletList',
				content: [
					{
						type: 'listItem',
						attrs: { boxKind: 'checkbox', checked: true },
						content: [
							{ type: 'paragraph', content: [{ type: 'text', text: '우유' }] }
						]
					},
					{
						type: 'listItem',
						attrs: { boxKind: 'radio', checked: false },
						content: [
							{ type: 'paragraph', content: [{ type: 'text', text: '밥' }] }
						]
					},
					{
						type: 'listItem',
						content: [
							{ type: 'paragraph', content: [{ type: 'text', text: '빵' }] }
						]
					}
				]
			}
		]
	};

	it('markdown: 태스크 문법 + 라디오 리터럴', () => {
		expect(tiptapToMarkdown(boxDoc)).toBe('- [x] 우유\n- ( ) 밥\n- 빵');
	});

	it('plain: 접두 마커', () => {
		expect(tiptapToPlainText(boxDoc)).toBe('[x] 우유\n( ) 밥\n빵');
	});

	it('structured: 불릿 글리프 대신 마커', () => {
		expect(tiptapToStructuredText(boxDoc)).toBe('[x] 우유\n( ) 밥\n• 빵');
	});

	it('html: input 요소', () => {
		const html = tiptapToHtml(boxDoc);
		expect(html).toContain(
			'<li><input type="checkbox" disabled checked> <p>우유</p></li>'
		);
		expect(html).toContain('<li><input type="radio" disabled> <p>밥</p></li>');
		expect(html).toContain('<li><p>빵</p></li>');
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/copyFormatted.test.ts`
Expected: 새 테스트 4개 FAIL

- [ ] **Step 3: copyFormatted.ts 수정**

공용 헬퍼 (`getTextNodes` 아래에 추가):

```ts
/** 항목 단위(boxKind) 박스의 텍스트 접두 마커. 없으면 ''. */
function boxPrefix(li: JSONContent): string {
	const kind = li.attrs?.boxKind;
	if (kind === 'checkbox') return li.attrs?.checked ? '[x] ' : '[ ] ';
	if (kind === 'radio') return li.attrs?.checked ? '(o) ' : '( ) ';
	return '';
}
```

`plainNode` switch에 `listItem` 케이스 추가 (default 앞):

```ts
		case 'listItem':
			return boxPrefix(node) + (node.content ?? []).map(plainNode).join('\n');
```

(주의: `case 'listItem':`을 기존 `case 'doc': case 'bulletList': ...` fall-through 그룹에서 빼서 별도 케이스로 둔다.)

`structuredListItem` — 마커 교체:

```ts
function structuredListItem(li: JSONContent, indent: number, marker: string): string {
	const box = boxPrefix(li);
	const effectiveMarker = box !== '' ? box : marker;
	const pad = '  '.repeat(indent);
	const lines: string[] = [];
	for (const child of li.content ?? []) {
		if (child.type === 'paragraph') {
			lines.push(pad + effectiveMarker + structuredNode(child, indent));
		} else if (child.type === 'bulletList' || child.type === 'orderedList') {
			lines.push(structuredNode(child, indent + 1));
		} else {
			lines.push(pad + effectiveMarker + structuredNode(child, indent));
		}
	}
	return lines.join('\n');
}
```

`htmlNode`의 `listItem` 케이스 교체:

```ts
		case 'listItem': {
			const kind = node.attrs?.boxKind;
			let boxInput = '';
			if (kind === 'checkbox') {
				boxInput = `<input type="checkbox" disabled${node.attrs?.checked ? ' checked' : ''}> `;
			} else if (kind === 'radio') {
				boxInput = `<input type="radio" disabled${node.attrs?.checked ? ' checked' : ''}> `;
			}
			return `<li>${boxInput}${(node.content ?? []).map(htmlNode).join('')}</li>`;
		}
```

`mdListItem` — prefix에 boxPrefix 결합:

```ts
function mdListItem(li: JSONContent, indent: number): string {
	const prefix = ' '.repeat(indent * 2) + '- ' + boxPrefix(li);
```

(마크다운 라디오는 표준 부재 → `( ) `/`(o) ` 리터럴. 체크박스는 `boxPrefix`의 `[x] `가 그대로 GFM 태스크 문법이 된다.)

- [ ] **Step 4: 테스트 통과 + 회귀 확인**

Run: `cd app && npx vitest run tests/unit/editor/copyFormatted.test.ts`
Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/editor/copyFormatted.ts app/tests/unit/editor/copyFormatted.test.ts
git commit -m "feat(editor): copyFormatted 4종에 boxKind 항목 마커 지원"
```

---

### Task 7: 설정 가이드 카드 + 전체 검증

**Goal:** 설정 → 가이드 editor 탭의 기존 "체크박스 · 라디오 · 체크리스트 영역" 카드에 항목 단위 문법을 추가하고, 전체 테스트 + 타입 체크로 마무리.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (~line 2109 카드)

**Acceptance Criteria:**
- [ ] 가이드 카드에 `[[ ]]`/`(( ))` 항목 단위 문법, Enter 상속, Backspace 해제, 라디오 그룹 규칙 설명
- [ ] 낡은 설명("영역 헤더 없이 [[X]] 만 적으면 평문 텍스트로 남습니다") 교체
- [ ] `npm run check` 에러 0, `npm run test` 전체 PASS

**Verify:** `cd app && npm run check && npm run test` → 에러 0 / 전체 PASS

**Steps:**

- [ ] **Step 1: 가이드 카드 수정**

`app/src/routes/settings/+page.svelte`의 "체크박스 · 라디오 · 체크리스트 영역" 카드에서, "3. 체크리스트 영역" `<pre class="snippet">` 다음에 추가:

```html
					<p class="info-text"><strong>4. 항목 단위 체크박스/라디오 (불릿 교체)</strong> —
						리스트 항목 <strong>내용 맨 앞</strong>에서 <code>[[ ]]</code> / <code>[[x]]</code> 를
						입력하면 그 항목의 불릿이 통째 체크박스로, <code>(( ))</code> / <code>((o))</code> 를
						입력하면 라디오 버튼으로 바뀝니다. <code>체크리스트:</code> 헤더 없이 항목 하나씩
						켤 수 있습니다.</p>
					<pre class="snippet">- [[ ]] 우유   ← ☐ 우유
- (( )) 빵    ← ○ 빵</pre>
```

`guide-list`의 마지막 `<li>`("영역 헤더 없이 <code>[[X]]</code> 만 적으면 평문 텍스트로 남습니다 (의미 없음).")를 다음 3개로 교체:

```html
						<li>항목 단위 라디오는 <strong>같은 리스트의 직계 형제끼리</strong> 한 개만
							선택됩니다 (선택된 것을 다시 클릭하면 해제). 중첩 하위 리스트는 별도 그룹.</li>
						<li>항목 단위 박스에서 <kbd>Enter</kbd> 로 새 항목을 만들면 같은 종류(미체크)로
							이어집니다. 일반 불릿으로 되돌리려면 항목 내용 맨 앞에서 <kbd>Backspace</kbd>.</li>
						<li>저장 형식: 체크박스 <code>[[ ]]</code> / <code>[[X]]</code>, 라디오
							<code>(( ))</code> / <code>((O))</code> 마커가 항목 앞에 붙습니다. 리스트 항목
							맨 앞이 아닌 곳의 <code>[[X]]</code> / <code>(( ))</code> 는 평문 텍스트로 남습니다.</li>
```

- [ ] **Step 2: 전체 검증**

Run: `cd app && npm run check`
Expected: 에러 0

Run: `cd app && npm run test`
Expected: 전체 PASS (기존 3251개 + 신규)

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(guide): 항목 단위 체크박스/라디오([[ ]]/(( ))) 가이드 추가"
```
