# 각주 + 인용 기능 구현 계획 (Footnote + Blockquote)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 노트 에디터에 각주(`[^N]` → 클릭 가능한 위첨자 숫자 + 스크롤)와 인용(`> ` → 왼쪽 테두리 들여쓰기) 두 표시 기능을 추가한다.

**Architecture:** 두 기능 모두 **순수 표시 계층(decoration-only)**. 마커 텍스트(`[^N]`, `> `)는 라이브 ProseMirror 문서와 `.note` XML 양쪽에 평범한 텍스트로 그대로 남고, ProseMirror 플러그인이 화면에만 각주/인용으로 그린다. **아카이버(`noteContentArchiver.ts`)와 스키마는 절대 건드리지 않는다** — 라운드트립이 자동으로 byte-stable. 체크리스트 기능의 모듈 구조(`detection / plugin / index`)를 미러링한다.

**Tech Stack:** SvelteKit, Svelte 5 runes, TipTap 3 / ProseMirror, TypeScript, vitest.

**참고:** 설계 스펙은 `docs/superpowers/specs/2026-05-20-footnote-blockquote-design.md`.

---

## 파일 구조

| 파일 | 역할 | 태스크 |
|------|------|--------|
| `app/src/lib/editor/footnote/footnotes.ts` | 각주 마커 탐색 순수 함수 | 1 |
| `app/src/lib/editor/footnote/plugin.ts` | 각주 데코레이션 + 클릭 스크롤 플러그인 | 2 |
| `app/src/lib/editor/footnote/index.ts` | `TomboyFootnote` 확장 + re-export | 2 |
| `app/src/lib/editor/blockquote/blockquote.ts` | 인용 단락 탐색 순수 함수 | 3 |
| `app/src/lib/editor/blockquote/plugin.ts` | 인용 데코레이션 플러그인 | 4 |
| `app/src/lib/editor/blockquote/index.ts` | `TomboyBlockquote` 확장 + re-export | 4 |
| `app/src/lib/editor/TomboyEditor.svelte` | 확장 등록 + onMissing 토스트 + CSS | 5 |
| `app/tests/unit/editor/footnotes.test.ts` | 각주 탐색 테스트 | 1 |
| `app/tests/unit/editor/footnotePlugin.test.ts` | 각주 플러그인 테스트 | 2 |
| `app/tests/unit/editor/blockquote.test.ts` | 인용 탐색 테스트 | 3 |
| `app/tests/unit/editor/blockquotePlugin.test.ts` | 인용 플러그인 테스트 | 4 |

**의존성:** Task 2 ← Task 1, Task 4 ← Task 3, Task 5 ← Task 2 + Task 4. Task 1과 3은 독립적.

모든 명령은 `app/` 에서 실행한다.

---

## Task 1: 각주 마커 탐색 모듈

**Goal:** 문서에서 `[^N]` 마커를 찾아 참조/설명마커로 분류하고 짝을 찾는 순수 함수 모듈을 만든다.

**Files:**
- Create: `app/src/lib/editor/footnote/footnotes.ts`
- Test: `app/tests/unit/editor/footnotes.test.ts`

**Acceptance Criteria:**
- [ ] `findFootnoteMatches` 가 `[^N]` 매치를 문서 순서대로 찾고, 잘못된 형태(`[^]`, 닫는 `]` 없음, `[^ x]`)는 무시하며, 제목(0번 단락)을 제외한다
- [ ] 최상위 단락 맨 앞(선행 공백 제외)의 `[^N]` 은 `isDefinitionMarker: true`, 그 외(단락 중간, 리스트 내부)는 `false`
- [ ] `findFootnoteAt` 가 위치를 포함하는 매치를, `findFootnotePartner` 가 같은 라벨의 반대 역할 매치를 반환
- [ ] `cd app && npm run test -- footnotes` 통과

**Verify:** `cd app && npm run test -- footnotes` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/editor/footnotes.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

import {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner
} from '$lib/editor/footnote/footnotes.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeDoc(blocks: JSONContent[]): PMNode {
	currentEditor = new Editor({
		extensions: [StarterKit],
		content: { type: 'doc', content: blocks }
	});
	return currentEditor.state.doc;
}

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});

describe('findFootnoteMatches', () => {
	it('finds a reference in a body paragraph', () => {
		const doc = makeDoc([P('제목'), P('진술하였다:[^7] 끝')]);
		const matches = findFootnoteMatches(doc);
		expect(matches).toHaveLength(1);
		expect(matches[0].label).toBe('7');
		expect(matches[0].isDefinitionMarker).toBe(false);
		expect(doc.textBetween(matches[0].from, matches[0].to)).toBe('[^7]');
	});

	it('ignores malformed markers', () => {
		const doc = makeDoc([P('제목'), P('[^] [^ x] [^abc 끝')]);
		expect(findFootnoteMatches(doc)).toHaveLength(0);
	});

	it('marks a paragraph-leading [^N] as a definition marker', () => {
		const doc = makeDoc([P('제목'), P('[^7] 설명 내용')]);
		const matches = findFootnoteMatches(doc);
		expect(matches).toHaveLength(1);
		expect(matches[0].isDefinitionMarker).toBe(true);
	});

	it('treats a definition marker after leading whitespace as a definition', () => {
		const doc = makeDoc([P('제목'), P('   [^7] 설명')]);
		expect(findFootnoteMatches(doc)[0].isDefinitionMarker).toBe(true);
	});

	it('treats a mid-paragraph [^N] as a reference', () => {
		const doc = makeDoc([P('제목'), P('앞 글자 [^7]')]);
		expect(findFootnoteMatches(doc)[0].isDefinitionMarker).toBe(false);
	});

	it('excludes the title (block index 0)', () => {
		const doc = makeDoc([P('[^7] 제목'), P('본문')]);
		expect(findFootnoteMatches(doc)).toHaveLength(0);
	});

	it('treats a [^N] inside a list item as a reference', () => {
		const doc = makeDoc([
			P('제목'),
			{
				type: 'bulletList',
				content: [{ type: 'listItem', content: [P('[^7] 항목')] }]
			}
		]);
		const matches = findFootnoteMatches(doc);
		expect(matches).toHaveLength(1);
		expect(matches[0].label).toBe('7');
		expect(matches[0].isDefinitionMarker).toBe(false);
		expect(doc.textBetween(matches[0].from, matches[0].to)).toBe('[^7]');
	});

	it('returns multiple matches in document order', () => {
		const doc = makeDoc([
			P('제목'),
			P('가[^7] 나[^8]'),
			P('[^7] 설명7')
		]);
		const matches = findFootnoteMatches(doc);
		expect(matches.map((m) => m.label)).toEqual(['7', '8', '7']);
		expect(matches[2].isDefinitionMarker).toBe(true);
	});
});

describe('findFootnoteAt', () => {
	it('returns the match containing a position, else null', () => {
		const doc = makeDoc([P('제목'), P('가[^7]')]);
		const matches = findFootnoteMatches(doc);
		expect(findFootnoteAt(matches, matches[0].from + 2)).toBe(matches[0]);
		expect(findFootnoteAt(matches, 1)).toBeNull();
	});
});

describe('findFootnotePartner', () => {
	function setup() {
		const doc = makeDoc([
			P('제목'),
			P('본문 [^7] 그리고 [^9]'),
			P('[^7] 라벨7 설명')
		]);
		return findFootnoteMatches(doc);
	}

	it('reference → first definition marker of same label', () => {
		const matches = setup();
		const ref = matches.find((m) => m.label === '7' && !m.isDefinitionMarker)!;
		const partner = findFootnotePartner(matches, ref);
		expect(partner?.isDefinitionMarker).toBe(true);
		expect(partner?.label).toBe('7');
	});

	it('definition marker → first reference of same label', () => {
		const matches = setup();
		const def = matches.find((m) => m.isDefinitionMarker)!;
		const partner = findFootnotePartner(matches, def);
		expect(partner?.isDefinitionMarker).toBe(false);
		expect(partner?.label).toBe('7');
	});

	it('returns null when no partner exists', () => {
		const matches = setup();
		const ref9 = matches.find((m) => m.label === '9')!;
		expect(findFootnotePartner(matches, ref9)).toBeNull();
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- footnotes`
Expected: FAIL — `footnotes.js` 모듈 없음.

- [ ] **Step 3: `footnotes.ts` 구현** — `app/src/lib/editor/footnote/footnotes.ts`

```ts
/**
 * 각주 마커 [^라벨] 탐색 (순수 함수).
 *
 * 본문 어디든 나오는 [^N] 은 "참조", 최상위 단락의 맨 앞(선행 공백
 * 제외)에 오는 [^N] 은 "설명 마커"다. 화면 표시는 동일하고, 역할은
 * 클릭 시 스크롤 대상 결정에만 쓰인다. 제목(0번 단락)은 제외한다.
 *
 * 마커는 라이브 문서와 .note XML 양쪽에 평범한 텍스트로 남는다 —
 * 아카이버(noteContentArchiver.ts)는 이 파일을 거치지 않는다.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

/** [^라벨] — 라벨은 ] 와 공백이 아닌 1자 이상. */
const FOOTNOTE_RE = /\[\^([^\]\s]+)\]/g;

export interface FootnoteMatch {
	/** 매치 시작 절대 위치 ('[' 앞). */
	from: number;
	/** 매치 끝 절대 위치 (']' 뒤). */
	to: number;
	/** [^ 와 ] 사이의 라벨 텍스트. */
	label: string;
	/** 최상위 단락의 맨 앞(선행 공백 제외)에 오면 true. */
	isDefinitionMarker: boolean;
}

/**
 * 한 textblock 의 인라인 텍스트에서 [^N] 매치를 모은다. `canBeDefinition`
 * 이 true 면 블록 맨 앞(선행 공백 제외)의 매치는 설명 마커로 표시된다.
 */
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
		if (child.isText && child.text != null) {
			const text = child.text;
			FOOTNOTE_RE.lastIndex = 0;
			let lastIdx = 0;
			let m: RegExpExecArray | null;
			while ((m = FOOTNOTE_RE.exec(text)) !== null) {
				if (/\S/.test(text.slice(lastIdx, m.index))) sawContent = true;
				const from = contentStart + rel + m.index;
				out.push({
					from,
					to: from + m[0].length,
					label: m[1],
					isDefinitionMarker: canBeDefinition && !sawContent
				});
				sawContent = true;
				lastIdx = m.index + m[0].length;
			}
			if (/\S/.test(text.slice(lastIdx))) sawContent = true;
		} else {
			// 텍스트 아닌 인라인 노드(hardBreak 등)는 내용으로 친다.
			sawContent = true;
		}
		rel += child.nodeSize;
	});
}

/** 문서 전체의 각주 매치를 문서 순서대로 반환. 제목(0번 단락) 제외. */
export function findFootnoteMatches(doc: PMNode): FootnoteMatch[] {
	const out: FootnoteMatch[] = [];
	doc.forEach((topNode, offset, index) => {
		if (index === 0) return; // 제목 단락 제외
		if (topNode.isTextblock) {
			scanTextblock(
				topNode,
				offset,
				topNode.type.name === 'paragraph',
				out
			);
		} else {
			// 리스트 등 컨테이너 — 내부 textblock 스캔, 설명 마커는 불가.
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

/** 위치 `pos` 를 포함하는 매치를 반환(없으면 null). */
export function findFootnoteAt(
	matches: FootnoteMatch[],
	pos: number
): FootnoteMatch | null {
	for (const m of matches) {
		if (pos >= m.from && pos <= m.to) return m;
	}
	return null;
}

/**
 * 클릭된 매치의 짝을 반환:
 *  - 설명 마커 클릭 → 같은 라벨의 첫 참조
 *  - 참조 클릭     → 같은 라벨의 첫 설명 마커
 * 짝이 없으면 null.
 */
export function findFootnotePartner(
	matches: FootnoteMatch[],
	clicked: FootnoteMatch
): FootnoteMatch | null {
	const wantDefinition = !clicked.isDefinitionMarker;
	for (const m of matches) {
		if (m === clicked) continue;
		if (m.label !== clicked.label) continue;
		if (m.isDefinitionMarker === wantDefinition) return m;
	}
	return null;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- footnotes`
Expected: PASS — 모든 테스트.

- [ ] **Step 5: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web
git add app/src/lib/editor/footnote/footnotes.ts app/tests/unit/editor/footnotes.test.ts
git commit -m "feat(footnote): 각주 마커 탐색 모듈"
```

---

## Task 2: 각주 데코레이션 플러그인 + 확장

**Goal:** `[^N]` 매치마다 브래킷을 숨기고 라벨을 위첨자로 그리는 데코레이션 플러그인, 클릭 시 짝으로 스크롤하는 핸들러, 그리고 `TomboyFootnote` TipTap 확장을 만든다.

**Files:**
- Create: `app/src/lib/editor/footnote/plugin.ts`
- Create: `app/src/lib/editor/footnote/index.ts`
- Test: `app/tests/unit/editor/footnotePlugin.test.ts`

**Acceptance Criteria:**
- [ ] `[^N]` 매치마다 인라인 데코레이션 3개 — `[^` 숨김, 라벨 `<sup>`, `]` 숨김
- [ ] 플러그인 상태가 매치 목록과 `DecorationSet` 을 보관하고 doc 변경 시 재계산
- [ ] `handleClick` 이 각주 클릭 시 짝으로 스크롤하고, 짝이 없으면 `onMissing(label, kind)` 호출 후 `true` 반환; 각주 밖 클릭은 `false`
- [ ] `cd app && npm run test -- footnotePlugin` 통과

**Verify:** `cd app && npm run test -- footnotePlugin` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/editor/footnotePlugin.test.ts`

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import {
	TomboyFootnote,
	footnotePluginKey,
	findFootnoteMatches
} from '$lib/editor/footnote/index.js';

// jsdom 은 레이아웃을 구현하지 않아 scrollIntoView 가 없을 수 있다.
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});

function makeEditor(blocks: JSONContent[], onMissing = () => {}): Editor {
	currentEditor = new Editor({
		extensions: [StarterKit, TomboyFootnote.configure({ onMissing })],
		content: { type: 'doc', content: blocks }
	});
	return currentEditor;
}

function clickAt(e: Editor, pos: number): boolean {
	const handled = e.view.someProp('handleClick', (fn) =>
		fn(e.view, pos, new MouseEvent('click'))
	);
	return handled === true;
}

describe('footnote plugin decorations', () => {
	it('builds 3 decorations per [^N] match', () => {
		const e = makeEditor([P('제목'), P('가[^7] 나[^8]')]);
		const st = footnotePluginKey.getState(e.state)!;
		expect(st.matches).toHaveLength(2);
		expect(st.decorations.find()).toHaveLength(6);
	});

	it('produces no decorations when there are no footnotes', () => {
		const e = makeEditor([P('제목'), P('각주 없음')]);
		const st = footnotePluginKey.getState(e.state)!;
		expect(st.decorations.find()).toHaveLength(0);
	});
});

describe('footnote plugin click', () => {
	it('calls onMissing for a reference with no definition', () => {
		const onMissing = vi.fn();
		const e = makeEditor([P('제목'), P('본문 [^7]')], onMissing);
		const ref = findFootnoteMatches(e.state.doc)[0];
		expect(clickAt(e, ref.from + 2)).toBe(true);
		expect(onMissing).toHaveBeenCalledWith('7', 'reference');
	});

	it('calls onMissing for a definition marker with no reference', () => {
		const onMissing = vi.fn();
		const e = makeEditor([P('제목'), P('[^7] 설명만 있음')], onMissing);
		const def = findFootnoteMatches(e.state.doc)[0];
		clickAt(e, def.from + 2);
		expect(onMissing).toHaveBeenCalledWith('7', 'definition');
	});

	it('does not call onMissing when a partner exists', () => {
		const onMissing = vi.fn();
		const e = makeEditor(
			[P('제목'), P('본문 [^7]'), P('[^7] 설명')],
			onMissing
		);
		const ref = findFootnoteMatches(e.state.doc).find(
			(m) => !m.isDefinitionMarker
		)!;
		expect(clickAt(e, ref.from + 2)).toBe(true);
		expect(onMissing).not.toHaveBeenCalled();
	});

	it('returns false for a click outside any footnote', () => {
		const onMissing = vi.fn();
		const e = makeEditor([P('제목'), P('본문 [^7]')], onMissing);
		expect(clickAt(e, 1)).toBe(false);
		expect(onMissing).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- footnotePlugin`
Expected: FAIL — `footnote/index.js` 없음.

- [ ] **Step 3: `plugin.ts` 구현** — `app/src/lib/editor/footnote/plugin.ts`

```ts
/**
 * 각주 ProseMirror 플러그인 — 표시 전용.
 *
 * 모든 [^N] 매치에 인라인 데코레이션을 단다([^ 와 ] 는 폭 0으로 접고
 * 가운데 라벨은 <sup> 로 감싼다). 클릭하면 짝(참조↔설명)으로 스크롤한다.
 * 문서를 변형하지 않는다.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

import {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner,
	type FootnoteMatch
} from './footnotes.js';

export interface FootnotePluginOptions {
	/** 짝(참조/설명)을 찾지 못했을 때. kind 는 클릭한 마커의 역할. */
	onMissing: (label: string, kind: 'reference' | 'definition') => void;
}

export interface FootnotePluginState {
	matches: FootnoteMatch[];
	decorations: DecorationSet;
}

export const footnotePluginKey = new PluginKey<FootnotePluginState>(
	'tomboyFootnote'
);

function buildDecorations(
	doc: PMNode,
	matches: FootnoteMatch[]
): DecorationSet {
	const decos: Decoration[] = [];
	for (const m of matches) {
		// 여는 [^ (2자) 숨김.
		decos.push(
			Decoration.inline(m.from, m.from + 2, { class: 'tomboy-fn-bracket' })
		);
		// 라벨 → <sup class="tomboy-fn-ref">.
		decos.push(
			Decoration.inline(m.from + 2, m.to - 1, {
				nodeName: 'sup',
				class: 'tomboy-fn-ref'
			})
		);
		// 닫는 ] (1자) 숨김.
		decos.push(
			Decoration.inline(m.to - 1, m.to, { class: 'tomboy-fn-bracket' })
		);
	}
	return DecorationSet.create(doc, decos);
}

/** 대상 매치가 있는 블록으로 부드럽게 스크롤 + 약 1.2초 하이라이트. */
function scrollToMatch(view: EditorView, target: FootnoteMatch): void {
	const { node } = view.domAtPos(target.from);
	const el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
	if (!el) return;
	const block = el.closest('p, li, h1, h2, h3') ?? el;
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
				const matches = findFootnoteMatches(state.doc);
				return {
					matches,
					decorations: buildDecorations(state.doc, matches)
				};
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				const matches = findFootnoteMatches(newState.doc);
				return {
					matches,
					decorations: buildDecorations(newState.doc, matches)
				};
			}
		},
		props: {
			decorations(state) {
				return footnotePluginKey.getState(state)?.decorations ?? null;
			},
			handleClick(view, pos) {
				const st = footnotePluginKey.getState(view.state);
				if (!st) return false;
				const hit = findFootnoteAt(st.matches, pos);
				if (!hit) return false;
				const partner = findFootnotePartner(st.matches, hit);
				if (!partner) {
					options.onMissing(
						hit.label,
						hit.isDefinitionMarker ? 'definition' : 'reference'
					);
					return true;
				}
				scrollToMatch(view, partner);
				return true;
			}
		}
	});
}
```

- [ ] **Step 4: `index.ts` 구현** — `app/src/lib/editor/footnote/index.ts`

```ts
import { Extension } from '@tiptap/core';

import {
	createFootnotePlugin,
	footnotePluginKey,
	type FootnotePluginOptions
} from './plugin.js';

export {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner
} from './footnotes.js';
export type { FootnoteMatch } from './footnotes.js';
export { footnotePluginKey };
export type { FootnotePluginOptions, FootnotePluginState } from './plugin.js';

export const TomboyFootnote = Extension.create<FootnotePluginOptions>({
	name: 'tomboyFootnote',
	addOptions() {
		return {
			onMissing: () => {}
		};
	},
	addProseMirrorPlugins() {
		return [createFootnotePlugin(this.options)];
	}
});
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd app && npm run test -- footnotePlugin`
Expected: PASS — 모든 테스트.

- [ ] **Step 6: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web
git add app/src/lib/editor/footnote/plugin.ts app/src/lib/editor/footnote/index.ts app/tests/unit/editor/footnotePlugin.test.ts
git commit -m "feat(footnote): 데코레이션 + 클릭 스크롤 플러그인"
```

---

## Task 3: 인용 단락 탐색 모듈

**Goal:** `> ` 로 시작하는 최상위 단락(인용 단락)을 찾는 순수 함수 모듈을 만든다.

**Files:**
- Create: `app/src/lib/editor/blockquote/blockquote.ts`
- Test: `app/tests/unit/editor/blockquote.test.ts`

**Acceptance Criteria:**
- [ ] `isQuotedParagraphText` 가 `> `(꺾쇠+공백)로 시작하는 텍스트에만 true (공백 없는 `>`, 앞 공백 있는 경우는 false)
- [ ] `findQuotedParagraphs` 가 인용 최상위 단락을 문서 순서대로 찾고, 제목(0번)·리스트 내부 단락은 제외하며, `textStart = paraPos + 1` 을 반환
- [ ] `cd app && npm run test -- editor/blockquote.test` 통과 (`blockquote.test.ts`)

**Verify:** `cd app && npm run test -- editor/blockquote.test` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/editor/blockquote.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

import {
	isQuotedParagraphText,
	findQuotedParagraphs
} from '$lib/editor/blockquote/blockquote.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeDoc(blocks: JSONContent[]): PMNode {
	currentEditor = new Editor({
		extensions: [StarterKit],
		content: { type: 'doc', content: blocks }
	});
	return currentEditor.state.doc;
}

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});

describe('isQuotedParagraphText', () => {
	it('is true only for text starting with "> "', () => {
		expect(isQuotedParagraphText('> 인용문')).toBe(true);
		expect(isQuotedParagraphText('>인용문')).toBe(false);
		expect(isQuotedParagraphText('인용 아님')).toBe(false);
		expect(isQuotedParagraphText('  > 앞공백')).toBe(false);
	});
});

describe('findQuotedParagraphs', () => {
	it('finds a quoted body paragraph', () => {
		const doc = makeDoc([P('제목'), P('> 인용된 단락')]);
		const quoted = findQuotedParagraphs(doc);
		expect(quoted).toHaveLength(1);
		expect(quoted[0].textStart).toBe(quoted[0].paraPos + 1);
		expect(
			doc.textBetween(quoted[0].textStart, quoted[0].textStart + 2)
		).toBe('> ');
	});

	it('ignores non-quoted paragraphs', () => {
		const doc = makeDoc([P('제목'), P('보통 단락')]);
		expect(findQuotedParagraphs(doc)).toHaveLength(0);
	});

	it('excludes the title even if it starts with "> "', () => {
		const doc = makeDoc([P('> 제목'), P('본문')]);
		expect(findQuotedParagraphs(doc)).toHaveLength(0);
	});

	it('excludes paragraphs inside a list', () => {
		const doc = makeDoc([
			P('제목'),
			{
				type: 'bulletList',
				content: [{ type: 'listItem', content: [P('> 리스트 안')] }]
			}
		]);
		expect(findQuotedParagraphs(doc)).toHaveLength(0);
	});

	it('finds every paragraph in a run of consecutive quotes', () => {
		const doc = makeDoc([
			P('제목'),
			P('> 첫 줄'),
			P('> 둘째 줄'),
			P('보통'),
			P('> 떨어진 인용')
		]);
		expect(findQuotedParagraphs(doc)).toHaveLength(3);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- editor/blockquote.test`
Expected: FAIL — `blockquote.js` 모듈 없음.

- [ ] **Step 3: `blockquote.ts` 구현** — `app/src/lib/editor/blockquote/blockquote.ts`

```ts
/**
 * 인용 단락 탐색 (순수 함수).
 *
 * '> '(꺾쇠 + 공백)로 시작하는 최상위 단락이 인용 단락이다. 제목(0번
 * 단락)과 리스트 내부 단락은 제외한다. 마커 '> ' 는 라이브 문서와
 * .note XML 양쪽에 텍스트로 남는다 — 아카이버 비경유.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

/** 텍스트가 '> '(꺾쇠+공백)로 시작하면 인용 단락. */
export function isQuotedParagraphText(text: string): boolean {
	return /^> /.test(text);
}

export interface QuotedParagraph {
	/** 단락 노드의 절대 위치. */
	paraPos: number;
	paraNode: PMNode;
	/** 단락 내용 시작 위치 = paraPos + 1 ('>' 의 위치). */
	textStart: number;
}

/** 문서의 인용 최상위 단락을 문서 순서대로 반환. 제목(0번) 제외. */
export function findQuotedParagraphs(doc: PMNode): QuotedParagraph[] {
	const out: QuotedParagraph[] = [];
	doc.forEach((node, offset, index) => {
		if (index === 0) return; // 제목 제외
		if (node.type.name !== 'paragraph') return; // 최상위 단락만
		if (!isQuotedParagraphText(node.textContent)) return;
		out.push({ paraPos: offset, paraNode: node, textStart: offset + 1 });
	});
	return out;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- editor/blockquote.test`
Expected: PASS — 모든 테스트.

- [ ] **Step 5: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web
git add app/src/lib/editor/blockquote/blockquote.ts app/tests/unit/editor/blockquote.test.ts
git commit -m "feat(blockquote): 인용 단락 탐색 모듈"
```

---

## Task 4: 인용 데코레이션 플러그인 + 확장

**Goal:** 인용 단락마다 `<p>` 에 클래스를 달고 맨 앞 `> ` 를 숨기는 데코레이션 플러그인, 그리고 `TomboyBlockquote` TipTap 확장을 만든다.

**Files:**
- Create: `app/src/lib/editor/blockquote/plugin.ts`
- Create: `app/src/lib/editor/blockquote/index.ts`
- Test: `app/tests/unit/editor/blockquotePlugin.test.ts`

**Acceptance Criteria:**
- [ ] 인용 단락마다 데코레이션 2개 — `<p>` 노드 데코(`tomboy-quote`) + `> ` 2자 인라인 숨김 데코(`tomboy-quote-marker`)
- [ ] 비인용 단락은 미장식; doc 변경 시 재계산
- [ ] `TomboyBlockquote` 확장이 플러그인을 등록
- [ ] `cd app && npm run test -- blockquotePlugin` 통과

**Verify:** `cd app && npm run test -- blockquotePlugin` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `app/tests/unit/editor/blockquotePlugin.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import {
	TomboyBlockquote,
	blockquotePluginKey
} from '$lib/editor/blockquote/index.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});

function makeEditor(blocks: JSONContent[]): Editor {
	currentEditor = new Editor({
		extensions: [StarterKit, TomboyBlockquote],
		content: { type: 'doc', content: blocks }
	});
	return currentEditor;
}

describe('blockquote plugin decorations', () => {
	it('builds a node + marker decoration per quoted paragraph', () => {
		const e = makeEditor([P('제목'), P('> 인용')]);
		const set = blockquotePluginKey.getState(e.state)!;
		expect(set.find()).toHaveLength(2);
	});

	it('produces no decorations without a quoted paragraph', () => {
		const e = makeEditor([P('제목'), P('보통 단락')]);
		const set = blockquotePluginKey.getState(e.state)!;
		expect(set.find()).toHaveLength(0);
	});

	it('decorates each paragraph in a consecutive quote run', () => {
		const e = makeEditor([P('제목'), P('> 첫'), P('> 둘'), P('보통')]);
		const set = blockquotePluginKey.getState(e.state)!;
		expect(set.find()).toHaveLength(4);
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- blockquotePlugin`
Expected: FAIL — `blockquote/index.js` 없음.

- [ ] **Step 3: `plugin.ts` 구현** — `app/src/lib/editor/blockquote/plugin.ts`

```ts
/**
 * 인용 ProseMirror 플러그인 — 표시 전용.
 *
 * 인용 단락마다 <p> 에 .tomboy-quote 노드 데코를, 맨 앞 '> ' 2자에
 * 폭 0 마커 숨김 데코를 단다. 문서를 변형하지 않는다. 연속 인용의
 * 시각적 연결은 CSS 인접 형제 선택자가 처리한다.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

import { findQuotedParagraphs } from './blockquote.js';

export const blockquotePluginKey = new PluginKey<DecorationSet>(
	'tomboyBlockquote'
);

function buildDecorations(doc: PMNode): DecorationSet {
	const decos: Decoration[] = [];
	for (const q of findQuotedParagraphs(doc)) {
		decos.push(
			Decoration.node(q.paraPos, q.paraPos + q.paraNode.nodeSize, {
				class: 'tomboy-quote'
			})
		);
		decos.push(
			Decoration.inline(q.textStart, q.textStart + 2, {
				class: 'tomboy-quote-marker'
			})
		);
	}
	return DecorationSet.create(doc, decos);
}

export function createBlockquotePlugin(): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: blockquotePluginKey,
		state: {
			init(_, state) {
				return buildDecorations(state.doc);
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				return buildDecorations(newState.doc);
			}
		},
		props: {
			decorations(state) {
				return blockquotePluginKey.getState(state) ?? null;
			}
		}
	});
}
```

- [ ] **Step 4: `index.ts` 구현** — `app/src/lib/editor/blockquote/index.ts`

```ts
import { Extension } from '@tiptap/core';

import { createBlockquotePlugin, blockquotePluginKey } from './plugin.js';

export { isQuotedParagraphText, findQuotedParagraphs } from './blockquote.js';
export type { QuotedParagraph } from './blockquote.js';
export { blockquotePluginKey };

export const TomboyBlockquote = Extension.create({
	name: 'tomboyBlockquote',
	addProseMirrorPlugins() {
		return [createBlockquotePlugin()];
	}
});
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd app && npm run test -- blockquotePlugin`
Expected: PASS — 모든 테스트.

- [ ] **Step 6: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web
git add app/src/lib/editor/blockquote/plugin.ts app/src/lib/editor/blockquote/index.ts app/tests/unit/editor/blockquotePlugin.test.ts
git commit -m "feat(blockquote): 인용 데코레이션 플러그인"
```

---

## Task 5: 에디터 연결 — 확장 등록 · onMissing 토스트 · CSS

**Goal:** `TomboyEditor.svelte` 에 `TomboyFootnote`/`TomboyBlockquote` 확장을 등록하고, 각주 onMissing 을 토스트로 연결하고, 각주·인용 CSS 를 추가한다.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte` — 확장 import, 확장 배열, `<style>` 블록

**Acceptance Criteria:**
- [ ] `TomboyFootnote.configure({ onMissing })` 와 `TomboyBlockquote` 가 확장 배열에 등록됨
- [ ] `onMissing` 이 `pushToast` 로 한국어 오류 메시지를 띄움
- [ ] 각주 `[^N]` 은 위첨자 작은 숫자로, `[^`/`]` 는 숨겨짐; 인용 `> ` 단락은 왼쪽 테두리+들여쓰기, `> ` 는 숨겨짐; 연속 인용은 간격 좁힘
- [ ] `cd app && npm run check && npm run test` 통과 (타입 0 오류, 전체 테스트 통과)

**Verify:** `cd app && npm run check && npm run test` → svelte-check 0 errors, 전체 vitest PASS. 이어서 아래 Step 5 의 수동 확인.

**Steps:**

- [ ] **Step 1: 확장 import 추가**

`app/src/lib/editor/TomboyEditor.svelte` 의 checklist import 블록(`} from "./checklist/index.js";`, 약 83번째 줄) **바로 다음 줄**에 추가:

```ts
	import { TomboyFootnote } from "./footnote/index.js";
	import { TomboyBlockquote } from "./blockquote/index.js";
```

- [ ] **Step 2: 확장 배열에 등록**

확장 배열의 `TomboyChecklist.configure({ ... })` 블록(약 464–470번째 줄, `onToggle` 콜백으로 끝남) **바로 다음**, 배열을 닫는 `]` 앞에 추가:

```ts
				TomboyFootnote.configure({
					onMissing: (label, kind) => {
						pushToast(
							kind === "reference"
								? `각주 ‘${label}’ 설명을 찾을 수 없습니다`
								: `각주 ‘${label}’ 참조를 찾을 수 없습니다`,
							{ kind: "error" },
						);
					},
				}),
				TomboyBlockquote,
```

`pushToast` 는 이미 import 되어 있다(파일 상단 `import { pushToast, dismissToast } from "$lib/stores/toast.js";`). 새 import 불필요.

- [ ] **Step 3: CSS 추가**

`<style>` 블록의 체크리스트 CSS 마지막 규칙(`.tomboy-editor :global(.tomboy-checkbox-box.is-checked) { ... }`, 약 1607번째 줄에서 닫힘) **바로 다음**에 추가:

```css
	/* 각주 [^N] — footnote 플러그인이 [^ 와 ] 를 .tomboy-fn-bracket 로
	   폭 0 처리하고, 가운데 라벨을 <sup class="tomboy-fn-ref"> 로 감싼다.
	   마커는 .note XML 본문에 [^N] 텍스트로 그대로 남는다. */
	.tomboy-editor :global(.tomboy-fn-bracket) {
		font-size: 0;
	}
	.tomboy-editor :global(.tomboy-fn-ref) {
		font-size: 0.75em;
		color: #2563eb;
		cursor: pointer;
	}
	/* 클릭 스크롤 도착 시 약 1.2초 하이라이트 깜빡임. */
	.tomboy-editor :global(.tomboy-fn-flash) {
		animation: tomboy-fn-flash 1.2s ease-out;
	}
	@keyframes -global-tomboy-fn-flash {
		from {
			background-color: rgba(250, 204, 21, 0.55);
		}
		to {
			background-color: transparent;
		}
	}

	/* 인용 단락 — blockquote 플러그인이 '> ' 로 시작하는 최상위 단락에
	   .tomboy-quote 노드 데코를, 맨 앞 '> ' 2자에 .tomboy-quote-marker
	   폭 0 데코를 단다. 연속 인용은 인접 형제 선택자로 위 여백을 좁혀
	   한 덩어리처럼 보이게 한다. */
	.tomboy-editor :global(p.tomboy-quote) {
		border-left: 3px solid #d1d5db;
		padding-left: 0.9em;
		color: #4b5563;
	}
	.tomboy-editor :global(p.tomboy-quote + p.tomboy-quote) {
		margin-top: 0.2em;
	}
	.tomboy-editor :global(.tomboy-quote-marker) {
		font-size: 0;
	}
```

참고: `@keyframes` 에 `-global-` 접두사를 쓰면 Svelte 가 스코핑하지 않아 `:global()` 규칙의 `animation: tomboy-fn-flash` 가 그대로 참조한다(접두사는 이름에서 제거됨).

- [ ] **Step 4: 타입 체크 + 전체 테스트**

Run: `cd app && npm run check && npm run test`
Expected: svelte-check 0 errors (기존 무관 a11y 경고는 허용), 전체 vitest PASS — 새 4개 테스트 파일 포함, 회귀 없음.

- [ ] **Step 5: 수동 확인** (`cd app && npm run dev` 후 브라우저)

설계 스펙의 캡쳐 이미지(목격자 출현 예시)를 기준으로 노트 하나에서 확인:

1. 본문 단락에 `진술하였다:[^7]` 입력 → `[^7]` 이 작은 위첨자 `7` 로 표시, `[^`·`]` 안 보임.
2. 문서 하단에 `[^7] 각주 7 설명...` 단락 작성 → 맨 앞 `[^7]` 도 위첨자 `7` 로 표시.
3. 본문의 위첨자 `⁷` 클릭 → 하단 설명 단락으로 부드럽게 스크롤 + 잠깐 하이라이트.
4. 설명 단락의 `⁷` 클릭 → 본문 참조로 되돌아 스크롤.
5. 짝 없는 `[^9]` 클릭 → 오류 토스트 `각주 ‘9’ 설명을 찾을 수 없습니다`.
6. 단락을 `> "내가 벅스 로에..."` 로 시작 → 왼쪽 테두리 + 들여쓰기 + 흐린 색, `> ` 안 보임.
7. 그 아래 단락도 `> ` 로 시작 → 두 인용 단락의 왼쪽 테두리가 거의 이어지고 줄 사이 간격만 살짝.
8. 인용 단락 끝에서 Enter → `> ` 없는 일반 단락(테두리 없음).
9. 노트를 저장/재진입(또는 메뉴 → 원본 XML 보기) → `.note` XML 본문에 `[^7]`·`> ` 가 텍스트로 그대로 남아 있고 라운드트립이 깨지지 않음.
10. `/desktop` 의 노트 윈도우에서도 1–9 가 동일하게 동작.

- [ ] **Step 6: 커밋**

```bash
cd /var/home/umayloveme/workspace/tomboy-web
git add app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(editor): 각주 + 인용 확장 등록 · onMissing 토스트 · CSS"
```

---

## 자기 검토 노트 (작성자용)

- **스펙 커버리지:** 각주 마커/역할/렌더/클릭스크롤/onMissing → Task 1·2·5. 인용 마커/렌더/연속/제목·리스트 제외 → Task 3·4·5. 아카이버 무변경 → 어떤 태스크도 `noteContentArchiver.ts` 를 수정하지 않음(파일 구조 표 참조). 에디터 연결·CSS → Task 5.
- **타입 일관성:** `FootnoteMatch { from, to, label, isDefinitionMarker }`, `findFootnoteMatches/findFootnoteAt/findFootnotePartner`, `FootnotePluginOptions.onMissing(label, kind)`, `footnotePluginKey`, `TomboyFootnote` — Task 1·2·5 에서 동일하게 사용. `QuotedParagraph { paraPos, paraNode, textStart }`, `isQuotedParagraphText/findQuotedParagraphs`, `blockquotePluginKey`, `TomboyBlockquote` — Task 3·4·5 에서 동일.
- **플레이스홀더:** 없음 — 모든 코드 블록은 완전한 구현.
