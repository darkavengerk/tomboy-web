# LLM 노트 빠른 도우미 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `llm://<ollama-model-ref>` 시그니처 노트를 채팅 누적 노트로 인식하고, 우하단 [보내기] / Ctrl+Enter 로 메인 PC 의 Ollama 에 호출 → NDJSON 스트림 응답을 노트 본문 끝에 토큰 단위로 흘려 넣는다. 기존 `bridge/` 컨테이너에 `/llm/chat` endpoint 1개 추가.

**Architecture:** 클라이언트 측 pure modules (parser, builder, sendChat) + ProseMirror plugin (자동 헤더 보완) + Svelte UI (LlmSendBar) + Node bridge endpoint (Ollama 패스스루). 노트 IDB 저장 / sync / 백링크 / 그래프 등 기존 인프라는 **변경 없음** — LLM 노트가 일반 노트와 같은 저장 경로를 쓰는 것이 핵심 단순화.

**Tech Stack:** TypeScript (`app/`, `bridge/`), Svelte 5 runes, TipTap 3 (ProseMirror), vitest, Ollama HTTP API, Node 18+ fetch/ReadableStream.

**Spec:** `docs/superpowers/specs/2026-05-12-llm-note-quick-helper-design.md`

---

## File Structure Map

**신규 클라이언트 모듈** — pure TS, 단위 테스트 용이:

```
app/src/lib/llmNote/
├── defaults.ts                       ← 자동 보완 기본값, 정규식 상수
├── parseLlmNote.ts                   ← editor JSON → LlmNoteSpec | null
├── buildChatRequest.ts               ← LlmNoteSpec → /llm/chat body
└── sendChat.ts                       ← fetch + NDJSON 스트림 + AbortController
```

**신규 에디터 모듈** — ProseMirror 통합:

```
app/src/lib/editor/llmNote/
├── llmNotePlugin.ts                  ← 시그니처 감지 + 자동 헤더 보완
└── LlmSendBar.svelte                 ← 우하단 [보내기] / [중지] / 토큰 카운트
```

**신규 bridge 모듈**:

```
bridge/src/llm.ts                     ← /llm/chat 핸들러 (~80 LOC)
```

**기존 코드 수정**:

| 파일 | 변경 |
|---|---|
| `app/src/lib/editor/TomboyEditor.svelte` | `llmNotePlugin` 등록 |
| `app/src/routes/note/[id]/+page.svelte` | `<LlmSendBar>` 마운트 |
| `app/src/lib/desktop/NoteWindow.svelte` | `<LlmSendBar>` 마운트 |
| `app/src/routes/settings/+page.svelte` | "터미널 브릿지" → "원격 브릿지" 라벨 1줄 |
| `bridge/src/server.ts` | `/llm/chat` 라우팅 추가 |
| `bridge/deploy/term-bridge.container` | `OLLAMA_BASE_URL` env 추가 |
| `pipeline/desktop/deploy/desktop-pipeline.service` | `ExecStartPre` Ollama evict |

**불변** — `noteManager.ts` / `noteStore.ts` / Firebase sync / Dropbox sync / title-unique guard / 자동링크 plugin / 그래프 시각화는 모두 변경 없음.

---

## Task 1: 노트 grammar 파서 + 자동 보완 기본값

**Goal:** ProseMirror editor JSON 을 받아 `LlmNoteSpec | null` 을 리턴하는 pure 파서 + 자동 보완에 쓸 기본값 상수. 시그니처 감지 + 헤더 파싱 + Q/A turn 추출.

**Files:**
- Create: `app/src/lib/llmNote/defaults.ts`
- Create: `app/src/lib/llmNote/parseLlmNote.ts`
- Test: `app/tests/unit/llmNote/parseLlmNote.test.ts`

**Acceptance Criteria:**
- [ ] `defaults.ts` 가 `LLM_SIGNATURE_RE`, `LLM_HEADER_KEY_RE`, `LLM_HEADER_DEFAULTS`, `LLM_RECOGNIZED_HEADER_KEYS` 를 export
- [ ] `parseLlmNote(doc)` 가 `doc.content[1]` 의 시그니처를 인식 → `LlmNoteSpec` 리턴
- [ ] `doc.content[0]` 에만 시그니처가 있는 과도기 케이스도 인식 (자동 보완 도달 전 단일 transaction)
- [ ] 시그니처 없음 / 형식 깨짐 → `null` 리턴
- [ ] 헤더 멀티라인 system (다음 줄이 들여쓰여 있으면 이전 키 값의 연속) 처리
- [ ] `temperature: not-a-number` 같은 형식 깨짐 → 그 키만 silent 무시, 다른 헤더는 살림
- [ ] turn 영역의 `Q:` / `A:` 추출 (대소문자 구분), 텍스트 trim 안 함 (사용자 입력 그대로)
- [ ] 마지막 message 가 user role 이고 그 뒤 assistant 없으면 `trailingEmptyUserTurn: true`

**Verify:** `cd app && npm test -- llmNote/parseLlmNote` → 모든 단언 PASS

**Steps:**

- [ ] **Step 1: defaults.ts 작성**

```ts
// app/src/lib/llmNote/defaults.ts

/**
 * Matches the LLM note signature line:
 *   llm://qwen2.5-coder:3b
 *   llm://library/qwen2.5:7b
 *
 * Captures the model ref. Ollama tags use [a-z0-9._:-] plus optional / for
 * registry namespacing; we allow uppercase too for robustness.
 */
export const LLM_SIGNATURE_RE = /^llm:\/\/([A-Za-z0-9._:/-]+)\s*$/;

/**
 * Matches a recognized header key at the start of a line.
 * Capture 1 = key name, capture 2 = value (may be empty).
 */
export const LLM_HEADER_KEY_RE =
	/^(system|temperature|num_ctx|top_p|seed|num_predict):\s?(.*)$/;

export const LLM_RECOGNIZED_HEADER_KEYS = [
	'system',
	'temperature',
	'num_ctx',
	'top_p',
	'seed',
	'num_predict'
] as const;

export type LlmHeaderKey = (typeof LLM_RECOGNIZED_HEADER_KEYS)[number];

/**
 * Defaults inserted by auto-complete when keys are missing.
 *   system: empty value — user is nudged to define their persona explicitly
 *   temperature: 0.3 — conservative for Korean + technical answers
 *   num_ctx: 4096 — safe coexistence with 7B-Q4 on RTX 3080 10GB
 *
 * `top_p`, `seed`, `num_predict` are NOT auto-inserted — user adds them
 * when they need them.
 */
export const LLM_HEADER_DEFAULTS = {
	system: '',
	temperature: 0.3,
	num_ctx: 4096
} as const;
```

- [ ] **Step 2: 테스트 파일 작성 (TDD red phase)**

```ts
// app/tests/unit/llmNote/parseLlmNote.test.ts
import { describe, it, expect } from 'vitest';
import { parseLlmNote } from '$lib/llmNote/parseLlmNote.js';
import type { JSONContent } from '@tiptap/core';

// Helper: build a doc from an array of paragraph strings
function doc(...paras: string[]): JSONContent {
	return {
		type: 'doc',
		content: paras.map((text) => ({
			type: 'paragraph',
			content: text === '' ? undefined : [{ type: 'text', text }]
		}))
	};
}

describe('parseLlmNote', () => {
	it('returns null when doc is empty or undefined', () => {
		expect(parseLlmNote(undefined)).toBeNull();
		expect(parseLlmNote(null)).toBeNull();
		expect(parseLlmNote({ type: 'doc', content: [] })).toBeNull();
	});

	it('returns null when no signature line is present', () => {
		expect(parseLlmNote(doc('hello', 'world'))).toBeNull();
	});

	it('returns null when signature format is broken', () => {
		expect(parseLlmNote(doc('title', 'llm://invalid format!'))).toBeNull();
	});

	it('recognizes signature at doc.content[1] (canonical placement)', () => {
		const result = parseLlmNote(doc('셸 도우미', 'llm://qwen2.5-coder:3b'));
		expect(result).not.toBeNull();
		expect(result!.model).toBe('qwen2.5-coder:3b');
	});

	it('recognizes signature at doc.content[0] (transient pre-auto-complete state)', () => {
		const result = parseLlmNote(doc('llm://qwen2.5-coder:3b'));
		expect(result).not.toBeNull();
		expect(result!.model).toBe('qwen2.5-coder:3b');
	});

	it('prefers doc.content[1] when both positions match (abnormal case)', () => {
		const result = parseLlmNote(
			doc('llm://qwen2.5-coder:3b', 'llm://qwen2.5:7b')
		);
		expect(result!.model).toBe('qwen2.5:7b');
	});

	it('parses single-line header values', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'system: you are a helpful assistant',
				'temperature: 0.5',
				'num_ctx: 2048'
			)
		);
		expect(result!.system).toBe('you are a helpful assistant');
		expect(result!.options.temperature).toBe(0.5);
		expect(result!.options.num_ctx).toBe(2048);
	});

	it('parses multi-line system header (continuation lines indented)', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b\nsystem: line 1\n  line 2\n  line 3\ntemperature: 0.3'
			)
		);
		expect(result!.system).toBe('line 1\nline 2\nline 3');
		expect(result!.options.temperature).toBe(0.3);
	});

	it('silently drops a header key whose value fails to parse as number', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'temperature: not-a-number',
				'num_ctx: 4096'
			)
		);
		expect(result!.options.temperature).toBeUndefined();
		expect(result!.options.num_ctx).toBe(4096);
	});

	it('extracts Q/A turns from the turn region (after blank paragraph)', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'system: shell helper',
				'',
				'Q: tar.zst 풀기?',
				'A: tar -I zstd -xf file.tar.zst',
				'Q: zstd 없으면?',
				'A: dnf install zstd'
			)
		);
		expect(result!.messages).toEqual([
			{ role: 'user', content: 'tar.zst 풀기?' },
			{ role: 'assistant', content: 'tar -I zstd -xf file.tar.zst' },
			{ role: 'user', content: 'zstd 없으면?' },
			{ role: 'assistant', content: 'dnf install zstd' }
		]);
	});

	it('sets trailingEmptyUserTurn true when ending with empty Q:', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'',
				'Q: first question',
				'A: first answer',
				'Q:'
			)
		);
		expect(result!.trailingEmptyUserTurn).toBe(true);
		expect(result!.messages[result!.messages.length - 1]).toEqual({
			role: 'user',
			content: ''
		});
	});

	it('sets trailingEmptyUserTurn true when ending with Q: containing text', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'',
				'Q: first',
				'A: answered',
				'Q: second pending'
			)
		);
		expect(result!.trailingEmptyUserTurn).toBe(true);
		expect(result!.messages[result!.messages.length - 1]).toEqual({
			role: 'user',
			content: 'second pending'
		});
	});

	it('sets trailingEmptyUserTurn false when ending with A:', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'',
				'Q: question',
				'A: answer'
			)
		);
		expect(result!.trailingEmptyUserTurn).toBe(false);
	});

	it('treats unrecognized header keys as silent ignore', () => {
		const result = parseLlmNote(
			doc(
				'title',
				'llm://qwen2.5-coder:3b',
				'temperature: 0.3',
				'unknown_key: value',
				'num_ctx: 4096'
			)
		);
		expect(result!.options.temperature).toBe(0.3);
		expect(result!.options.num_ctx).toBe(4096);
		// unknown_key should not appear anywhere
		expect((result!.options as Record<string, unknown>).unknown_key).toBeUndefined();
	});
});
```

- [ ] **Step 3: 테스트 실행 — 빨간색 확인**

Run: `cd app && npm test -- llmNote/parseLlmNote`
Expected: 모든 테스트 FAIL — `parseLlmNote` 가 아직 export 안 됨.

- [ ] **Step 4: parseLlmNote.ts 구현**

```ts
// app/src/lib/llmNote/parseLlmNote.ts
import type { JSONContent } from '@tiptap/core';
import {
	LLM_SIGNATURE_RE,
	LLM_HEADER_KEY_RE,
	type LlmHeaderKey
} from './defaults.js';

export interface LlmNoteSpec {
	model: string;
	system?: string;
	options: {
		temperature?: number;
		num_ctx?: number;
		top_p?: number;
		seed?: number;
		num_predict?: number;
	};
	messages: Array<{ role: 'user' | 'assistant'; content: string }>;
	/**
	 * True when the last message is a user turn awaiting a response (whether
	 * its content is empty or has text). The send-time check separately
	 * verifies the content is non-empty.
	 */
	trailingEmptyUserTurn: boolean;
}

/** Plain text of a paragraph block, joining only text-typed inline children. */
function paragraphText(block: JSONContent | undefined): string {
	if (!block || !Array.isArray(block.content)) return '';
	return block.content
		.map((node) => (node.type === 'text' ? (node.text ?? '') : ''))
		.join('');
}

/**
 * In tomboy-web a "paragraph" is usually a single visual line, but a paragraph
 * node can hold '\n' characters. Defensively split.
 */
function paragraphLines(block: JSONContent | undefined): string[] {
	return paragraphText(block).split('\n');
}

const INT_KEYS = new Set<LlmHeaderKey>(['num_ctx', 'seed', 'num_predict']);

export function parseLlmNote(doc: JSONContent | null | undefined): LlmNoteSpec | null {
	if (!doc || !Array.isArray(doc.content) || doc.content.length === 0) return null;

	// Find signature: doc.content[1] preferred, doc.content[0] tolerated.
	let sigIndex: number;
	let model: string;

	const c1FirstLine = doc.content.length > 1 ? paragraphLines(doc.content[1])[0] ?? '' : '';
	const m1 = LLM_SIGNATURE_RE.exec(c1FirstLine);
	if (m1) {
		sigIndex = 1;
		model = m1[1];
	} else {
		const c0FirstLine = paragraphLines(doc.content[0])[0] ?? '';
		const m0 = LLM_SIGNATURE_RE.exec(c0FirstLine);
		if (!m0) return null;
		sigIndex = 0;
		model = m0[1];
	}

	// Header lines: collect every line after the signature line until the
	// first BLANK paragraph (which is the header/turn boundary).
	const headerLines: string[] = [];
	let blankSeen = false;
	let turnStartIndex = sigIndex + 1;

	// First, the rest of the signature paragraph itself (if signature was
	// followed by more lines within the same paragraph).
	const sigParaLines = paragraphLines(doc.content[sigIndex]);
	for (let i = 1; i < sigParaLines.length; i++) {
		headerLines.push(sigParaLines[i]);
	}

	for (let i = sigIndex + 1; i < doc.content.length; i++) {
		const text = paragraphText(doc.content[i]);
		if (text === '') {
			blankSeen = true;
			turnStartIndex = i + 1;
			break;
		}
		for (const line of paragraphLines(doc.content[i])) {
			headerLines.push(line);
		}
	}
	if (!blankSeen) turnStartIndex = doc.content.length; // no turn region

	// Parse header lines into a result.
	const result: LlmNoteSpec = {
		model,
		options: {},
		messages: [],
		trailingEmptyUserTurn: false
	};

	let currentKey: LlmHeaderKey | null = null;
	let currentValueLines: string[] = [];

	const flushKey = (): void => {
		if (currentKey === null) return;
		const value = currentValueLines.join('\n');
		if (currentKey === 'system') {
			result.system = value;
		} else {
			const trimmed = value.trim();
			const n = INT_KEYS.has(currentKey) ? parseInt(trimmed, 10) : parseFloat(trimmed);
			if (Number.isFinite(n)) {
				(result.options as Record<string, number>)[currentKey] = n;
			}
			// else silently drop the key
		}
		currentKey = null;
		currentValueLines = [];
	};

	for (const line of headerLines) {
		const keyMatch = LLM_HEADER_KEY_RE.exec(line);
		if (keyMatch) {
			flushKey();
			currentKey = keyMatch[1] as LlmHeaderKey;
			currentValueLines = [keyMatch[2]];
		} else if (currentKey !== null) {
			// Continuation of the previous key — strip a single level of indent.
			const stripped = line.replace(/^\s+/, '');
			currentValueLines.push(stripped);
		}
		// else: orphan line at start of header (no key yet) — ignore.
	}
	flushKey();

	// Turn region: from turnStartIndex onwards.
	let lastRole: 'user' | 'assistant' | null = null;
	let lastContent: string[] = [];

	const flushTurn = (): void => {
		if (lastRole === null) return;
		result.messages.push({ role: lastRole, content: lastContent.join('\n') });
		lastRole = null;
		lastContent = [];
	};

	for (let i = turnStartIndex; i < doc.content.length; i++) {
		const text = paragraphText(doc.content[i]);
		if (text.startsWith('Q: ') || text === 'Q:') {
			flushTurn();
			lastRole = 'user';
			lastContent = [text === 'Q:' ? '' : text.slice(3)];
		} else if (text.startsWith('A: ') || text === 'A:') {
			flushTurn();
			lastRole = 'assistant';
			lastContent = [text === 'A:' ? '' : text.slice(3)];
		} else if (lastRole !== null) {
			// Continuation of the current turn (multi-line content, blank lines).
			lastContent.push(text);
		}
		// else: orphan line before any Q:/A: — ignore.
	}

	// If the last turn is a user turn awaiting response, set the flag BEFORE
	// flushing (so we can still flush properly with content).
	if (lastRole === 'user') {
		result.trailingEmptyUserTurn = true;
	}
	flushTurn();

	return result;
}
```

- [ ] **Step 5: 테스트 재실행 — 초록색 확인**

Run: `cd app && npm test -- llmNote/parseLlmNote`
Expected: 모든 테스트 PASS.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/llmNote/defaults.ts \
        app/src/lib/llmNote/parseLlmNote.ts \
        app/tests/unit/llmNote/parseLlmNote.test.ts
git commit -m "LLM 노트 grammar 파서 + 자동 보완 기본값"
```

---

## Task 2: chat request 빌더

**Goal:** `LlmNoteSpec` 을 `/llm/chat` body 로 변환. system 을 messages 앞에 prepend, options 의 undefined 키 omit.

**Files:**
- Create: `app/src/lib/llmNote/buildChatRequest.ts`
- Test: `app/tests/unit/llmNote/buildChatRequest.test.ts`

**Acceptance Criteria:**
- [ ] `system` 있으면 `messages[0]` 위치에 `{role:'system', content}` prepend
- [ ] `system` 없으면 messages 그대로
- [ ] `options` 의 undefined 키는 결과에 포함 안 됨 (정의된 키만 포함)
- [ ] `model` 그대로 통과
- [ ] 결과 객체 구조가 spec §4 의 `/llm/chat` body 와 일치

**Verify:** `cd app && npm test -- llmNote/buildChatRequest` → PASS

**Steps:**

- [ ] **Step 1: 테스트 작성**

```ts
// app/tests/unit/llmNote/buildChatRequest.test.ts
import { describe, it, expect } from 'vitest';
import { buildChatRequest } from '$lib/llmNote/buildChatRequest.js';
import type { LlmNoteSpec } from '$lib/llmNote/parseLlmNote.js';

const baseSpec: LlmNoteSpec = {
	model: 'qwen2.5-coder:3b',
	options: {},
	messages: [{ role: 'user', content: 'hi' }],
	trailingEmptyUserTurn: true
};

describe('buildChatRequest', () => {
	it('passes model through unchanged', () => {
		const body = buildChatRequest(baseSpec);
		expect(body.model).toBe('qwen2.5-coder:3b');
	});

	it('passes messages through when system is undefined', () => {
		const body = buildChatRequest(baseSpec);
		expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
	});

	it('prepends system as the first message when defined', () => {
		const body = buildChatRequest({
			...baseSpec,
			system: 'you are a shell helper'
		});
		expect(body.messages).toEqual([
			{ role: 'system', content: 'you are a shell helper' },
			{ role: 'user', content: 'hi' }
		]);
	});

	it('omits undefined option keys', () => {
		const body = buildChatRequest({
			...baseSpec,
			options: { temperature: 0.5, num_ctx: undefined }
		});
		expect(body.options).toEqual({ temperature: 0.5 });
		expect('num_ctx' in body.options).toBe(false);
	});

	it('includes all defined option keys', () => {
		const body = buildChatRequest({
			...baseSpec,
			options: {
				temperature: 0.5,
				num_ctx: 4096,
				top_p: 0.9,
				seed: 42,
				num_predict: 256
			}
		});
		expect(body.options).toEqual({
			temperature: 0.5,
			num_ctx: 4096,
			top_p: 0.9,
			seed: 42,
			num_predict: 256
		});
	});

	it('omits options entirely when no keys are defined', () => {
		const body = buildChatRequest(baseSpec);
		expect(body.options).toEqual({});
	});

	it('passes empty system string as a system message (user wants explicit empty persona)', () => {
		const body = buildChatRequest({
			...baseSpec,
			system: ''
		});
		// Empty system means "user explicitly chose no persona" — we send it as
		// undefined so we don't waste a system message on whitespace.
		expect(body.messages[0].role).toBe('user');
	});
});
```

- [ ] **Step 2: 테스트 실행 — 빨간색 확인**

Run: `cd app && npm test -- llmNote/buildChatRequest`
Expected: FAIL — `buildChatRequest` not exported.

- [ ] **Step 3: 구현**

```ts
// app/src/lib/llmNote/buildChatRequest.ts
import type { LlmNoteSpec } from './parseLlmNote.js';

export interface ChatRequestBody {
	model: string;
	options: Record<string, number>;
	messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

/**
 * Convert a parsed LLM note spec into the JSON body POSTed to /llm/chat.
 *
 * - If `system` is a non-empty string, prepend it as a system message.
 *   Empty string means "user deliberately left the persona blank" — we
 *   omit the system message entirely rather than wasting a slot.
 * - `options` only contains keys whose value is not undefined.
 * - `model` is passed through unchanged.
 */
export function buildChatRequest(spec: LlmNoteSpec): ChatRequestBody {
	const options: Record<string, number> = {};
	for (const [k, v] of Object.entries(spec.options)) {
		if (typeof v === 'number') options[k] = v;
	}

	const messages = spec.system && spec.system.length > 0
		? [{ role: 'system' as const, content: spec.system }, ...spec.messages]
		: [...spec.messages];

	return { model: spec.model, options, messages };
}
```

- [ ] **Step 4: 테스트 재실행 — 초록색 확인**

Run: `cd app && npm test -- llmNote/buildChatRequest`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/llmNote/buildChatRequest.ts \
        app/tests/unit/llmNote/buildChatRequest.test.ts
git commit -m "LLM 노트 chat request 빌더"
```

---

## Task 3: ProseMirror 자동 헤더 보완 플러그인

**Goal:** 시그니처 라인이 막 완성된 transaction + mount 시 헤더 0개인 경우에 제목 단락 + 누락된 헤더 키 + 빈 Q: 줄을 자동 추가. autoWeekday 패턴 (`appendTransaction`, `setMeta` rescan) 그대로.

**Files:**
- Create: `app/src/lib/editor/llmNote/llmNotePlugin.ts`
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (플러그인 등록 1줄)
- Test: `app/tests/unit/editor/llmNotePlugin.test.ts`

**Acceptance Criteria:**
- [ ] 시그니처 타이핑 transaction 직후 자동 보완 발생: 빈 제목 단락이 시그니처 앞에 삽입, 누락 헤더 키 추가, 빈 단락 + 빈 `Q: ` 추가
- [ ] mount 시 `setMeta(llmNotePluginKey, { rescan: true })` 패스 — 헤더 인식 키가 0 개일 때만 보완 (기존 키 있으면 NO-OP)
- [ ] 사용자가 `temperature:` 줄 지운 후 일반 transaction → 자동 복원 안 함
- [ ] 시그니처 없는 노트엔 모든 transaction 에서 NO-OP — 일반 노트 영향 0

**Verify:** `cd app && npm test -- editor/llmNotePlugin` → PASS

**Steps:**

- [ ] **Step 1: 테스트 작성**

테스트는 `Editor` 인스턴스 + StarterKit + llmNotePlugin 으로 ProseMirror command 시뮬레이션 (autoWeekday test 와 같은 패턴). 기존 `app/tests/unit/editor/autoWeekdayPlugin.test.ts` 의 setup 패턴을 참조.

```ts
// app/tests/unit/editor/llmNotePlugin.test.ts
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
	createLlmNotePlugin,
	llmNotePluginKey
} from '$lib/editor/llmNote/llmNotePlugin.js';

function createTestEditor(): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ history: false }),
			{
				name: 'llmNoteExt',
				addProseMirrorPlugins() {
					return [createLlmNotePlugin()];
				}
			} as never
		],
		content: ''
	});
	return editor;
}

function editorParagraphTexts(editor: Editor): string[] {
	const out: string[] = [];
	editor.state.doc.forEach((node) => {
		out.push(node.textContent);
	});
	return out;
}

describe('llmNotePlugin', () => {
	it('inserts title paragraph + headers + empty Q: after signature is typed', async () => {
		const editor = createTestEditor();
		editor.commands.setContent('');
		// Simulate the user typing the signature into the empty first paragraph.
		editor.commands.insertContent('llm://qwen2.5-coder:3b');
		// appendTransaction runs synchronously after the doc-changing tr.
		const paras = editorParagraphTexts(editor);
		// Expected: ['' (title), 'llm://qwen2.5-coder:3b', 'system: ',
		//            'temperature: 0.3', 'num_ctx: 4096', '', 'Q: ']
		expect(paras[0]).toBe('');
		expect(paras[1]).toBe('llm://qwen2.5-coder:3b');
		expect(paras).toContain('system: ');
		expect(paras).toContain('temperature: 0.3');
		expect(paras).toContain('num_ctx: 4096');
		expect(paras[paras.length - 1]).toBe('Q: ');
		// Blank paragraph between header and Q:
		const qIndex = paras.lastIndexOf('Q: ');
		expect(paras[qIndex - 1]).toBe('');
		editor.destroy();
	});

	it('does not re-apply auto-complete on subsequent transactions', () => {
		const editor = createTestEditor();
		editor.commands.setContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '셸 도우미' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'llm://qwen2.5-coder:3b' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'temperature: 0.5' }] },
				{ type: 'paragraph' },
				{ type: 'paragraph', content: [{ type: 'text', text: 'Q: hi' }] }
			]
		});
		// User deletes the temperature line by replacing the third paragraph
		// with empty content.
		const before = editorParagraphTexts(editor).filter((p) => p.startsWith('temperature:'));
		expect(before.length).toBe(1);
		// Delete that paragraph
		editor.commands.setContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '셸 도우미' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'llm://qwen2.5-coder:3b' }] },
				{ type: 'paragraph' },
				{ type: 'paragraph', content: [{ type: 'text', text: 'Q: hi' }] }
			]
		});
		// Now type something that triggers a docChanged tr (not a rescan).
		editor.commands.insertContentAt(editor.state.doc.content.size, 'x');
		const paras = editorParagraphTexts(editor);
		// temperature should NOT be re-added.
		expect(paras.filter((p) => p.startsWith('temperature:')).length).toBe(0);
		editor.destroy();
	});

	it('on rescan meta with header keys 0, fills the missing keys', () => {
		const editor = createTestEditor();
		editor.commands.setContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'llm://qwen2.5-coder:3b' }] }
			]
		});
		// No headers, no Q. Dispatch rescan.
		const tr = editor.state.tr.setMeta(llmNotePluginKey, { rescan: true });
		editor.view.dispatch(tr);
		const paras = editorParagraphTexts(editor);
		expect(paras).toContain('system: ');
		expect(paras).toContain('temperature: 0.3');
		expect(paras).toContain('num_ctx: 4096');
		expect(paras[paras.length - 1]).toBe('Q: ');
		editor.destroy();
	});

	it('on rescan with header keys present, does NOT modify the doc', () => {
		const editor = createTestEditor();
		const initialContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'llm://qwen2.5-coder:3b' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'temperature: 0.5' }] }
			]
		};
		editor.commands.setContent(initialContent);
		const before = editor.getJSON();
		const tr = editor.state.tr.setMeta(llmNotePluginKey, { rescan: true });
		editor.view.dispatch(tr);
		const after = editor.getJSON();
		expect(after).toEqual(before);
		editor.destroy();
	});

	it('does nothing on docs without a signature', () => {
		const editor = createTestEditor();
		editor.commands.setContent({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'a regular note' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'with content' }] }
			]
		});
		const before = editor.getJSON();
		// docChanged tr
		editor.commands.insertContentAt(editor.state.doc.content.size, 'x');
		// Trigger rescan too — still nothing
		const tr = editor.state.tr.setMeta(llmNotePluginKey, { rescan: true });
		editor.view.dispatch(tr);
		// Doc should only differ by the 'x' insertion, not by any plugin action
		const after = editor.getJSON();
		const beforeText = JSON.stringify(before).replace(/with content/, 'with contentx');
		// Just verify the plugin didn't add any "system: " / "Q: " / etc.
		const allTexts = JSON.stringify(after);
		expect(allTexts).not.toContain('system: ');
		expect(allTexts).not.toContain('Q: ');
		editor.destroy();
	});
});
```

- [ ] **Step 2: 빨간색 확인**

Run: `cd app && npm test -- editor/llmNotePlugin`
Expected: FAIL — module not found.

- [ ] **Step 3: 플러그인 구현**

```ts
// app/src/lib/editor/llmNote/llmNotePlugin.ts
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { parseLlmNote } from '$lib/llmNote/parseLlmNote.js';
import {
	LLM_SIGNATURE_RE,
	LLM_HEADER_DEFAULTS,
	LLM_RECOGNIZED_HEADER_KEYS,
	type LlmHeaderKey
} from '$lib/llmNote/defaults.js';

export const llmNotePluginKey = new PluginKey<undefined>('llmNote');

interface SignatureLocation {
	paragraphIndex: number;
	model: string;
}

function paragraphTextOfPMNode(node: PMNode): string {
	return node.textContent;
}

/** Find the signature line position in the doc. Returns null if absent. */
function findSignature(doc: PMNode): SignatureLocation | null {
	if (doc.childCount === 0) return null;

	// Check doc.content[1] first (canonical placement).
	if (doc.childCount > 1) {
		const c1FirstLine = paragraphTextOfPMNode(doc.child(1)).split('\n')[0] ?? '';
		const m1 = LLM_SIGNATURE_RE.exec(c1FirstLine);
		if (m1) return { paragraphIndex: 1, model: m1[1] };
	}
	// Tolerate doc.content[0] (pre-auto-complete transient state).
	const c0FirstLine = paragraphTextOfPMNode(doc.child(0)).split('\n')[0] ?? '';
	const m0 = LLM_SIGNATURE_RE.exec(c0FirstLine);
	if (m0) return { paragraphIndex: 0, model: m0[1] };

	return null;
}

/** Count recognized header keys appearing in the header region of the doc. */
function countRecognizedHeaderKeys(doc: PMNode, sigIndex: number): number {
	const headerKeyRE = new RegExp(
		`^(${LLM_RECOGNIZED_HEADER_KEYS.join('|')}):`
	);
	let count = 0;
	for (let i = sigIndex + 1; i < doc.childCount; i++) {
		const text = paragraphTextOfPMNode(doc.child(i));
		if (text === '') break; // hit the blank-paragraph boundary
		for (const line of text.split('\n')) {
			if (headerKeyRE.test(line)) count++;
		}
	}
	return count;
}

/**
 * Build paragraph nodes for the auto-complete output: the missing default
 * header lines (system, temperature, num_ctx), then a blank paragraph, then
 * the empty `Q: ` line.
 */
function buildAutoCompleteParagraphs(
	schema: Schema,
	existingHeaderKeys: Set<LlmHeaderKey>
): PMNode[] {
	const paras: PMNode[] = [];
	if (!existingHeaderKeys.has('system')) {
		paras.push(schema.nodes.paragraph.create(null, schema.text('system: ')));
	}
	if (!existingHeaderKeys.has('temperature')) {
		paras.push(
			schema.nodes.paragraph.create(
				null,
				schema.text(`temperature: ${LLM_HEADER_DEFAULTS.temperature}`)
			)
		);
	}
	if (!existingHeaderKeys.has('num_ctx')) {
		paras.push(
			schema.nodes.paragraph.create(
				null,
				schema.text(`num_ctx: ${LLM_HEADER_DEFAULTS.num_ctx}`)
			)
		);
	}
	// Empty paragraph (header/turn boundary)
	paras.push(schema.nodes.paragraph.create());
	// Empty Q: line
	paras.push(schema.nodes.paragraph.create(null, schema.text('Q: ')));
	return paras;
}

function existingHeaderKeysInDoc(
	doc: PMNode,
	sigIndex: number
): Set<LlmHeaderKey> {
	const out = new Set<LlmHeaderKey>();
	const headerKeyRE = new RegExp(
		`^(${LLM_RECOGNIZED_HEADER_KEYS.join('|')}):`
	);
	for (let i = sigIndex + 1; i < doc.childCount; i++) {
		const text = paragraphTextOfPMNode(doc.child(i));
		if (text === '') break;
		for (const line of text.split('\n')) {
			const m = headerKeyRE.exec(line);
			if (m) out.add(m[1] as LlmHeaderKey);
		}
	}
	return out;
}

export function createLlmNotePlugin(): Plugin {
	return new Plugin({
		key: llmNotePluginKey,
		appendTransaction(trs, oldState, newState) {
			const rescan = trs.some(
				(tr) => tr.getMeta(llmNotePluginKey)?.rescan === true
			);
			const docChanged = trs.some((tr) => tr.docChanged);

			if (!rescan && !docChanged) return null;

			const { doc, schema } = newState;
			const sig = findSignature(doc);
			if (!sig) return null;

			// Decide whether to trigger auto-complete.
			let shouldComplete = false;

			if (rescan) {
				// mount-time rescan: only complete if header keys count == 0
				if (countRecognizedHeaderKeys(doc, sig.paragraphIndex) === 0) {
					shouldComplete = true;
				}
			} else if (docChanged) {
				// docChange: only complete if the signature line was NOT present
				// in the old state. Detect by checking findSignature(oldDoc).
				const oldSig = findSignature(oldState.doc);
				if (!oldSig) {
					shouldComplete = true;
				}
			}

			if (!shouldComplete) return null;

			// Apply auto-complete: insert title paragraph if signature is at
			// content[0]; then insert missing header lines + blank + Q: at the
			// end of the header region.
			const tr = newState.tr;
			let titleInserted = false;

			if (sig.paragraphIndex === 0) {
				// Insert empty paragraph before the signature paragraph.
				const emptyPara = schema.nodes.paragraph.create();
				tr.insert(0, emptyPara);
				titleInserted = true;
				// Signature paragraph is now at index 1; recompute header region
				// against the new doc state (use the resolved position).
			}

			// Recompute sigIndex after potential title insertion.
			const effSigIndex = titleInserted ? sig.paragraphIndex + 1 : sig.paragraphIndex;

			// Compute insertion position: end of header region (just before the
			// first blank paragraph, or end of doc if no blank).
			let insertPos: number;
			const currentDoc = tr.doc;
			let endOfHeaderIndex = effSigIndex + 1;
			while (endOfHeaderIndex < currentDoc.childCount) {
				const text = paragraphTextOfPMNode(currentDoc.child(endOfHeaderIndex));
				if (text === '') break;
				endOfHeaderIndex++;
			}
			// Compute absolute position = sum of node sizes up to that index.
			insertPos = 0;
			for (let i = 0; i < endOfHeaderIndex; i++) {
				insertPos += currentDoc.child(i).nodeSize;
			}

			// Insert missing default headers + blank + Q: at insertPos.
			const existing = existingHeaderKeysInDoc(currentDoc, effSigIndex);
			// If a blank already exists at endOfHeaderIndex (i.e. header region
			// ended with a blank), we want to insert BEFORE it. The Q: line will
			// then come at the bottom. To keep one blank between header and Q:,
			// we strip the blank-and-everything-after if present, and re-append.
			let hasTrailingBlankAndQ = false;
			if (endOfHeaderIndex < currentDoc.childCount) {
				// header region has explicit boundary already
				hasTrailingBlankAndQ = true;
			}

			const paras = buildAutoCompleteParagraphs(schema, existing);
			// If there's already a trailing blank + something, don't double-insert
			// the blank + Q: tail.
			const parasToInsert = hasTrailingBlankAndQ
				? paras.slice(0, paras.length - 2) // drop the empty para + Q: line
				: paras;

			if (parasToInsert.length > 0) {
				tr.insert(insertPos, parasToInsert);
			}

			// Move cursor to start of the (new) empty title paragraph when a
			// docChange triggered this (rescan keeps cursor where it was).
			if (rescan === false && titleInserted) {
				// position 1 = inside the first (now-empty) paragraph
				tr.setSelection(newState.selection.constructor.near(tr.doc.resolve(1)));
			}

			return tr;
		}
	});
}
```

- [ ] **Step 4: TomboyEditor.svelte 에 플러그인 등록**

`app/src/lib/editor/TomboyEditor.svelte` 의 extensions 목록 (autoWeekday 등록 부근) 에 한 줄 추가:

```svelte
<!-- in the extensions array of new Editor({...}): -->
import { createLlmNotePlugin } from './llmNote/llmNotePlugin.js';
// ...
{
    name: 'llmNoteExt',
    addProseMirrorPlugins() {
        return [createLlmNotePlugin()];
    }
} as never
```

정확한 등록 위치: autoWeekdayPlugin 등록 줄 (현재 코드의 패턴) 옆. autoWeekday 가 `addProseMirrorPlugins` 로 등록되어 있는지 확인 후 같은 방식.

(Subagent 가 이 단계 도달 시 TomboyEditor.svelte 의 현재 extension 등록 구조를 읽고 일관된 형태로 추가.)

- [ ] **Step 5: 테스트 재실행 — 초록색 확인**

Run: `cd app && npm test -- editor/llmNotePlugin`
Expected: PASS.

전체 테스트도 깨지지 않는지 확인:
Run: `cd app && npm test`
Expected: 모든 기존 테스트 PASS (autoWeekday/autoLink/clipboard 등 영향 없음).

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/llmNote/llmNotePlugin.ts \
        app/src/lib/editor/TomboyEditor.svelte \
        app/tests/unit/editor/llmNotePlugin.test.ts
git commit -m "LLM 노트 자동 헤더 보완 ProseMirror plugin"
```

---

## Task 4: bridge `/llm/chat` endpoint

**Goal:** 기존 `bridge/` 컨테이너에 `/llm/chat` HTTP endpoint 추가. Bearer 인증 → Ollama `/api/chat` NDJSON 패스스루. admin endpoint 노출 금지.

**Files:**
- Create: `bridge/src/llm.ts`
- Modify: `bridge/src/server.ts` (`handleHttp` 에 `/llm/chat` 분기)
- Modify: `bridge/deploy/term-bridge.container` (`OLLAMA_BASE_URL` env)

**Acceptance Criteria:**
- [ ] `POST /llm/chat` with Bearer auth → Ollama `/api/chat` 패스스루
- [ ] 401 unauthorized when token invalid
- [ ] 400 bad_request when model missing/empty
- [ ] 400 empty_messages when messages array empty
- [ ] 503 ollama_unavailable when Ollama connection refused
- [ ] 404 model_not_found when Ollama returns 404
- [ ] 502 upstream_error when Ollama returns 5xx
- [ ] NDJSON streaming pass-through with `Content-Type: application/x-ndjson` + `Transfer-Encoding: chunked`
- [ ] 클라이언트 abort → bridge 가 Ollama 연결도 끊음 (AbortController 패턴)
- [ ] 로그 형식: `[term-bridge llm] model=X msgs=N` 시작, `[term-bridge llm] done duration=Xs tokens_out=Y` 또는 `[term-bridge llm] error CODE`. 본문 비공개
- [ ] `OPTIONS /llm/chat` CORS preflight 가 `applyCors` 통과

**Verify:** bridge 컨테이너 재빌드 후 `curl` 으로 manual smoke (Task 9 의 단계 2 일부)

**Steps:**

- [ ] **Step 1: `bridge/src/llm.ts` 작성**

```ts
// bridge/src/llm.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

interface ChatRequestBody {
	model?: unknown;
	options?: Record<string, unknown>;
	messages?: unknown;
	[k: string]: unknown;
}

const MODEL_RE = /^[A-Za-z0-9._:/-]+$/;

export async function handleLlmChat(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string
): Promise<void> {
	// Auth
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	// Read body
	let body: ChatRequestBody;
	try {
		body = (await readJson(req)) as ChatRequestBody;
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}

	// Validate
	const model = typeof body.model === 'string' ? body.model : '';
	if (!model || !MODEL_RE.test(model)) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_request', detail: 'invalid_model' }));
		return;
	}

	const messages = Array.isArray(body.messages) ? body.messages : [];
	if (messages.length === 0) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'empty_messages' }));
		return;
	}

	const msgCount = messages.length;
	const startTs = Date.now();
	console.log(`[term-bridge llm] model=${model} msgs=${msgCount}`);

	// Construct Ollama request
	const ollamaBody = {
		model,
		messages,
		options: body.options ?? {},
		stream: true
	};

	const abortCtrl = new AbortController();
	req.on('close', () => {
		// Client disconnected (TCP RST or normal close) → abort Ollama request
		abortCtrl.abort();
	});

	let upstream: Response;
	try {
		upstream = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(ollamaBody),
			signal: abortCtrl.signal
		});
	} catch (err) {
		const e = err as { code?: string; name?: string; message?: string };
		// Connection refused / network error
		if (e.code === 'ECONNREFUSED' || e.name === 'TypeError') {
			console.log(`[term-bridge llm] error ollama_unavailable model=${model}`);
			res.writeHead(503, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'ollama_unavailable' }));
			return;
		}
		console.log(`[term-bridge llm] error fetch_failed model=${model} msg=${e.message}`);
		res.writeHead(502, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'upstream_error' }));
		return;
	}

	// Map Ollama status codes
	if (upstream.status === 404) {
		console.log(`[term-bridge llm] error model_not_found model=${model}`);
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'model_not_found', model }));
		return;
	}
	if (upstream.status >= 500 || upstream.status < 200) {
		console.log(`[term-bridge llm] error upstream_${upstream.status} model=${model}`);
		res.writeHead(502, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'upstream_error', status: upstream.status }));
		return;
	}
	if (!upstream.ok) {
		// 4xx other than 404 — pass status through with generic body
		res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'upstream_client_error' }));
		return;
	}

	// 200 — stream NDJSON through. Counters for logging only.
	res.writeHead(200, {
		'Content-Type': 'application/x-ndjson',
		'Transfer-Encoding': 'chunked',
		'Cache-Control': 'no-cache'
	});

	let tokensOut = 0;
	const decoder = new TextDecoder();
	const reader = upstream.body?.getReader();
	if (!reader) {
		res.end();
		return;
	}

	try {
		// Pump the stream chunk-by-chunk.
		// We do NOT parse the NDJSON here — pass raw bytes through. We just
		// count token-bearing chunks for logging by counting newlines, which
		// is a rough proxy for Ollama NDJSON frame count.
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) {
				res.write(value);
				const text = decoder.decode(value, { stream: true });
				tokensOut += (text.match(/\n/g) ?? []).length;
			}
		}
		res.end();
		const duration = ((Date.now() - startTs) / 1000).toFixed(2);
		console.log(
			`[term-bridge llm] done model=${model} duration=${duration}s frames=${tokensOut}`
		);
	} catch (err) {
		// Mid-stream error or client abort — best-effort cleanup
		try { res.end(); } catch { /* ignore */ }
		const e = err as { name?: string };
		if (e.name === 'AbortError' || abortCtrl.signal.aborted) {
			console.log(`[term-bridge llm] aborted model=${model}`);
		} else {
			console.log(`[term-bridge llm] stream_error model=${model}`);
		}
	}
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	const MAX = 1024 * 1024; // 1 MiB
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		total += buf.length;
		if (total > MAX) throw new Error('body too large');
		chunks.push(buf);
	}
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw) return {};
	return JSON.parse(raw);
}
```

- [ ] **Step 2: `bridge/src/server.ts` 에 라우팅 추가**

`handleHttp` 안의 url 분기에 `/llm/chat` 추가. 기존 `/health`, `/login` 같은 위치에. 정확한 변경:

```ts
// bridge/src/server.ts — import 영역 상단에 추가
import { handleLlmChat } from './llm.js';
```

`handleHttp` 함수 안, `if (url === '/login' ...)` 블록 뒤, `res.writeHead(404).end();` 직전에:

```ts
if (url === '/llm/chat' && req.method === 'POST') {
    await handleLlmChat(req, res, SECRET);
    return;
}
```

(다른 url/method 조합은 404 — 의도적인 admin endpoint 차단.)

- [ ] **Step 3: `bridge/deploy/term-bridge.container` 에 env 추가**

기존 파일의 `[Container]` 섹션 (또는 `EnvironmentFile=` 위치 부근) 에 한 줄 추가:

```ini
Environment=OLLAMA_BASE_URL=http://localhost:11434
```

또는 사용자 env 파일에 옵션으로 두려면 `~/.config/term-bridge.env` 추가 안내 (기본값이 안전한 localhost 라 env 파일 변경 없이도 동작 — 라인은 명시적 가시성 위해 추가).

파일 상단의 install 안내 comment 에도 `OLLAMA_BASE_URL` 줄 추가:

```
#   3. Create ~/.config/term-bridge.env with the required env vars:
#        BRIDGE_PASSWORD=...
#        BRIDGE_SECRET=...
#        BRIDGE_ALLOWED_ORIGIN=https://your-app-domain
#        # OLLAMA_BASE_URL=http://localhost:11434  (optional — default shown)
```

- [ ] **Step 4: bridge 빌드 확인**

Run: `cd bridge && npm run build`
Expected: 0 TS 에러. dist/ 에 `llm.js` 생성.

- [ ] **Step 5: 커밋**

```bash
git add bridge/src/llm.ts \
        bridge/src/server.ts \
        bridge/deploy/term-bridge.container
git commit -m "bridge /llm/chat endpoint (Ollama 패스스루)"
```

---

## Task 5: sendChat 스트리밍 클라이언트

**Goal:** 노트앱 측 fetch + ReadableStream + AbortController 로 `/llm/chat` 호출, NDJSON 토큰을 콜백으로 흘려보냄.

**Files:**
- Create: `app/src/lib/llmNote/sendChat.ts`
- Test: `app/tests/unit/llmNote/sendChat.test.ts`

**Acceptance Criteria:**
- [ ] `sendChat({url, token, body, onToken, signal})` 가 NDJSON 한 줄씩 파싱, `message.content` 부분만 `onToken(content)` 호출
- [ ] `done: true` 프레임 도착 시 promise resolve (전체 응답 누적값 함께 리턴)
- [ ] HTTP 401 → throw `LlmChatError({type: 'unauthorized'})`
- [ ] HTTP 404 with `{error:'model_not_found', model}` → throw `LlmChatError({type: 'model_not_found', model})`
- [ ] HTTP 503 → throw `LlmChatError({type: 'ollama_unavailable'})`
- [ ] HTTP 5xx → throw `LlmChatError({type: 'upstream_error', status})`
- [ ] 네트워크 에러 → throw `LlmChatError({type: 'network'})`
- [ ] `signal.abort()` 호출 시 fetch 중단, 그 시점까지 누적된 응답 리턴 + reason 'abort'

**Verify:** `cd app && npm test -- llmNote/sendChat` → PASS

**Steps:**

- [ ] **Step 1: 테스트 작성 (mock fetch)**

```ts
// app/tests/unit/llmNote/sendChat.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendChat, LlmChatError } from '$lib/llmNote/sendChat.js';

function ndjsonStreamResponse(frames: object[], status = 200): Response {
	const text = frames.map((f) => JSON.stringify(f)).join('\n') + '\n';
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			// Split into per-frame chunks to test buffering
			for (const f of frames) {
				controller.enqueue(encoder.encode(JSON.stringify(f) + '\n'));
			}
			controller.close();
		}
	});
	return new Response(stream, {
		status,
		headers: { 'Content-Type': 'application/x-ndjson' }
	});
}

describe('sendChat', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('streams tokens via onToken and resolves with full content', async () => {
		const frames = [
			{ message: { role: 'assistant', content: 'Hello' }, done: false },
			{ message: { role: 'assistant', content: ', ' }, done: false },
			{ message: { role: 'assistant', content: 'world' }, done: false },
			{ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }
		];
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ndjsonStreamResponse(frames));

		const tokens: string[] = [];
		const result = await sendChat({
			url: 'https://bridge.example/llm/chat',
			token: 't',
			body: { model: 'x', messages: [{ role: 'user', content: 'hi' }], options: {} },
			onToken: (t) => tokens.push(t)
		});

		expect(tokens).toEqual(['Hello', ', ', 'world']);
		expect(result.content).toBe('Hello, world');
		expect(result.reason).toBe('done');
	});

	it('throws unauthorized on 401', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
		);
		await expect(
			sendChat({
				url: 'x',
				token: 't',
				body: { model: 'x', messages: [{ role: 'user', content: 'hi' }], options: {} },
				onToken: () => {}
			})
		).rejects.toMatchObject({ kind: 'unauthorized' });
	});

	it('throws model_not_found with model name on 404', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({ error: 'model_not_found', model: 'foo:bar' }),
				{ status: 404 }
			)
		);
		await expect(
			sendChat({
				url: 'x',
				token: 't',
				body: { model: 'foo:bar', messages: [{ role: 'user', content: 'hi' }], options: {} },
				onToken: () => {}
			})
		).rejects.toMatchObject({ kind: 'model_not_found', model: 'foo:bar' });
	});

	it('throws ollama_unavailable on 503', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ error: 'ollama_unavailable' }), { status: 503 })
		);
		await expect(
			sendChat({
				url: 'x',
				token: 't',
				body: { model: 'x', messages: [{ role: 'user', content: 'hi' }], options: {} },
				onToken: () => {}
			})
		).rejects.toMatchObject({ kind: 'ollama_unavailable' });
	});

	it('resolves with reason=abort when signal aborts mid-stream', async () => {
		// Stream that emits one chunk then waits
		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();
				controller.enqueue(
					encoder.encode(JSON.stringify({ message: { content: 'partial' }, done: false }) + '\n')
				);
				// Never close — wait for abort
			}
		});
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
		);

		const ctrl = new AbortController();
		const tokens: string[] = [];
		const p = sendChat({
			url: 'x',
			token: 't',
			body: { model: 'x', messages: [{ role: 'user', content: 'hi' }], options: {} },
			onToken: (t) => {
				tokens.push(t);
				if (tokens.length === 1) ctrl.abort();
			},
			signal: ctrl.signal
		});
		const result = await p;
		expect(result.content).toBe('partial');
		expect(result.reason).toBe('abort');
	});
});
```

- [ ] **Step 2: 빨간색 확인**

Run: `cd app && npm test -- llmNote/sendChat`
Expected: FAIL — module not found.

- [ ] **Step 3: 구현**

```ts
// app/src/lib/llmNote/sendChat.ts
import type { ChatRequestBody } from './buildChatRequest.js';

export type LlmChatErrorKind =
	| 'unauthorized'
	| 'model_not_found'
	| 'ollama_unavailable'
	| 'upstream_error'
	| 'network'
	| 'bad_request';

export class LlmChatError extends Error {
	kind: LlmChatErrorKind;
	model?: string;
	status?: number;

	constructor(
		kind: LlmChatErrorKind,
		opts: { model?: string; status?: number; message?: string } = {}
	) {
		super(opts.message ?? kind);
		this.name = 'LlmChatError';
		this.kind = kind;
		this.model = opts.model;
		this.status = opts.status;
	}
}

export interface SendChatOptions {
	url: string;
	token: string;
	body: ChatRequestBody;
	onToken: (delta: string) => void;
	signal?: AbortSignal;
}

export interface SendChatResult {
	content: string;
	reason: 'done' | 'abort' | 'stream_error';
}

interface NdjsonFrame {
	message?: { role?: string; content?: string };
	done?: boolean;
	done_reason?: string;
}

export async function sendChat(opts: SendChatOptions): Promise<SendChatResult> {
	let resp: Response;
	try {
		resp = await fetch(opts.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${opts.token}`
			},
			body: JSON.stringify(opts.body),
			signal: opts.signal
		});
	} catch (err) {
		const e = err as { name?: string };
		if (e.name === 'AbortError') {
			return { content: '', reason: 'abort' };
		}
		throw new LlmChatError('network', { message: (err as Error).message });
	}

	if (resp.status === 401) {
		throw new LlmChatError('unauthorized', { status: 401 });
	}
	if (resp.status === 404) {
		const errBody = await resp.json().catch(() => ({}));
		throw new LlmChatError('model_not_found', {
			status: 404,
			model: (errBody as { model?: string }).model
		});
	}
	if (resp.status === 503) {
		throw new LlmChatError('ollama_unavailable', { status: 503 });
	}
	if (resp.status === 400) {
		const errBody = await resp.json().catch(() => ({}));
		throw new LlmChatError('bad_request', {
			status: 400,
			message: (errBody as { error?: string }).error
		});
	}
	if (resp.status >= 500 || !resp.ok) {
		throw new LlmChatError('upstream_error', { status: resp.status });
	}

	const reader = resp.body?.getReader();
	if (!reader) {
		return { content: '', reason: 'done' };
	}

	const decoder = new TextDecoder();
	let buffer = '';
	let accumulated = '';

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!value) continue;
			buffer += decoder.decode(value, { stream: true });
			// Process complete NDJSON frames in buffer
			let nlIdx: number;
			while ((nlIdx = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, nlIdx).trim();
				buffer = buffer.slice(nlIdx + 1);
				if (line === '') continue;
				let frame: NdjsonFrame;
				try {
					frame = JSON.parse(line) as NdjsonFrame;
				} catch {
					continue; // skip malformed frame
				}
				const delta = frame.message?.content ?? '';
				if (delta) {
					accumulated += delta;
					opts.onToken(delta);
				}
				if (frame.done) {
					return { content: accumulated, reason: 'done' };
				}
			}
		}
	} catch (err) {
		const e = err as { name?: string };
		if (e.name === 'AbortError' || opts.signal?.aborted) {
			return { content: accumulated, reason: 'abort' };
		}
		return { content: accumulated, reason: 'stream_error' };
	}

	// Stream ended without a `done: true` frame — treat as done with what we have.
	return { content: accumulated, reason: 'done' };
}
```

- [ ] **Step 4: 테스트 재실행 — 초록색 확인**

Run: `cd app && npm test -- llmNote/sendChat`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/llmNote/sendChat.ts \
        app/tests/unit/llmNote/sendChat.test.ts
git commit -m "LLM 노트 NDJSON 스트리밍 클라이언트 (sendChat)"
```

---

## Task 6: LlmSendBar Svelte 컴포넌트

**Goal:** 노트 우하단 floating bar — `<TomboyEditor>` 컨테이너가 마운트하는 작은 UI. [보내기]/[중지] 토글, 토큰 카운터, editor lock, 에러 toast. parser/sendChat/bridgeSettings 와 연결.

**Files:**
- Create: `app/src/lib/editor/llmNote/LlmSendBar.svelte`

**Acceptance Criteria:**
- [ ] Props: `editor: Editor`, `bridgeUrl: string`, `bridgeToken: string`
- [ ] `parseLlmNote(editor.getJSON())` 결과를 `$derived` 로 watch — non-null 때만 자체 렌더, null 이면 빈 fragment
- [ ] Idle 상태: [보내기] 버튼 + Ctrl+Enter (에디터 keymap) 둘 다 보내기 트리거
- [ ] `trailingEmptyUserTurn === false` 거나 마지막 user content trim() === '' 이면 보내기 disable + 마우스 hover 시 tooltip "보낼 질문이 없습니다"
- [ ] 보내기 시: editor `setEditable(false)` → 본문 끝에 `A: ` 줄 ProseMirror tr 로 추가 → sendChat 호출 → onToken 마다 `A: ` 자리에 텍스트 append → 본문 끝까지 자동 스크롤
- [ ] 진행 중: 버튼이 [■ 중지] 로 토글, 옆에 `N tok` 카운터
- [ ] 중지 클릭 → AbortController.abort() → 그 시점 본문 그대로, 빈 `Q: ` 한 줄 + 빈 단락 추가 → editor `setEditable(true)`
- [ ] 완료 (`done`): 빈 단락 + 빈 `Q: ` 추가 → editor `setEditable(true)`
- [ ] 에러:
  - `unauthorized` → toast "원격 브릿지 재인증 필요 (설정 페이지)" + 노트에 `A: [오류: 인증 실패]` + editor unlock
  - `model_not_found` → 노트에 `A: [오류: 모델 '<model>' 없음. ollama pull <model> 필요]` + editor unlock
  - `ollama_unavailable` → 노트에 `A: [오류: Ollama 서비스가 응답하지 않음]` + editor unlock
  - `network` / `upstream_error` → 노트에 `A: [오류: 연결 실패. 재시도?]` + editor unlock
- [ ] Component unmount 시 진행 중 요청 abort

**Verify:** Task 9 의 manual smoke 단계 3~7 에서 검증 (UI 컴포넌트는 단위 테스트 비용 크고 spec 의 §8 도 UI 자동 테스트는 안 명시함).

**Steps:**

- [ ] **Step 1: 컴포넌트 작성**

```svelte
<!-- app/src/lib/editor/llmNote/LlmSendBar.svelte -->
<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import { onDestroy } from 'svelte';
	import { parseLlmNote } from '$lib/llmNote/parseLlmNote.js';
	import { buildChatRequest } from '$lib/llmNote/buildChatRequest.js';
	import { sendChat, LlmChatError } from '$lib/llmNote/sendChat.js';
	import { pushToast } from '$lib/stores/toast.js';

	type Props = {
		editor: Editor;
		bridgeUrl: string;
		bridgeToken: string;
	};

	let { editor, bridgeUrl, bridgeToken }: Props = $props();

	let abortController: AbortController | null = $state(null);
	let tokenCount = $state(0);
	let lastEditorVersion = $state(0);

	// Re-parse when editor doc changes. Subscribe to editor.on('update').
	let spec = $derived.by(() => {
		lastEditorVersion; // tracked
		return parseLlmNote(editor.getJSON());
	});

	const onEditorUpdate = () => {
		lastEditorVersion = (lastEditorVersion + 1) | 0;
	};
	editor.on('update', onEditorUpdate);

	const sending = $derived(abortController !== null);

	const lastUserContent = $derived.by(() => {
		if (!spec || spec.messages.length === 0) return '';
		const last = spec.messages[spec.messages.length - 1];
		if (last.role !== 'user') return '';
		return last.content;
	});

	const sendDisabled = $derived(
		sending ||
			!spec ||
			!spec.trailingEmptyUserTurn ||
			lastUserContent.trim() === ''
	);

	function appendParagraph(text: string): void {
		const { state, view } = editor;
		const endPos = state.doc.content.size;
		const para = state.schema.nodes.paragraph.create(
			null,
			text === '' ? null : state.schema.text(text)
		);
		const tr = state.tr.insert(endPos, para);
		view.dispatch(tr);
	}

	function appendToLastParagraph(text: string): void {
		const { state, view } = editor;
		const endPos = state.doc.content.size;
		// Insert text right before the closing tag of the last paragraph.
		// endPos points after the last node; -1 puts us inside it.
		const insertPos = endPos - 1;
		const tr = state.tr.insertText(text, insertPos);
		view.dispatch(tr);
		// Auto-scroll
		try {
			view.dom.scrollTop = view.dom.scrollHeight;
		} catch { /* ignore */ }
	}

	async function send(): Promise<void> {
		if (sendDisabled || !spec) return;

		const body = buildChatRequest(spec);
		const ctrl = new AbortController();
		abortController = ctrl;
		tokenCount = 0;
		editor.setEditable(false);

		// Add empty A: paragraph as placeholder
		appendParagraph('A: ');

		try {
			const result = await sendChat({
				url: `${bridgeUrl.replace(/\/$/, '')}/llm/chat`,
				token: bridgeToken,
				body,
				onToken: (delta) => {
					appendToLastParagraph(delta);
					tokenCount++;
				},
				signal: ctrl.signal
			});
			// On success/abort: add blank + new Q:
			appendParagraph('');
			appendParagraph('Q: ');
			// Move cursor to end of Q: line
			const endPos = editor.state.doc.content.size;
			editor.commands.setTextSelection(endPos - 1);
			if (result.reason === 'abort') {
				// nothing more to do — partial response already in doc
			}
		} catch (err) {
			if (err instanceof LlmChatError) {
				let line: string;
				switch (err.kind) {
					case 'unauthorized':
						line = '[오류: 인증 실패]';
						pushToast('원격 브릿지 재인증 필요 — 설정 페이지에서 로그인');
						break;
					case 'model_not_found':
						line = `[오류: 모델 '${err.model ?? '?'}' 없음. ollama pull ${err.model ?? ''} 필요]`;
						break;
					case 'ollama_unavailable':
						line = '[오류: Ollama 서비스가 응답하지 않음]';
						break;
					case 'bad_request':
						line = `[오류: 요청 형식 오류 ${err.message ?? ''}]`;
						break;
					case 'upstream_error':
					case 'network':
					default:
						line = '[오류: 연결 실패. 재시도?]';
						break;
				}
				appendToLastParagraph(line);
				appendParagraph('');
				appendParagraph('Q: ');
			}
		} finally {
			abortController = null;
			editor.setEditable(true);
		}
	}

	function stop(): void {
		abortController?.abort();
	}

	function onKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			if (spec && !sendDisabled) {
				e.preventDefault();
				void send();
			}
		}
	}

	// Listen for Ctrl+Enter on the editor DOM
	$effect(() => {
		const dom = editor.view.dom;
		dom.addEventListener('keydown', onKeyDown);
		return () => {
			dom.removeEventListener('keydown', onKeyDown);
		};
	});

	onDestroy(() => {
		editor.off('update', onEditorUpdate);
		abortController?.abort();
	});
</script>

{#if spec}
	<div class="llm-send-bar">
		{#if sending}
			<span class="tok-count">{tokenCount} tok</span>
			<button type="button" onclick={stop} class="stop">■ 중지</button>
		{:else}
			<button
				type="button"
				onclick={send}
				disabled={sendDisabled}
				title={sendDisabled && spec.trailingEmptyUserTurn === false
					? '보낼 질문이 없습니다'
					: ''}
				class="send"
			>
				보내기
			</button>
		{/if}
	</div>
{/if}

<style>
	.llm-send-bar {
		position: absolute;
		right: clamp(0.5rem, 2vw, 1.5rem);
		bottom: clamp(0.5rem, 2vw, 1.5rem);
		display: flex;
		gap: 0.5rem;
		align-items: center;
		padding: 0.4rem 0.6rem;
		background: var(--bg-elevated, #fff);
		border: 1px solid var(--border-color, #ccc);
		border-radius: 0.5rem;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
		z-index: 10;
		font-size: clamp(0.8rem, 1.6vw, 0.95rem);
	}
	button {
		padding: 0.3rem 0.8rem;
		border-radius: 0.3rem;
		border: 1px solid var(--border-color, #ccc);
		cursor: pointer;
		background: var(--bg-button, #f5f5f5);
	}
	button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	button.send {
		background: var(--accent, #3b82f6);
		color: white;
		border-color: var(--accent, #3b82f6);
	}
	button.stop {
		background: var(--danger, #dc2626);
		color: white;
		border-color: var(--danger, #dc2626);
	}
	.tok-count {
		font-variant-numeric: tabular-nums;
		opacity: 0.7;
	}
</style>
```

- [ ] **Step 2: TS 컴파일 검증**

Run: `cd app && npm run check 2>&1 | grep -i -E "(error|llmnote|sendbar)" | head -20`
Expected: 새 컴포넌트 관련 에러 없음. (기존 svelte-check 경고가 있어도 OK — 새 파일 관련만 검사.)

- [ ] **Step 3: 커밋**

```bash
git add app/src/lib/editor/llmNote/LlmSendBar.svelte
git commit -m "LlmSendBar Svelte 컴포넌트 (보내기/중지/토큰 카운터)"
```

---

## Task 7: 노트 view 통합 + 설정 라벨

**Goal:** `routes/note/[id]/+page.svelte` (모바일) 와 `lib/desktop/NoteWindow.svelte` (데스크탑) 가 `<LlmSendBar>` 를 노트 wrapper 의 footer 영역에 마운트 — `parseLlmNote(editorContent) !== null` 일 때만. 설정 페이지 라벨 1줄 변경.

**Files:**
- Modify: `app/src/routes/note/[id]/+page.svelte`
- Modify: `app/src/lib/desktop/NoteWindow.svelte`
- Modify: `app/src/routes/settings/+page.svelte`

**Acceptance Criteria:**
- [ ] 모바일 라우트 (`/note/[id]`) 에서 LLM 시그니처 노트 열면 우하단 [보내기] 보임
- [ ] 일반 노트 열면 [보내기] 안 보임
- [ ] 데스크탑 NoteWindow 에서 LLM 노트 열면 우하단 [보내기] 보임 (노트 window 안에 absolute 포지셔닝)
- [ ] 설정 페이지의 "터미널 브릿지" 섹션 헤더가 "원격 브릿지" 로 표시됨
- [ ] Bridge URL / token 입력은 그대로 동작 — terminal note 와 LLM 노트 둘 다 같은 값 사용

**Verify:** Task 9 의 manual smoke 시나리오 3~9 (mobile + desktop + 외부 네트워크 검증).

**Steps:**

- [ ] **Step 1: `app/src/routes/note/[id]/+page.svelte` 수정**

(subagent 가 이 단계에서 파일을 읽어 정확한 위치에 wire 한다. 패턴은 다음과 같다:)

```svelte
<!-- in <script lang="ts"> imports -->
import LlmSendBar from '$lib/editor/llmNote/LlmSendBar.svelte';
import { loadBridgeSettings } from '$lib/editor/terminal/bridgeSettings.js';

// in props/state area
let editorRef: TomboyEditor | undefined = $state();
const bridgeSettings = $derived(loadBridgeSettings());

<!-- in the template, after <TomboyEditor /> inside the note wrapper -->
{#if editorRef?.editor && bridgeSettings.url && bridgeSettings.token}
    <LlmSendBar
        editor={editorRef.editor}
        bridgeUrl={bridgeSettings.url}
        bridgeToken={bridgeSettings.token}
    />
{/if}
```

정확한 마운트 위치: 노트 wrapper `<div>` 안의 `<TomboyEditor>` 형제로 (TomboyEditor 의 ProseMirror DOM 외부 — float over). 노트 wrapper 가 `position: relative` 이어야 함 (LlmSendBar 가 absolute right/bottom 사용).

`editorRef` 는 `<TomboyEditor bind:this={editorRef} .../>` 형태. TomboyEditor 가 internal `editor: Editor` 인스턴스를 외부에 노출하는지 확인 후, 그대로 노출되어 있지 않으면 `export const editor = ...` 를 TomboyEditor.svelte 에 추가.

- [ ] **Step 2: `app/src/lib/desktop/NoteWindow.svelte` 동일 패턴 적용**

위와 같은 import + 같은 `{#if}` 블록. NoteWindow 의 노트 wrapper 가 `position: relative` 인지 확인 (NoteWindow 는 floating window 라 이미 relative 컨테이너일 가능성 높음).

- [ ] **Step 3: `app/src/routes/settings/+page.svelte` 라벨 변경**

"터미널 브릿지" 라는 한국어 라벨을 찾아 "원격 브릿지" 로 교체. 1줄 변경.

검색:
```bash
grep -n "터미널 브릿지" app/src/routes/settings/+page.svelte
```

이 매치된 라인의 텍스트를 "원격 브릿지" 로 교체.

- [ ] **Step 4: 빌드 + 타입 체크**

```bash
cd app && npm run check
```
Expected: 새 코드 관련 에러 0 (기존 경고는 무시 가능).

- [ ] **Step 5: dev 서버에서 시각 확인**

```bash
cd app && npm run dev
```
브라우저에서:
- `/note/<existing-note-id>` → [보내기] 안 보임 ✓
- 새 노트 만들기 → 첫 줄 `llm://qwen2.5-coder:3b` → 자동 보완 → [보내기] 우하단 보임 ✓
- 설정 페이지 → "원격 브릿지" 표시 ✓

- [ ] **Step 6: 커밋**

```bash
git add app/src/routes/note/\[id\]/+page.svelte \
        app/src/lib/desktop/NoteWindow.svelte \
        app/src/routes/settings/+page.svelte
git commit -m "LlmSendBar 마운트 (mobile + desktop) + 설정 라벨 '원격 브릿지'"
```

---

## Task 8: diary 파이프라인 동거 (ExecStartPre)

**Goal:** diary systemd unit 시작 시 Ollama 의 모델들을 명시적으로 unload — diary 의 transformers VLM 로딩과 OOM 충돌 방지.

**Files:**
- Modify: `pipeline/desktop/deploy/desktop-pipeline.service`

**Acceptance Criteria:**
- [ ] `[Service]` 섹션에 `ExecStartPre` 줄 추가 — `qwen2.5-coder:3b` 와 `qwen2.5:7b` 에 대해 `keep_alive: 0` 빈 호출
- [ ] `curl` 명령이 모델 없을 때도 silent fail (`|| true`) — diary 첫 실행 시 Ollama 에 모델 없으면 정상 진행

**Verify:** `systemctl --user cat tomboy-diary-pipeline.service` 로 unit 파일 출력 확인. 다음 diary 트리거 시 journalctl 에 evict 로그 보임.

**Steps:**

- [ ] **Step 1: unit 파일 수정**

기존 `pipeline/desktop/deploy/desktop-pipeline.service` 의 `[Service]` 섹션에 다음 줄 추가 (`ExecStart` 직전):

```ini
ExecStartPre=/bin/bash -c 'for m in qwen2.5-coder:3b qwen2.5:7b; do curl -sf -X POST http://localhost:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null || true; done'
```

(불필요한 줄바꿈 없이 한 줄 — systemd ExecStartPre 는 한 줄 명령이 안전.)

- [ ] **Step 2: 변경 검증**

```bash
grep -A1 "ExecStartPre" pipeline/desktop/deploy/desktop-pipeline.service
```
Expected: 추가된 줄 출력.

- [ ] **Step 3: 커밋**

```bash
git add pipeline/desktop/deploy/desktop-pipeline.service
git commit -m "diary pipeline: Ollama 모델 evict (ExecStartPre)"
```

(unit 재로드는 Task 9 의 운영 단계에서 사용자가 직접 수행.)

---

## Task 9: 운영 배포 + 수동 smoke 검증

**Goal:** PC 측 Ollama 설치 + 모델 pull + systemd 설정 → bridge 재배포 + diary unit 재로드 → spec §8 의 13-step smoke 체크리스트 실행 → 모두 통과.

**Files:** (코드 변경 없음 — 운영 단계)

**Acceptance Criteria:**
- [ ] Ollama 가 `127.0.0.1:11434` 에서 listening + `qwen2.5-coder:3b`, `qwen2.5:7b` pull 완료
- [ ] bridge container 재빌드 + 재배포 — `OLLAMA_BASE_URL` env 인식
- [ ] `curl https://<bridge-domain>/llm/chat -H 'Authorization: Bearer <token>' -d '{...}'` 가 NDJSON 응답 (manual)
- [ ] diary unit 재로드 후 ExecStartPre 가 journal 에 보임
- [ ] PWA 에서 LLM 노트 13-step smoke 시나리오 모두 통과

**Verify:** spec §8 의 수동 smoke 시나리오 13 단계.

**Steps:**

- [ ] **Step 1: Ollama 설치** (rootless container, Bazzite)

```bash
mkdir -p ~/.config/containers/systemd
mkdir -p ~/.local/share/ollama-models

cat > ~/.config/containers/systemd/ollama.container <<'EOF'
[Unit]
Description=Ollama (local LLM runtime)
After=network-online.target
Wants=network-online.target

[Container]
Image=docker.io/ollama/ollama:latest
ContainerName=ollama
PublishPort=127.0.0.1:11434:11434
Volume=%h/.local/share/ollama-models:/root/.ollama:z
AddDevice=nvidia.com/gpu=all
Environment=OLLAMA_HOST=0.0.0.0:11434
Environment=OLLAMA_KEEP_ALIVE=5m
Environment=OLLAMA_MAX_LOADED_MODELS=2
Environment=OLLAMA_NUM_PARALLEL=1

[Service]
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
# Quadlet 가 자동으로 .container → .service 생성. 생성된 unit 은
# transient 라 `enable` 불가 — start 만. 부팅 자동 시작은 .container
# 의 [Install] WantedBy=default.target 가 generator 를 통해 처리.

# 이미지 미리 pull (systemd 기본 start timeout 90s 안에 ollama:latest ~2GB
# pull 못 끝나서 restart 루프에 빠지는 것 방지).
podman pull docker.io/ollama/ollama:latest

systemctl --user start ollama.service
loginctl enable-linger $USER

# GPU passthrough 확인. CDI spec 이 없으면 컨테이너 시작 실패.
# ls /etc/cdi/  →  nvidia.yaml 보여야 함. 없으면:
#   sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
```

확인:
```bash
curl -s http://127.0.0.1:11434/api/version
```
Expected: `{"version":"..."}`

(GPU passthrough 가 안 되면 CDI 설정 필요 — `nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml` 를 root 권한으로 한 번. Bazzite 에선 `rpm-ostree install nvidia-container-toolkit` 또는 image 에 이미 포함. 환경에 맞춰 조정.)

- [ ] **Step 2: 모델 pull**

```bash
podman exec ollama ollama pull qwen2.5-coder:3b
podman exec ollama ollama pull qwen2.5:7b
podman exec ollama ollama list
```
Expected: 두 모델 목록에 보임.

- [ ] **Step 3: bridge 컨테이너 재빌드 + 재배포**

```bash
cd ~/workspace/tomboy-web/bridge
podman build -t term-bridge:latest .
systemctl --user restart term-bridge.service
journalctl --user -u term-bridge.service -n 20 --no-pager
```
Expected: `[term-bridge] listening on :3000` 로그.

- [ ] **Step 4: bridge `/llm/chat` curl smoke**

(bridge 토큰을 가지고 — 기존 PWA 의 설정에서 발급된 token 재사용)

```bash
BRIDGE_URL=https://your-bridge-domain
TOKEN=<your_token>

curl -s -N "$BRIDGE_URL/llm/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5-coder:3b",
    "messages": [{"role":"user","content":"say hi"}],
    "options": {"temperature":0.3,"num_ctx":2048}
  }' | head -20
```
Expected: NDJSON 프레임이 한 줄씩 흘러나옴. 마지막 `{"done":true,...}` 프레임.

추가 검증:
```bash
# 잘못된 토큰 → 401
curl -s -o /dev/null -w "%{http_code}" "$BRIDGE_URL/llm/chat" \
  -H "Authorization: Bearer bad" \
  -H "Content-Type: application/json" \
  -d '{"model":"x","messages":[{"role":"user","content":"hi"}]}'
# 출력: 401

# 모델 없음 → 404
curl -s -o /dev/null -w "%{http_code}" "$BRIDGE_URL/llm/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"nonexistent:tag","messages":[{"role":"user","content":"hi"}]}'
# 출력: 404

# admin endpoint 차단 → 404
curl -s -o /dev/null -w "%{http_code}" "$BRIDGE_URL/api/tags" \
  -H "Authorization: Bearer $TOKEN"
# 출력: 404
```

- [ ] **Step 5: diary unit 재로드**

```bash
systemctl --user daemon-reload
```
(unit 파일 자체는 commit 으로 변경됨 — `daemon-reload` 만으로 새 ExecStartPre 인식.)

확인:
```bash
systemctl --user cat tomboy-diary-pipeline.service | grep ExecStartPre
```
Expected: 새 줄 출력.

- [ ] **Step 6: spec §8 의 13-step PWA smoke 체크리스트**

각 항목을 PWA 에서 실행 후 result 박스에 ✅ 또는 ❌ 기록:

```
[ ]  3. 새 노트 → llm://qwen2.5-coder:3b → 자동 보완 (빈 제목 단락 + 헤더 + 빈 Q:)
[ ]  4. 제목 입력 + system 입력 + Q 작성 + Ctrl+Enter
[ ]  5. 토큰 단위 스트리밍 + 자동 스크롤
[ ]  6. follow-up Q 가 이전 context 반영
[ ]  7. [중지] → 부분 응답 + 빈 Q:
[ ]  8. 노트 닫고 다시 열기 → 본문/헤더 그대로, 자동 보완 재발생 안 함
[ ]  9. 두 번째 LLM 노트 (qwen2.5:7b) → 두 노트 동시 사용
[ ] 10. 모바일 외부 네트워크 → 같은 단계 1~6 반복
[ ] 11. Tomboy desktop ref 에서 LLM 노트 열기 → 평문 텍스트, 크래시 X
[ ] 12. diary 트리거 (테스트 페이지) → 동시 LLM 보내기 → 503 토스트 (또는 evict 후 정상)
[ ] 13. 토큰 만료 (BRIDGE_SECRET 회전) → 401 → "원격 브릿지 재인증" 토스트
```

13 항목 모두 ✅ 면 spec 의 acceptance 통과.

- [ ] **Step 7: 운영 단계 완료 마크 — 코드 커밋은 없음**

(Task 8 까지 코드는 이미 main 에 들어가 있음. Task 9 는 manual ops + smoke. 별도 commit 없음.)

이 단계까지 마치면 spec 의 모든 acceptance criteria 충족.

---

## Spec Coverage 검토

본 plan 의 각 task 가 spec 의 어느 섹션을 cover 하는지:

| Spec 섹션 | Task |
|---|---|
| §1 노트 grammar / 파서 | Task 1 |
| §2 자동 헤더 보완 | Task 3 |
| §3 클라이언트 편집 UX | Task 6 + Task 7 |
| §4 bridge `/llm/chat` | Task 4 |
| §5 클라이언트 모듈 구조 | Task 1, 2, 3, 5, 6, 7 (전체) |
| §6 Ollama 운영 / diary 동거 | Task 8 + Task 9 |
| §7 Invariant | 모든 task 에 분산 (각 task 의 acceptance) |
| §8 테스트 / 검증 | 자동: Task 1, 2, 3, 5. 수동: Task 9 |
| §9 비-목표 | (의도적 미구현 — plan 에서도 추가 task 없음) |

---

## Notes for the executing engineer

- **TipTap import path**: `@tiptap/core` 의 `Editor`, `@tiptap/pm/state` 의 `Plugin/PluginKey`, `@tiptap/pm/model` 의 `Node`, `Schema`. 기존 패턴은 autoWeekday plugin 참조.
- **Test runner**: vitest. `cd app && npm test -- <pattern>` 로 부분 실행 가능. test 파일 패턴은 `app/tests/unit/**/*.test.ts`.
- **bridge dev**: `cd bridge && npm run dev` — TS watch + node --watch. dev 환경에선 컨테이너 안 띄우고 host 에서 직접 실행 가능 (단 env vars 수동 set).
- **Svelte 5 runes**: `$state`, `$derived`, `$derived.by`, `$props`, `$effect`. 컴포넌트 props 는 `let { ... }: Props = $props()`.
- **toast.ts**: `pushToast(message)` 가 기존 store 메소드. import: `from '$lib/stores/toast.js'`.
- **bridgeSettings**: `loadBridgeSettings()` 가 `{ url, token }` 또는 빈 객체 리턴. import: `from '$lib/editor/terminal/bridgeSettings.js'`.
- **노트 desktop 호환 검증**: Task 9 의 step 11 — ref/ 디렉토리의 Tomboy desktop 빌드 또는 별도 머신의 Tomboy 4.x 에서 같은 노트를 열어 본다. `.note` XML 이 자유 텍스트만 포함하므로 정상 동작 예상.
- **CORS**: bridge `applyCors` 가 `BRIDGE_ALLOWED_ORIGIN` env 기반. 새 endpoint 도 자동 적용. PWA 도메인이 그 origin 에 등록되어 있다면 추가 설정 없음.
- **Caddy**: 기존 reverse_proxy 가 모든 path 를 bridge 로 보낸다고 가정 (terminal note 가 이미 그렇게 동작 중). `/llm/*` 도 자동.
