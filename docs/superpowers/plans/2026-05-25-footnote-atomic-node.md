# 각주 마커 atomic 노드 전환 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 각주 `[^N]` 마커를 데코레이션-only 텍스트에서 atomic ProseMirror 노드(`footnoteMarker`)로 전환해 캐럿이 마커 내부에 진입할 수 없게 만들고, 부분 삭제 잔해도 구조적으로 차단한다.

**Architecture:** archiver(`noteContentArchiver.ts`) 한 곳이 외부 텍스트(`[^N]`) ↔ 내부 노드(`footnoteMarker`)의 단일 경계가 된다. 에디터 내부 보호막은 input rule + paste transform. NodeView 는 노드의 부모 위치를 검사해 ref(`<sup>`) 또는 def(`<span>`) 로 렌더한다. `.note` XML 파일 포맷은 변경 없음.

**Tech Stack:** TipTap 3, ProseMirror, Svelte 5, vitest, TypeScript

**Spec:** `docs/superpowers/specs/2026-05-25-footnote-atomic-node-design.md`

---

## File Structure

### 신규
- `app/src/lib/editor/footnote/node.ts` — Node Extension (스키마 + NodeView + input rule + paste transform). 단일 책임: 마커 노드 자체. ~200 LOC.
- `app/tests/unit/editor/footnote/node.test.ts` — node.ts 단위 테스트.
- `app/tests/unit/core/archiverFootnote.test.ts` — archiver round-trip 단위 테스트 (footnote 전용).

### 재작성
- `app/src/lib/editor/footnote/footnotes.ts` — 정규식 → 노드 walk. API 시그니처 보존.
- `app/src/lib/editor/footnote/insertCommand.ts` — 텍스트 op → 노드 op. 알고리즘 동일.
- `app/src/lib/editor/footnote/plugin.ts` — 데코레이션 빌더 삭제, mousedown 클릭 핸들러만 유지.
- `app/src/lib/editor/footnote/index.ts` — extension 등록 재구성 (TomboyFootnote → Node extension import).

### 수정
- `app/src/lib/core/noteContentArchiver.ts` — `appendInlineNodes` 에 footnote split, `serializeInlineContent` 에 노드 핸들러, `getPlainText` 에 노드 핸들러 추가.
- `app/src/lib/editor/copyFormatted.ts` — 4 serializer 에 `footnoteMarker` 분기.
- `app/src/lib/schedule/parseSchedule.ts` — `linearizeDoc` 의 inlineText 가 노드를 `[^N]` 텍스트로 평탄화.
- `app/src/lib/editor/TomboyEditor.svelte` — `.tomboy-fn-bracket` CSS 규칙 삭제 (브래킷 DOM 없음).

### 삭제
- `app/src/lib/editor/footnote/cleanupPlugin.ts`
- `app/tests/unit/editor/footnote/cleanupPlugin.test.ts`

### 업데이트 (기존 테스트 어설션 형태 변경)
- `app/tests/unit/editor/footnote/insertCommand.test.ts` — `paragraphTexts` 헬퍼가 노드를 `[^N]` 으로 평탄화하도록.
- `app/tests/unit/editor/footnote/extensionCommand.test.ts` — 토스트 동작 그대로지만 환경 의존 점검.

---

### Task 1: footnoteMarker 노드 스키마 + 기본 NodeView

**Goal:** atomic inline 노드 타입을 정의하고 TipTap 확장으로 등록한다 (위치 기반 ref/def 분기 없는 stub NodeView 포함).

**Files:**
- Create: `app/src/lib/editor/footnote/node.ts`
- Create: `app/tests/unit/editor/footnote/node.test.ts`

**Acceptance Criteria:**
- [ ] `footnoteMarker` 노드 타입이 schema 에 등록되어 있고 `inline === true`, `isAtom === true`, `selectable === true`.
- [ ] `attrs.label` 이 정의되어 있고 기본값 `''`.
- [ ] `toDOM` 이 `['span', { class: 'tomboy-fn-marker', 'data-label': label }, label]` 형태를 반환 (clipboard/HTML output 용).
- [ ] NodeView 가 부착되어 라이브 doc 에서 노드를 렌더 (이 task 에서는 ref/def 구분 없이 `<sup class="tomboy-fn-ref">N</sup>` 형태로만 렌더 — Task 4 에서 정교화).
- [ ] 새 테스트 파일 `node.test.ts` 의 모든 케이스 통과.

**Verify:** `cd app && npm run test -- footnote/node` → 5/5 통과.

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/editor/footnote/node.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';

let editor: Editor | null = null;
afterEach(() => {
	editor?.destroy();
	editor = null;
});

function makeEditor(content: unknown): Editor {
	const e = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
			TomboyParagraph,
			TomboyListItem,
			TomboyFootnote
		],
		content
	});
	editor = e;
	return e;
}

describe('footnoteMarker schema', () => {
	it('schema 에 footnoteMarker 노드 타입이 등록됨', () => {
		const e = makeEditor({ type: 'doc', content: [{ type: 'paragraph' }] });
		const t = e.schema.nodes.footnoteMarker;
		expect(t).toBeDefined();
		expect(t.isAtom).toBe(true);
		expect(t.isInline).toBe(true);
		expect(t.spec.selectable).toBe(true);
		expect(t.spec.attrs?.label?.default).toBe('');
	});

	it('노드 생성 시 label attr 가 보존됨', () => {
		const e = makeEditor({ type: 'doc', content: [{ type: 'paragraph' }] });
		const node = e.schema.nodes.footnoteMarker.create({ label: '7' });
		expect(node.attrs.label).toBe('7');
	});

	it('JSON 에서 노드를 포함한 doc 가 그대로 라운드트립', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '본문 ' },
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' 끝' }
					]
				}
			]
		});
		const out = e.getJSON();
		const inlines = out.content?.[1]?.content ?? [];
		expect(inlines[1]).toMatchObject({ type: 'footnoteMarker', attrs: { label: '1' } });
	});

	it('toDOM 출력 — span.tomboy-fn-marker', () => {
		const e = makeEditor({ type: 'doc', content: [{ type: 'paragraph' }] });
		const node = e.schema.nodes.footnoteMarker.create({ label: '3' });
		const out = node.type.spec.toDOM!(node) as [string, Record<string, string>, string];
		expect(out[0]).toBe('span');
		expect(out[1].class).toBe('tomboy-fn-marker');
		expect(out[1]['data-label']).toBe('3');
		expect(out[2]).toBe('3');
	});

	it('NodeView 가 DOM 에 마커를 렌더', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '본문 ' },
						{ type: 'footnoteMarker', attrs: { label: '2' } }
					]
				}
			]
		});
		const html = e.view.dom.innerHTML;
		expect(html).toContain('tomboy-fn-ref');
		expect(html).toMatch(/>2<\/sup>|>2<\/span>/);
	});
});
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

Run: `cd app && npm run test -- footnote/node`
Expected: FAIL — `e.schema.nodes.footnoteMarker` undefined.

- [ ] **Step 3: Node 정의 작성** — `app/src/lib/editor/footnote/node.ts`

```ts
/**
 * 각주 마커 atomic 노드.
 *
 * `[^N]` 텍스트가 NOT 아니라 단일 ProseMirror 노드. 캐럿이 안으로 진입할
 * 수 없고(atom) 부분 삭제도 불가. 라운드트립은 archiver
 * (noteContentArchiver.ts) 에서 [^N] 텍스트 ↔ 노드로 변환.
 *
 * 이 파일은 Task 1 에서 스키마만, Task 4 에서 NodeView 의 ref/def 위치
 * 기반 분기, Task 7 에서 input rule + paste transform 을 차례로 채운다.
 */
import { Node } from '@tiptap/core';

export const FootnoteMarker = Node.create({
	name: 'footnoteMarker',
	group: 'inline',
	inline: true,
	atom: true,
	selectable: true,

	addAttributes() {
		return {
			label: { default: '' }
		};
	},

	parseHTML() {
		return [
			{
				tag: 'span.tomboy-fn-marker',
				getAttrs: (el) => ({
					label: (el as HTMLElement).getAttribute('data-label') ?? ''
				})
			}
		];
	},

	renderHTML({ node }) {
		return [
			'span',
			{ class: 'tomboy-fn-marker', 'data-label': node.attrs.label },
			node.attrs.label
		];
	},

	addNodeView() {
		return ({ node }) => {
			// Task 4 에서 위치 기반 ref/def 분기로 교체. 지금은 항상 ref.
			const dom = document.createElement('sup');
			dom.className = 'tomboy-fn-ref';
			dom.textContent = node.attrs.label;
			return { dom };
		};
	}
});
```

- [ ] **Step 4: extension 등록 업데이트** — `app/src/lib/editor/footnote/index.ts`

기존 파일 상단에 import 추가하고 `addExtensions` 로 같이 등록:

```ts
import { Extension } from '@tiptap/core';

import { FootnoteMarker } from './node.js';
import {
	createFootnotePlugin,
	footnotePluginKey,
	type FootnotePluginOptions
} from './plugin.js';
import {
	createFootnoteCleanupPlugin,
	footnoteCleanupPluginKey
} from './cleanupPlugin.js';
import { buildInsertFootnoteTransaction } from './insertCommand.js';
import { pushToast } from '$lib/stores/toast.js';

export {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner
} from './footnotes.js';
export type { FootnoteMatch } from './footnotes.js';
export { footnotePluginKey, footnoteCleanupPluginKey };
export type { FootnotePluginOptions, FootnotePluginState } from './plugin.js';
export { buildInsertFootnoteTransaction } from './insertCommand.js';
export type { InsertFootnoteResult } from './insertCommand.js';
export { FootnoteMarker } from './node.js';

const ABORT_TOAST: Record<'in-title' | 'inside-existing-marker', string> = {
	'in-title': '각주는 본문에서만 삽입할 수 있습니다',
	'inside-existing-marker': '기존 각주 안에서는 삽입할 수 없습니다'
};

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		tomboyFootnote: {
			insertFootnote: () => ReturnType;
		};
	}
}

const TomboyFootnoteExtension = Extension.create<FootnotePluginOptions>({
	name: 'tomboyFootnote',
	addOptions() {
		return { onMissing: () => {} };
	},
	addProseMirrorPlugins() {
		const getEditor = () => this.editor;
		return [
			createFootnotePlugin(this.options),
			createFootnoteCleanupPlugin(getEditor)
		];
	},
	addCommands() {
		return {
			insertFootnote:
				() =>
				({ state, dispatch }) => {
					const result = buildInsertFootnoteTransaction(state);
					if (!result.ok) {
						pushToast(ABORT_TOAST[result.reason], { kind: 'error' });
						return false;
					}
					if (dispatch) dispatch(result.tr);
					return true;
				}
		};
	}
});

/** 호환 export — 노드 + extension 을 한 묶음으로 등록. */
export const TomboyFootnote = [FootnoteMarker, TomboyFootnoteExtension];
```

**중요:** `TomboyFootnote` 가 단일 Extension 에서 배열로 바뀐다. 사용처 (TomboyEditor.svelte 등) 가 `extensions: [..., TomboyFootnote]` 가 아니라 spread 형태 `extensions: [..., ...TomboyFootnote]` 가 되어야 한다. 다음 step 에서 호출지를 확인하고 필요시 수정.

- [ ] **Step 5: TomboyFootnote 호출지 spread 적용**

Run: `grep -rn "TomboyFootnote" app/src app/tests`
각 호출지를 확인하고 `extensions: [..., TomboyFootnote]` → `extensions: [..., ...TomboyFootnote]` 로 수정. 예상되는 위치:
- `app/src/lib/editor/TomboyEditor.svelte`
- `app/tests/unit/editor/footnote/insertCommand.test.ts`
- `app/tests/unit/editor/footnote/extensionCommand.test.ts`
- `app/tests/unit/editor/footnote/cleanupPlugin.test.ts` (아직 삭제 전)

- [ ] **Step 6: 테스트 실행 — pass 확인**

Run: `cd app && npm run test -- footnote/node`
Expected: PASS 5/5.

- [ ] **Step 7: 타입 체크 회귀 확인**

Run: `cd app && npm run check`
Expected: 0 errors.

- [ ] **Step 8: 커밋**

```bash
git add app/src/lib/editor/footnote/node.ts \
        app/src/lib/editor/footnote/index.ts \
        app/src/lib/editor/TomboyEditor.svelte \
        app/tests/unit/editor/footnote/
git commit -m "feat(footnote): footnoteMarker atomic 노드 + stub NodeView"
```

---

### Task 2: Archiver 읽기 — `[^N]` 텍스트 → 노드

**Goal:** `deserializeContent` 가 본문 텍스트 안의 `[^N]` 패턴을 만나면 자동으로 `footnoteMarker` 노드로 split 한다. 마크는 좌우 텍스트에만 전달.

**Files:**
- Modify: `app/src/lib/core/noteContentArchiver.ts:326-362` (`appendInlineNodes` 함수)
- Create: `app/tests/unit/core/archiverFootnote.test.ts`

**Acceptance Criteria:**
- [ ] `deserializeContent('<note-content version="0.1">제목\n본문 [^1] 끝</note-content>')` → 두 번째 단락의 content 가 `[text('본문 '), footnoteMarker{label:'1'}, text(' 끝')]`.
- [ ] `<bold>x [^1] y</bold>` → bold 마크가 `x ` 와 ` y` 에만 전달, footnoteMarker 는 마크 없음.
- [ ] 정의 단락 `[^1] 정의 본문` → 첫 inline 이 footnoteMarker, 두 번째가 text(' 정의 본문').
- [ ] 비숫자 라벨 `[^abc]`, 한글 `[^참고1]` 도 노드로 변환.
- [ ] Malformed `[^]`, `[^ x]` 는 매치 안 됨 → 평문 텍스트로 남음.
- [ ] 한 단락에 마커 여러 개 (`[^1] 본문 [^2]`) 모두 노드화.
- [ ] 새 테스트 파일의 모든 케이스 통과.

**Verify:** `cd app && npm run test -- archiverFootnote` → 7/7 통과.

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `app/tests/unit/core/archiverFootnote.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';

function inlines(doc: ReturnType<typeof deserializeContent>, paraIdx: number) {
	return doc.content?.[paraIdx]?.content ?? [];
}

describe('archiver 읽기 — footnote 노드 split', () => {
	it('본문 중간 [^1] → text + 노드 + text', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n본문 [^1] 끝</note-content>`
		);
		expect(inlines(doc, 1)).toEqual([
			{ type: 'text', text: '본문 ' },
			{ type: 'footnoteMarker', attrs: { label: '1' } },
			{ type: 'text', text: ' 끝' }
		]);
	});

	it('정의 단락 [^1] 본문 → 노드 + text', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n[^1] 정의 본문</note-content>`
		);
		expect(inlines(doc, 1)).toEqual([
			{ type: 'footnoteMarker', attrs: { label: '1' } },
			{ type: 'text', text: ' 정의 본문' }
		]);
	});

	it('마크가 마커를 가로지름 — bold 가 좌우로 split', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n<bold>x [^1] y</bold></note-content>`
		);
		const ins = inlines(doc, 1);
		expect(ins).toEqual([
			{ type: 'text', text: 'x ', marks: [{ type: 'bold' }] },
			{ type: 'footnoteMarker', attrs: { label: '1' } },
			{ type: 'text', text: ' y', marks: [{ type: 'bold' }] }
		]);
	});

	it('한 단락 안에 여러 마커', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n[^1] 와 [^2]</note-content>`
		);
		expect(inlines(doc, 1)).toEqual([
			{ type: 'footnoteMarker', attrs: { label: '1' } },
			{ type: 'text', text: ' 와 ' },
			{ type: 'footnoteMarker', attrs: { label: '2' } }
		]);
	});

	it('비숫자 라벨 [^abc]', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n[^abc] 본문</note-content>`
		);
		expect(inlines(doc, 1)[0]).toMatchObject({
			type: 'footnoteMarker',
			attrs: { label: 'abc' }
		});
	});

	it('한글 라벨 [^참고1]', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n[^참고1] 본문</note-content>`
		);
		expect(inlines(doc, 1)[0]).toMatchObject({
			type: 'footnoteMarker',
			attrs: { label: '참고1' }
		});
	});

	it('malformed [^] / [^ x] 는 평문으로 남음', () => {
		const doc = deserializeContent(
			`<note-content version="0.1">제목\n[^] 와 [^ x]</note-content>`
		);
		const ins = inlines(doc, 1);
		expect(ins).toEqual([{ type: 'text', text: '[^] 와 [^ x]' }]);
	});
});
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

Run: `cd app && npm run test -- archiverFootnote`
Expected: FAIL — text 노드가 split 되지 않아 `[^1]` 전체가 텍스트로 들어옴.

- [ ] **Step 3: archiver 에 footnote split 추가** — `app/src/lib/core/noteContentArchiver.ts`

`appendInlineNodes` 함수 (320 라인 근처) 바로 위에 헬퍼 추가:

```ts
const FOOTNOTE_SPLIT_RE = /\[\^([^\]\s]+)\]/g;

/**
 * 텍스트 안의 [^N] 패턴을 footnoteMarker 노드로 split.
 * 마크는 좌우 텍스트에만 전달 — atomic 노드는 마크를 받지 않는다.
 */
function splitFootnotesInText(
	text: string,
	marks: JSONContent[] | undefined
): JSONContent[] {
	FOOTNOTE_SPLIT_RE.lastIndex = 0;
	const out: JSONContent[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = FOOTNOTE_SPLIT_RE.exec(text)) !== null) {
		if (m.index > last) {
			const piece: JSONContent = { type: 'text', text: text.slice(last, m.index) };
			if (marks) piece.marks = marks;
			out.push(piece);
		}
		out.push({ type: 'footnoteMarker', attrs: { label: m[1] } });
		last = m.index + m[0].length;
	}
	if (last === 0) {
		// 매치 없음 — 원본 그대로 (alloc 절약).
		return [{ type: 'text', text, ...(marks ? { marks } : {}) }];
	}
	if (last < text.length) {
		const piece: JSONContent = { type: 'text', text: text.slice(last) };
		if (marks) piece.marks = marks;
		out.push(piece);
	}
	return out;
}
```

그리고 `appendInlineNodes` 의 텍스트 처리 분기를 다음과 같이 변경:

```ts
function appendInlineNodes(nodes: JSONContent[]) {
	for (const n of nodes) {
		if (n.type === 'text' && typeof n.text === 'string') {
			// 먼저 footnote 패턴을 노드로 split.
			const split = splitFootnotesInText(n.text, n.marks);
			if (split.length === 1 && split[0].type === 'text') {
				appendTextWithNewlines(split[0]);
			} else {
				for (const piece of split) {
					if (piece.type === 'text') appendTextWithNewlines(piece);
					else {
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

/** 기존 appendInlineNodes 의 text 처리 분기 — \n split + 마크 캐리. */
function appendTextWithNewlines(n: JSONContent) {
	if (n.type !== 'text' || typeof n.text !== 'string' || n.text.length === 0) return;
	if (n.text.includes('\n')) {
		const parts = n.text.split('\n');
		for (let j = 0; j < parts.length; j++) {
			if (j > 0) {
				if (absorbNextNewline) absorbNextNewline = false;
				else pushParagraph(n.marks);
			}
			if (parts[j].length > 0) {
				const piece: JSONContent = { type: 'text', text: parts[j] };
				if (n.marks) piece.marks = n.marks;
				currentInline.push(piece);
				absorbNextNewline = false;
			}
		}
		lastTextEndedWithNewline = n.text.endsWith('\n');
	} else {
		currentInline.push(n);
		absorbNextNewline = false;
		lastTextEndedWithNewline = false;
	}
}
```

(`appendTextWithNewlines` 의 본문은 기존 `appendInlineNodes` 의 text 처리 로직을 그대로 들고온 것. `absorbNextNewline`, `lastTextEndedWithNewline`, `currentInline`, `pushParagraph` 모두 동일한 closure 변수.)

- [ ] **Step 4: 테스트 실행 — pass 확인**

Run: `cd app && npm run test -- archiverFootnote`
Expected: PASS 7/7.

- [ ] **Step 5: 기존 archiver 회귀 테스트 확인**

Run: `cd app && npm run test -- noteContentArchiver`
Expected: ALL PASS (footnote 미포함 케이스는 영향 없어야 함).

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/core/noteContentArchiver.ts \
        app/tests/unit/core/archiverFootnote.test.ts
git commit -m "feat(footnote): archiver 읽기 — [^N] 텍스트를 노드로 split"
```

---

### Task 3: Archiver 쓰기 — 노드 → `[^N]` 텍스트

**Goal:** `serializeContent` 가 `footnoteMarker` 노드를 만나면 `[^${label}]` 텍스트로 직렬화한다. 마크가 가로지르는 경우 자연스럽게 split (mark stack close → 텍스트 emit → 다음 text node 가 마크 재오픈).

**Files:**
- Modify: `app/src/lib/core/noteContentArchiver.ts:616-657` (`serializeInlineContent`)
- Modify: `app/src/lib/core/noteContentArchiver.ts` (top-level serialize: 마크 lookahead 헬퍼 도 검토)
- Modify: `app/tests/unit/core/archiverFootnote.test.ts` (round-trip 테스트 추가)

**Acceptance Criteria:**
- [ ] `serializeContent(deserializeContent(xml)) === xml` for: `<note-content version="0.1">제목\n본문 [^1] 끝</note-content>`.
- [ ] 정의 단락 round-trip 보존.
- [ ] 여러 마커 한 단락 round-trip 보존.
- [ ] 비숫자/한글 라벨 round-trip 보존.
- [ ] `<bold>x [^1] y</bold>` 입력 → `<bold>x </bold>[^1]<bold> y</bold>` 출력 (split — 의도된 비대칭). 재로드 시 doc 동일.
- [ ] Top-level serialize 의 mark lookahead 가 footnoteMarker 를 mark-close 트리거로 인식.

**Verify:** `cd app && npm run test -- archiverFootnote` → 12+/12+ 통과.

**Steps:**

- [ ] **Step 1: round-trip 테스트 추가** — `app/tests/unit/core/archiverFootnote.test.ts`

기존 파일에 다음 describe block 추가:

```ts
import { serializeContent } from '$lib/core/noteContentArchiver.js';

describe('archiver 쓰기 — footnoteMarker 노드 → [^N] 텍스트', () => {
	function roundTrip(xml: string) {
		return serializeContent(deserializeContent(xml));
	}

	it('본문 중간 마커 round-trip', () => {
		const xml = `<note-content version="0.1">제목\n본문 [^1] 끝</note-content>`;
		expect(roundTrip(xml)).toBe(xml);
	});

	it('정의 단락 round-trip', () => {
		const xml = `<note-content version="0.1">제목\n[^1] 정의 본문</note-content>`;
		expect(roundTrip(xml)).toBe(xml);
	});

	it('여러 마커 round-trip', () => {
		const xml = `<note-content version="0.1">제목\n[^1] 와 [^2]</note-content>`;
		expect(roundTrip(xml)).toBe(xml);
	});

	it('한글 라벨 round-trip', () => {
		const xml = `<note-content version="0.1">제목\n[^참고1] 본문</note-content>`;
		expect(roundTrip(xml)).toBe(xml);
	});

	it('마크 가로지름 — split 결과 (의도)', () => {
		const xml = `<note-content version="0.1">제목\n<bold>x [^1] y</bold></note-content>`;
		const out = roundTrip(xml);
		expect(out).toBe(
			`<note-content version="0.1">제목\n<bold>x </bold>[^1]<bold> y</bold></note-content>`
		);
		// idempotent: 한 번 더 돌려도 동일.
		expect(roundTrip(out)).toBe(out);
	});
});
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

Run: `cd app && npm run test -- archiverFootnote`
Expected: FAIL — 노드가 직렬화 안 됨 (조용히 무시되거나 빈 출력).

- [ ] **Step 3: `serializeInlineContent` 에 노드 분기 추가** — `app/src/lib/core/noteContentArchiver.ts:627`

기존 `for (const node of content)` 루프 안의 `else if (node.type === 'hardBreak')` 옆에 분기 추가:

```ts
		} else if (node.type === 'hardBreak') {
			closeAll();
			result += '\n';
		} else if (node.type === 'footnoteMarker') {
			// 모든 mark 닫고 [^N] emit. 다음 text 노드가 mark 를 다시 연다.
			closeAll();
			result += `[^${escapeXmlContent(node.attrs?.label ?? '')}]`;
		}
```

- [ ] **Step 4: top-level serialize 의 mark lookahead 업데이트** — `app/src/lib/core/noteContentArchiver.ts:108-128`

`nextTextNodeMarks` 헬퍼가 inline 노드를 스캔할 때 footnoteMarker 를 만나면 mark-share 가 끊긴다 (close-all 트리거). 다음과 같이 수정:

```ts
function nextTextNodeMarks(
	blocks: JSONContent[],
	startIdx: number
): JSONContent[] | undefined {
	for (let i = startIdx; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.type === 'paragraph' || b.type === 'heading') {
			for (const inline of b.content ?? []) {
				if (inline.type === 'text') return inline.marks ?? [];
				if (inline.type === 'hardBreak') return [];
				if (inline.type === 'footnoteMarker') return [];
			}
			continue;
		}
		return [];
	}
	return [];
}
```

또한 top-level `writeTextNode` 가 호출되는 메인 루프 (대략 150-300 라인) 에서 inline 노드 종류를 분기하는 곳에 footnoteMarker 분기를 추가해야 한다. 현재 코드의 inline 루프를 찾아 hardBreak 분기 옆에 다음을 추가:

```ts
} else if (inline.type === 'footnoteMarker') {
	closeAll();
	result += `[^${escapeXmlContent(inline.attrs?.label ?? '')}]`;
}
```

(정확한 위치는 `writeTextNode` 호출이 있는 paragraph/heading 처리 부분. 구현 시 `grep -n "writeTextNode\|hardBreak" noteContentArchiver.ts` 로 confirm.)

- [ ] **Step 5: 테스트 실행 — pass 확인**

Run: `cd app && npm run test -- archiverFootnote`
Expected: PASS all.

- [ ] **Step 6: 전체 archiver 회귀 확인**

Run: `cd app && npm run test -- noteContentArchiver`
Expected: ALL PASS.

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/core/noteContentArchiver.ts \
        app/tests/unit/core/archiverFootnote.test.ts
git commit -m "feat(footnote): archiver 쓰기 — 노드를 [^N] 텍스트로 직렬화"
```

---

### Task 4: NodeView 위치 기반 ref/def 분기

**Goal:** NodeView 가 `getPos()` 로 노드의 절대 위치를 얻어 부모 단락을 검사 — 같은 단락의 첫 비공백 inline 자식이면 `<span class="tomboy-fn-def">N</span>`, 아니면 `<sup class="tomboy-fn-ref">N</sup>`. `update(node)` 콜백에서도 재검사해 def↔ref 전환 지원.

**Files:**
- Modify: `app/src/lib/editor/footnote/node.ts` (NodeView)
- Modify: `app/tests/unit/editor/footnote/node.test.ts` (위치 기반 케이스 추가)

**Acceptance Criteria:**
- [ ] 본문 단락 첫 inline 이 마커면 DOM 출력 `<span class="tomboy-fn-def">N</span>`.
- [ ] 본문 단락 중간/끝 마커는 `<sup class="tomboy-fn-ref">N</sup>`.
- [ ] 리스트 항목 안의 마커는 항상 `tomboy-fn-ref` (정의 마커 불가).
- [ ] 제목 (top-level idx 0) 안의 마커는 `tomboy-fn-ref`.
- [ ] 선행 공백만 있는 텍스트 다음의 마커는 def 로 인정 (e.g. `'  [^1]'`).
- [ ] 단락 앞에 텍스트 삽입 → `update` 가 def → ref 전환 (DOM 갱신).

**Verify:** `cd app && npm run test -- footnote/node` → 11/11 통과.

**Steps:**

- [ ] **Step 1: 테스트 추가** — `app/tests/unit/editor/footnote/node.test.ts`

```ts
describe('footnoteMarker NodeView — ref/def 위치 기반', () => {
	function html(e: Editor): string {
		return e.view.dom.innerHTML;
	}

	it('단락 첫 inline 이면 tomboy-fn-def', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' 정의' }
					]
				}
			]
		});
		expect(html(e)).toContain('tomboy-fn-def');
		expect(html(e)).not.toContain('tomboy-fn-ref');
	});

	it('단락 중간이면 tomboy-fn-ref', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '본문 ' },
						{ type: 'footnoteMarker', attrs: { label: '1' } }
					]
				}
			]
		});
		expect(html(e)).toContain('tomboy-fn-ref');
		expect(html(e)).not.toContain('tomboy-fn-def');
	});

	it('리스트 항목 안의 첫 inline 이어도 항상 ref', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							content: [
								{
									type: 'paragraph',
									content: [
										{ type: 'footnoteMarker', attrs: { label: '1' } }
									]
								}
							]
						}
					]
				}
			]
		});
		expect(html(e)).toContain('tomboy-fn-ref');
		expect(html(e)).not.toContain('tomboy-fn-def');
	});

	it('제목 단락의 마커는 ref', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' 제목' }
					]
				}
			]
		});
		expect(html(e)).toContain('tomboy-fn-ref');
	});

	it('선행 공백만 있으면 def 인정', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '   ' },
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' 정의' }
					]
				}
			]
		});
		expect(html(e)).toContain('tomboy-fn-def');
	});

	it('앞에 텍스트 삽입 시 def → ref 갱신', async () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' 정의' }
					]
				}
			]
		});
		expect(html(e)).toContain('tomboy-fn-def');
		// 두 번째 단락의 맨 앞에 텍스트 삽입.
		let para1Start = 0;
		e.state.doc.forEach((_n, offset, idx) => {
			if (idx === 1) para1Start = offset;
		});
		e.view.dispatch(e.state.tr.insertText('앞쪽 ', para1Start + 1));
		expect(html(e)).toContain('tomboy-fn-ref');
		expect(html(e)).not.toContain('tomboy-fn-def');
	});
});
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

Run: `cd app && npm run test -- footnote/node`
Expected: 위치 기반 케이스가 모두 fail (현재는 항상 ref 로만 렌더).

- [ ] **Step 3: NodeView 위치 분기 구현** — `app/src/lib/editor/footnote/node.ts`

`addNodeView` 교체:

```ts
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

/**
 * 현재 노드 위치를 보고 정의 마커인지 판정.
 * 정의 마커 조건: top-level paragraph (제목 제외) 의 첫 비공백 inline 자식.
 */
function isDefinitionPosition(getPos: () => number | undefined, view: EditorView): boolean {
	const pos = getPos();
	if (pos == null) return false;
	const $pos = view.state.doc.resolve(pos);
	// 부모 단락이 top-level 인가 (depth=1) — list item 등의 깊은 경우는 ref.
	if ($pos.depth !== 1) return false;
	if ($pos.parent.type.name !== 'paragraph') return false;
	// 제목 (top-level idx 0) 은 ref.
	if ($pos.index(0) === 0) return false;
	// 자기 자신 이전 자식들이 모두 공백-only text 인지.
	const myIndex = $pos.index();
	let i = 0;
	let sawContent = false;
	$pos.parent.forEach((child, _offset, idx) => {
		if (idx >= myIndex) return;
		if (child.isText) {
			if (/\S/.test(child.text ?? '')) sawContent = true;
		} else {
			sawContent = true;
		}
		i++;
	});
	return !sawContent;
}

// addNodeView 교체:
	addNodeView() {
		return ({ node, getPos, editor }) => {
			const view = editor.view;
			let isDef = isDefinitionPosition(getPos as () => number | undefined, view);
			const dom = document.createElement(isDef ? 'span' : 'sup');
			dom.className = isDef ? 'tomboy-fn-def' : 'tomboy-fn-ref';
			dom.textContent = node.attrs.label;
			return {
				dom,
				update(updatedNode) {
					if (updatedNode.type.name !== 'footnoteMarker') return false;
					const newIsDef = isDefinitionPosition(
						getPos as () => number | undefined,
						view
					);
					const newLabel = updatedNode.attrs.label;
					if (newIsDef !== isDef) {
						// 태그가 바뀌어야 해서 false 반환 → PM 이 NodeView 를 재생성.
						return false;
					}
					if (newLabel !== dom.textContent) {
						dom.textContent = newLabel;
					}
					isDef = newIsDef;
					return true;
				}
			};
		};
	}
```

- [ ] **Step 4: 테스트 실행 — pass 확인**

Run: `cd app && npm run test -- footnote/node`
Expected: PASS 11/11.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/footnote/node.ts \
        app/tests/unit/editor/footnote/node.test.ts
git commit -m "feat(footnote): NodeView 위치 기반 ref/def 분기"
```

---

### Task 5: `footnotes.ts` 노드 walk 재작성

**Goal:** `findFootnoteMatches` / `findFootnoteAt` / `findFootnotePartner` 의 외부 API 는 그대로 유지하되, 내부 구현을 정규식 텍스트 스캔 → ProseMirror 노드 walk 로 교체한다.

**Files:**
- Modify: `app/src/lib/editor/footnote/footnotes.ts`
- Create: `app/tests/unit/editor/footnote/footnotes.test.ts` (없으면 신규)

**Acceptance Criteria:**
- [ ] `FootnoteMatch` 타입은 `from`, `to`, `label`, `isDefinitionMarker` 그대로.
- [ ] `findFootnoteMatches(doc)` 가 `footnoteMarker` 노드만 수집 (텍스트 안의 `[^N]` 은 더 이상 매치 안 함).
- [ ] `to = from + 1` (atomic 노드 nodeSize = 1).
- [ ] `isDefinitionMarker` 판정 규칙 유지: top-level paragraph (제목 제외) 의 첫 비공백 inline 자식.
- [ ] 리스트 안의 마커는 def 안 됨.
- [ ] `findFootnoteAt(matches, pos)` — pos 가 노드 내부면 매치 반환 (atomic 이라 pos === from 일 때 매치 — `pos > m.from && pos < m.to` 는 false 가 되므로 조건 조정 필요).
- [ ] `findFootnotePartner` 로직 그대로 (ref → 뒤 def, def → 앞 ref).

**Verify:** `cd app && npm run test -- footnote/footnotes` → 모든 케이스 통과.

**Steps:**

- [ ] **Step 1: 테스트 작성** — `app/tests/unit/editor/footnote/footnotes.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';
import {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner
} from '$lib/editor/footnote/footnotes.js';

function makeEditor(content: unknown): Editor {
	return new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
			TomboyParagraph,
			TomboyListItem,
			...TomboyFootnote
		],
		content
	});
}

describe('findFootnoteMatches — 노드 walk', () => {
	it('빈 doc → 빈 결과', () => {
		const e = makeEditor({ type: 'doc', content: [{ type: 'paragraph' }] });
		expect(findFootnoteMatches(e.state.doc)).toEqual([]);
	});

	it('본문 중간 ref 매치', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '본문 ' },
						{ type: 'footnoteMarker', attrs: { label: '1' } }
					]
				}
			]
		});
		const matches = findFootnoteMatches(e.state.doc);
		expect(matches.length).toBe(1);
		expect(matches[0].label).toBe('1');
		expect(matches[0].isDefinitionMarker).toBe(false);
		expect(matches[0].to - matches[0].from).toBe(1);
	});

	it('정의 마커 식별', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' 정의' }
					]
				}
			]
		});
		const matches = findFootnoteMatches(e.state.doc);
		expect(matches[0].isDefinitionMarker).toBe(true);
	});

	it('리스트 안의 마커는 def 안 됨', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							content: [
								{
									type: 'paragraph',
									content: [
										{ type: 'footnoteMarker', attrs: { label: '1' } }
									]
								}
							]
						}
					]
				}
			]
		});
		const matches = findFootnoteMatches(e.state.doc);
		expect(matches[0].isDefinitionMarker).toBe(false);
	});

	it('제목 단락 마커는 제외', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' 제목' }
					]
				}
			]
		});
		expect(findFootnoteMatches(e.state.doc)).toEqual([]);
	});

	it('findFootnoteAt — 정확히 from 위치', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [{ type: 'footnoteMarker', attrs: { label: '1' } }]
				}
			]
		});
		const matches = findFootnoteMatches(e.state.doc);
		expect(findFootnoteAt(matches, matches[0].from)).toBe(matches[0]);
		expect(findFootnoteAt(matches, matches[0].from - 1)).toBe(null);
	});

	it('findFootnotePartner — ref → def', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '본문 ' },
						{ type: 'footnoteMarker', attrs: { label: '1' } }
					]
				},
				{
					type: 'paragraph',
					content: [
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' 정의' }
					]
				}
			]
		});
		const matches = findFootnoteMatches(e.state.doc);
		const ref = matches.find((m) => !m.isDefinitionMarker)!;
		const def = matches.find((m) => m.isDefinitionMarker)!;
		expect(findFootnotePartner(matches, ref)).toBe(def);
		expect(findFootnotePartner(matches, def)).toBe(ref);
	});
});
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

Run: `cd app && npm run test -- footnote/footnotes`
Expected: FAIL — 현재 구현이 정규식 기반이라 노드 인식 못 함.

- [ ] **Step 3: `footnotes.ts` 재작성** — 전체 파일을 다음으로 교체

```ts
/**
 * 각주 마커 노드 탐색 (순수 함수).
 *
 * footnoteMarker 는 atomic inline 노드. 본문 어디든 등장하면 "참조"(ref),
 * 최상위 paragraph 의 첫 비공백 inline 이면 "설명 마커"(def). 제목 (idx 0)
 * 은 제외. 리스트 안에서는 def 안 됨.
 *
 * archiver 가 외부 텍스트 [^N] 을 노드로 변환하므로 이 파일은 노드만 본다.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

export interface FootnoteMatch {
	/** 노드 시작 절대 위치 (노드 자체의 위치). */
	from: number;
	/** 노드 끝 절대 위치 (from + 1 for atomic). */
	to: number;
	/** 노드의 label attr. */
	label: string;
	/** 최상위 paragraph 의 첫 비공백 inline 이면 true. */
	isDefinitionMarker: boolean;
}

/** 한 textblock 안의 footnoteMarker 노드 수집. */
function scanTextblock(
	block: PMNode,
	blockPos: number,
	canBeDefinition: boolean,
	out: FootnoteMatch[]
): void {
	const contentStart = blockPos + 1;
	let rel = 0;
	let sawContent = false;
	block.forEach((child) => {
		if (child.type.name === 'footnoteMarker') {
			out.push({
				from: contentStart + rel,
				to: contentStart + rel + child.nodeSize,
				label: child.attrs.label ?? '',
				isDefinitionMarker: canBeDefinition && !sawContent
			});
			sawContent = true;
		} else if (child.isText) {
			if (/\S/.test(child.text ?? '')) sawContent = true;
		} else {
			// hardBreak 등 다른 inline 노드는 content 로 친다.
			sawContent = true;
		}
		rel += child.nodeSize;
	});
}

/** 문서 전체의 각주 매치를 문서 순서대로 반환. 제목 (idx 0) 제외. */
export function findFootnoteMatches(doc: PMNode): FootnoteMatch[] {
	const out: FootnoteMatch[] = [];
	doc.forEach((topNode, offset, index) => {
		if (index === 0) return;
		if (topNode.isTextblock) {
			scanTextblock(topNode, offset, topNode.type.name === 'paragraph', out);
		} else {
			topNode.descendants((n, p) => {
				if (n.isTextblock) {
					scanTextblock(n, offset + 1 + p, false, out);
					return false;
				}
				return true;
			});
		}
	});
	return out;
}

/**
 * 위치 `pos` 를 포함하는 매치. atomic 노드라 pos === from 일 때만 매치.
 * (이전 데코레이션 구현은 마커 내부 위치들도 매치했지만, 노드는 from 이 유일.)
 */
export function findFootnoteAt(
	matches: FootnoteMatch[],
	pos: number
): FootnoteMatch | null {
	for (const m of matches) {
		if (pos === m.from) return m;
	}
	return null;
}

/** 짝(ref↔def) 찾기 — 라벨 같은 매치 중 가장 가까운 것. */
export function findFootnotePartner(
	matches: FootnoteMatch[],
	clicked: FootnoteMatch
): FootnoteMatch | null {
	if (!clicked.isDefinitionMarker) {
		for (const m of matches) {
			if (
				m.label === clicked.label &&
				m.isDefinitionMarker &&
				m.from > clicked.from
			) {
				return m;
			}
		}
		return null;
	}
	let found: FootnoteMatch | null = null;
	for (const m of matches) {
		if (
			m.label === clicked.label &&
			!m.isDefinitionMarker &&
			m.from < clicked.from
		) {
			found = m;
		}
	}
	return found;
}
```

- [ ] **Step 4: 테스트 실행 — pass 확인**

Run: `cd app && npm run test -- footnote/footnotes`
Expected: PASS all.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/footnote/footnotes.ts \
        app/tests/unit/editor/footnote/footnotes.test.ts
git commit -m "refactor(footnote): findFootnoteMatches 노드 walk 로 재작성"
```

---

### Task 6: `insertCommand.ts` 노드 op 재작성

**Goal:** Alt+J 명령의 `buildInsertFootnoteTransaction` 의 알고리즘 (group renumber + def 단락 재정렬) 은 그대로 유지하고, 텍스트 치환 op (`tr.insertText`) 를 노드 치환 op (`tr.replaceWith`) 으로 교체한다.

**Files:**
- Modify: `app/src/lib/editor/footnote/insertCommand.ts`
- Modify: `app/tests/unit/editor/footnote/insertCommand.test.ts` (`paragraphTexts` 헬퍼만 갱신)

**Acceptance Criteria:**
- [ ] 기존 13개 테스트 모두 통과 (어설션은 `paragraphTexts` 가 노드를 `[^N]` 텍스트로 평탄화하므로 변함 없음).
- [ ] 빈 doc → 첫 각주 삽입 시 `[^1]` 노드 + 정의 단락 `[^1] ` (노드 + space) 추가.
- [ ] 정의 단락의 마커도 노드.
- [ ] Group renumber (커서가 기존 마커 앞에 있을 때 새 마커가 1, 기존 1이 2 로) 동작.
- [ ] Def 단락 라벨 오름차순 재정렬 동작.

**Verify:** `cd app && npm run test -- footnote/insertCommand` → 13/13 통과.

**Steps:**

- [ ] **Step 1: 테스트 헬퍼 갱신** — `app/tests/unit/editor/footnote/insertCommand.test.ts`

`paragraphTexts` 와 makeEditor 의 spread 적용:

```ts
function nodeToPlain(node: { type: { name: string }; text?: string; attrs?: { label?: string }; content?: { content?: any[] }; forEach?: (cb: (n: any) => void) => void }): string {
	if (node.text) return node.text;
	if ((node as any).type?.name === 'footnoteMarker') return `[^${(node as any).attrs?.label ?? ''}]`;
	if (typeof (node as any).forEach === 'function') {
		const parts: string[] = [];
		(node as any).forEach((c: any) => { parts.push(nodeToPlain(c)); });
		return parts.join('');
	}
	return '';
}

function paragraphTexts(editor: Editor): string[] {
	const out: string[] = [];
	editor.state.doc.forEach((node) => {
		out.push(nodeToPlain(node));
	});
	return out;
}
```

`makeEditor` 의 extension 배열에서 `TomboyFootnote` → `...TomboyFootnote` (Task 1 에서 이미 했어야 함, 재확인).

- [ ] **Step 2: 테스트 실행 — 현재 상태 확인**

Run: `cd app && npm run test -- footnote/insertCommand`
Expected: 일부 fail — 현재 insertCommand 는 `tr.insertText('[^N]', ...)` 라서 노드가 안 만들어지고 텍스트가 생긴다. paragraphTexts 결과는 같은 `'[^1]'` 라 fail 안 될 수도 있지만, 후속 동작 (예: 두 번째 호출에서 group renumber) 은 깨진다.

- [ ] **Step 3: `insertCommand.ts` 의 op 빌더 교체**

`buildInsertFootnoteTransaction` 의 다음 부분 (현재 79-89 라인 근처):

```ts
const ops: Op[] = numericMatches.map((m) => ({
	from: m.from,
	to: m.to,
	text: `[^${oldToNew.get(m.label)}]`
}));
ops.push({ from: selFrom, to: selTo, text: `[^${newLabel}]` });

ops.sort((a, b) => b.from - a.from || b.to - a.to);

const tr = state.tr;
for (const op of ops) tr.insertText(op.text, op.from, op.to);
```

다음으로 교체:

```ts
type NodeOp = { from: number; to: number; label: string };

const ops: NodeOp[] = numericMatches.map((m) => ({
	from: m.from,
	to: m.to,
	label: oldToNew.get(m.label)!
}));
ops.push({ from: selFrom, to: selTo, label: newLabel });

ops.sort((a, b) => b.from - a.from || b.to - a.to);

const fnType = state.schema.nodes.footnoteMarker;
const tr = state.tr;
for (const op of ops) {
	const node = fnType.create({ label: op.label });
	tr.replaceWith(op.from, op.to, node);
}
```

`Op` 타입 alias 제거하거나 NodeOp 으로 rename — 위 코드는 NodeOp 새로 정의.

그리고 정의 단락 생성도 노드 + 텍스트로:

```ts
// 기존:
const defPara = paragraphType.create(null, state.schema.text(`[^${newLabel}] `));

// 새로:
const defPara = paragraphType.create(null, Fragment.from([
	fnType.create({ label: newLabel }),
	state.schema.text(' ')
]));
```

(Fragment 는 이미 import 됨.)

정의 단락 식별 부분 (현재 102-127 라인) 의 `DEF_PARA_RE` 매치도 변경 필요. 현재는 paragraph 의 textContent 가 `[^N] ...` 로 시작하는지 봤는데, 이제는 paragraph 의 첫 inline child 가 `footnoteMarker` 인지 봐야 한다:

```ts
function defLabelOf(node: PMNode): string | null {
	const first = node.firstChild;
	if (!first || first.type.name !== 'footnoteMarker') return null;
	return first.attrs.label ?? null;
}

// allDefIdx 채우는 부분:
const allDefIdx = new Set<number>();
for (const m of matches) {
	if (m.isDefinitionMarker) allDefIdx.add(state.doc.resolve(m.from).index(0));
}
// (이 부분은 그대로 유지 — matches 의 isDefinitionMarker 가 노드 기반이라 정확.)

// existingDefs 모으는 부분:
if (firstDefIdx < childCount) {
	tr.doc.forEach((node, offset, idx) => {
		if (idx < firstDefIdx) return;
		if (idx === firstDefIdx) defSectionStart = offset;
		const lbl = defLabelOf(node);
		if (lbl === null) return; // 방어 — allDefIdx 가 보장하지만 type safety.
		existingDefs.push({
			node,
			sortKey: /^\d+$/.test(lbl) ? parseInt(lbl, 10) : Infinity,
			origIdx: idx
		});
	});
}
```

기존의 `DEF_PARA_RE` 상수와 `DEF_PARA_RE.exec(node.textContent)![1]` 호출은 위 `defLabelOf` 로 대체.

커서 이동 부분 (147-153 라인) 도 textContent 매칭에서 첫 child 가 노드인지로 변경:

```ts
let cursorPos = tr.doc.content.size - 1;
tr.doc.forEach((node, offset, idx) => {
	if (idx === 0) return;
	const first = node.firstChild;
	if (first?.type.name === 'footnoteMarker' && first.attrs.label === newLabel) {
		// 단락 끝 — paragraph 의 inner content end.
		cursorPos = offset + node.nodeSize - 1;
	}
});
tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPos)));
tr.scrollIntoView();
```

- [ ] **Step 4: 테스트 실행 — pass 확인**

Run: `cd app && npm run test -- footnote/insertCommand`
Expected: PASS 13/13.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/footnote/insertCommand.ts \
        app/tests/unit/editor/footnote/insertCommand.test.ts
git commit -m "refactor(footnote): insertCommand 텍스트 op → 노드 op"
```

---

### Task 7: Input rule + Paste transform

**Goal:** 사용자가 본문에서 `[^N]` 을 직접 타이핑하거나 plain text 를 paste 하면 즉시 `footnoteMarker` 노드로 변환된다. 제목 단락에서는 차단.

**Files:**
- Modify: `app/src/lib/editor/footnote/node.ts` (addInputRules + addProseMirrorPlugins)
- Modify: `app/tests/unit/editor/footnote/node.test.ts`

**Acceptance Criteria:**
- [ ] 본문 단락에서 `[^1]` 타이핑 → 노드로 변환.
- [ ] 제목 단락에서 `[^1]` 타이핑 → 텍스트로 남음.
- [ ] Plain text paste (`hello [^1] world`) → text + 노드 + text.
- [ ] Plain text paste 가 제목 단락에 들어가도 변환됨 (paste 는 단락 신경 안 쓰고 전부 변환 — 단순화. 단, paste 결과가 제목으로 들어가는 경우는 드물고 input rule 만큼 자주 트리거 안 됨).

**Verify:** `cd app && npm run test -- footnote/node` → 15+/15+ 통과.

**Steps:**

- [ ] **Step 1: 테스트 추가** — `app/tests/unit/editor/footnote/node.test.ts`

```ts
import { TextSelection } from '@tiptap/pm/state';
import { Slice, Fragment } from '@tiptap/pm/model';

describe('input rule — 타이핑한 [^N] 을 노드로', () => {
	it('본문 단락에서 매치', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		// 두 번째 단락 안쪽으로 커서.
		const para1Start = e.state.doc.resolve(0).nodeAfter!.nodeSize + 1;
		e.view.dispatch(
			e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(para1Start + 1)))
		);
		// 타이핑 시뮬레이션 — insertText 하나씩.
		'[^7]'.split('').forEach((ch) => {
			e.view.dispatch(e.state.tr.insertText(ch));
		});
		const para1 = e.state.doc.child(1);
		expect(para1.firstChild?.type.name).toBe('footnoteMarker');
		expect(para1.firstChild?.attrs.label).toBe('7');
	});

	it('제목 단락에서는 변환 안 됨', () => {
		const e = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '제목 ' }] }]
		});
		e.view.dispatch(
			e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(4)))
		);
		'[^7]'.split('').forEach((ch) => {
			e.view.dispatch(e.state.tr.insertText(ch));
		});
		const para0 = e.state.doc.child(0);
		expect(para0.textContent).toBe('제목 [^7]');
		// footnoteMarker 노드 없음.
		let hasNode = false;
		para0.descendants((n) => {
			if (n.type.name === 'footnoteMarker') hasNode = true;
		});
		expect(hasNode).toBe(false);
	});
});

describe('paste transform — plain text 의 [^N] 을 노드로', () => {
	it('plain text 페이스트 — text + 노드 + text', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		const para1Start = e.state.doc.resolve(0).nodeAfter!.nodeSize + 1;
		e.view.dispatch(
			e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(para1Start + 1)))
		);

		// transformPasted 를 직접 호출 (paste 이벤트 시뮬레이션 어려움).
		const slice = new Slice(
			Fragment.from(e.state.schema.text('hello [^9] world')),
			0,
			0
		);
		const transformed = (e.view.someProp('transformPasted') as any)(slice, e.view);
		expect(transformed.content.childCount).toBeGreaterThan(1);
		// 첫 자식 = text 'hello ', 둘째 = footnoteMarker, 셋째 = text ' world'
		const first = transformed.content.firstChild!;
		expect(first.type.name).toBe('text');
		expect(first.text).toBe('hello ');
	});
});
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

Run: `cd app && npm run test -- footnote/node`
Expected: 새 케이스 fail.

- [ ] **Step 3: input rule + paste transform 구현** — `app/src/lib/editor/footnote/node.ts`

상단 import 보강:

```ts
import { InputRule } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
```

`FootnoteMarker` Node.create 객체에 다음 두 메서드 추가:

```ts
	addInputRules() {
		const type = this.type;
		return [
			new InputRule({
				find: /\[\^([^\]\s]+)\]$/,
				handler: ({ state, range, match }) => {
					const $from = state.doc.resolve(range.from);
					// 제목 (top-level idx 0) 에서는 차단.
					if ($from.index(0) === 0) return null;
					const node = type.create({ label: match[1] });
					state.tr.replaceWith(range.from, range.to, node);
					return;
				}
			})
		];
	},

	addProseMirrorPlugins() {
		const type = this.type;
		return [
			new Plugin({
				props: {
					transformPasted: (slice) => transformPastedSlice(slice, type)
				}
			})
		];
	}
```

그리고 헬퍼:

```ts
const FN_PASTE_RE = /\[\^([^\]\s]+)\]/g;

function transformPastedSlice(slice: Slice, fnType: PMNode['type']): Slice {
	const newContent = transformFragment(slice.content, fnType);
	return new Slice(newContent, slice.openStart, slice.openEnd);
}

function transformFragment(frag: Fragment, fnType: PMNode['type']): Fragment {
	const out: PMNode[] = [];
	frag.forEach((child) => {
		if (child.isText && typeof child.text === 'string' && FN_PASTE_RE.test(child.text)) {
			FN_PASTE_RE.lastIndex = 0;
			const text = child.text;
			let last = 0;
			let m: RegExpExecArray | null;
			while ((m = FN_PASTE_RE.exec(text)) !== null) {
				if (m.index > last) {
					const piece = child.cut(last, m.index); // marks 보존됨
					out.push(piece);
				}
				out.push(fnType.create({ label: m[1] }));
				last = m.index + m[0].length;
			}
			if (last < text.length) {
				out.push(child.cut(last));
			}
		} else if (child.content.size > 0) {
			const inner = transformFragment(child.content, fnType);
			out.push(child.copy(inner));
		} else {
			out.push(child);
		}
	});
	return Fragment.fromArray(out);
}
```

(주의: `FN_PASTE_RE.test` 는 lastIndex 를 진행시키므로 다음 `exec` 전에 reset. 위 코드는 `lastIndex = 0` 로 reset.)

- [ ] **Step 4: 테스트 실행 — pass 확인**

Run: `cd app && npm run test -- footnote/node`
Expected: PASS all (15+).

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/footnote/node.ts \
        app/tests/unit/editor/footnote/node.test.ts
git commit -m "feat(footnote): input rule + paste transform 으로 [^N] → 노드"
```

---

### Task 8: Plugin 정리 — 데코레이션 제거 + cleanupPlugin 삭제

**Goal:** `plugin.ts` 의 데코레이션 빌더를 삭제하고 mousedown 클릭 핸들러만 유지. `cleanupPlugin.ts` 와 테스트를 통째 삭제. `index.ts` 에서 cleanupPlugin 등록 제거.

**Files:**
- Modify: `app/src/lib/editor/footnote/plugin.ts`
- Delete: `app/src/lib/editor/footnote/cleanupPlugin.ts`
- Delete: `app/tests/unit/editor/footnote/cleanupPlugin.test.ts`
- Modify: `app/src/lib/editor/footnote/index.ts`

**Acceptance Criteria:**
- [ ] `plugin.ts` 가 더 이상 Decoration / DecorationSet 을 import 하지 않음.
- [ ] `buildDecorations` 함수 삭제.
- [ ] `state` 필드의 `decorations` 키 삭제 (state 는 `{ matches }` 만).
- [ ] `props.decorations` 삭제.
- [ ] `props.handleDOMEvents.mousedown` 핸들러 유지 — `.tomboy-fn-ref, .tomboy-fn-def` 셀렉터로 NodeView DOM 매치.
- [ ] `cleanupPlugin.ts` 와 `cleanupPlugin.test.ts` 파일 없음.
- [ ] `index.ts` 가 `createFootnoteCleanupPlugin` 을 import / 등록하지 않음.
- [ ] `index.ts` 의 `footnoteCleanupPluginKey` export 제거.
- [ ] `cd app && npm run test -- footnote/` 전체 통과.
- [ ] `cd app && npm run check` 0 errors.

**Verify:** `cd app && npm run test -- footnote/ && npm run check` → all green.

**Steps:**

- [ ] **Step 1: `plugin.ts` 재작성** — 전체 파일을 다음으로 교체

```ts
/**
 * 각주 클릭 핸들러 플러그인.
 *
 * footnoteMarker 노드는 NodeView (node.ts) 가 .tomboy-fn-ref / .tomboy-fn-def
 * DOM 을 렌더한다. 이 플러그인은 클릭 시 짝(ref↔def)으로 부드럽게 스크롤만 한다.
 *
 * mousedown 에서 가로채는 이유: 클릭으로 인한 PM 기본 selection 변경이
 * 모바일에서 키보드를 띄워 본문을 가리는 문제를 막기 위함.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner,
	type FootnoteMatch
} from './footnotes.js';

export interface FootnotePluginOptions {
	onMissing: (label: string, kind: 'reference' | 'definition') => void;
}

export interface FootnotePluginState {
	matches: FootnoteMatch[];
}

export const footnotePluginKey = new PluginKey<FootnotePluginState>('tomboyFootnote');

function scrollToMatch(view: EditorView, target: FootnoteMatch): void {
	const { node } = view.domAtPos(target.from + 1);
	const el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
	if (!el) return;
	const block = el.closest('p, li, h1, h2, h3, h4, h5, h6') ?? el;
	block.scrollIntoView({ behavior: 'smooth', block: 'center' });
	block.classList.add('tomboy-fn-flash');
	window.setTimeout(() => block.classList.remove('tomboy-fn-flash'), 1200);
}

export function createFootnotePlugin(
	options: FootnotePluginOptions
): Plugin<FootnotePluginState> {
	return new Plugin<FootnotePluginState>({
		key: footnotePluginKey,
		state: {
			init(_, state) {
				return { matches: findFootnoteMatches(state.doc) };
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				return { matches: findFootnoteMatches(newState.doc) };
			}
		},
		props: {
			handleDOMEvents: {
				mousedown(view, event) {
					const target = event.target;
					const fnEl =
						target instanceof Element
							? target.closest('.tomboy-fn-ref, .tomboy-fn-def')
							: null;
					if (!fnEl) return false;
					event.preventDefault();
					const st = footnotePluginKey.getState(view.state);
					if (!st) return true;
					let pos: number | null = null;
					try {
						pos = view.posAtDOM(fnEl, 0);
					} catch {
						pos = null;
					}
					const hit = pos != null ? findFootnoteAt(st.matches, pos) : null;
					if (hit) {
						const partner = findFootnotePartner(st.matches, hit);
						if (partner) scrollToMatch(view, partner);
						else
							options.onMissing(
								hit.label,
								hit.isDefinitionMarker ? 'definition' : 'reference'
							);
					}
					return true;
				}
			}
		}
	});
}
```

- [ ] **Step 2: cleanupPlugin 파일 삭제**

```bash
rm app/src/lib/editor/footnote/cleanupPlugin.ts \
   app/tests/unit/editor/footnote/cleanupPlugin.test.ts
```

- [ ] **Step 3: `index.ts` 정리**

기존:
```ts
import {
	createFootnoteCleanupPlugin,
	footnoteCleanupPluginKey
} from './cleanupPlugin.js';
...
export { footnotePluginKey, footnoteCleanupPluginKey };
...
addProseMirrorPlugins() {
	const getEditor = () => this.editor;
	return [
		createFootnotePlugin(this.options),
		createFootnoteCleanupPlugin(getEditor)
	];
},
```

를 다음으로:
```ts
// cleanupPlugin import 제거
...
export { footnotePluginKey };  // footnoteCleanupPluginKey 제거
...
addProseMirrorPlugins() {
	return [createFootnotePlugin(this.options)];
},
```

- [ ] **Step 4: 테스트 + 타입 체크**

Run: `cd app && npm run test -- footnote/ && npm run check`
Expected: PASS all, 0 type errors.

- [ ] **Step 5: 커밋**

```bash
git add -A app/src/lib/editor/footnote/ app/tests/unit/editor/footnote/
git commit -m "refactor(footnote): 데코레이션 플러그인 제거 + cleanupPlugin 삭제"
```

---

### Task 9: 하위 소비자 업데이트 + CSS 정리

**Goal:** `footnoteMarker` 노드를 인식해야 하는 모든 하위 코드를 업데이트한다 — `copyFormatted` 의 4개 직렬화, `parseSchedule.ts` 의 `linearizeDoc`, `noteContentArchiver.ts` 의 `getPlainText`, `TomboyEditor.svelte` 의 CSS 정리. 마지막으로 전체 회귀 테스트와 타입 체크가 깨끗하게 통과한다.

**Files:**
- Modify: `app/src/lib/core/noteContentArchiver.ts:834` (`getPlainText`)
- Modify: `app/src/lib/editor/copyFormatted.ts`
- Modify: `app/src/lib/schedule/parseSchedule.ts` (linearizeDoc 의 inlineText)
- Modify: `app/src/lib/editor/TomboyEditor.svelte:1828-1853` (`.tomboy-fn-bracket` CSS 삭제)
- Modify: `app/tests/unit/editor/copyFormatted.test.ts` (footnote 케이스 추가)

**Acceptance Criteria:**
- [ ] `getPlainText({ type: 'footnoteMarker', attrs: { label: '1' } })` === `'[^1]'`.
- [ ] copyFormatted 4 serializer 모두 footnote 처리:
  - plain: `[^N]`
  - structured: `[^N]`
  - html: `<sup>N</sup>` (또는 def 위치 무관 항상 `<sup>` — paste-friendly)
  - markdown: `[^N]`
- [ ] `parseSchedule` 의 `inlineText` 가 footnoteMarker 를 `[^N]` 으로 펼침.
- [ ] `TomboyEditor.svelte` 에서 `.tomboy-fn-bracket` CSS 선택자 삭제 (DOM 에 더 이상 존재하지 않음).
- [ ] `.tomboy-fn-ref` / `.tomboy-fn-def` / `.tomboy-fn-flash` 스타일은 유지.
- [ ] `cd app && npm run test` 전체 통과 (footnote 외 회귀 없음).
- [ ] `cd app && npm run check` 0 errors.

**Verify:** `cd app && npm run test && npm run check` → 전 테스트 통과 + 타입 0 에러.

**Steps:**

- [ ] **Step 1: `getPlainText` 노드 분기 추가** — `app/src/lib/core/noteContentArchiver.ts:834`

```ts
function getPlainText(node: JSONContent): string {
	if (node.text) return node.text;
	if (node.type === 'footnoteMarker') {
		return `[^${(node.attrs?.label as string | undefined) ?? ''}]`;
	}
	if (!node.content) return '';
	return node.content.map(getPlainText).join('');
}
```

- [ ] **Step 2: copyFormatted 4 serializer 분기 추가** — `app/src/lib/editor/copyFormatted.ts`

`getTextNodes` (라인 23) 부터 시작해서 각 serializer 안의 inline 처리에 footnoteMarker 분기.

`getTextNodes` 보강:
```ts
function getTextNodes(node: JSONContent): string {
	if (node.type === 'text') return node.text ?? '';
	if (node.type === 'footnoteMarker') {
		return `[^${(node.attrs?.label as string | undefined) ?? ''}]`;
	}
	return (node.content ?? []).map(getTextNodes).join('');
}
```

이미 `getTextNodes` 가 plain/structured/markdown 의 다른 헬퍼들에서 호출되면 한 곳만 고치면 되지만, 각 serializer 가 자체 inline walker 를 가지면 각각 고쳐야 한다. 다음 grep 으로 확인:

```bash
grep -n "type === 'text'\|type === \"text\"" app/src/lib/editor/copyFormatted.ts
```

각 매치 옆에 footnoteMarker 분기를 추가:
- plainNode: text 처리 옆에 `if (child.type === 'footnoteMarker') parts.push('[^' + child.attrs?.label + ']');`
- structuredNode: 동일
- markdownNode: 동일 (raw 텍스트, escape 안 함 — `[`,`^`,`]` 는 `escapeMd` 가 escape 하므로 unescaped 형태로 push 후 escape 따로 안 한다. 단, `[^N]` 자체가 markdown footnote 문법이라 보존이 맞음. 단순화: `parts.push('[^' + label + ']')` 그대로).
- htmlNode: `<sup>N</sup>` push.

각각의 정확한 위치는 grep 후 구현 시 확인. 새 테스트 케이스로 검증.

- [ ] **Step 3: copyFormatted 테스트 추가** — `app/tests/unit/editor/copyFormatted.test.ts`

(기존 테스트 파일에 추가; 없으면 신규)

```ts
import { describe, it, expect } from 'vitest';
import {
	tiptapToPlainText,
	tiptapToStructuredText,
	tiptapToHtml,
	tiptapToMarkdown
} from '$lib/editor/copyFormatted.js';

const docWithFn = {
	type: 'doc',
	content: [
		{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
		{
			type: 'paragraph',
			content: [
				{ type: 'text', text: '본문 ' },
				{ type: 'footnoteMarker', attrs: { label: '1' } },
				{ type: 'text', text: ' 끝' }
			]
		}
	]
};

describe('copyFormatted — footnoteMarker', () => {
	it('plain → [^N]', () => {
		expect(tiptapToPlainText(docWithFn)).toContain('본문 [^1] 끝');
	});
	it('structured → [^N]', () => {
		expect(tiptapToStructuredText(docWithFn)).toContain('본문 [^1] 끝');
	});
	it('html → <sup>N</sup>', () => {
		expect(tiptapToHtml(docWithFn)).toContain('<sup>1</sup>');
	});
	it('markdown → [^N]', () => {
		expect(tiptapToMarkdown(docWithFn)).toContain('본문 [^1] 끝');
	});
});
```

- [ ] **Step 4: `parseSchedule.ts` 의 inlineText 보강** — `app/src/lib/schedule/parseSchedule.ts`

`inlineText` 헬퍼 (linearizeDoc 에서 사용) 를 찾아 footnote 분기 추가. grep:

```bash
grep -n "inlineText\|firstParagraphText" app/src/lib/schedule/parseSchedule.ts
```

해당 함수의 inline 노드 처리에 다음 추가:

```ts
if (n.type === 'footnoteMarker') {
	return `[^${(n.attrs?.label as string | undefined) ?? ''}]`;
}
```

(실제 함수의 패턴에 맞게 inline). 의도는 schedule parser 가 노드를 raw text 처럼 보게 하는 것 — 일정 라인에 각주가 박혀도 무시되지 않게.

- [ ] **Step 5: CSS 정리** — `app/src/lib/editor/TomboyEditor.svelte:1828-1853`

`.tomboy-fn-bracket` 규칙 삭제 (DOM 에 더 이상 클래스가 없음). 헤더 주석도 갱신:

```css
/* 각주 [^N] — footnoteMarker 노드의 NodeView 가 ref 는 <sup class="tomboy-fn-ref">
   (작은 위첨자), def 는 <span class="tomboy-fn-def"> (일반 크기) 로 렌더한다. */
.tomboy-editor :global(.tomboy-fn-ref) {
	...
}
.tomboy-editor :global(.tomboy-fn-def) {
	...
}
.tomboy-editor :global(.tomboy-fn-flash) {
	animation: tomboy-fn-flash 1.2s ease-out;
}
@keyframes -global-tomboy-fn-flash {
	...
}
```

(기존 `.tomboy-fn-bracket { font-size: 0; ... }` 등의 block 만 제거. 다른 규칙들은 그대로.)

- [ ] **Step 6: 전체 테스트 + 타입 체크**

Run: `cd app && npm run test && npm run check`
Expected: 전 테스트 통과, 0 type errors.

만약 회귀가 발견되면 (e.g. `noteContentArchiver.test.ts` 의 round-trip 깨짐) 해당 케이스를 분석 — 보통 footnote 와 무관한 spec 가정 (e.g. text-only inline 가정) 이 깨진 곳이다. 노드 핸들링을 추가하거나 테스트 expectation 갱신.

- [ ] **Step 7: 최종 커밋**

```bash
git add app/src/lib/core/noteContentArchiver.ts \
        app/src/lib/editor/copyFormatted.ts \
        app/src/lib/schedule/parseSchedule.ts \
        app/src/lib/editor/TomboyEditor.svelte \
        app/tests/unit/editor/copyFormatted.test.ts
git commit -m "feat(footnote): 하위 소비자(copyFormatted/parseSchedule/getPlainText/CSS) 업데이트"
```

---

## Self-Review

**Spec coverage:**
- 스키마 (atom, label) → Task 1 ✅
- NodeView 위치 기반 ref/def + update → Task 4 ✅
- Archiver 읽기/쓰기 → Task 2, 3 ✅
- Input rule + paste → Task 7 ✅
- Alt+J 명령 알고리즘 보존 → Task 6 ✅
- footnotes.ts 노드 walk → Task 5 ✅
- plugin.ts 데코 제거 + 클릭 핸들러 유지 → Task 8 ✅
- cleanupPlugin 삭제 → Task 8 ✅
- copyFormatted 4 serializer → Task 9 ✅
- parseSchedule linearizeDoc → Task 9 ✅
- getPlainText → Task 9 ✅
- CSS 정리 → Task 9 ✅
- 마크 가로지름 split 보존 → Task 3 (테스트 케이스로 검증) ✅
- malformed / 비숫자 / 한글 라벨 → Task 2, 5 (테스트 케이스) ✅

**Placeholder scan:** 모든 step 에 구체적 코드/명령. "implement later" 류 없음. 단, Task 9 의 inlineText 위치는 grep 으로 찾으라고만 했는데, 이건 implementation-time detail 이라 OK.

**Type consistency:**
- `FootnoteMarker` (node export) — Task 1 신설, Task 7 에서 보강 (input rule + paste). 이름 일관.
- `TomboyFootnote` — Task 1 에서 단일 Extension → 배열로 의미 변경. 호출지 spread 적용 step 포함.
- `FootnoteMatch` 시그니처 변화 없음 — Task 5 의 새 구현이 같은 type 반환.
- `defLabelOf` (Task 6) 새 헬퍼 — `DEF_PARA_RE` (Task 6 에서 제거되는 기존 상수) 대체.

OK, 일관성 문제 없음.

## 종합 동작 흐름 (참고)

전체 플로우가 정상 동작하는 마지막 상태 (Task 9 완료 후):

1. 사용자가 `.note` 파일을 열면 archiver(`deserializeContent`) 가 본문 텍스트의 `[^N]` 을 `footnoteMarker` 노드로 split. NodeView 가 ref/def 위치 분기에 따라 `<sup>` 또는 `<span>` 으로 렌더.
2. 사용자가 본문에서 `[^1]` 타이핑 → input rule 이 즉시 노드로 변환.
3. plain text paste → transformPasted 가 노드로 변환.
4. Alt+J → insertCommand 가 노드 op 로 그룹 renumber + 정의 단락 재정렬.
5. 마커 클릭 → plugin 의 mousedown 핸들러가 NodeView DOM (`.tomboy-fn-ref/.tomboy-fn-def`) 매치 → 짝으로 스크롤.
6. 저장 시 archiver(`serializeContent`) 가 노드를 `[^N]` 텍스트로 직렬화. 마크 가로지름은 mark 가 split 됨 (의도된 비대칭).
7. 캐럿 좌우 화살표는 마커 통째 건너뜀 (atomic 노드 PM 기본 동작). 캐럿 사라짐 문제 — 구조적 해결.
