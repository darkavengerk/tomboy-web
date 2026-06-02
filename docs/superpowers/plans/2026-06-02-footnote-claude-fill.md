# 각주 @claude 자동 채우기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 각주 정의 칸에 `@claude ` 트리거를 입력하면 Claude가 본문 참조 마커 위치까지의 맥락 + 지시문을 받아 그 각주 설명을 스트리밍으로 채운다.

**Architecture:** 기존 각주 모듈(`lib/editor/footnote/`)과 기존 Claude 백엔드(`sendClaude` → bridge `/claude/chat` → desktop claude-service)를 잇는다. 새 인프라 없음. ProseMirror 플러그인이 정의 단락에서 `@claude ` 트리거를 감지하고, 순수 오케스트레이터가 컨텍스트를 뽑아 `sendClaude`로 스트리밍하며 정의 단락의 마커 뒤 텍스트만 갈아끼운다. 생각 과정은 정의 단락 옆 일시적 위젯 데코레이션으로 표시. 실패/중단 시 원문 복원.

**Tech Stack:** SvelteKit + TipTap 3 / ProseMirror, Svelte 5 runes, vitest + @testing-library/svelte, TypeScript.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `app/src/lib/editor/footnote/claudeFill.ts` (신규) | 순수 헬퍼(트리거 파싱, 컨텍스트/메시지 빌드, 정의 위치 탐색) + 오케스트레이터 `runFootnoteClaude` |
| `app/src/lib/editor/footnote/claudePlugin.ts` (신규) | ProseMirror 플러그인: 트리거 감지(`view.update`) + 잠금 상태 + 생각 위젯 데코레이션 |
| `app/src/lib/editor/footnote/index.ts` (수정) | 신규 export 재노출 |
| `app/src/lib/editor/TomboyEditor.svelte` (수정) | 플러그인을 `Extension.create`로 편집기에 장착 |
| `app/src/routes/settings/+page.svelte` (수정) | 가이드 카드(editor 탭) |
| `app/tests/unit/editor/footnote/claudeFillHelpers.test.ts` (신규) | Task 1 순수 헬퍼 테스트 |
| `app/tests/unit/editor/footnote/claudeFillDoc.test.ts` (신규) | Task 2 doc 탐색 헬퍼 테스트 |
| `app/tests/unit/editor/footnote/claudePlugin.test.ts` (신규) | Task 3 플러그인 트리거/잠금 테스트 |
| `app/tests/unit/editor/footnote/runFootnoteClaude.test.ts` (신규) | Task 4 오케스트레이터 테스트 |

핵심 타입(전 태스크 공유 — 시그니처 고정):

```ts
// claudeFill.ts
export interface DefLocation {
  /** footnoteMarker 노드의 절대 위치 (atom, nodeSize=1). */
  markerPos: number;
  /** 마커 뒤 텍스트 시작 (markerPos + 1). */
  textFrom: number;
  /** 정의 단락 내용 끝 (= 마커 뒤 텍스트 끝). */
  textTo: number;
  /** 마커 뒤 텍스트(= 단락 textContent, 마커는 atom이라 기여 안 함). */
  text: string;
}
```

---

### Task 1: 순수 헬퍼 — 트리거 파싱 · 시스템 프롬프트 · 메시지 빌드

**Goal:** doc 없이 테스트 가능한 순수 함수(트리거 추출, 복원용 trim, 메시지 조립)와 시스템 프롬프트 상수를 `claudeFill.ts`에 만든다.

**Files:**
- Create: `app/src/lib/editor/footnote/claudeFill.ts`
- Test: `app/tests/unit/editor/footnote/claudeFillHelpers.test.ts`

**Acceptance Criteria:**
- [ ] `extractTrigger('좀 더 설명해줘 @claude ')` → `{ instruction: '좀 더 설명해줘' }`
- [ ] `extractTrigger('@claude ')` → `{ instruction: '' }` (지시문 비어도 트리거 성립)
- [ ] `extractTrigger('설명 @claude')` (뒤 공백 없음) → `null`
- [ ] `extractTrigger('보통 텍스트')` → `null`
- [ ] `extractTrigger('@claude 추가 입력 ')` (트리거가 끝이 아님) → `null`
- [ ] `stripTriggerForRestore('설명해줘 @claude ')` → `'설명해줘 @claude'` (끝 공백만 제거)
- [ ] `buildFootnoteMessages('본문맥락', '설명해줘')` → 단일 user 메시지, content text가 컨텍스트와 지시문을 모두 포함
- [ ] `FOOTNOTE_SYSTEM_PROMPT`가 "각주", "300자", "한국어"를 언급

**Verify:** `cd app && npx vitest run tests/unit/editor/footnote/claudeFillHelpers.test.ts` → 모든 테스트 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/editor/footnote/claudeFillHelpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	extractTrigger,
	stripTriggerForRestore,
	buildFootnoteMessages,
	FOOTNOTE_SYSTEM_PROMPT
} from '$lib/editor/footnote/claudeFill.js';

describe('extractTrigger', () => {
	it('지시문 + @claude + 끝공백 → 지시문 추출', () => {
		expect(extractTrigger('좀 더 설명해줘 @claude ')).toEqual({
			instruction: '좀 더 설명해줘'
		});
	});
	it('지시문 없이 @claude + 공백도 성립', () => {
		expect(extractTrigger('@claude ')).toEqual({ instruction: '' });
	});
	it('뒤 공백 없으면 null', () => {
		expect(extractTrigger('설명 @claude')).toBeNull();
	});
	it('트리거 없는 일반 텍스트 → null', () => {
		expect(extractTrigger('보통 텍스트')).toBeNull();
	});
	it('@claude 뒤에 더 입력되어 끝이 아니면 null', () => {
		expect(extractTrigger('@claude 추가 입력 ')).toBeNull();
	});
	it('탭/개행도 트리거 공백으로 인정', () => {
		expect(extractTrigger('설명 @claude\t')).toEqual({ instruction: '설명' });
	});
});

describe('stripTriggerForRestore', () => {
	it('끝 공백만 제거해 재발화를 막는다', () => {
		expect(stripTriggerForRestore('설명해줘 @claude ')).toBe('설명해줘 @claude');
	});
	it('끝 공백이 없으면 그대로', () => {
		expect(stripTriggerForRestore('설명해줘 @claude')).toBe('설명해줘 @claude');
	});
});

describe('buildFootnoteMessages', () => {
	it('단일 user 메시지에 컨텍스트와 지시문을 담는다', () => {
		const msgs = buildFootnoteMessages('제목\n본문', '설명해줘');
		expect(msgs).toHaveLength(1);
		expect(msgs[0].role).toBe('user');
		expect(msgs[0].content).toHaveLength(1);
		const block = msgs[0].content[0];
		expect(block.type).toBe('text');
		const text = block.type === 'text' ? block.text : '';
		expect(text).toContain('제목\n본문');
		expect(text).toContain('설명해줘');
	});
});

describe('FOOTNOTE_SYSTEM_PROMPT', () => {
	it('각주·글자수·한국어 제약을 명시', () => {
		expect(FOOTNOTE_SYSTEM_PROMPT).toMatch(/각주/);
		expect(FOOTNOTE_SYSTEM_PROMPT).toMatch(/300/);
		expect(FOOTNOTE_SYSTEM_PROMPT).toMatch(/한국어/);
	});
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/footnote/claudeFillHelpers.test.ts`
Expected: FAIL — `claudeFill.js`가 없어 import 에러.

- [ ] **Step 3: 최소 구현**

`app/src/lib/editor/footnote/claudeFill.ts` (이 태스크 범위만):

```ts
import type { AnthropicMessage } from '$lib/chatNote/buildClaudeMessages.js';

/** 각주 설명 작성용 시스템 프롬프트. 글자수는 소프트(프롬프트) 유도. */
export const FOOTNOTE_SYSTEM_PROMPT =
	'너는 각주(footnote)를 작성하는 도우미다. 주어진 본문 맥락과 요청을 바탕으로, ' +
	'머리말이나 맺음말 없이 설명 본문만 출력한다. 반드시 한국어로, 300자 이내로 ' +
	'간결하게 작성한다. 마크다운 제목이나 목록 없이 자연스러운 문장으로 쓴다.';

/** 정의 칸 텍스트 끝의 `@claude <공백>` 트리거를 인식하고 지시문을 추출. */
export function extractTrigger(text: string): { instruction: string } | null {
	const m = /^([\s\S]*?)\s*@claude\s$/.exec(text);
	if (!m) return null;
	return { instruction: m[1].trim() };
}

/** 실패/중단 복원 시 끝 공백을 제거해 자동 재발화(@claude\s$ 재매치)를 막는다. */
export function stripTriggerForRestore(text: string): string {
	return text.replace(/\s+$/, '');
}

/** 컨텍스트 + 지시문을 단일 user 메시지로 조립. */
export function buildFootnoteMessages(
	context: string,
	instruction: string
): AnthropicMessage[] {
	const ask = instruction
		? `${context}\n\n[각주 요청] ${instruction}`
		: `${context}\n\n[각주 요청] 위 맥락에 맞는 각주 설명을 작성해줘.`;
	return [{ role: 'user', content: [{ type: 'text', text: ask }] }];
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/footnote/claudeFillHelpers.test.ts`
Expected: PASS (모든 it 통과).

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/footnote/claudeFill.ts app/tests/unit/editor/footnote/claudeFillHelpers.test.ts
git commit -m "feat(footnote): @claude 트리거 파싱 + 메시지 빌드 헬퍼"
```

---

### Task 2: doc 탐색 헬퍼 — 정의 위치 · 컨텍스트 · 트리거 스캔

**Goal:** ProseMirror doc에서 라벨로 정의 단락을 찾고(`locateDefinition`), 짝 참조 마커까지의 평문 컨텍스트를 뽑고(`buildFootnoteContext`), 트리거가 걸린 정의들을 스캔하는(`definitionsMatchingTrigger`) 순수 함수를 추가한다.

**Files:**
- Modify: `app/src/lib/editor/footnote/claudeFill.ts` (헬퍼 추가)
- Test: `app/tests/unit/editor/footnote/claudeFillDoc.test.ts`

**Acceptance Criteria:**
- [ ] `locateDefinition(doc, '1')`가 정의 마커의 `markerPos`/`textFrom`/`textTo`와 마커 뒤 `text`를 반환
- [ ] 라벨이 정의로 존재하지 않으면 `locateDefinition` → `null`
- [ ] `buildFootnoteContext(doc, '1')`가 제목부터 본문 `[^1]` 참조 마커 직전까지 평문을 반환하고, 마커 이후 본문/각주 정의는 제외
- [ ] 짝 참조 마커가 없으면 첫 정의 마커 직전까지로 폴백
- [ ] `definitionsMatchingTrigger(doc)`가 `@claude ` 끝나는 정의 단락만 `Map<label, instruction>`로 반환(본문 참조 마커·일반 단락 제외)

**Verify:** `cd app && npx vitest run tests/unit/editor/footnote/claudeFillDoc.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/editor/footnote/claudeFillDoc.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';
import {
	locateDefinition,
	buildFootnoteContext,
	definitionsMatchingTrigger
} from '$lib/editor/footnote/claudeFill.js';

let editor: Editor | null = null;
afterEach(() => {
	editor?.destroy();
	editor = null;
});

function makeEditor(content: unknown): Editor {
	const e = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem,
			...TomboyFootnote
		],
		content: content as never
	});
	editor = e;
	return e;
}

// 제목 / 본문(ref [^1]) / 정의([^1] 설명...)
function docWithFootnote(defText: string) {
	return {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
			{
				type: 'paragraph',
				content: [
					{ type: 'text', text: '앞 문장 ' },
					{ type: 'footnoteMarker', attrs: { label: '1' } },
					{ type: 'text', text: ' 뒤 문장' }
				]
			},
			{
				type: 'paragraph',
				content: [
					{ type: 'footnoteMarker', attrs: { label: '1' } },
					{ type: 'text', text: defText }
				]
			}
		]
	};
}

describe('locateDefinition', () => {
	it('라벨로 정의 단락의 마커 뒤 텍스트 위치를 찾는다', () => {
		const e = makeEditor(docWithFootnote('설명해줘 @claude '));
		const loc = locateDefinition(e.state.doc, '1');
		expect(loc).not.toBeNull();
		expect(loc!.text).toBe('설명해줘 @claude ');
		expect(loc!.textFrom).toBe(loc!.markerPos + 1);
		expect(loc!.textTo).toBeGreaterThan(loc!.textFrom);
	});
	it('정의가 없는 라벨 → null', () => {
		const e = makeEditor(docWithFootnote('설명'));
		expect(locateDefinition(e.state.doc, '없음')).toBeNull();
	});
});

describe('buildFootnoteContext', () => {
	it('제목~참조 마커 직전까지, 마커 이후·정의는 제외', () => {
		const e = makeEditor(docWithFootnote('설명해줘 @claude '));
		const ctx = buildFootnoteContext(e.state.doc, '1');
		expect(ctx).toContain('제목');
		expect(ctx).toContain('앞 문장');
		expect(ctx).not.toContain('뒤 문장'); // ref 마커 이후 제외
		expect(ctx).not.toContain('설명해줘'); // 정의 텍스트 제외
	});
	it('짝 참조 마커가 없으면 첫 정의 직전까지 폴백', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: '본문만 있음' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: '설명해줘 @claude ' }
					]
				}
			]
		});
		const ctx = buildFootnoteContext(e.state.doc, '1');
		expect(ctx).toContain('본문만 있음');
		expect(ctx).not.toContain('설명해줘');
	});
});

describe('definitionsMatchingTrigger', () => {
	it('정의 칸 @claude 끝만 잡고 instruction을 추출', () => {
		const e = makeEditor(docWithFootnote('설명해줘 @claude '));
		const map = definitionsMatchingTrigger(e.state.doc);
		expect(map.get('1')).toBe('설명해줘');
	});
	it('본문 ref 마커 옆 @claude 는 무시', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: '본문 @claude ' } // ref 마커 단락(정의 아님)
					]
				}
			]
		});
		// 위 단락은 top idx 1, 첫 inline이 마커 → 정의로 잡힌다. ref가 아니므로
		// 정의로 인정되는 것이 맞다. 진짜 ref(중간 삽입)는 정의가 아님을 확인:
		const e2 = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '본문 ' },
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' @claude ' }
					]
				}
			]
		});
		expect(definitionsMatchingTrigger(e2.state.doc).has('1')).toBe(false);
		e.destroy();
	});
	it('트리거 없는 정의는 제외', () => {
		const e = makeEditor(docWithFootnote('이미 채워진 설명'));
		expect(definitionsMatchingTrigger(e.state.doc).size).toBe(0);
	});
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/footnote/claudeFillDoc.test.ts`
Expected: FAIL — `locateDefinition` 등 미정의.

- [ ] **Step 3: 최소 구현 — `claudeFill.ts`에 추가**

```ts
import type { Node as PMNode } from '@tiptap/pm/model';
import {
	findFootnoteMatches,
	findFootnotePartner,
	type FootnoteMatch
} from './footnotes.js';

/** 라벨에 해당하는 정의 마커 + 마커 뒤 텍스트 범위. 없으면 null. */
export function locateDefinition(doc: PMNode, label: string): DefLocation | null {
	const matches = findFootnoteMatches(doc);
	const def = matches.find((m) => m.isDefinitionMarker && m.label === label);
	if (!def) return null;
	const $after = doc.resolve(def.from + 1);
	const textTo = $after.end();
	return {
		markerPos: def.from,
		textFrom: def.from + 1,
		textTo,
		text: doc.textBetween(def.from + 1, textTo, '\n')
	};
}

/** 제목~짝 참조 마커 직전까지의 평문. 짝이 없으면 첫 정의 마커 직전까지 폴백. */
export function buildFootnoteContext(doc: PMNode, label: string): string {
	const matches = findFootnoteMatches(doc);
	const def = matches.find((m) => m.isDefinitionMarker && m.label === label);
	let cut: number;
	const partner = def ? findFootnotePartner(matches, def) : null;
	if (partner) {
		cut = partner.from;
	} else {
		const firstDef = matches.find((m) => m.isDefinitionMarker);
		cut = firstDef ? firstDef.from : doc.content.size;
	}
	return doc.textBetween(0, cut, '\n').trim();
}

/** `@claude <공백>` 로 끝나는 정의 단락만 label→instruction 맵으로 반환. */
export function definitionsMatchingTrigger(doc: PMNode): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of findFootnoteMatches(doc)) {
		if (!m.isDefinitionMarker) continue;
		const $after = doc.resolve(m.from + 1);
		const text = doc.textBetween(m.from + 1, $after.end(), '\n');
		const trig = extractTrigger(text);
		if (trig) out.set(m.label, trig.instruction);
	}
	return out;
}
```

> `DefLocation` 인터페이스는 파일 상단(File Structure의 타입 블록)에 정의돼 있어야 한다. 없으면 Step 3에서 함께 추가한다. `FootnoteMatch` import는 사용하지 않으면 제거.

- [ ] **Step 4: 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/footnote/claudeFillDoc.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/footnote/claudeFill.ts app/tests/unit/editor/footnote/claudeFillDoc.test.ts
git commit -m "feat(footnote): 정의 위치 탐색 + 컨텍스트/트리거 스캔 헬퍼"
```

---

### Task 3: 트리거 플러그인 — 감지 · 잠금 · 생각 위젯

**Goal:** 정의 단락에 `@claude ` 가 새로 입력되면(이전 상태에는 없던 트리거) 1회만 `fill` 콜백을 호출하고, 진행 중 라벨을 잠그며, 활성 정의 옆에 생각 위젯 데코레이션을 그리는 플러그인을 만든다.

**Files:**
- Create: `app/src/lib/editor/footnote/claudePlugin.ts`
- Test: `app/tests/unit/editor/footnote/claudePlugin.test.ts`

**Acceptance Criteria:**
- [ ] 정의 칸에 `@claude ` 입력 트랜잭션 후 `fill(view, '1', '설명해줘')`가 정확히 1회 호출
- [ ] 같은 정의가 이미 active(잠금) 상태면 재호출 안 함
- [ ] 복원 텍스트(`...@claude`, 끝 공백 없음)는 트리거로 인식 안 함(재발화 없음)
- [ ] `markActive`/`markIdle` 메타로 active 집합이 갱신되고, `setFootnoteStep`이 step/stepLabel을 갱신
- [ ] step + stepLabel 설정 시 해당 정의 단락 위치에 `.thinking-display` 위젯 데코레이션 1개 생성

**Verify:** `cd app && npx vitest run tests/unit/editor/footnote/claudePlugin.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/editor/footnote/claudePlugin.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';
import {
	createFootnoteClaudePlugin,
	footnoteClaudeKey,
	markActive,
	markIdle,
	setFootnoteStep
} from '$lib/editor/footnote/claudePlugin.js';

let editor: Editor | null = null;
afterEach(() => {
	editor?.destroy();
	editor = null;
});

function makeEditor(content: unknown, fill: (...a: unknown[]) => void): Editor {
	const e = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem,
			...TomboyFootnote,
			Extension.create({
				name: 'tomboyFootnoteClaudeTest',
				addProseMirrorPlugins() {
					return [createFootnoteClaudePlugin({ fill: fill as never })];
				}
			})
		],
		content: content as never
	});
	editor = e;
	return e;
}

// 정의 단락: [^1] + "설명해줘 @claude" (끝 공백 아직 없음 → 트리거 직전 상태)
function docPreTrigger() {
	return {
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
					{ type: 'text', text: '설명해줘 @claude' }
				]
			}
		]
	};
}

/** 정의 단락 끝(마커 뒤 텍스트 끝)에 공백을 삽입해 트리거를 완성한다. */
function typeSpaceAtDefEnd(e: Editor) {
	const doc = e.state.doc;
	let insertAt = -1;
	doc.descendants((node, pos) => {
		if (node.type.name === 'footnoteMarker') {
			const $a = doc.resolve(pos + 1);
			// 정의(둘째 마커, top idx 2)만 대상
			if ($a.index(0) === 2) insertAt = $a.end();
		}
		return true;
	});
	e.view.dispatch(e.state.tr.insertText(' ', insertAt));
}

describe('createFootnoteClaudePlugin — 트리거', () => {
	it('@claude 끝공백 입력 시 fill 1회 호출', () => {
		const fill = vi.fn();
		const e = makeEditor(docPreTrigger(), fill);
		typeSpaceAtDefEnd(e);
		expect(fill).toHaveBeenCalledTimes(1);
		expect(fill.mock.calls[0][1]).toBe('1'); // label
		expect(fill.mock.calls[0][2]).toBe('설명해줘'); // instruction
	});

	it('이미 active면 재호출 안 함', () => {
		const fill = vi.fn();
		const e = makeEditor(docPreTrigger(), fill);
		markActive(e.view, '1');
		typeSpaceAtDefEnd(e);
		expect(fill).not.toHaveBeenCalled();
	});

	it('복원 텍스트(@claude, 끝공백 없음)는 트리거 아님', () => {
		const fill = vi.fn();
		// 이미 "@claude" 로 끝나는 상태에서 다른 곳을 편집해도 발화 안 함
		const e = makeEditor(docPreTrigger(), fill);
		// 제목에 한 글자 추가(정의 단락은 그대로 @claude 끝 공백 없음)
		e.view.dispatch(e.state.tr.insertText('x', 1));
		expect(fill).not.toHaveBeenCalled();
	});
});

describe('잠금/스텝 메타', () => {
	it('markActive/markIdle 로 active 집합 갱신', () => {
		const e = makeEditor(docPreTrigger(), vi.fn());
		markActive(e.view, '1');
		expect(footnoteClaudeKey.getState(e.state)!.active).toContain('1');
		markIdle(e.view, '1');
		expect(footnoteClaudeKey.getState(e.state)!.active).not.toContain('1');
	});

	it('setFootnoteStep 가 step/stepLabel 갱신 + 위젯 데코 생성', () => {
		const e = makeEditor(docPreTrigger(), vi.fn());
		setFootnoteStep(e.view, '1', {
			kind: 'thinking',
			label: '생각 중',
			body: ''
		});
		const st = footnoteClaudeKey.getState(e.state)!;
		expect(st.stepLabel).toBe('1');
		expect(st.step?.label).toBe('생각 중');
		// 위젯 DOM이 렌더됐는지
		expect(e.view.dom.querySelector('.thinking-display')).not.toBeNull();
	});
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/footnote/claudePlugin.test.ts`
Expected: FAIL — `claudePlugin.js` 미존재.

- [ ] **Step 3: 최소 구현**

`app/src/lib/editor/footnote/claudePlugin.ts`:

```ts
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { ThinkingStep } from '$lib/chatNote/backends/claude.js';

import { definitionsMatchingTrigger, locateDefinition } from './claudeFill.js';
import { runFootnoteClaude } from './claudeFill.js';

export interface FootnoteClaudeState {
	active: string[];
	step: ThinkingStep | null;
	stepLabel: string | null;
}

export interface FootnoteClaudeOptions {
	/** 트리거 감지 시 호출. 기본값은 실제 오케스트레이터. */
	fill: (view: EditorView, label: string, instruction: string) => void;
}

export const footnoteClaudeKey = new PluginKey<FootnoteClaudeState>('footnoteClaude');

type Meta =
	| { type: 'active'; label: string }
	| { type: 'idle'; label: string }
	| { type: 'step'; label: string; step: ThinkingStep | null };

export function markActive(view: EditorView, label: string): void {
	view.dispatch(view.state.tr.setMeta(footnoteClaudeKey, { type: 'active', label }));
}
export function markIdle(view: EditorView, label: string): void {
	view.dispatch(view.state.tr.setMeta(footnoteClaudeKey, { type: 'idle', label }));
}
export function setFootnoteStep(
	view: EditorView,
	label: string,
	step: ThinkingStep | null
): void {
	view.dispatch(view.state.tr.setMeta(footnoteClaudeKey, { type: 'step', label, step }));
}

function buildWidgetDom(step: ThinkingStep): HTMLElement {
	const aside = document.createElement('aside');
	aside.className = 'thinking-display';
	aside.setAttribute('data-kind', step.kind);
	const header = document.createElement('header');
	header.className = 'thinking-display-label';
	header.textContent = step.label;
	aside.appendChild(header);
	if (step.body) {
		const bq = document.createElement('blockquote');
		bq.className = 'thinking-display-body';
		bq.textContent = step.body;
		aside.appendChild(bq);
	}
	return aside;
}

function reduce(state: FootnoteClaudeState, meta: Meta): FootnoteClaudeState {
	switch (meta.type) {
		case 'active':
			return state.active.includes(meta.label)
				? state
				: { ...state, active: [...state.active, meta.label] };
		case 'idle': {
			const clearStep = state.stepLabel === meta.label;
			return {
				active: state.active.filter((l) => l !== meta.label),
				step: clearStep ? null : state.step,
				stepLabel: clearStep ? null : state.stepLabel
			};
		}
		case 'step':
			return { ...state, step: meta.step, stepLabel: meta.step ? meta.label : null };
	}
}

export function createFootnoteClaudePlugin(
	opts?: Partial<FootnoteClaudeOptions>
): Plugin<FootnoteClaudeState> {
	const fill = opts?.fill ?? runFootnoteClaude;
	return new Plugin<FootnoteClaudeState>({
		key: footnoteClaudeKey,
		state: {
			init(): FootnoteClaudeState {
				return { active: [], step: null, stepLabel: null };
			},
			apply(tr, value): FootnoteClaudeState {
				const meta = tr.getMeta(footnoteClaudeKey) as Meta | undefined;
				return meta ? reduce(value, meta) : value;
			}
		},
		view() {
			return {
				update(view: EditorView, prev: EditorState) {
					const cur = view.state;
					if (cur.doc.eq(prev.doc)) return;
					const before = definitionsMatchingTrigger(prev.doc);
					const after = definitionsMatchingTrigger(cur.doc);
					const active = footnoteClaudeKey.getState(cur)?.active ?? [];
					for (const [label, instruction] of after) {
						if (before.has(label)) continue; // 이전에도 트리거였음 → 새 발화 아님
						if (active.includes(label)) continue; // 잠금 중
						fill(view, label, instruction);
					}
				}
			};
		},
		props: {
			decorations(state): DecorationSet {
				const st = footnoteClaudeKey.getState(state);
				if (!st?.step || !st.stepLabel) return DecorationSet.empty;
				const loc = locateDefinition(state.doc, st.stepLabel);
				if (!loc) return DecorationSet.empty;
				const widget = Decoration.widget(loc.textTo, () => buildWidgetDom(st.step!), {
					side: 1,
					ignoreSelection: true
				});
				return DecorationSet.create(state.doc, [widget]);
			}
		}
	});
}
```

> `runFootnoteClaude`는 Task 4에서 구현된다. Task 3을 먼저 구현하면 import가 깨지므로, **이 태스크에서는 `claudeFill.ts`에 임시 스텁** `export function runFootnoteClaude() {}` 을 추가해 컴파일을 통과시키고 Task 4에서 본 구현으로 교체한다. (스텁은 테스트에서 `fill` 주입으로 우회되므로 영향 없음.)

- [ ] **Step 4: 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/footnote/claudePlugin.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/footnote/claudePlugin.ts app/src/lib/editor/footnote/claudeFill.ts app/tests/unit/editor/footnote/claudePlugin.test.ts
git commit -m "feat(footnote): @claude 트리거 감지 플러그인 + 생각 위젯"
```

---

### Task 4: 오케스트레이터 `runFootnoteClaude` — 스트리밍 · mutate · 복원

**Goal:** 트리거 발화 시 라벨 잠금 → 정의 칸 비우기 → bridge 설정 로드 → `sendClaude` 스트리밍으로 답변 델타를 정의 칸에 누적 → 완료 시 trim → 실패/중단 시 원문 복원 + 토스트, 의 전체 흐름을 구현한다.

**Files:**
- Modify: `app/src/lib/editor/footnote/claudeFill.ts` (스텁 → 본 구현)
- Test: `app/tests/unit/editor/footnote/runFootnoteClaude.test.ts`

**Acceptance Criteria:**
- [ ] 시작 시 라벨이 active 로 잠기고 정의 칸의 마커 뒤 텍스트가 비워짐
- [ ] `onToken` 델타가 정의 칸에 순서대로 누적되어 최종 텍스트 = 답변
- [ ] `done` 후 라벨 잠금 해제(active 제거)
- [ ] `sendClaude`가 throw하면 정의 칸이 `stripTriggerForRestore(원문)`으로 복원되고 에러 토스트 1회, 잠금 해제
- [ ] bridge URL/토큰이 비면 `sendClaude` 호출 없이 즉시 복원 + 토스트
- [ ] `sendClaude`에 넘긴 body가 `FOOTNOTE_SYSTEM_PROMPT` system, 빌드된 messages, 기본 model/effort 포함

**Verify:** `cd app && npx vitest run tests/unit/editor/footnote/runFootnoteClaude.test.ts` → PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/editor/footnote/runFootnoteClaude.test.ts`:

```ts
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';
import {
	createFootnoteClaudePlugin,
	footnoteClaudeKey
} from '$lib/editor/footnote/claudePlugin.js';

// --- 모듈 모킹 ---
const sendClaudeMock = vi.fn();
vi.mock('$lib/chatNote/backends/claude.js', async (orig) => {
	const actual = await orig<typeof import('$lib/chatNote/backends/claude.js')>();
	return { ...actual, sendClaude: (...a: unknown[]) => sendClaudeMock(...a) };
});
vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
	getDefaultTerminalBridge: vi.fn(async () => 'https://bridge.example'),
	getTerminalBridgeToken: vi.fn(async () => 'tok')
}));
vi.mock('$lib/storage/appSettings.js', async (orig) => {
	const actual = await orig<typeof import('$lib/storage/appSettings.js')>();
	return {
		...actual,
		getClaudeDefaultModel: vi.fn(async () => 'claude-x'),
		getClaudeDefaultEffort: vi.fn(async () => 'high')
	};
});
const toastMock = vi.fn();
vi.mock('$lib/stores/toast.js', async (orig) => {
	const actual = await orig<typeof import('$lib/stores/toast.js')>();
	return { ...actual, pushToast: (...a: unknown[]) => toastMock(...a) };
});

import { runFootnoteClaude } from '$lib/editor/footnote/claudeFill.js';

let editor: Editor | null = null;
afterEach(() => {
	editor?.destroy();
	editor = null;
});
beforeEach(() => {
	sendClaudeMock.mockReset();
	toastMock.mockReset();
});

function makeEditor(): Editor {
	const e = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem,
			...TomboyFootnote,
			Extension.create({
				name: 'tomboyFootnoteClaudeTest',
				addProseMirrorPlugins() {
					// fill 미주입 → 기본 runFootnoteClaude 사용
					return [createFootnoteClaudePlugin()];
				}
			})
		],
		content: {
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
						{ type: 'text', text: '설명해줘 @claude ' }
					]
				}
			]
		} as never
	});
	editor = e;
	return e;
}

function defText(e: Editor): string {
	let out = '';
	const doc = e.state.doc;
	doc.descendants((node, pos) => {
		if (node.type.name === 'footnoteMarker') {
			const $a = doc.resolve(pos + 1);
			if ($a.index(0) === 2) out = doc.textBetween(pos + 1, $a.end(), '\n');
		}
		return true;
	});
	return out;
}

describe('runFootnoteClaude', () => {
	it('성공: 정의 칸을 답변으로 채우고 잠금 해제', async () => {
		sendClaudeMock.mockImplementation(async (opts: never) => {
			const o = opts as { onToken: (d: string) => void };
			o.onToken('답변');
			o.onToken(' 본문');
			return { reason: 'done' };
		});
		const e = makeEditor();
		await runFootnoteClaude(e.view, '1', '설명해줘');
		expect(defText(e)).toBe('답변 본문');
		expect(footnoteClaudeKey.getState(e.state)!.active).not.toContain('1');
		// body 검증
		const body = (sendClaudeMock.mock.calls[0][0] as { body: never }).body as {
			system: string;
			model: string;
			effort: string;
			messages: unknown[];
		};
		expect(body.system).toMatch(/각주/);
		expect(body.model).toBe('claude-x');
		expect(body.effort).toBe('high');
		expect(body.messages).toHaveLength(1);
	});

	it('실패: 원문 복원(@claude, 끝공백 없음) + 토스트', async () => {
		sendClaudeMock.mockRejectedValue(new Error('boom'));
		const e = makeEditor();
		await runFootnoteClaude(e.view, '1', '설명해줘');
		expect(defText(e)).toBe('설명해줘 @claude'); // 끝 공백 제거 = 재발화 방지
		expect(toastMock).toHaveBeenCalledTimes(1);
		expect(footnoteClaudeKey.getState(e.state)!.active).not.toContain('1');
	});

	it('bridge 미설정: sendClaude 미호출, 복원 + 토스트', async () => {
		const mod = await import('$lib/editor/terminal/bridgeSettings.js');
		(mod.getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');
		const e = makeEditor();
		await runFootnoteClaude(e.view, '1', '설명해줘');
		expect(sendClaudeMock).not.toHaveBeenCalled();
		expect(toastMock).toHaveBeenCalledTimes(1);
		expect(defText(e)).toBe('설명해줘 @claude');
	});
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd app && npx vitest run tests/unit/editor/footnote/runFootnoteClaude.test.ts`
Expected: FAIL — `runFootnoteClaude`가 스텁(no-op)이라 정의 칸이 안 바뀜.

- [ ] **Step 3: 본 구현 — `claudeFill.ts`의 스텁 교체**

기존 `export function runFootnoteClaude() {}` 스텁을 삭제하고 아래로 교체. 상단 import 추가:

```ts
import type { EditorView } from '@tiptap/pm/view';
import { sendClaude, ClaudeChatError } from '$lib/chatNote/backends/claude.js';
import {
	getDefaultTerminalBridge,
	getTerminalBridgeToken
} from '$lib/editor/terminal/bridgeSettings.js';
import {
	getClaudeDefaultModel,
	getClaudeDefaultEffort
} from '$lib/storage/appSettings.js';
import { pushToast } from '$lib/stores/toast.js';
import {
	footnoteClaudeKey,
	markActive,
	markIdle,
	setFootnoteStep
} from './claudePlugin.js';
```

```ts
/** 정의 칸 마커 뒤 텍스트를 새 텍스트로 교체(라벨로 재탐색해 위치 드리프트 무시). */
function replaceDefinitionText(view: EditorView, label: string, text: string): void {
	const loc = locateDefinition(view.state.doc, label);
	if (!loc) return;
	const tr = view.state.tr;
	if (loc.textTo > loc.textFrom) tr.delete(loc.textFrom, loc.textTo);
	if (text) tr.insertText(text, loc.textFrom);
	view.dispatch(tr);
}

/** 정의 칸 끝에 델타를 덧붙임(매 호출 재탐색). */
function appendDefinitionText(view: EditorView, label: string, delta: string): void {
	const loc = locateDefinition(view.state.doc, label);
	if (!loc) return;
	view.dispatch(view.state.tr.insertText(delta, loc.textTo));
}

/**
 * 각주 @claude 채우기 오케스트레이터.
 * 시작 → 잠금 + 원문 스냅샷 + 정의 비우기 → bridge 설정 →
 * sendClaude 스트리밍 → 완료 trim / 실패·중단 복원.
 */
export async function runFootnoteClaude(
	view: EditorView,
	label: string,
	instruction: string
): Promise<void> {
	const startLoc = locateDefinition(view.state.doc, label);
	if (!startLoc) return;
	const snapshot = startLoc.text;
	const context = buildFootnoteContext(view.state.doc, label);

	markActive(view, label);
	replaceDefinitionText(view, label, ''); // 정의 비우기
	setFootnoteStep(view, label, { kind: 'thinking', label: '생각 중…', body: '' });

	const restore = () => {
		replaceDefinitionText(view, label, stripTriggerForRestore(snapshot));
	};
	const finish = () => {
		setFootnoteStep(view, label, null);
		markIdle(view, label);
	};

	try {
		const [bridge, token] = await Promise.all([
			getDefaultTerminalBridge(),
			getTerminalBridgeToken()
		]);
		if (!bridge || !token) {
			restore();
			pushToast('Claude 서비스에 연결할 수 없습니다 (브릿지 미설정)', {
				kind: 'error'
			});
			return;
		}
		const [model, effort] = await Promise.all([
			getClaudeDefaultModel(),
			getClaudeDefaultEffort()
		]);
		const r = await sendClaude({
			url: `${bridge}/claude/chat`,
			token,
			body: {
				messages: buildFootnoteMessages(context, instruction),
				system: FOOTNOTE_SYSTEM_PROMPT,
				model: model || undefined,
				effort
			},
			onToken: (delta) => appendDefinitionText(view, label, delta),
			onStep: (step) => setFootnoteStep(view, label, step)
		});
		if (r.reason === 'abort') {
			restore();
		} else {
			// 완료: trim 정리. 빈 응답이면 원문 복원.
			const loc = locateDefinition(view.state.doc, label);
			const trimmed = (loc?.text ?? '').trim();
			if (trimmed) replaceDefinitionText(view, label, trimmed);
			else {
				restore();
				pushToast('Claude가 빈 응답을 보냈습니다', { kind: 'error' });
			}
		}
	} catch (err) {
		restore();
		const msg =
			err instanceof ClaudeChatError
				? `Claude 오류: ${err.kind}`
				: 'Claude 연결 실패';
		pushToast(msg, { kind: 'error' });
	} finally {
		finish();
	}
}
```

> ⚠️ `claudeFill.ts` ↔ `claudePlugin.ts` 는 서로 import 한다(ES 모듈 순환). 둘 다 **호출 시점**에만 상대 심볼을 쓰므로(모듈 평가 시점 아님) 안전하다 — `tomboy-backlinkindex` 스킬의 순환 import 패턴과 동일. 평가 시점에 상대 함수를 호출하지 말 것.

- [ ] **Step 4: 통과 확인**

Run: `cd app && npx vitest run tests/unit/editor/footnote/runFootnoteClaude.test.ts`
Expected: PASS.

이전 태스크 회귀 확인:
Run: `cd app && npx vitest run tests/unit/editor/footnote/`
Expected: 전체 PASS.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/footnote/claudeFill.ts app/tests/unit/editor/footnote/runFootnoteClaude.test.ts
git commit -m "feat(footnote): runFootnoteClaude 오케스트레이터(스트리밍/복원)"
```

---

### Task 5: 편집기 장착 + export 재노출

**Goal:** 플러그인을 `TomboyEditor.svelte`에 `Extension.create`로 장착하고, `index.ts`에서 공개 심볼을 재노출한다.

**Files:**
- Modify: `app/src/lib/editor/footnote/index.ts`
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (기존 `tomboyThinkingDisplay` Extension 근처)

**Acceptance Criteria:**
- [ ] `index.ts`가 `createFootnoteClaudePlugin`, `footnoteClaudeKey`, `runFootnoteClaude`를 re-export
- [ ] `TomboyEditor.svelte`에 `tomboyFootnoteClaude` Extension이 추가되어 플러그인 장착
- [ ] `npm run check`(svelte-check) 타입 통과
- [ ] `npm run dev` + 데스크탑 claude-service 가동 상태에서 각주 정의 칸 `@claude ` 입력 시 스트리밍으로 채워짐(수동)

**Verify:** `cd app && npm run check` → 0 errors. 수동: `npm run dev`로 각주 채우기 동작 확인.

**Steps:**

- [ ] **Step 1: `index.ts` 재노출 추가**

`app/src/lib/editor/footnote/index.ts`의 기존 export 블록에 추가:

```ts
export {
	createFootnoteClaudePlugin,
	footnoteClaudeKey,
	setFootnoteStep,
	markActive,
	markIdle
} from './claudePlugin.js';
export type { FootnoteClaudeState, FootnoteClaudeOptions } from './claudePlugin.js';
export { runFootnoteClaude } from './claudeFill.js';
```

- [ ] **Step 2: `TomboyEditor.svelte` import 추가**

`105`행 부근의 footnote import 옆에 추가:

```ts
import { createFootnoteClaudePlugin } from "./footnote/claudePlugin.js";
```

- [ ] **Step 3: Extension 장착**

`TomboyEditor.svelte`에서 `tomboyThinkingDisplay` Extension.create 블록(약 494–499행) 바로 뒤에 추가:

```ts
				Extension.create({
					name: "tomboyFootnoteClaude",
					addProseMirrorPlugins() {
						return [createFootnoteClaudePlugin()];
					},
				}),
```

- [ ] **Step 4: 타입 체크**

Run: `cd app && npm run check`
Expected: 0 errors, 0 warnings (footnote 관련).

- [ ] **Step 5: 수동 검증**

데스크탑 claude-service 가동 후 `cd app && npm run dev`. 노트에서 각주 삽입 → 정의 칸에 `설명해줘 @claude ` 입력 → 생각 위젯 표시 + 스트리밍 → 답변만 남는지 확인. 브릿지 끊고 재시도 → 원문 복원 + 토스트 확인.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/footnote/index.ts app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(footnote): @claude 채우기 플러그인 편집기 장착"
```

---

### Task 6: 가이드 카드 (설정 → 가이드 → 편집기)

**Goal:** CLAUDE.md 규약대로 사용자 발견 surface에 기능을 문서화한다.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte` (`guideSubTab === 'editor'` 영역)

**Acceptance Criteria:**
- [ ] editor 가이드 탭에 "각주를 Claude로 채우기" `<details class="guide-card">` 추가
- [ ] summary / `<p class="info-text">` 소개 / `<pre class="snippet">` 예시 / `<ul class="guide-list">` 제약 포함
- [ ] guide-list가 명시: 컨텍스트=참조 마커까지, ~300자, 데스크탑 claude-service 필요, 실패 시 원문 복원
- [ ] `npm run check` 통과

**Verify:** `cd app && npm run check` → 0 errors. `npm run dev` → 설정 → 가이드 → 편집기 탭에 카드 노출.

**Steps:**

- [ ] **Step 1: 기존 editor 카드 패턴 확인**

Run: `cd app && grep -n "guideSubTab === 'editor'\|guide-card" src/routes/settings/+page.svelte | head`
기존 카드 하나의 마크업을 패턴으로 삼는다.

- [ ] **Step 2: 카드 추가**

editor 탭 카드 묶음 안에 추가:

```svelte
<details class="guide-card">
	<summary>각주를 Claude로 채우기</summary>
	<p class="info-text">
		각주 설명 칸에 요청을 적고 <code>@claude</code> 뒤에 공백을 입력하면,
		Claude가 본문 맥락을 읽어 그 각주 설명을 자동으로 채웁니다.
	</p>
	<pre class="snippet">좀 더 자세한 설명을 해줘 @claude </pre>
	<ul class="guide-list">
		<li>맥락은 <strong>본문 속 각주 참조 마커 위치까지</strong>만 전달됩니다(그 이후 본문·다른 각주는 제외).</li>
		<li>각주답게 <strong>300자 이내</strong>로 간결하게 작성하도록 유도합니다.</li>
		<li>데스크탑 <strong>claude-service</strong>가 켜져 있어야 합니다(채팅 노트와 동일 경로).</li>
		<li>생성 중 생각 과정이 각주 옆에 잠깐 표시되고, 완료되면 답변만 남습니다.</li>
		<li>실패하거나 중단하면 원래 요청 문구가 복원됩니다 — 끝 공백을 다시 입력해 재시도하세요.</li>
	</ul>
</details>
```

- [ ] **Step 3: 타입 체크**

Run: `cd app && npm run check`
Expected: 0 errors.

- [ ] **Step 4: 커밋**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(footnote): @claude 각주 채우기 가이드 카드"
```

---

## Self-Review

**Spec coverage:**
- 트리거 `@claude ` 끝공백 자동 감지 → Task 1(extractTrigger) + Task 3(view.update).
- 컨텍스트=참조 마커 위치까지 → Task 2(buildFootnoteContext).
- 응답 100% 대체 + 질문/@claude 제거 → Task 4(replaceDefinitionText, 시작 시 비우기, 완료 trim).
- 생각 과정 일시 표시(안 A) → Task 3(decorations) + Task 4(setFootnoteStep).
- 실패/중단 원문 복원 → Task 4(restore, stripTriggerForRestore).
- 300자 소프트 → Task 1(FOOTNOTE_SYSTEM_PROMPT).
- bridge/claude-service 재사용 → Task 4(getDefaultTerminalBridge/Token, sendClaude).
- 가이드 카드 → Task 6.
- 모든 spec 항목에 대응 태스크 존재. 갭 없음.

**Placeholder scan:** "TBD"/"적절히"/"등등" 없음. 코드 스텝은 실제 코드 포함. Task 3→4 순환 의존은 임시 스텁 명시로 해소.

**Type consistency:** `DefLocation`(markerPos/textFrom/textTo/text), `FootnoteClaudeState`(active/step/stepLabel), `runFootnoteClaude(view,label,instruction)`, `setFootnoteStep(view,label,step)`, `markActive/markIdle(view,label)` — 전 태스크 시그니처 일치. `sendClaude` body는 `{messages,system,model,effort}`(claude.ts `ClaudeChatBody`)와 일치.
