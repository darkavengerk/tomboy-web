# Inline Checkbox Atomic Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 노트 본문에서 `[ ]` / `[x]` 를 타이핑하거나 paste 하면 클릭으로 토글 가능한 atomic ProseMirror 노드 `inlineCheckbox` 로 변환. `.note` XML 라운드트립은 archiver 한 곳에서 텍스트 ↔ 노드로 변환.

**Architecture:** 각주 마커 (`footnoteMarker`) 와 동일한 atomic 노드 패턴을 미러. 캐럿 진입 불가 (`atom: true`), 부분 삭제 불가 (`nodeSize=1`), mark 안 받음 (`marks: ''`). archiver 한 곳에서 `\[([ xX])\]` 텍스트 ↔ 노드 split + serialize. NodeView 의 `mousedown` 핸들러가 PM `setNodeAttribute` 트랜잭션을 dispatch. 입력은 input rule + paste transform 두 경로.

**Tech Stack:** TipTap 3 (`Node.create`, `InputRule`, NodeView), ProseMirror Plugin (`transformPasted`), SvelteKit, vitest.

**Spec:** [docs/superpowers/specs/2026-05-25-inline-checkbox-node-design.md](../specs/2026-05-25-inline-checkbox-node-design.md)

---

## File Structure

```
app/src/lib/editor/inlineCheckbox/
├── node.ts        # Node.create + input rule + paste transform + NodeView
└── index.ts       # export TomboyInlineCheckbox = [InlineCheckbox]

app/tests/unit/core/
└── archiverInlineCheckbox.test.ts        # XML ↔ JSON 라운드트립

app/tests/unit/editor/inlineCheckbox/
└── node.test.ts                          # 스키마/NodeView/input/paste/click
```

**Modified files (integration):**
- `app/src/lib/core/noteContentArchiver.ts` — split helper + 직렬화 분기 3 곳 + getPlainText 분기
- `app/src/lib/editor/copyFormatted.ts` — `getTextNodes`, `mdNode`, `htmlNode` 3 곳 분기
- `app/src/lib/schedule/parseSchedule.ts` — `inlineText` 워커 분기
- `app/src/lib/editor/TomboyEditor.svelte` — extension 등록 + CSS
- `app/tests/unit/editor/copyFormatted.test.ts` — 4 개 serializer 케이스

---

### Task 1: `InlineCheckbox` 노드 스켈레톤 + 기본 NodeView

**Goal:** atomic inline 노드 `inlineCheckbox` 정의 + 정적 NodeView. 토글/input/paste 는 후속 태스크.

**Files:**
- Create: `app/src/lib/editor/inlineCheckbox/node.ts`
- Create: `app/src/lib/editor/inlineCheckbox/index.ts`
- Create: `app/tests/unit/editor/inlineCheckbox/node.test.ts`

**Acceptance Criteria:**
- [ ] Node.create with `name='inlineCheckbox', group='inline', inline=true, atom=true, selectable=true, marks=''`
- [ ] attrs `{ checked: { default: false } }`
- [ ] `parseHTML`: `span.tomboy-inline-checkbox` 매칭, `data-checked='true'` 면 `checked: true`
- [ ] `renderHTML`: `['span', { class: 'tomboy-inline-checkbox', 'data-checked': 'true'|'false' }]`
- [ ] NodeView: `<span class="tomboy-inline-checkbox" data-checked="..">`, `contentEditable='false'`, `update()` 가 `data-checked` 만 갱신 (토글 없음)
- [ ] `TomboyInlineCheckbox = [InlineCheckbox]` 배열 export
- [ ] 스키마 / parseHTML / renderHTML / NodeView 단위 테스트 PASS

**Verify:** `cd app && npm run test -- tests/unit/editor/inlineCheckbox/node.test.ts` → schema/NodeView tests PASS

**Steps:**

- [ ] **Step 1: 실패 테스트 — 스키마**

`app/tests/unit/editor/inlineCheckbox/node.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyInlineCheckbox } from '../../../../src/lib/editor/inlineCheckbox';

function makeEditor(content: any = { type: 'doc', content: [{ type: 'paragraph' }] }) {
	return new Editor({
		extensions: [StarterKit, ...TomboyInlineCheckbox],
		content
	});
}

describe('inlineCheckbox schema', () => {
	it('creates an atomic inline node with checked default false', () => {
		const editor = makeEditor();
		const type = editor.schema.nodes.inlineCheckbox;
		expect(type).toBeDefined();
		expect(type.isAtom).toBe(true);
		expect(type.isInline).toBe(true);
		expect(type.spec.selectable).toBe(true);
		expect(type.spec.marks).toBe('');
		const node = type.create({ checked: false });
		expect(node.attrs.checked).toBe(false);
		expect(node.nodeSize).toBe(1);
		editor.destroy();
	});

	it('preserves checked=true through doc round-trip', () => {
		const doc = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '할 일 ' },
						{ type: 'inlineCheckbox', attrs: { checked: true } }
					]
				}
			]
		};
		const editor = makeEditor(doc);
		const para = editor.state.doc.firstChild!;
		const cb = para.lastChild!;
		expect(cb.type.name).toBe('inlineCheckbox');
		expect(cb.attrs.checked).toBe(true);
		editor.destroy();
	});
});

describe('inlineCheckbox NodeView', () => {
	it('renders <span class="tomboy-inline-checkbox" data-checked="false"> for unchecked', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [{ type: 'inlineCheckbox', attrs: { checked: false } }]
				}
			]
		});
		editor.view.updateState(editor.view.state); // force NodeView
		const dom = editor.view.dom.querySelector('.tomboy-inline-checkbox');
		expect(dom).not.toBeNull();
		expect(dom!.getAttribute('data-checked')).toBe('false');
		editor.destroy();
	});

	it('renders data-checked="true" for checked', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [{ type: 'inlineCheckbox', attrs: { checked: true } }]
				}
			]
		});
		const dom = editor.view.dom.querySelector('.tomboy-inline-checkbox');
		expect(dom!.getAttribute('data-checked')).toBe('true');
		editor.destroy();
	});
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
cd app && npm run test -- tests/unit/editor/inlineCheckbox/node.test.ts
```

Expected: FAIL — `TomboyInlineCheckbox` import 실패 또는 `inlineCheckbox` 노드 정의 없음.

- [ ] **Step 3: 노드 구현**

`app/src/lib/editor/inlineCheckbox/node.ts`:

```ts
/**
 * Inline 체크박스 atomic 노드.
 *
 * 본문 어디서나 [ ] / [x] 입력 → atomic 노드. 캐럿 진입 불가, 부분 삭제
 * 불가. mark 도 받지 않는다. 라운드트립은 archiver
 * (noteContentArchiver.ts) 에서 [ ] / [x] 텍스트 ↔ 노드로 변환.
 *
 * 각주 (FootnoteMarker) 와 동일 패턴 — 차이는 (1) def/ref 위치 분기 없음,
 * (2) attrs 가 label 이 아니라 checked boolean, (3) NodeView 가 클릭
 * 토글 핸들러를 가짐 (Task 6 에서 추가). 본 태스크는 토글 없이 정적
 * NodeView 만.
 */
import { Node } from '@tiptap/core';

export const InlineCheckbox = Node.create({
	name: 'inlineCheckbox',
	group: 'inline',
	inline: true,
	atom: true,
	selectable: true,
	marks: '',

	addAttributes() {
		return {
			checked: { default: false }
		};
	},

	parseHTML() {
		return [
			{
				tag: 'span.tomboy-inline-checkbox',
				getAttrs: (el) => ({
					checked: (el as HTMLElement).getAttribute('data-checked') === 'true'
				})
			}
		];
	},

	renderHTML({ node }) {
		return [
			'span',
			{
				class: 'tomboy-inline-checkbox',
				'data-checked': node.attrs.checked ? 'true' : 'false'
			}
		];
	},

	addNodeView() {
		return ({ node }) => {
			const dom = document.createElement('span');
			dom.className = 'tomboy-inline-checkbox';
			dom.setAttribute('data-checked', node.attrs.checked ? 'true' : 'false');
			dom.contentEditable = 'false';
			return {
				dom,
				update(updatedNode) {
					if (updatedNode.type.name !== 'inlineCheckbox') return false;
					dom.setAttribute(
						'data-checked',
						updatedNode.attrs.checked ? 'true' : 'false'
					);
					return true;
				}
			};
		};
	}
});
```

- [ ] **Step 4: index.ts 작성**

`app/src/lib/editor/inlineCheckbox/index.ts`:

```ts
import { InlineCheckbox } from './node.js';

export { InlineCheckbox };

export const TomboyInlineCheckbox = [InlineCheckbox];
```

- [ ] **Step 5: 테스트 PASS 확인**

```bash
cd app && npm run test -- tests/unit/editor/inlineCheckbox/node.test.ts
```

Expected: PASS — schema(2) + NodeView(2) = 4 tests pass.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/inlineCheckbox/ app/tests/unit/editor/inlineCheckbox/
git commit -m "feat(inline-checkbox): atomic 노드 + stub NodeView"
```

---

### Task 2: Archiver 읽기 — `[ ]` / `[x]` 텍스트 → 노드 split

**Goal:** `noteContentArchiver.ts` 의 `appendInlineNodes` 가 텍스트 안의 `\[([ xX])\]` 패턴을 `inlineCheckbox` 노드로 split. 좌우 텍스트의 mark 는 보존, 노드 자체는 mark 받지 않음.

**Files:**
- Modify: `app/src/lib/core/noteContentArchiver.ts:48-92` (정규식 + splitter 헬퍼 추가), `app/src/lib/core/noteContentArchiver.ts:377-405` (`appendInlineNodes`)
- Create: `app/tests/unit/core/archiverInlineCheckbox.test.ts`

**Acceptance Criteria:**
- [ ] `INLINE_CHECKBOX_SPLIT_RE = /\[([ xX])\]/g` 모듈 상수
- [ ] `splitInlineCheckboxesInText(text, marks)` 헬퍼: footnote splitter 와 동일 패턴, 매치마다 `{type:'inlineCheckbox', attrs:{checked: <bool>}}` emit
- [ ] `appendInlineNodes` 가 footnote split **후** inline-checkbox split 도 적용 (체이닝)
- [ ] `[x]` / `[X]` → `checked: true`, `[ ]` → `checked: false`
- [ ] mark-crossing: `<bold>[ ]</bold>` → bold 텍스트 → checkbox 노드 → bold 텍스트 분리 (마크는 좌우만, 노드는 mark 0)
- [ ] 연속: `[ ][x]` → 노드 두 개
- [ ] 테스트: 단순/대문자/mark-crossing/연속/혼합 (`[ ]` + `[^N]` 같이)

**Verify:** `cd app && npm run test -- tests/unit/core/archiverInlineCheckbox.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패 테스트**

`app/tests/unit/core/archiverInlineCheckbox.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deserializeContent } from '../../../src/lib/core/noteContentArchiver';

function paragraphInlines(doc: any, idx = 1) {
	return doc.content[idx].content;
}

describe('archiver: [ ]/[x] text → inlineCheckbox node', () => {
	it('parses [ ] as unchecked inlineCheckbox', () => {
		const xml = `<note-content version="0.1">제목\n[ ] 우유 사기</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines[0]).toEqual({
			type: 'inlineCheckbox',
			attrs: { checked: false }
		});
		expect(inlines[1]).toEqual({ type: 'text', text: ' 우유 사기' });
	});

	it('parses [x] as checked inlineCheckbox', () => {
		const xml = `<note-content version="0.1">제목\n[x] 끝난 일</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines[0]).toEqual({
			type: 'inlineCheckbox',
			attrs: { checked: true }
		});
	});

	it('parses uppercase [X] as checked', () => {
		const xml = `<note-content version="0.1">제목\n[X] 대문자</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines[0].attrs.checked).toBe(true);
	});

	it('handles mark-crossing — bold runs split around the checkbox', () => {
		const xml = `<note-content version="0.1">제목\n<bold>중요 [ ] 작업</bold></note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		// expect: bold "중요 " | inlineCheckbox | bold " 작업"
		expect(inlines).toHaveLength(3);
		expect(inlines[0].type).toBe('text');
		expect(inlines[0].text).toBe('중요 ');
		expect(inlines[0].marks?.[0]?.type).toBe('bold');
		expect(inlines[1].type).toBe('inlineCheckbox');
		expect(inlines[1].attrs.checked).toBe(false);
		expect(inlines[1].marks).toBeUndefined();
		expect(inlines[2].type).toBe('text');
		expect(inlines[2].text).toBe(' 작업');
		expect(inlines[2].marks?.[0]?.type).toBe('bold');
	});

	it('handles consecutive [ ][x] as two adjacent nodes', () => {
		const xml = `<note-content version="0.1">제목\n[ ][x]</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		expect(inlines).toHaveLength(2);
		expect(inlines[0].type).toBe('inlineCheckbox');
		expect(inlines[0].attrs.checked).toBe(false);
		expect(inlines[1].type).toBe('inlineCheckbox');
		expect(inlines[1].attrs.checked).toBe(true);
	});

	it('coexists with footnote markers in the same text', () => {
		const xml = `<note-content version="0.1">제목\n[ ] 작업 [^1]</note-content>`;
		const doc = deserializeContent(xml);
		const inlines = paragraphInlines(doc);
		const types = inlines.map((n: any) => n.type);
		expect(types).toContain('inlineCheckbox');
		expect(types).toContain('footnoteMarker');
	});
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
cd app && npm run test -- tests/unit/core/archiverInlineCheckbox.test.ts
```

Expected: FAIL — `[ ]` / `[x]` 가 그대로 text 로 남아 있어 `inlineCheckbox` 노드가 없음.

- [ ] **Step 3: archiver 수정 — 정규식 + splitter**

`app/src/lib/core/noteContentArchiver.ts`, `FOOTNOTE_SPLIT_RE` 아래 (line 52 근처) 에 추가:

```ts
// Inline-checkbox 패턴. `[ ]` (공백 1 개) 또는 `[x]` / `[X]`.
// 좌우 텍스트는 mark 를 유지하고, 매치 자리에 atomic 노드를 삽입.
const INLINE_CHECKBOX_SPLIT_RE = /\[([ xX])\]/g;

/**
 * 텍스트 안의 [ ]/[x] 패턴을 inlineCheckbox 노드로 split.
 * splitFootnotesInText 와 동일 구조 — atomic 노드는 mark 안 받음,
 * 좌우 텍스트만 원본 mark 유지.
 */
function splitInlineCheckboxesInText(
	text: string,
	marks: InlineMark[] | undefined
): JSONContent[] {
	INLINE_CHECKBOX_SPLIT_RE.lastIndex = 0;
	const out: JSONContent[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = INLINE_CHECKBOX_SPLIT_RE.exec(text)) !== null) {
		if (m.index > last) {
			const piece: JSONContent = { type: 'text', text: text.slice(last, m.index) };
			if (marks) piece.marks = marks;
			out.push(piece);
		}
		const checked = m[1] === 'x' || m[1] === 'X';
		out.push({ type: 'inlineCheckbox', attrs: { checked } });
		last = m.index + m[0].length;
	}
	if (last === 0) {
		const piece: JSONContent = { type: 'text', text };
		if (marks) piece.marks = marks;
		return [piece];
	}
	if (last < text.length) {
		const piece: JSONContent = { type: 'text', text: text.slice(last) };
		if (marks) piece.marks = marks;
		out.push(piece);
	}
	return out;
}
```

- [ ] **Step 4: `appendInlineNodes` 체이닝**

같은 파일, `appendInlineNodes` 안의 split 처리부 (line ~385 근처) 를 수정:

```ts
function appendInlineNodes(nodes: JSONContent[]) {
	for (const n of nodes) {
		if (n.type === 'text' && typeof n.text === 'string') {
			if (n.text.length === 0) continue;
			// 1) 각주 split (footnoteMarker) → 2) 인라인 체크박스 split.
			// 각주가 분리한 텍스트 조각 각각에 대해 체크박스 패턴을 다시 split.
			const fnSplit = splitFootnotesInText(n.text, n.marks);
			const split: JSONContent[] = [];
			for (const piece of fnSplit) {
				if (piece.type === 'text' && typeof piece.text === 'string') {
					split.push(...splitInlineCheckboxesInText(piece.text, piece.marks));
				} else {
					split.push(piece);
				}
			}
			if (split.length === 1 && split[0].type === 'text') {
				appendTextWithNewlines(split[0]);
			} else {
				for (const piece of split) {
					if (piece.type === 'text') {
						appendTextWithNewlines(piece);
					} else {
						currentInline.push(piece);
						absorbNextNewline = false;
						lastTextEndedWithNewline = false;
					}
				}
			}
		} else {
			currentInline.push(n);
			absorbNextNewline = false;
			lastTextEndedWithNewline = false;
		}
	}
}
```

- [ ] **Step 5: `scanForNextRunMarks` 확장 — `inlineCheckbox` 도 마크 닫기 트리거**

같은 파일, line ~162 근처:

```ts
for (const inline of b.content ?? []) {
	if (inline.type === 'text') return inline.marks ?? [];
	if (inline.type === 'hardBreak') return [];
	if (inline.type === 'footnoteMarker') return [];
	if (inline.type === 'inlineCheckbox') return [];
}
```

- [ ] **Step 6: 테스트 PASS 확인**

```bash
cd app && npm run test -- tests/unit/core/archiverInlineCheckbox.test.ts
```

Expected: PASS — 6 tests pass.

- [ ] **Step 7: 회귀 — archiver 전체 테스트**

```bash
cd app && npm run test -- tests/unit/core/
```

Expected: 기존 archiver 테스트 모두 PASS (각주 round-trip 포함).

- [ ] **Step 8: 커밋**

```bash
git add app/src/lib/core/noteContentArchiver.ts app/tests/unit/core/archiverInlineCheckbox.test.ts
git commit -m "feat(inline-checkbox): archiver 읽기 — [ ]/[x] 텍스트를 노드로 split"
```

---

### Task 3: Archiver 쓰기 — 노드 → `[ ]` / `[x]` 텍스트

**Goal:** 직렬화 시 `inlineCheckbox` 노드를 `[ ]` / `[x]` 텍스트로 출력. `getPlainText` 도 동일.

**Files:**
- Modify: `app/src/lib/core/noteContentArchiver.ts:228-240` (`serializeContent` 의 paragraph 직렬화 분기), `:720-734` (`serializeInlineContent` writeTextNode 직렬화 분기), `:916-922` (`getPlainText`)
- Modify: `app/tests/unit/core/archiverInlineCheckbox.test.ts` (round-trip 케이스 추가)

**Acceptance Criteria:**
- [ ] 두 직렬화 루프 모두 `inlineCheckbox` 노드 만나면 `closeAll()` + `[ ]`/`[x]` 텍스트 emit
- [ ] `getPlainText` 가 `inlineCheckbox` → `[ ]` / `[x]`
- [ ] Round-trip: XML `[ ]` → JSON → XML 동일
- [ ] Round-trip with mark: `<bold>중요 [x] 작업</bold>` → JSON 3 인라인 → 다시 `<bold>중요 [x] 작업</bold>`
- [ ] 직렬화 시 nullable `attrs?.checked` 가 `false` 로 정규화 (TipTap default attr 처리)

**Verify:** `cd app && npm run test -- tests/unit/core/archiverInlineCheckbox.test.ts` → all PASS (read + write + round-trip)

**Steps:**

- [ ] **Step 1: round-trip 실패 테스트 추가**

`app/tests/unit/core/archiverInlineCheckbox.test.ts` 에 추가:

```ts
import { serializeContent } from '../../../src/lib/core/noteContentArchiver';

describe('archiver: inlineCheckbox node → [ ]/[x] text', () => {
	it('serializes unchecked node to [ ]', () => {
		const doc = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'inlineCheckbox', attrs: { checked: false } },
						{ type: 'text', text: ' 우유' }
					]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('[ ] 우유');
	});

	it('serializes checked node to [x]', () => {
		const doc = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [{ type: 'inlineCheckbox', attrs: { checked: true } }]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('[x]');
	});

	it('round-trips simple [ ]', () => {
		const xml = `<note-content version="0.1">제목\n[ ] 우유</note-content>`;
		const doc = deserializeContent(xml);
		const back = serializeContent(doc);
		expect(back).toContain('[ ] 우유');
	});

	it('round-trips with mark crossing — bold splits around checkbox', () => {
		const xml = `<note-content version="0.1">제목\n<bold>중요 [x] 작업</bold></note-content>`;
		const doc = deserializeContent(xml);
		const back = serializeContent(doc);
		// One bold span becomes two on serialize (intentional split):
		expect(back).toMatch(/<bold>중요 <\/bold>\[x\]<bold> 작업<\/bold>/);
	});
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
cd app && npm run test -- tests/unit/core/archiverInlineCheckbox.test.ts
```

Expected: serialize 케이스 4 개 FAIL — `[ ]` / `[x]` 가 출력 안 됨 (현재는 노드를 default branch 가 무시).

- [ ] **Step 3: 최상위 직렬화 분기 추가**

`app/src/lib/core/noteContentArchiver.ts`, `paragraph`/`heading` 인라인 루프 (line ~235 근처):

```ts
} else if (inline.type === 'footnoteMarker') {
	closeAll();
	result += `[^${escapeXmlContent((inline.attrs?.label as string | undefined) ?? '')}]`;
} else if (inline.type === 'inlineCheckbox') {
	// 모든 mark 닫고 [ ]/[x] emit. 다음 text 노드가 mark 를 다시 연다.
	closeAll();
	result += inline.attrs?.checked ? '[x]' : '[ ]';
}
```

- [ ] **Step 4: `serializeInlineContent` 분기**

같은 파일 line ~730 근처:

```ts
} else if (node.type === 'footnoteMarker') {
	closeAll();
	result += `[^${escapeXmlContent((node.attrs?.label as string | undefined) ?? '')}]`;
} else if (node.type === 'inlineCheckbox') {
	closeAll();
	result += node.attrs?.checked ? '[x]' : '[ ]';
}
```

- [ ] **Step 5: `getPlainText` 분기**

같은 파일 line ~918 근처:

```ts
if (node.type === 'footnoteMarker') {
	return `[^${(node.attrs?.label as string | undefined) ?? ''}]`;
}
if (node.type === 'inlineCheckbox') {
	return node.attrs?.checked ? '[x]' : '[ ]';
}
```

- [ ] **Step 6: 테스트 PASS 확인**

```bash
cd app && npm run test -- tests/unit/core/archiverInlineCheckbox.test.ts
```

Expected: PASS — read(6) + serialize(2) + round-trip(2) = 10 tests pass.

- [ ] **Step 7: 회귀 — archiver 전체**

```bash
cd app && npm run test -- tests/unit/core/
```

Expected: 기존 archiver 테스트 (각주 포함) 전부 PASS.

- [ ] **Step 8: 커밋**

```bash
git add app/src/lib/core/noteContentArchiver.ts app/tests/unit/core/archiverInlineCheckbox.test.ts
git commit -m "feat(inline-checkbox): archiver 쓰기 — 노드를 [ ]/[x] 텍스트로 직렬화"
```

---

### Task 4: Input rule — `[ ]` / `[x]` 타이핑 → 노드

**Goal:** 사용자가 `[ ]` / `[x]` / `[X]` 를 본문에 타이핑하면 즉시 노드로 변환. 제목 라인 (`idx(0) === 0`) 에서는 변환 안 함.

**Files:**
- Modify: `app/src/lib/editor/inlineCheckbox/node.ts` — `addInputRules` 추가
- Modify: `app/tests/unit/editor/inlineCheckbox/node.test.ts` — input rule 케이스

**Acceptance Criteria:**
- [ ] `InputRule` with `find: /\[([ xX])\]$/`
- [ ] match[1] === 'x' || 'X' → `checked: true`; match[1] === ' ' → `checked: false`
- [ ] 제목 라인 (`$from.index(0) === 0`) 차단 — `return null`
- [ ] 본문 paragraph 에서 `[ ]` 타이핑 → 1 개 노드, 텍스트 `[ ]` 사라짐
- [ ] 본문 paragraph 에서 `[x]` 타이핑 → checked 노드
- [ ] 제목 라인에서는 `[ ]` 가 텍스트로 남음
- [ ] 모든 단위 테스트 PASS

**Verify:** `cd app && npm run test -- tests/unit/editor/inlineCheckbox/node.test.ts` → schema/NodeView/input tests PASS

**Steps:**

- [ ] **Step 1: 실패 테스트**

`tests/unit/editor/inlineCheckbox/node.test.ts` 에 추가:

```ts
import { InputRule } from '@tiptap/core';

function typeText(editor: Editor, text: string) {
	// Simulate textInput by injecting characters one-by-one through
	// TipTap's command interface — this triggers input rules.
	for (const ch of text) {
		editor.commands.insertContent(ch);
	}
}

describe('inlineCheckbox input rule', () => {
	it('converts [ ] typed in body to unchecked node', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		// Cursor in the empty body paragraph.
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, '[ ]');
		const para = editor.state.doc.lastChild!;
		expect(para.childCount).toBe(1);
		expect(para.firstChild!.type.name).toBe('inlineCheckbox');
		expect(para.firstChild!.attrs.checked).toBe(false);
		editor.destroy();
	});

	it('converts [x] typed in body to checked node', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, '[x]');
		const para = editor.state.doc.lastChild!;
		expect(para.firstChild!.attrs.checked).toBe(true);
		editor.destroy();
	});

	it('converts [X] (uppercase) to checked node', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, '[X]');
		const para = editor.state.doc.lastChild!;
		expect(para.firstChild!.attrs.checked).toBe(true);
		editor.destroy();
	});

	it('does NOT convert in the title line (idx=0)', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] }]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);
		typeText(editor, ' [ ]');
		const para = editor.state.doc.firstChild!;
		// 제목 그대로 — 노드 없음.
		expect(para.textContent).toContain('[ ]');
		const hasCheckbox = (() => {
			let found = false;
			para.descendants((n) => {
				if (n.type.name === 'inlineCheckbox') found = true;
			});
			return found;
		})();
		expect(hasCheckbox).toBe(false);
		editor.destroy();
	});
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
cd app && npm run test -- tests/unit/editor/inlineCheckbox/node.test.ts
```

Expected: 4 input rule 테스트 FAIL — 현재 input rule 없음.

- [ ] **Step 3: `node.ts` 에 input rule 추가**

`app/src/lib/editor/inlineCheckbox/node.ts`, 상단 import 보강:

```ts
import { InputRule, Node } from '@tiptap/core';
```

그리고 Node.create 안에 `addInputRules` 추가 (renderHTML 다음):

```ts
addInputRules() {
	const type = this.type;
	return [
		new InputRule({
			find: /\[([ xX])\]$/,
			handler: ({ state, range, match }) => {
				const $from = state.doc.resolve(range.from);
				// 제목 (top-level idx 0) 차단 — 각주와 동일.
				if ($from.index(0) === 0) return null;
				const checked = match[1] === 'x' || match[1] === 'X';
				const node = type.create({ checked });
				state.tr.replaceWith(range.from, range.to, node);
			}
		})
	];
},
```

- [ ] **Step 4: 테스트 PASS 확인**

```bash
cd app && npm run test -- tests/unit/editor/inlineCheckbox/node.test.ts
```

Expected: PASS — schema(2) + NodeView(2) + input(4) = 8 tests pass.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/inlineCheckbox/node.ts app/tests/unit/editor/inlineCheckbox/node.test.ts
git commit -m "feat(inline-checkbox): input rule — [ ]/[x] 타이핑 → 노드 (제목 차단)"
```

---

### Task 5: Paste transform — fragment 안 텍스트 split

**Goal:** 외부에서 paste 되는 slice 안의 `[ ]` / `[x]` 텍스트를 노드로 split. destination 이 제목 라인이면 skip.

**Files:**
- Modify: `app/src/lib/editor/inlineCheckbox/node.ts` — `addProseMirrorPlugins`
- Modify: `app/tests/unit/editor/inlineCheckbox/node.test.ts` — paste 케이스

**Acceptance Criteria:**
- [ ] `addProseMirrorPlugins` 가 paste transform plugin 등록
- [ ] `transformPasted: (slice, view) => Slice` — destination 가 제목이면 원본 반환
- [ ] fragment 안 텍스트 노드를 `\[([ xX])\]` 패턴으로 split → inlineCheckbox 노드 삽입, 좌우 텍스트 mark 보존
- [ ] 중첩 노드 (예: bulletList → listItem → paragraph → text) 안의 텍스트도 재귀적으로 변환
- [ ] 테스트: paste 본문 시 변환, 제목 destination 일 때 skip, 중첩 fragment 처리

**Verify:** `cd app && npm run test -- tests/unit/editor/inlineCheckbox/node.test.ts` → paste tests PASS

**Steps:**

- [ ] **Step 1: 실패 테스트**

```ts
import { Slice, Fragment } from '@tiptap/pm/model';

function makeSlice(editor: Editor, paragraphText: string): Slice {
	const schema = editor.schema;
	const paragraph = schema.nodes.paragraph.create(
		null,
		schema.text(paragraphText)
	);
	return new Slice(Fragment.from(paragraph), 1, 1);
}

describe('inlineCheckbox paste transform', () => {
	it('splits [ ] / [x] in pasted slice into nodes', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		// 본문 paragraph 에 커서.
		editor.commands.setTextSelection(editor.state.doc.content.size);

		const slice = makeSlice(editor, '할 일 [ ] 라면 [x] 끓이기');
		// Apply the plugin's transformPasted via view.props.
		const transformed = editor.view.someProp(
			'transformPasted',
			(fn: any) => fn(slice, editor.view)
		) as Slice;
		const para = transformed.content.firstChild!;
		const types = [];
		para.forEach((n) => types.push({ type: n.type.name, attrs: n.attrs }));
		expect(types.map((t) => t.type)).toEqual([
			'text',
			'inlineCheckbox',
			'text',
			'inlineCheckbox',
			'text'
		]);
		expect(types[1].attrs.checked).toBe(false);
		expect(types[3].attrs.checked).toBe(true);
		editor.destroy();
	});

	it('does NOT transform when destination is the title line', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] }]
		});
		// 제목 끝으로 커서 이동 (idx(0) === 0).
		editor.commands.setTextSelection(3);
		const slice = makeSlice(editor, ' [ ]');
		const transformed = editor.view.someProp(
			'transformPasted',
			(fn: any) => fn(slice, editor.view)
		) as Slice;
		// fragment 안에 inlineCheckbox 가 없어야 함.
		let hasCheckbox = false;
		transformed.content.descendants((n) => {
			if (n.type.name === 'inlineCheckbox') hasCheckbox = true;
		});
		expect(hasCheckbox).toBe(false);
		editor.destroy();
	});

	it('recurses into nested list fragments', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		editor.commands.setTextSelection(editor.state.doc.content.size);

		const schema = editor.schema;
		const li = schema.nodes.listItem.create(
			null,
			schema.nodes.paragraph.create(null, schema.text('[ ] 첫 항목'))
		);
		const list = schema.nodes.bulletList.create(null, li);
		const slice = new Slice(Fragment.from(list), 2, 2);

		const transformed = editor.view.someProp(
			'transformPasted',
			(fn: any) => fn(slice, editor.view)
		) as Slice;
		let hasCheckbox = false;
		transformed.content.descendants((n) => {
			if (n.type.name === 'inlineCheckbox') hasCheckbox = true;
		});
		expect(hasCheckbox).toBe(true);
		editor.destroy();
	});
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
cd app && npm run test -- tests/unit/editor/inlineCheckbox/node.test.ts
```

Expected: paste 3 케이스 FAIL.

- [ ] **Step 3: paste transform plugin 구현**

`app/src/lib/editor/inlineCheckbox/node.ts` 상단에 imports 보강:

```ts
import { InputRule, Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as PMNode, type NodeType } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
```

Node.create 안 `addInputRules` 다음에 `addProseMirrorPlugins`:

```ts
addProseMirrorPlugins() {
	const type = this.type;
	return [createPasteTransformPlugin(type)];
},
```

파일 하단에 plugin + 헬퍼:

```ts
const CB_PASTE_RE = /\[([ xX])\]/g;

function transformPastedSlice(slice: Slice, cbType: NodeType): Slice {
	const newContent = transformFragment(slice.content, cbType);
	if (newContent === slice.content) return slice;
	return new Slice(newContent, slice.openStart, slice.openEnd);
}

function transformFragment(frag: Fragment, cbType: NodeType): Fragment {
	const out: PMNode[] = [];
	let changed = false;
	frag.forEach((child) => {
		if (child.isText && typeof child.text === 'string') {
			CB_PASTE_RE.lastIndex = 0;
			const text = child.text;
			let last = 0;
			let m: RegExpExecArray | null;
			let split = false;
			const pieces: PMNode[] = [];
			while ((m = CB_PASTE_RE.exec(text)) !== null) {
				split = true;
				if (m.index > last) {
					pieces.push(child.cut(last, m.index));
				}
				const checked = m[1] === 'x' || m[1] === 'X';
				pieces.push(cbType.create({ checked }));
				last = m.index + m[0].length;
			}
			if (split) {
				if (last < text.length) pieces.push(child.cut(last));
				out.push(...pieces);
				changed = true;
			} else {
				out.push(child);
			}
		} else if (child.content.size > 0) {
			const inner = transformFragment(child.content, cbType);
			if (inner !== child.content) {
				out.push(child.copy(inner));
				changed = true;
			} else {
				out.push(child);
			}
		} else {
			out.push(child);
		}
	});
	if (!changed) return frag;
	return Fragment.fromArray(out);
}

function createPasteTransformPlugin(cbType: NodeType): Plugin {
	return new Plugin({
		props: {
			transformPasted: (slice: Slice, view: EditorView) => {
				// destination 이 제목 (idx 0) 이면 변환 skip.
				const $from = view.state.selection.$from;
				if ($from.depth >= 1 && $from.index(0) === 0) return slice;
				return transformPastedSlice(slice, cbType);
			}
		}
	});
}
```

- [ ] **Step 4: 테스트 PASS 확인**

```bash
cd app && npm run test -- tests/unit/editor/inlineCheckbox/node.test.ts
```

Expected: PASS — 11 tests (schema 2 + NodeView 2 + input 4 + paste 3).

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/inlineCheckbox/node.ts app/tests/unit/editor/inlineCheckbox/node.test.ts
git commit -m "feat(inline-checkbox): paste transform — slice 안 [ ]/[x] split (제목 차단)"
```

---

### Task 6: 클릭 토글 — NodeView `mousedown` → `setNodeAttribute`

**Goal:** NodeView DOM 클릭 시 `checked` 토글. PM transaction 으로 dispatch 하여 undo 가능. `mousedown` + `preventDefault` 로 selection 점프 방지.

**Files:**
- Modify: `app/src/lib/editor/inlineCheckbox/node.ts` — NodeView `mousedown` 핸들러
- Modify: `app/tests/unit/editor/inlineCheckbox/node.test.ts` — click 케이스

**Acceptance Criteria:**
- [ ] `dom.addEventListener('mousedown', handler)` 등록
- [ ] handler 가 `e.preventDefault()` 호출 (selection 점프 차단)
- [ ] handler 가 `view.dispatch(tr.setNodeAttribute(pos, 'checked', next))` 로 토글
- [ ] update() 가 `data-checked` DOM 속성을 새 값으로 갱신
- [ ] click → undo (`editor.commands.undo()`) 로 원래 상태 복원
- [ ] 새 attrs 가 PM doc 에도 반영 (관측 가능)

**Verify:** `cd app && npm run test -- tests/unit/editor/inlineCheckbox/node.test.ts` → click test PASS

**Steps:**

- [ ] **Step 1: 실패 테스트**

```ts
describe('inlineCheckbox click toggle', () => {
	it('toggles checked on mousedown', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [{ type: 'inlineCheckbox', attrs: { checked: false } }]
				}
			]
		});
		const dom = editor.view.dom.querySelector(
			'.tomboy-inline-checkbox'
		) as HTMLElement;
		expect(dom.getAttribute('data-checked')).toBe('false');
		dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		expect(dom.getAttribute('data-checked')).toBe('true');
		// PM doc 도 업데이트?
		const node = editor.state.doc.lastChild!.firstChild!;
		expect(node.attrs.checked).toBe(true);
		editor.destroy();
	});

	it('undo restores prior checked state', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [{ type: 'inlineCheckbox', attrs: { checked: false } }]
				}
			]
		});
		const dom = editor.view.dom.querySelector(
			'.tomboy-inline-checkbox'
		) as HTMLElement;
		dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		expect(editor.state.doc.lastChild!.firstChild!.attrs.checked).toBe(true);
		editor.commands.undo();
		expect(editor.state.doc.lastChild!.firstChild!.attrs.checked).toBe(false);
		editor.destroy();
	});
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
cd app && npm run test -- tests/unit/editor/inlineCheckbox/node.test.ts
```

Expected: click 2 케이스 FAIL — NodeView 에 mousedown handler 없음.

- [ ] **Step 3: NodeView 에 토글 핸들러 추가**

`app/src/lib/editor/inlineCheckbox/node.ts`, `addNodeView` 수정:

```ts
addNodeView() {
	return ({ node, getPos, editor }) => {
		const view = editor.view;
		const getPosFn = getPos as () => number | undefined;
		const dom = document.createElement('span');
		dom.className = 'tomboy-inline-checkbox';
		dom.setAttribute('data-checked', node.attrs.checked ? 'true' : 'false');
		dom.contentEditable = 'false';
		dom.addEventListener('mousedown', (e) => {
			e.preventDefault();
			const pos = getPosFn();
			if (pos == null) return;
			const current = view.state.doc.nodeAt(pos);
			if (!current || current.type.name !== 'inlineCheckbox') return;
			const next = !current.attrs.checked;
			view.dispatch(view.state.tr.setNodeAttribute(pos, 'checked', next));
		});
		return {
			dom,
			update(updatedNode) {
				if (updatedNode.type.name !== 'inlineCheckbox') return false;
				dom.setAttribute(
					'data-checked',
					updatedNode.attrs.checked ? 'true' : 'false'
				);
				return true;
			}
		};
	};
}
```

- [ ] **Step 4: 테스트 PASS 확인**

```bash
cd app && npm run test -- tests/unit/editor/inlineCheckbox/node.test.ts
```

Expected: PASS — 13 tests (schema 2 + NodeView 2 + input 4 + paste 3 + click 2).

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/inlineCheckbox/node.ts app/tests/unit/editor/inlineCheckbox/node.test.ts
git commit -m "feat(inline-checkbox): NodeView mousedown 토글 + undo 지원"
```

---

### Task 7: 하위 소비자 — copyFormatted, parseSchedule

**Goal:** copyFormatted 4 개 serializer 와 parseSchedule inline walker 가 `inlineCheckbox` 노드를 텍스트로 변환. plain / structured / markdown 은 `[ ]`/`[x]`, html 은 `<input type="checkbox" disabled>`.

**Files:**
- Modify: `app/src/lib/editor/copyFormatted.ts:23-29` (`getTextNodes`), `:162-188` (`htmlNode`), `:220-250` (`mdNode`)
- Modify: `app/src/lib/schedule/parseSchedule.ts:67-74` (`inlineText`)
- Modify: `app/tests/unit/editor/copyFormatted.test.ts`

**Acceptance Criteria:**
- [ ] `getTextNodes` 가 `inlineCheckbox` → `[ ]` 또는 `[x]` (plain + structured 자동 커버)
- [ ] `htmlNode` 에 `inlineCheckbox` case: `<input type="checkbox" disabled>` (false) / `<input type="checkbox" disabled checked>` (true)
- [ ] `mdNode` 에 `inlineCheckbox` case: `[ ]` / `[x]` (GFM task list 호환)
- [ ] `parseSchedule.inlineText` 에 `inlineCheckbox` case: `[ ]` / `[x]`
- [ ] copyFormatted.test.ts 에 4 개 serializer × 2 상태 = 8 케이스 추가
- [ ] 회귀 — 전체 테스트 PASS

**Verify:** `cd app && npm run test -- tests/unit/editor/copyFormatted.test.ts tests/unit/schedule/`

**Steps:**

- [ ] **Step 1: copyFormatted 실패 테스트**

`app/tests/unit/editor/copyFormatted.test.ts` 에 추가 (파일 구조는 기존 footnote 테스트 패턴 미러):

```ts
describe('inlineCheckbox serializers', () => {
	const docOf = (checked: boolean) => ({
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
			{
				type: 'paragraph',
				content: [
					{ type: 'text', text: '할 일 ' },
					{ type: 'inlineCheckbox', attrs: { checked } },
					{ type: 'text', text: ' 우유' }
				]
			}
		]
	});

	it('plain text emits [ ] for unchecked', () => {
		expect(tiptapToPlainText(docOf(false))).toContain('[ ]');
	});

	it('plain text emits [x] for checked', () => {
		expect(tiptapToPlainText(docOf(true))).toContain('[x]');
	});

	it('structured text emits [ ] / [x]', () => {
		expect(tiptapToStructuredText(docOf(false))).toContain('[ ]');
		expect(tiptapToStructuredText(docOf(true))).toContain('[x]');
	});

	it('markdown emits [ ] / [x] (GFM task list)', () => {
		expect(tiptapToMarkdown(docOf(false))).toContain('[ ]');
		expect(tiptapToMarkdown(docOf(true))).toContain('[x]');
	});

	it('html emits <input type="checkbox" disabled> for unchecked', () => {
		const html = tiptapToHtml(docOf(false));
		expect(html).toContain('<input type="checkbox" disabled>');
		expect(html).not.toContain('checked');
	});

	it('html emits <input type="checkbox" disabled checked> for checked', () => {
		const html = tiptapToHtml(docOf(true));
		expect(html).toContain('<input type="checkbox" disabled checked>');
	});
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
cd app && npm run test -- tests/unit/editor/copyFormatted.test.ts
```

Expected: 6 case FAIL — `inlineCheckbox` 노드가 default branch (children content) 로 fallthrough 됨.

- [ ] **Step 3: `getTextNodes` 수정**

`app/src/lib/editor/copyFormatted.ts:23` 근처:

```ts
function getTextNodes(node: JSONContent): string {
	if (node.type === 'text') return node.text ?? '';
	if (node.type === 'footnoteMarker') {
		return `[^${(node.attrs?.label as string | undefined) ?? ''}]`;
	}
	if (node.type === 'inlineCheckbox') {
		return node.attrs?.checked ? '[x]' : '[ ]';
	}
	return (node.content ?? []).map(getTextNodes).join('');
}
```

- [ ] **Step 4: `htmlNode` 수정**

`app/src/lib/editor/copyFormatted.ts:171` 근처, `footnoteMarker` case 뒤:

```ts
case 'inlineCheckbox': {
	const checked = node.attrs?.checked ? ' checked' : '';
	return `<input type="checkbox" disabled${checked}>`;
}
```

- [ ] **Step 5: `mdNode` 수정**

`app/src/lib/editor/copyFormatted.ts:241` 근처, `footnoteMarker` case 뒤:

```ts
case 'inlineCheckbox': {
	return node.attrs?.checked ? '[x]' : '[ ]';
}
```

- [ ] **Step 6: `parseSchedule.inlineText` 수정**

`app/src/lib/schedule/parseSchedule.ts:67-74`:

```ts
function inlineText(node: JSONContent): string {
	if (typeof node.text === 'string') return node.text;
	if (node.type === 'footnoteMarker') {
		return `[^${(node.attrs?.label as string | undefined) ?? ''}]`;
	}
	if (node.type === 'inlineCheckbox') {
		return node.attrs?.checked ? '[x]' : '[ ]';
	}
	if (!node.content) return '';
	return node.content.map(inlineText).join('');
}
```

- [ ] **Step 7: 테스트 PASS 확인**

```bash
cd app && npm run test -- tests/unit/editor/copyFormatted.test.ts tests/unit/schedule/
```

Expected: PASS — 새 6 케이스 + 기존 케이스 모두.

- [ ] **Step 8: 커밋**

```bash
git add app/src/lib/editor/copyFormatted.ts app/src/lib/schedule/parseSchedule.ts app/tests/unit/editor/copyFormatted.test.ts
git commit -m "feat(inline-checkbox): copyFormatted + parseSchedule 분기 추가"
```

---

### Task 8: 에디터 통합 — Extension 등록 + CSS + 전체 회귀

**Goal:** `TomboyInlineCheckbox` 를 `TomboyEditor.svelte` 의 extensions 에 추가, `.tomboy-inline-checkbox` CSS 작성. 전체 `npm run test` 와 `npm run check` 통과 확인.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte` — import + extensions 배열 + CSS

**Acceptance Criteria:**
- [ ] `import { TomboyInlineCheckbox } from './inlineCheckbox';` 추가
- [ ] Editor 의 extensions 배열에 `...TomboyInlineCheckbox` 추가 (각주 `...TomboyFootnote` 인접)
- [ ] CSS rule `.tomboy-inline-checkbox` — 14px 정사각형, border, vertical-align baseline, hover/checked 상태
- [ ] `:has` / `[data-checked='true']` selector 로 체크 상태 시각화 (회색 배경 + 흰색 ✓ SVG inline data URL)
- [ ] 모바일 hit-area: `::before` 또는 padding 으로 적어도 24×24 px 터치 영역 확보
- [ ] `cd app && npm run check` → 새 에러 0
- [ ] `cd app && npm run test` → 전체 PASS

**Verify:**
```bash
cd app && npm run check && npm run test
```

**Steps:**

- [ ] **Step 1: extension import + 등록**

`app/src/lib/editor/TomboyEditor.svelte` 의 import 블록에 (각주 import 근처):

```ts
import { TomboyInlineCheckbox } from './inlineCheckbox';
```

extensions 배열에 추가 (각주 다음):

```ts
extensions: [
	// ... existing extensions ...
	...TomboyFootnote,
	...TomboyInlineCheckbox,
	// ...
]
```

- [ ] **Step 2: CSS 작성**

`TomboyEditor.svelte` 의 `<style>` 블록 (각주 스타일 인접) 에:

```css
.tomboy-inline-checkbox {
	display: inline-block;
	width: 14px;
	height: 14px;
	border: 1px solid var(--text-muted, #888);
	border-radius: 2px;
	vertical-align: -2px;
	margin: 0 2px;
	cursor: pointer;
	background: transparent;
	user-select: none;
	position: relative;
	box-sizing: border-box;
	transition: background-color 0.12s ease, border-color 0.12s ease;
}

/* 모바일 hit-area — 보이지 않는 ::before 가 24x24 영역 확보. */
.tomboy-inline-checkbox::before {
	content: '';
	position: absolute;
	top: -5px;
	left: -5px;
	right: -5px;
	bottom: -5px;
}

.tomboy-inline-checkbox[data-checked='true'] {
	background-color: var(--accent, #4a76d4);
	border-color: var(--accent, #4a76d4);
	background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='3 8 7 12 13 4'/></svg>");
	background-size: 12px 12px;
	background-position: center;
	background-repeat: no-repeat;
}

.tomboy-inline-checkbox:hover {
	border-color: var(--accent, #4a76d4);
}
```

- [ ] **Step 3: 타입 체크**

```bash
cd app && npm run check
```

Expected: 새 에러 0 (기존 pre-existing 외).

- [ ] **Step 4: 전체 테스트**

```bash
cd app && npm run test
```

Expected: 전체 PASS — 새 13 + 6 + 회귀 모두.

- [ ] **Step 5: 수동 dev 서버 sanity (선택)**

```bash
cd app && npm run dev
```

브라우저에서:
1. 노트 본문에 `[ ]` 타이핑 → 회색 박스로 변환
2. 박스 클릭 → 채워진 박스 (체크 상태)
3. 다시 클릭 → 해제
4. `[x]` 타이핑 → 채워진 박스 즉시
5. 제목에서 `[ ]` → 텍스트 유지 (변환 안 됨)
6. 저장 → 다시 열기 → 체크 상태 보존
7. Ctrl+Z (toggle 후) → 이전 상태 복원

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(inline-checkbox): TomboyEditor 통합 + CSS (14px 박스, 모바일 hit-area)"
```
