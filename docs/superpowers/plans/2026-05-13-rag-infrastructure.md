# RAG 인프라 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM 노트 헤더에 `rag: <K>` 가 있을 때 마지막 Q 텍스트를 bge-m3 로 임베딩하고, 데스크탑 sqlite-vec 인덱스에서 top-K 노트를 가져와 system prompt 에 본문 prepend, 응답 뒤에 `참고: [[제목]] …` 을 internal-link 마크로 자동 부착.

**Architecture:** 두 채널 인덱서 ([A] zip bootstrap startup-only, [B] Firestore polling 30 s) 가 desktop sqlite-vec 를 채움 → 같은 desktop 의 FastAPI 가 `/search` 노출 → Pi bridge 가 `/rag/search` 로 proxy → 브라우저 `LlmSendBar` 가 rag 헤더 감지 시 검색을 먼저 호출하고 system 에 prepend 한 뒤 기존 `/llm/chat` 흐름 진행. 응답 뒤 `[[제목]]` 자동 부착.

**Tech Stack:** Svelte 5 runes (Vitest), TypeScript, Node http (bridge), Python 3 + asyncio + httpx + FastAPI + sqlite-vec + firebase-admin (desktop), Ollama bge-m3.

**Spec:** `docs/superpowers/specs/2026-05-13-rag-infrastructure-design.md`

---

## Task 1: `rag` 헤더 키 — defaults + parser

**Goal:** `defaults.ts` 가 `rag` 키를 인식하고, `parseLlmNote` 가 `LlmNoteSpec.options.rag: number | undefined` 를 채운다 (off / 생략 = undefined, on = 5, 정수 → clamp(1,20)).

**Files:**
- Modify: `app/src/lib/llmNote/defaults.ts` (rag 추가)
- Modify: `app/src/lib/llmNote/parseLlmNote.ts` (rag 파싱)
- Modify: `app/tests/unit/llmNote/parseLlmNote.test.ts` (rag 케이스 추가)

**Acceptance Criteria:**
- [ ] `LLM_RECOGNIZED_HEADER_KEYS` 에 `'rag'` 포함
- [ ] `LLM_HEADER_KEY_RE` 정규식이 `rag:` 도 매치
- [ ] `LlmNoteSpec.options.rag?: number` 필드 존재
- [ ] `rag: on` → 5, `rag: 7` → 7, `rag: 30` → 20 (clamp), `rag: 0` → 1 (clamp), `rag: off` → undefined, `rag: foo` → undefined
- [ ] `rag` 키가 없으면 `options.rag === undefined`
- [ ] 기존 17 개 `parseLlmNote` 테스트 모두 통과

**Verify:** `cd app && npm test -- llmNote/parseLlmNote`

**Steps:**

- [ ] **Step 1: Add 4 failing tests in `app/tests/unit/llmNote/parseLlmNote.test.ts`**

Append at end of the existing test file (inside its outer `describe`):

```ts
	describe('rag header key', () => {
		test('rag: on → 5', () => {
			const doc = makeDoc(['t', 'llm://m', 'rag: on', '', 'Q: hi']);
			expect(parseLlmNote(doc)?.options.rag).toBe(5);
		});
		test('rag: 7 → 7', () => {
			const doc = makeDoc(['t', 'llm://m', 'rag: 7', '', 'Q: hi']);
			expect(parseLlmNote(doc)?.options.rag).toBe(7);
		});
		test('rag: 30 → clamps to 20', () => {
			const doc = makeDoc(['t', 'llm://m', 'rag: 30', '', 'Q: hi']);
			expect(parseLlmNote(doc)?.options.rag).toBe(20);
		});
		test('rag: 0 → clamps to 1', () => {
			const doc = makeDoc(['t', 'llm://m', 'rag: 0', '', 'Q: hi']);
			expect(parseLlmNote(doc)?.options.rag).toBe(1);
		});
		test('rag: off → undefined', () => {
			const doc = makeDoc(['t', 'llm://m', 'rag: off', '', 'Q: hi']);
			expect(parseLlmNote(doc)?.options.rag).toBeUndefined();
		});
		test('rag: foo → undefined', () => {
			const doc = makeDoc(['t', 'llm://m', 'rag: foo', '', 'Q: hi']);
			expect(parseLlmNote(doc)?.options.rag).toBeUndefined();
		});
		test('rag absent → undefined', () => {
			const doc = makeDoc(['t', 'llm://m', 'system: x', '', 'Q: hi']);
			expect(parseLlmNote(doc)?.options.rag).toBeUndefined();
		});
	});
```

Note: `makeDoc` is the existing helper at the top of the test file — reuse it. If it accepts `string[]` per-paragraph, the strings above are one paragraph each. If your existing tests already use a different helper signature, adapt these calls accordingly.

- [ ] **Step 2: Run tests, expect FAIL**

```bash
cd app && npm test -- llmNote/parseLlmNote
```

Expected: 7 new `rag header key` tests fail (key not recognized, `options.rag` is `undefined` for all). Existing 17 tests still pass.

- [ ] **Step 3: Add `rag` to defaults**

Edit `app/src/lib/llmNote/defaults.ts`:

```ts
export const LLM_SIGNATURE_RE = /^llm:\/\/([A-Za-z0-9._:/-]+)\s*$/;

export const LLM_HEADER_KEY_RE =
	/^(system|temperature|num_ctx|top_p|seed|num_predict|rag):\s*(.*)$/;

export const LLM_RECOGNIZED_HEADER_KEYS = [
	'system',
	'temperature',
	'num_ctx',
	'top_p',
	'seed',
	'num_predict',
	'rag'
] as const;

export type LlmHeaderKey = (typeof LLM_RECOGNIZED_HEADER_KEYS)[number];

export const LLM_HEADER_DEFAULTS = {
	system: '',
	temperature: 0.3,
	num_ctx: 4096
} as const;
```

- [ ] **Step 4: Extend `parseLlmNote` to read `rag` key**

Edit `app/src/lib/llmNote/parseLlmNote.ts`. Update the `LlmNoteSpec.options` interface to include `rag?: number`:

```ts
export interface LlmNoteSpec {
	model: string;
	system?: string;
	options: {
		temperature?: number;
		num_ctx?: number;
		top_p?: number;
		seed?: number;
		num_predict?: number;
		rag?: number;
	};
	messages: Array<{ role: 'user' | 'assistant'; content: string }>;
	trailingEmptyUserTurn: boolean;
}
```

In the `flushKey` function, the `rag` key needs custom parsing (not a plain integer). Replace `flushKey` with:

```ts
const flushKey = (): void => {
	if (currentKey === null) return;
	const value = currentValueLines.join('\n');
	if (currentKey === 'system') {
		result.system = value;
	} else if (currentKey === 'rag') {
		const trimmed = value.trim().toLowerCase();
		if (trimmed === 'on') {
			result.options.rag = 5;
		} else if (trimmed === 'off' || trimmed === '') {
			// undefined — leave unset
		} else {
			const n = parseInt(trimmed, 10);
			if (Number.isFinite(n)) {
				result.options.rag = Math.min(Math.max(n, 1), 20);
			}
		}
	} else {
		const trimmed = value.trim();
		const n = INT_KEYS.has(currentKey) ? parseInt(trimmed, 10) : parseFloat(trimmed);
		if (Number.isFinite(n)) {
			(result.options as Record<string, number>)[currentKey] = n;
		}
	}
	currentKey = null;
	currentValueLines = [];
};
```

- [ ] **Step 5: Run tests, expect PASS**

```bash
cd app && npm test -- llmNote/parseLlmNote
```

Expected: 24 tests (17 existing + 7 new) all pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/llmNote/defaults.ts app/src/lib/llmNote/parseLlmNote.ts app/tests/unit/llmNote/parseLlmNote.test.ts
git commit -m "feat(llmNote): rag 헤더 키 — parseLlmNote + defaults"
```

```json:metadata
{"files":["app/src/lib/llmNote/defaults.ts","app/src/lib/llmNote/parseLlmNote.ts","app/tests/unit/llmNote/parseLlmNote.test.ts"],"verifyCommand":"cd app && npm test -- llmNote/parseLlmNote","acceptanceCriteria":["rag in LLM_RECOGNIZED_HEADER_KEYS","LLM_HEADER_KEY_RE matches rag","options.rag?: number field","rag values parsed correctly (on/off/int/clamp)","existing 17 tests pass"]}
```

---

## Task 2: `llmNotePlugin` 헤더 정규식 갱신

**Goal:** 자동 보완 플러그인의 헤더 키 검출 정규식이 `rag` 도 헤더로 인식하도록 갱신. 자동 보완 자체는 `rag` 를 **삽입하지 않는다** (default OFF 유지) — 사용자가 직접 추가한 `rag:` 줄이 헤더 영역으로 인식되기만 하면 됨.

**Files:**
- Modify: `app/src/lib/editor/llmNote/llmNotePlugin.ts` (정규식만)
- Modify: `app/tests/unit/editor/llmNotePlugin.test.ts` (rag 인식 테스트 1개 추가)

**Acceptance Criteria:**
- [ ] `LLM_RECOGNIZED_HEADER_KEYS` 가 확장되었으므로 `HEADER_KEY_LINE_RE` 가 자동으로 rag 포함 (변경 필요 없음 — 코드 검증만)
- [ ] 사용자가 `rag: 5` 를 헤더 영역에 추가한 후 mount-rescan 트리거를 발사해도 추가 보완이 일어나지 않음 (헤더 0개 조건 위반 — `rag` 가 1개로 카운트)
- [ ] 기존 자동 보완 테스트 모두 통과

**Verify:** `cd app && npm test -- editor/llmNotePlugin`

**Steps:**

- [ ] **Step 1: Read the current plugin and confirm regex uses `LLM_RECOGNIZED_HEADER_KEYS`**

`app/src/lib/editor/llmNote/llmNotePlugin.ts:33-35`:

```ts
const HEADER_KEY_LINE_RE = new RegExp(
	`^(${LLM_RECOGNIZED_HEADER_KEYS.join('|')}):`
);
```

This builds the regex from the constant — Task 1 already added `'rag'` so the regex automatically includes it. No edit needed in this file.

- [ ] **Step 2: Add a test that confirms `rag` blocks the headers==0 rescan**

In `app/tests/unit/editor/llmNotePlugin.test.ts`, append (inside the outer describe):

```ts
	test('rag-only header counts: rescan does not add more', () => {
		const { editor } = makeEditorWithDoc([
			{ type: 'paragraph', content: [{ type: 'text', text: 'title' }] },
			{ type: 'paragraph', content: [{ type: 'text', text: 'llm://m' }] },
			{ type: 'paragraph', content: [{ type: 'text', text: 'rag: 5' }] },
			{ type: 'paragraph' }, // blank
			{ type: 'paragraph', content: [{ type: 'text', text: 'Q: hi' }] }
		]);
		const before = editor.getJSON();
		editor.view.dispatch(
			editor.state.tr.setMeta(llmNotePluginKey, { rescan: true })
		);
		expect(editor.getJSON()).toEqual(before);
		editor.destroy();
	});
```

Note: `makeEditorWithDoc` is the test helper that the existing plugin tests use. If the existing tests use a different helper name, follow that — the goal is to mount an editor with the doc, dispatch a rescan meta, and confirm the doc didn't change.

- [ ] **Step 3: Run tests, expect PASS**

```bash
cd app && npm test -- editor/llmNotePlugin
```

The new test should pass immediately because Task 1 already made `rag` a recognized header key (and `countRecognizedHeaderKeys` finds 1 → no autocompletion).

If any **existing** test fails after Task 1's regex change, it would be because that test relied on `rag` NOT being a header key — review and update accordingly. Most likely none of the existing tests use `rag`.

- [ ] **Step 4: Commit**

```bash
git add app/tests/unit/editor/llmNotePlugin.test.ts
git commit -m "test(llmNote): rag 헤더가 자동 보완 카운트에 포함됨 검증"
```

```json:metadata
{"files":["app/src/lib/editor/llmNote/llmNotePlugin.ts","app/tests/unit/editor/llmNotePlugin.test.ts"],"verifyCommand":"cd app && npm test -- editor/llmNotePlugin","acceptanceCriteria":["rag 가 헤더 키로 인식","rag-only 헤더가 보완을 막음","기존 테스트 모두 통과"]}
```

---

## Task 3: `searchRag.ts` — bridge `/rag/search` 클라이언트

**Goal:** `LlmSendBar` 가 호출할 RAG 검색 클라이언트. NDJSON 아닌 단발 JSON 응답이라 `sendChat` 보다 단순. 에러는 `RagSearchError` 로 분류.

**Files:**
- Create: `app/src/lib/llmNote/searchRag.ts`
- Create: `app/tests/unit/llmNote/searchRag.test.ts`

**Acceptance Criteria:**
- [ ] `searchRag()` 함수가 정상 응답 시 `RagHit[]` 반환
- [ ] 401 → `RagSearchError({ kind: 'unauthorized' })`
- [ ] 503 (rag_unavailable) → `RagSearchError({ kind: 'rag_unavailable' })`
- [ ] 400 → `RagSearchError({ kind: 'bad_request' })`
- [ ] 502 + 기타 5xx → `RagSearchError({ kind: 'upstream_error' })`
- [ ] fetch 실패 → `RagSearchError({ kind: 'network' })`
- [ ] AbortSignal abort → `RagSearchError({ kind: 'network', message: 'aborted' })` 또는 `AbortError` 전파 (선택 — `LlmSendBar` 가 try/catch 로 toast 만 띄움)

**Verify:** `cd app && npm test -- llmNote/searchRag`

**Steps:**

- [ ] **Step 1: Write failing tests in `app/tests/unit/llmNote/searchRag.test.ts`**

```ts
import { describe, test, expect, vi } from 'vitest';
import { searchRag, RagSearchError } from '$lib/llmNote/searchRag.js';

function mockFetch(status: number, body: unknown): typeof globalThis.fetch {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body)
	}) as unknown as typeof globalThis.fetch;
}

describe('searchRag', () => {
	test('200 → returns hits', async () => {
		const hits = [
			{ guid: 'g1', title: 't1', body: 'b1', score: 0.9 },
			{ guid: 'g2', title: 't2', body: 'b2', score: 0.8 }
		];
		globalThis.fetch = mockFetch(200, hits);
		const result = await searchRag({
			url: 'http://x/rag/search',
			token: 'tok',
			query: 'q',
			k: 5
		});
		expect(result).toEqual(hits);
	});

	test('401 → RagSearchError unauthorized', async () => {
		globalThis.fetch = mockFetch(401, { error: 'unauthorized' });
		await expect(
			searchRag({ url: 'http://x/rag/search', token: '', query: 'q', k: 5 })
		).rejects.toMatchObject({ kind: 'unauthorized' });
	});

	test('503 → RagSearchError rag_unavailable', async () => {
		globalThis.fetch = mockFetch(503, { error: 'rag_unavailable' });
		await expect(
			searchRag({ url: 'http://x/rag/search', token: 't', query: 'q', k: 5 })
		).rejects.toMatchObject({ kind: 'rag_unavailable' });
	});

	test('400 → RagSearchError bad_request', async () => {
		globalThis.fetch = mockFetch(400, { error: 'bad_query' });
		await expect(
			searchRag({ url: 'http://x/rag/search', token: 't', query: '', k: 5 })
		).rejects.toMatchObject({ kind: 'bad_request' });
	});

	test('500 → RagSearchError upstream_error', async () => {
		globalThis.fetch = mockFetch(500, {});
		await expect(
			searchRag({ url: 'http://x/rag/search', token: 't', query: 'q', k: 5 })
		).rejects.toMatchObject({ kind: 'upstream_error' });
	});

	test('network fail → RagSearchError network', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		await expect(
			searchRag({ url: 'http://x/rag/search', token: 't', query: 'q', k: 5 })
		).rejects.toMatchObject({ kind: 'network' });
	});

	test('posts JSON body with bearer', async () => {
		const spy = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve([])
		});
		globalThis.fetch = spy as unknown as typeof globalThis.fetch;
		await searchRag({
			url: 'http://x/rag/search',
			token: 'tok',
			query: 'hello',
			k: 3
		});
		expect(spy).toHaveBeenCalledWith(
			'http://x/rag/search',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: 'Bearer tok',
					'Content-Type': 'application/json'
				}),
				body: JSON.stringify({ query: 'hello', k: 3 })
			})
		);
	});
});
```

- [ ] **Step 2: Run tests, expect FAIL**

```bash
cd app && npm test -- llmNote/searchRag
```

Expected: all fail with "Cannot find module '$lib/llmNote/searchRag.js'".

- [ ] **Step 3: Implement `app/src/lib/llmNote/searchRag.ts`**

```ts
export interface RagHit {
	guid: string;
	title: string;
	body: string;
	score: number;
}

export type RagSearchErrorKind =
	| 'unauthorized'
	| 'rag_unavailable'
	| 'bad_request'
	| 'upstream_error'
	| 'network';

export class RagSearchError extends Error {
	kind: RagSearchErrorKind;
	status?: number;

	constructor(kind: RagSearchErrorKind, opts: { status?: number; message?: string } = {}) {
		super(opts.message ?? kind);
		this.name = 'RagSearchError';
		this.kind = kind;
		this.status = opts.status;
	}
}

export interface SearchRagOptions {
	url: string;
	token: string;
	query: string;
	k: number;
	signal?: AbortSignal;
}

export async function searchRag(opts: SearchRagOptions): Promise<RagHit[]> {
	let resp: Response;
	try {
		resp = await fetch(opts.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${opts.token}`
			},
			body: JSON.stringify({ query: opts.query, k: opts.k }),
			signal: opts.signal
		});
	} catch (err) {
		const e = err as { name?: string; message?: string };
		throw new RagSearchError('network', { message: e.message ?? 'fetch failed' });
	}

	if (resp.status === 401) throw new RagSearchError('unauthorized', { status: 401 });
	if (resp.status === 400) throw new RagSearchError('bad_request', { status: 400 });
	if (resp.status === 503) throw new RagSearchError('rag_unavailable', { status: 503 });
	if (resp.status >= 500 || !resp.ok)
		throw new RagSearchError('upstream_error', { status: resp.status });

	try {
		const data = (await resp.json()) as RagHit[];
		return Array.isArray(data) ? data : [];
	} catch (err) {
		throw new RagSearchError('upstream_error', {
			status: resp.status,
			message: 'bad json'
		});
	}
}
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd app && npm test -- llmNote/searchRag
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/llmNote/searchRag.ts app/tests/unit/llmNote/searchRag.test.ts
git commit -m "feat(llmNote): searchRag — bridge /rag/search 클라이언트"
```

```json:metadata
{"files":["app/src/lib/llmNote/searchRag.ts","app/tests/unit/llmNote/searchRag.test.ts"],"verifyCommand":"cd app && npm test -- llmNote/searchRag","acceptanceCriteria":["RagHit/RagSearchError export","에러 분류 (unauthorized/rag_unavailable/bad_request/upstream_error/network)","Bearer auth + JSON body","200 → hits"]}
```

---

## Task 4: `LlmSendBar` rag 분기

**Goal:** `spec.options.rag` 가 정수 > 0 이면 보내기 직전 `/rag/search` 호출 → system prompt 에 본문 prepend → 기존 `/llm/chat` → 응답 끝나면 `참고: [[제목]] …` 단락 부착. 검색 실패는 toast 만 띄우고 RAG 없이 진행.

**Files:**
- Modify: `app/src/lib/editor/llmNote/LlmSendBar.svelte`
- (No new test file — rag branch is tested via existing component test if any, plus manual smoke. The rag logic is largely transparent — sendChat and searchRag have their own unit tests.)

**Acceptance Criteria:**
- [ ] `spec.options.rag === undefined` 또는 0 → 기존 흐름 그대로 (검색 호출 없음, `참고:` 부착 없음)
- [ ] `spec.options.rag > 0` → `searchRag` 호출, 결과 본문을 `system` 앞에 prepend (system 없으면 새 system message 삽입)
- [ ] 검색 결과 0 개 → system 그대로, `참고:` 부착 없음
- [ ] 검색 실패 → toast `RAG 검색 실패 — 참고 노트 없이 응답`, RAG 없이 정상 chat 진행
- [ ] 응답 끝나고 `result.reason === 'done'` 이고 검색 결과 > 0 개 → `참고: [[t1]] [[t2]] …` 단락 부착
- [ ] AbortController 신호가 search 호출에도 전달됨

**Verify:** `cd app && npm run check` (type check) + manual smoke per Task 15

**Steps:**

- [ ] **Step 1: Edit `app/src/lib/editor/llmNote/LlmSendBar.svelte` — script section**

Replace the imports + `send()` function. Keep all other code (`onEditorUpdate`, `appendParagraph`, `appendToLastParagraph`, `stop`, `onKeyDown`, `$effect` blocks, `onDestroy`) unchanged.

Add import:
```ts
	import { searchRag, RagSearchError, type RagHit } from '$lib/llmNote/searchRag.js';
```

Replace the `send()` function with:

```ts
	async function send(): Promise<void> {
		if (sendDisabled || !spec) return;

		const body = buildChatRequest(spec);
		const ctrl = new AbortController();
		abortController = ctrl;
		tokenCount = 0;
		editor.setEditable(false);

		// Add empty A: paragraph as placeholder
		appendParagraph('A: ');

		const httpBase = bridgeUrl
			.replace(/^wss:\/\//, 'https://')
			.replace(/^ws:\/\//, 'http://')
			.replace(/\/(ws|llm\/chat)\/?$/, '')
			.replace(/\/$/, '');

		// RAG retrieval (opt-in via rag header)
		let retrievedNotes: RagHit[] = [];
		if (spec.options.rag && spec.options.rag > 0) {
			try {
				retrievedNotes = await searchRag({
					url: `${httpBase}/rag/search`,
					token: bridgeToken,
					query: lastUserContent,
					k: spec.options.rag,
					signal: ctrl.signal
				});
			} catch (err) {
				const e = err as RagSearchError;
				pushToast(`RAG 검색 실패 — 참고 노트 없이 응답 (${e.kind ?? 'unknown'})`);
			}
		}

		// Prepend retrieved bodies to system message (invisible to user)
		if (retrievedNotes.length > 0) {
			const ragPrefix =
				'참고 노트:\n' +
				retrievedNotes.map((n) => `## ${n.title}\n${n.body}`).join('\n\n---\n\n') +
				'\n\n---\n\n';
			if (body.messages.length > 0 && body.messages[0].role === 'system') {
				body.messages[0].content = ragPrefix + body.messages[0].content;
			} else {
				body.messages.unshift({ role: 'system', content: ragPrefix });
			}
		}

		try {
			const result = await sendChat({
				url: `${httpBase}/llm/chat`,
				token: bridgeToken,
				body,
				onToken: (delta) => {
					appendToLastParagraph(delta);
					tokenCount++;
				},
				signal: ctrl.signal
			});
			// Append 참고: [[title]] line on successful completion (not on abort)
			if (retrievedNotes.length > 0 && result.reason === 'done') {
				const titles = retrievedNotes.map((n) => `[[${n.title}]]`).join(' ');
				appendParagraph(`참고: ${titles}`);
			}
			appendParagraph('');
			appendParagraph('Q: ');
			const endPos = editor.state.doc.content.size;
			editor.commands.setTextSelection(endPos - 1);
			void result;
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
```

- [ ] **Step 2: Type check**

```bash
cd app && npm run check
```

Expected: 0 errors. (If `pushToast`, `lastUserContent`, `appendParagraph` types break, those are pre-existing — fix only what's directly related to the new code.)

- [ ] **Step 3: Run all unit tests (regression check)**

```bash
cd app && npm test
```

Expected: existing tests pass (the Svelte component itself has no unit tests; the rag branch is gated by `spec.options.rag` which is `undefined` for all existing test fixtures).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/editor/llmNote/LlmSendBar.svelte
git commit -m "feat(llmNote): LlmSendBar 에 rag 분기 — 검색 + system prepend + [[title]] 부착"
```

```json:metadata
{"files":["app/src/lib/editor/llmNote/LlmSendBar.svelte"],"verifyCommand":"cd app && npm run check && npm test","acceptanceCriteria":["rag undefined → 기존 흐름","rag > 0 → searchRag 호출 + system prepend","검색 실패 → toast + RAG 없이 진행","done 시 참고: [[title]] 부착","AbortSignal 전달"]}
```

---

## Task 5: bridge `/rag/search` 엔드포인트

**Goal:** Pi 의 bridge 가 `/rag/search` POST 를 받아 Bearer 검증 후 desktop FastAPI 로 proxy. 단발 JSON 패스스루 (NDJSON 아님).

**Files:**
- Create: `bridge/src/rag.ts`
- Modify: `bridge/src/server.ts` (route 추가)
- Modify: `bridge/deploy/term-bridge.container` (RAG_SEARCH_URL 주석 추가)

**Acceptance Criteria:**
- [ ] `POST /rag/search` 가 Bearer 없으면 401, 잘못된 body 면 400
- [ ] Desktop service 호출 실패 (ECONNREFUSED 등) → 503 `{error: 'rag_unavailable'}`
- [ ] Desktop 응답 5xx → 502 `{error: 'upstream_error'}`
- [ ] Desktop 정상 → 200 + JSON body 패스스루
- [ ] `k` 가 1-20 범위 밖이면 clamp
- [ ] client 가 끊으면 (req.on('close')) 업스트림도 abort

**Verify:** `cd bridge && npm run build` (compile check). 런타임 검증은 Task 15.

**Steps:**

- [ ] **Step 1: Create `bridge/src/rag.ts`**

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

const RAG_SEARCH_URL =
	process.env.RAG_SEARCH_URL || 'http://localhost:8743/search';

interface RagSearchBody {
	query?: unknown;
	k?: unknown;
}

export async function handleRagSearch(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	let body: RagSearchBody;
	try {
		body = (await readJson(req)) as RagSearchBody;
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}

	const query = typeof body.query === 'string' ? body.query : '';
	if (!query || query.length > 8192) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_query' }));
		return;
	}

	const kRaw = typeof body.k === 'number' ? body.k : parseInt(String(body.k ?? '5'), 10);
	const k = Math.min(Math.max(Number.isFinite(kRaw) ? kRaw : 5, 1), 20);

	const abortCtrl = new AbortController();
	req.on('close', () => abortCtrl.abort());

	let upstream: Response;
	try {
		upstream = await fetch(RAG_SEARCH_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query, k }),
			signal: abortCtrl.signal
		});
	} catch (err) {
		const e = err as { code?: string; name?: string; message?: string; cause?: { code?: string } };
		if (e.name === 'AbortError' || abortCtrl.signal.aborted) {
			return;
		}
		if (
			e.code === 'ECONNREFUSED' ||
			e.cause?.code === 'ECONNREFUSED' ||
			(e.name === 'TypeError' && /fetch failed/i.test(e.message ?? ''))
		) {
			console.log(`[term-bridge rag] rag_unavailable q.len=${query.length}`);
			res.writeHead(503, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'rag_unavailable' }));
			return;
		}
		console.log(`[term-bridge rag] fetch_failed msg=${e.message}`);
		res.writeHead(502, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'upstream_error' }));
		return;
	}

	if (upstream.status >= 500) {
		console.log(`[term-bridge rag] upstream_${upstream.status}`);
		res.writeHead(502, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'upstream_error', status: upstream.status }));
		return;
	}
	if (!upstream.ok) {
		res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
		const text = await upstream.text();
		res.end(text);
		return;
	}

	const text = await upstream.text();
	let hits: unknown = [];
	try {
		hits = JSON.parse(text);
	} catch {
		hits = [];
	}
	const hitCount = Array.isArray(hits) ? hits.length : 0;
	console.log(`[term-bridge rag] ok q.len=${query.length} k=${k} hits=${hitCount}`);
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	const MAX = 64 * 1024;
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

- [ ] **Step 2: Add route in `bridge/src/server.ts`**

After the existing import block, add:
```ts
import { handleRagSearch } from './rag.js';
```

In `handleHttp`, after the `/llm/chat` block, add:
```ts
	if (url === '/rag/search' && req.method === 'POST') {
		await handleRagSearch(req, res, SECRET);
		return;
	}
```

- [ ] **Step 3: Update `bridge/deploy/term-bridge.container` doc**

Edit the env comment block — after the `OLLAMA_BASE_URL` line, add:
```
#        # RAG 검색 서버 (desktop FastAPI). 같은 호스트면 생략 가능.
#        # 분리된 머신이면 (예: bridge=Pi, indexer=Desktop) 명시:
#        #   RAG_SEARCH_URL=http://<desktop-host-ip>:8743/search
```

(Place it right after the OLLAMA_BASE_URL block in the file.)

- [ ] **Step 4: Build**

```bash
cd bridge && npm run build
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/rag.ts bridge/src/server.ts bridge/deploy/term-bridge.container
git commit -m "feat(bridge): /rag/search proxy → desktop FastAPI"
```

```json:metadata
{"files":["bridge/src/rag.ts","bridge/src/server.ts","bridge/deploy/term-bridge.container"],"verifyCommand":"cd bridge && npm run build","acceptanceCriteria":["Bearer auth","bad query → 400","ECONNREFUSED → 503 rag_unavailable","upstream 5xx → 502","정상 → 200 패스스루","abort 전파","RAG_SEARCH_URL env doc"]}
```

---

## Task 6: Python `rag/note_parser.py` — `.note` XML 파싱

**Goal:** `.note` XML 문자열에서 `(title, body_text, content_hash, is_special)` 추출. `is_special` 은 LLM (`llm://`) / 터미널 (`ssh://`) 시그니처 노트 검출용.

**Files:**
- Create: `pipeline/desktop/rag/__init__.py` (빈 파일)
- Create: `pipeline/desktop/rag/note_parser.py`
- Create: `pipeline/tests/rag/__init__.py`
- Create: `pipeline/tests/rag/test_note_parser.py`

**Acceptance Criteria:**
- [ ] `parse_note_xml(xml: str) -> ParsedNote | None` 함수
- [ ] `ParsedNote.title` = Tomboy `<title>` 요소 또는 본문 첫 줄
- [ ] `ParsedNote.body_text` = `<note-content>` 안의 XML 을 plain text 로 변환 (모든 마크/태그 무시, 텍스트와 줄바꿈만)
- [ ] `ParsedNote.content_hash` = `sha256(title + "\n" + body_text)` hex
- [ ] `ParsedNote.is_special` = True iff 본문 첫 2 단락 (줄) 중 하나가 `llm://` 또는 `ssh://` 로 시작
- [ ] 손상 XML → None
- [ ] 빈 본문 → `body_text=""`

**Verify:** `cd pipeline && python -m pytest tests/rag/test_note_parser.py -v`

**Steps:**

- [ ] **Step 1: Create `pipeline/desktop/rag/__init__.py`**

```python
```

(empty file)

- [ ] **Step 2: Create `pipeline/tests/rag/__init__.py`**

```python
```

(empty file)

- [ ] **Step 3: Write failing tests in `pipeline/tests/rag/test_note_parser.py`**

```python
from desktop.rag.note_parser import parse_note_xml


NOTE_XML_BASIC = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns:link="http://beatniksoftware.com/tomboy/link" xmlns="http://beatniksoftware.com/tomboy">
  <title>제목 테스트</title>
  <text xml:space="preserve"><note-content version="0.1">제목 테스트
첫 줄
둘째 줄</note-content></text>
  <last-change-date>2026-05-13T10:00:00.0000000+09:00</last-change-date>
  <create-date>2026-05-13T10:00:00.0000000+09:00</create-date>
</note>
"""


NOTE_XML_LLM = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns="http://beatniksoftware.com/tomboy">
  <title>코딩 도우미</title>
  <text xml:space="preserve"><note-content version="0.1">코딩 도우미
llm://qwen2.5-coder:3b
system: 셸 전문가

Q: hi</note-content></text>
</note>
"""


NOTE_XML_SSH = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns="http://beatniksoftware.com/tomboy">
  <title>서버 콘솔</title>
  <text xml:space="preserve"><note-content version="0.1">서버 콘솔
ssh://root@server.local</note-content></text>
</note>
"""


NOTE_XML_WITH_MARKS = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns:link="http://beatniksoftware.com/tomboy/link" xmlns="http://beatniksoftware.com/tomboy">
  <title>마크 노트</title>
  <text xml:space="preserve"><note-content version="0.1">마크 노트
<bold>볼드</bold>와 <link:internal>내부링크</link:internal> 같이 있음</note-content></text>
</note>
"""


def test_basic_parse():
    p = parse_note_xml(NOTE_XML_BASIC)
    assert p is not None
    assert p.title == "제목 테스트"
    assert "첫 줄" in p.body_text
    assert "둘째 줄" in p.body_text
    assert p.is_special is False
    assert len(p.content_hash) == 64  # sha256 hex


def test_llm_signature_is_special():
    p = parse_note_xml(NOTE_XML_LLM)
    assert p is not None
    assert p.is_special is True


def test_ssh_signature_is_special():
    p = parse_note_xml(NOTE_XML_SSH)
    assert p is not None
    assert p.is_special is True


def test_marks_stripped():
    p = parse_note_xml(NOTE_XML_WITH_MARKS)
    assert p is not None
    assert "볼드" in p.body_text
    assert "내부링크" in p.body_text
    assert "<bold>" not in p.body_text
    assert "<link:internal>" not in p.body_text


def test_corrupt_xml_returns_none():
    assert parse_note_xml("<note>unclosed") is None
    assert parse_note_xml("") is None


def test_hash_stable():
    p1 = parse_note_xml(NOTE_XML_BASIC)
    p2 = parse_note_xml(NOTE_XML_BASIC)
    assert p1.content_hash == p2.content_hash


def test_hash_changes_with_body():
    p1 = parse_note_xml(NOTE_XML_BASIC)
    modified = NOTE_XML_BASIC.replace("첫 줄", "변경된 줄")
    p2 = parse_note_xml(modified)
    assert p1.content_hash != p2.content_hash
```

- [ ] **Step 4: Run tests, expect FAIL**

```bash
cd pipeline && python -m pytest tests/rag/test_note_parser.py -v
```

Expected: ImportError because `desktop.rag.note_parser` doesn't exist yet.

- [ ] **Step 5: Implement `pipeline/desktop/rag/note_parser.py`**

```python
"""Parse Tomboy .note XML for RAG indexing.

Extracts title + plain-text body (marks stripped) + content hash.
Detects LLM/terminal signature notes via the first 2 paragraphs of body.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from xml.etree import ElementTree as ET


_NS = {
    "t": "http://beatniksoftware.com/tomboy",
}

# Recognize LLM and terminal signatures within the first 2 lines/paragraphs
# of the body text. Same patterns as the app.
_LLM_SIG_RE = re.compile(r"^llm://[A-Za-z0-9._:/-]+")
_SSH_SIG_RE = re.compile(r"^ssh://")


@dataclass(frozen=True)
class ParsedNote:
    title: str
    body_text: str
    content_hash: str
    is_special: bool


def _strip_marks(elem: ET.Element) -> str:
    """Recursively extract text from `<note-content>`, ignoring all mark/tag
    boundaries (bold, italic, link:internal, datetime, …). Preserves text
    and tail whitespace verbatim.
    """
    parts: list[str] = []
    if elem.text:
        parts.append(elem.text)
    for child in elem:
        parts.append(_strip_marks(child))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


def parse_note_xml(xml: str) -> ParsedNote | None:
    if not xml or not xml.strip():
        return None
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None

    # Tomboy notes may or may not declare the namespace. Try with NS first.
    title_elem = root.find("t:title", _NS)
    if title_elem is None:
        title_elem = root.find("title")
    title = (title_elem.text or "").strip() if title_elem is not None else ""

    content_elem = root.find("t:text/t:note-content", _NS)
    if content_elem is None:
        content_elem = root.find("text/note-content")
    body_text = _strip_marks(content_elem).strip() if content_elem is not None else ""

    # Detect special signatures: scan first 2 non-empty lines of body.
    is_special = False
    lines = [ln for ln in body_text.split("\n") if ln.strip()][:2]
    for line in lines:
        s = line.strip()
        if _LLM_SIG_RE.match(s) or _SSH_SIG_RE.match(s):
            is_special = True
            break

    h = hashlib.sha256()
    h.update(title.encode("utf-8"))
    h.update(b"\n")
    h.update(body_text.encode("utf-8"))

    return ParsedNote(
        title=title,
        body_text=body_text,
        content_hash=h.hexdigest(),
        is_special=is_special,
    )
```

- [ ] **Step 6: Run tests, expect PASS**

```bash
cd pipeline && python -m pytest tests/rag/test_note_parser.py -v
```

Expected: 7 tests pass.

- [ ] **Step 7: Commit**

```bash
git add pipeline/desktop/rag/__init__.py pipeline/desktop/rag/note_parser.py pipeline/tests/rag/__init__.py pipeline/tests/rag/test_note_parser.py
git commit -m "feat(rag): note_parser — .note XML → title/body/hash/is_special"
```

```json:metadata
{"files":["pipeline/desktop/rag/__init__.py","pipeline/desktop/rag/note_parser.py","pipeline/tests/rag/__init__.py","pipeline/tests/rag/test_note_parser.py"],"verifyCommand":"cd pipeline && python -m pytest tests/rag/test_note_parser.py -v","acceptanceCriteria":["parse_note_xml returns ParsedNote","title + body_text 추출","마크/태그 stripped","llm:// ssh:// 검출 → is_special=True","content_hash sha256","손상 XML → None"]}
```

---

## Task 7: Python `rag/vector_store.py` — sqlite-vec 래퍼

**Goal:** sqlite-vec 가 깔린 단일 파일 (`index.db`) 에 노트 텍스트 + 1024-dim 임베딩을 저장/검색하는 thin wrapper. open / count / upsert / delete / search / close.

**Files:**
- Create: `pipeline/desktop/rag/vector_store.py`
- Create: `pipeline/tests/rag/test_vector_store.py`
- Modify: `pipeline/pyproject.toml` (의존성 추가)

**Acceptance Criteria:**
- [ ] `VectorStore(path: Path)` — 디렉토리 자동 생성, sqlite-vec extension 로드, WAL 모드 활성화
- [ ] `count_notes() -> int`
- [ ] `upsert(guid, title, body_text, content_hash, embedding: list[float])` — `notes` + `note_embeddings` 두 테이블 모두 upsert
- [ ] `delete(guid)` — 두 테이블에서 모두 삭제
- [ ] `get_content_hash(guid) -> str | None` — 존재 여부 + 변경 감지용
- [ ] `search(embedding: list[float], k: int) -> list[SearchHit]` — top-K, distance 기준 오름차순
- [ ] `close()` — connection 닫음

**Verify:** `cd pipeline && python -m pytest tests/rag/test_vector_store.py -v`

**Steps:**

- [ ] **Step 1: Add `sqlite-vec` to `pipeline/pyproject.toml` dependencies**

Find the existing `[project.dependencies]` or `[tool.poetry.dependencies]` table and add `sqlite-vec`. Example for PEP-621 style:

```toml
[project]
dependencies = [
    # ... existing ...
    "sqlite-vec>=0.1",
    "fastapi>=0.110",
    "uvicorn>=0.27",
    "httpx>=0.27",
]
```

(httpx, fastapi, uvicorn are added now because subsequent tasks need them; better to batch the deps update than amend later. If `pyproject.toml` uses a different layout, follow that.)

- [ ] **Step 2: Install the new deps**

```bash
cd pipeline && pip install -e .
```

(If using a venv, activate first.)

- [ ] **Step 3: Write failing tests in `pipeline/tests/rag/test_vector_store.py`**

```python
import tempfile
from pathlib import Path

import pytest

from desktop.rag.vector_store import VectorStore


@pytest.fixture
def store():
    with tempfile.TemporaryDirectory() as tmp:
        s = VectorStore(Path(tmp) / "index.db")
        yield s
        s.close()


def _vec(seed: int) -> list[float]:
    # Deterministic 1024-dim vector for tests
    return [(seed + i) / 10000.0 for i in range(1024)]


def test_empty_count(store):
    assert store.count_notes() == 0


def test_upsert_and_count(store):
    store.upsert("g1", "T1", "body1", "hash1", _vec(1))
    assert store.count_notes() == 1
    store.upsert("g2", "T2", "body2", "hash2", _vec(2))
    assert store.count_notes() == 2


def test_upsert_replace_same_guid(store):
    store.upsert("g1", "T1", "body1", "hash1", _vec(1))
    store.upsert("g1", "T1-new", "body1-new", "hash1-new", _vec(11))
    assert store.count_notes() == 1
    assert store.get_content_hash("g1") == "hash1-new"


def test_delete(store):
    store.upsert("g1", "T1", "body1", "hash1", _vec(1))
    store.delete("g1")
    assert store.count_notes() == 0
    assert store.get_content_hash("g1") is None


def test_get_content_hash_missing(store):
    assert store.get_content_hash("nonexistent") is None


def test_search_returns_top_k_in_order(store):
    # Insert 3 notes with increasing distance from query vector
    store.upsert("g_near", "near", "n", "h_near", _vec(0))
    store.upsert("g_mid", "mid", "m", "h_mid", _vec(50))
    store.upsert("g_far", "far", "f", "h_far", _vec(500))

    query = _vec(0)
    hits = store.search(query, k=2)
    assert len(hits) == 2
    assert hits[0].guid == "g_near"
    assert hits[1].guid == "g_mid"
    # Distance ascending → score descending
    assert hits[0].score >= hits[1].score


def test_search_limit(store):
    for i in range(5):
        store.upsert(f"g{i}", f"t{i}", f"b{i}", f"h{i}", _vec(i))
    hits = store.search(_vec(0), k=3)
    assert len(hits) == 3


def test_search_empty_store(store):
    hits = store.search(_vec(0), k=5)
    assert hits == []
```

- [ ] **Step 4: Run tests, expect FAIL**

```bash
cd pipeline && python -m pytest tests/rag/test_vector_store.py -v
```

Expected: ImportError because `desktop.rag.vector_store` doesn't exist.

- [ ] **Step 5: Implement `pipeline/desktop/rag/vector_store.py`**

```python
"""Thin sqlite-vec wrapper for the RAG note index.

Schema:
  notes(guid PK, title, body_text, content_hash, indexed_at)
  note_embeddings(guid PK, embedding FLOAT[1024])  -- sqlite-vec virtual table
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import sqlite_vec


EMBEDDING_DIM = 1024


@dataclass(frozen=True)
class SearchHit:
    guid: str
    title: str
    body: str
    score: float  # 1.0 - clamped_distance


class VectorStore:
    def __init__(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path))
        self._conn.enable_load_extension(True)
        sqlite_vec.load(self._conn)
        self._conn.enable_load_extension(False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS notes (
                guid           TEXT PRIMARY KEY,
                title          TEXT NOT NULL,
                body_text      TEXT NOT NULL,
                content_hash   TEXT NOT NULL,
                indexed_at     TEXT NOT NULL
            )
        """)
        self._conn.execute(f"""
            CREATE VIRTUAL TABLE IF NOT EXISTS note_embeddings USING vec0(
                guid TEXT PRIMARY KEY,
                embedding FLOAT[{EMBEDDING_DIM}]
            )
        """)
        self._conn.commit()

    def count_notes(self) -> int:
        cur = self._conn.execute("SELECT COUNT(*) FROM notes")
        return int(cur.fetchone()[0])

    def get_content_hash(self, guid: str) -> str | None:
        cur = self._conn.execute("SELECT content_hash FROM notes WHERE guid = ?", (guid,))
        row = cur.fetchone()
        return row[0] if row else None

    def upsert(
        self,
        guid: str,
        title: str,
        body_text: str,
        content_hash: str,
        embedding: list[float],
    ) -> None:
        if len(embedding) != EMBEDDING_DIM:
            raise ValueError(f"embedding must be {EMBEDDING_DIM}-dim, got {len(embedding)}")
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute("""
            INSERT INTO notes (guid, title, body_text, content_hash, indexed_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(guid) DO UPDATE SET
                title = excluded.title,
                body_text = excluded.body_text,
                content_hash = excluded.content_hash,
                indexed_at = excluded.indexed_at
        """, (guid, title, body_text, content_hash, now))
        # vec0 doesn't support ON CONFLICT — delete then insert
        self._conn.execute("DELETE FROM note_embeddings WHERE guid = ?", (guid,))
        self._conn.execute(
            "INSERT INTO note_embeddings (guid, embedding) VALUES (?, ?)",
            (guid, sqlite_vec.serialize_float32(embedding)),
        )
        self._conn.commit()

    def delete(self, guid: str) -> None:
        self._conn.execute("DELETE FROM notes WHERE guid = ?", (guid,))
        self._conn.execute("DELETE FROM note_embeddings WHERE guid = ?", (guid,))
        self._conn.commit()

    def search(self, embedding: list[float], k: int) -> list[SearchHit]:
        if len(embedding) != EMBEDDING_DIM:
            raise ValueError(f"query embedding must be {EMBEDDING_DIM}-dim")
        cur = self._conn.execute("""
            SELECT n.guid, n.title, n.body_text, v.distance
            FROM note_embeddings v
            JOIN notes n ON n.guid = v.guid
            WHERE v.embedding MATCH ?
            ORDER BY v.distance
            LIMIT ?
        """, (sqlite_vec.serialize_float32(embedding), k))
        results: list[SearchHit] = []
        for row in cur.fetchall():
            guid, title, body, distance = row
            score = max(0.0, 1.0 - min(float(distance), 1.0))
            results.append(SearchHit(guid=guid, title=title, body=body, score=score))
        return results

    def close(self) -> None:
        self._conn.close()
```

- [ ] **Step 6: Run tests, expect PASS**

```bash
cd pipeline && python -m pytest tests/rag/test_vector_store.py -v
```

Expected: 8 tests pass.

- [ ] **Step 7: Commit**

```bash
git add pipeline/desktop/rag/vector_store.py pipeline/tests/rag/test_vector_store.py pipeline/pyproject.toml
git commit -m "feat(rag): vector_store — sqlite-vec 래퍼 (upsert/delete/search)"
```

```json:metadata
{"files":["pipeline/desktop/rag/vector_store.py","pipeline/tests/rag/test_vector_store.py","pipeline/pyproject.toml"],"verifyCommand":"cd pipeline && python -m pytest tests/rag/test_vector_store.py -v","acceptanceCriteria":["VectorStore open/count/upsert/delete/get_content_hash/search/close","WAL 모드","sqlite-vec extension 로드","upsert 가 같은 guid 덮어씀","search top-K distance 오름차순"]}
```

---

## Task 8: Python `rag/embeddings.py` — Ollama bge-m3 클라이언트

**Goal:** Ollama 의 `/api/embed` (or `/api/embeddings`) 를 호출해서 1024-dim float 리스트 반환. httpx 비동기.

**Files:**
- Create: `pipeline/desktop/rag/embeddings.py`
- Create: `pipeline/tests/rag/test_embeddings.py`

**Acceptance Criteria:**
- [ ] `OllamaEmbedder(base_url, model)` 클래스 또는 `embed(text)` async 함수
- [ ] 정상 응답 → `list[float]` (1024 원소)
- [ ] HTTP 에러 (404/5xx) → `EmbedError` 예외
- [ ] 연결 실패 → `EmbedError`
- [ ] 모킹된 httpx 로 단위 테스트 가능

**Verify:** `cd pipeline && python -m pytest tests/rag/test_embeddings.py -v`

**Steps:**

- [ ] **Step 1: Write failing tests in `pipeline/tests/rag/test_embeddings.py`**

```python
import pytest
import httpx
import respx

from desktop.rag.embeddings import OllamaEmbedder, EmbedError


@pytest.mark.asyncio
async def test_embed_success():
    embedder = OllamaEmbedder(base_url="http://localhost:11434", model="bge-m3")
    fake_embedding = [0.1] * 1024
    with respx.mock(base_url="http://localhost:11434") as mock:
        mock.post("/api/embed").respond(
            json={"embeddings": [fake_embedding]}
        )
        result = await embedder.embed("hello")
        assert result == fake_embedding


@pytest.mark.asyncio
async def test_embed_404_raises():
    embedder = OllamaEmbedder(base_url="http://localhost:11434", model="missing-model")
    with respx.mock(base_url="http://localhost:11434") as mock:
        mock.post("/api/embed").respond(404, json={"error": "model not found"})
        with pytest.raises(EmbedError) as exc:
            await embedder.embed("hello")
        assert exc.value.kind == "model_not_found"


@pytest.mark.asyncio
async def test_embed_500_raises():
    embedder = OllamaEmbedder(base_url="http://localhost:11434", model="bge-m3")
    with respx.mock(base_url="http://localhost:11434") as mock:
        mock.post("/api/embed").respond(500)
        with pytest.raises(EmbedError) as exc:
            await embedder.embed("hello")
        assert exc.value.kind == "upstream_error"


@pytest.mark.asyncio
async def test_embed_connection_error():
    embedder = OllamaEmbedder(base_url="http://nonexistent.invalid", model="bge-m3")
    with pytest.raises(EmbedError) as exc:
        await embedder.embed("hello")
    assert exc.value.kind in ("network", "unavailable")
```

Note: `respx` is a popular httpx mocking library. If not already installed, add to dev deps: `respx>=0.20`. Also need `pytest-asyncio` for the async fixtures — add to dev deps if missing.

- [ ] **Step 2: Install test deps**

```bash
cd pipeline && pip install 'respx>=0.20' 'pytest-asyncio>=0.21'
```

And add to `pyproject.toml`:
```toml
[project.optional-dependencies]
dev = [
    # ... existing dev deps ...
    "respx>=0.20",
    "pytest-asyncio>=0.21",
]
```

(If pytest-asyncio is already there, skip.)

In `pyproject.toml`, also add:
```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
```

- [ ] **Step 3: Run tests, expect FAIL (ImportError)**

```bash
cd pipeline && python -m pytest tests/rag/test_embeddings.py -v
```

- [ ] **Step 4: Implement `pipeline/desktop/rag/embeddings.py`**

```python
"""Ollama bge-m3 embedding client.

Calls Ollama's /api/embed endpoint and returns a single 1024-dim vector.
"""
from __future__ import annotations

from typing import Literal

import httpx


EmbedErrorKind = Literal["model_not_found", "upstream_error", "network", "unavailable"]


class EmbedError(Exception):
    def __init__(self, kind: EmbedErrorKind, message: str = "") -> None:
        super().__init__(message or kind)
        self.kind = kind


class OllamaEmbedder:
    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        model: str = "bge-m3",
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    async def embed(self, text: str) -> list[float]:
        url = f"{self.base_url}/api/embed"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    url,
                    json={"model": self.model, "input": text},
                )
        except httpx.ConnectError as e:
            raise EmbedError("unavailable", str(e)) from e
        except httpx.HTTPError as e:
            raise EmbedError("network", str(e)) from e

        if resp.status_code == 404:
            raise EmbedError("model_not_found", f"model {self.model} not pulled")
        if resp.status_code >= 500:
            raise EmbedError("upstream_error", f"ollama {resp.status_code}")
        if not resp.is_success:
            raise EmbedError("upstream_error", f"http {resp.status_code}")

        data = resp.json()
        embeddings = data.get("embeddings")
        if not isinstance(embeddings, list) or len(embeddings) == 0:
            raise EmbedError("upstream_error", "no embeddings in response")
        vec = embeddings[0]
        if not isinstance(vec, list) or len(vec) == 0:
            raise EmbedError("upstream_error", "empty embedding vector")
        return [float(x) for x in vec]
```

- [ ] **Step 5: Run tests, expect PASS**

```bash
cd pipeline && python -m pytest tests/rag/test_embeddings.py -v
```

Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add pipeline/desktop/rag/embeddings.py pipeline/tests/rag/test_embeddings.py pipeline/pyproject.toml
git commit -m "feat(rag): embeddings — Ollama bge-m3 client (httpx)"
```

```json:metadata
{"files":["pipeline/desktop/rag/embeddings.py","pipeline/tests/rag/test_embeddings.py","pipeline/pyproject.toml"],"verifyCommand":"cd pipeline && python -m pytest tests/rag/test_embeddings.py -v","acceptanceCriteria":["OllamaEmbedder.embed → list[float]","EmbedError 분류 (model_not_found/upstream_error/network/unavailable)","httpx 비동기 + respx mock"]}
```

---

## Task 9: Python `rag/zip_bootstrap.py` — startup 1회 bulk

**Goal:** `~/.local/share/tomboy-rag/inbox/*.zip` 중 가장 최근 mtime 파일 1 개를 열어 `notes/{guid}.note` 들을 모두 파싱하고 임베딩 + upsert. 인덱서가 시작 시 `count == 0` 일 때만 호출.

**Files:**
- Create: `pipeline/desktop/rag/zip_bootstrap.py`
- Create: `pipeline/tests/rag/test_zip_bootstrap.py`

**Acceptance Criteria:**
- [ ] `bootstrap_from_zip(inbox_dir, store, embedder) -> int` — 처리한 노트 수 반환
- [ ] inbox 에 zip 없으면 `0` 반환 (조용히)
- [ ] 여러 zip → 가장 최근 mtime 1개만 사용
- [ ] zip 내 `notes/{guid}.note` 만 처리 (다른 파일 무시: tombstones.txt, local-manifest.json 등)
- [ ] `is_special=True` 노트 (LLM/SSH) 는 skip
- [ ] 손상된 .note 1 개는 skip (전체 bootstrap 실패하지 않음)
- [ ] 처리 후 zip 은 그대로 둠 (이름 변경 없음)

**Verify:** `cd pipeline && python -m pytest tests/rag/test_zip_bootstrap.py -v`

**Steps:**

- [ ] **Step 1: Write failing tests**

`pipeline/tests/rag/test_zip_bootstrap.py`:

```python
import io
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from desktop.rag.vector_store import VectorStore
from desktop.rag.zip_bootstrap import bootstrap_from_zip


NOTE_BASIC = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns="http://beatniksoftware.com/tomboy">
  <title>일반 노트</title>
  <text xml:space="preserve"><note-content version="0.1">일반 노트
본문 줄</note-content></text>
</note>"""


NOTE_LLM = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns="http://beatniksoftware.com/tomboy">
  <title>LLM 노트</title>
  <text xml:space="preserve"><note-content version="0.1">LLM 노트
llm://qwen2.5:7b</note-content></text>
</note>"""


def _make_zip(path: Path, files: dict[str, str]) -> None:
    with zipfile.ZipFile(path, "w") as z:
        for name, content in files.items():
            z.writestr(name, content)


@pytest.fixture
def store():
    with tempfile.TemporaryDirectory() as tmp:
        s = VectorStore(Path(tmp) / "index.db")
        yield s
        s.close()


@pytest.fixture
def embedder():
    e = AsyncMock()
    e.embed = AsyncMock(return_value=[0.1] * 1024)
    return e


@pytest.mark.asyncio
async def test_no_zip_returns_zero(tmp_path, store, embedder):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    n = await bootstrap_from_zip(inbox, store, embedder)
    assert n == 0
    assert store.count_notes() == 0


@pytest.mark.asyncio
async def test_basic_zip(tmp_path, store, embedder):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    _make_zip(
        inbox / "tomboy-local-backup-2026-05-13.zip",
        {
            "notes/g1.note": NOTE_BASIC,
            "notes/g2.note": NOTE_BASIC.replace("일반 노트", "다른 노트"),
            "meta.txt": "ignored",
            "local-manifest.json": "{}",
        },
    )
    n = await bootstrap_from_zip(inbox, store, embedder)
    assert n == 2
    assert store.count_notes() == 2


@pytest.mark.asyncio
async def test_skips_special_notes(tmp_path, store, embedder):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    _make_zip(
        inbox / "backup.zip",
        {
            "notes/g_basic.note": NOTE_BASIC,
            "notes/g_llm.note": NOTE_LLM,
        },
    )
    n = await bootstrap_from_zip(inbox, store, embedder)
    assert n == 1  # only the basic one indexed
    assert store.count_notes() == 1


@pytest.mark.asyncio
async def test_corrupt_note_skipped(tmp_path, store, embedder):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    _make_zip(
        inbox / "backup.zip",
        {
            "notes/g1.note": NOTE_BASIC,
            "notes/g2.note": "<note>broken",
        },
    )
    n = await bootstrap_from_zip(inbox, store, embedder)
    assert n == 1
    assert store.count_notes() == 1


@pytest.mark.asyncio
async def test_picks_most_recent_zip(tmp_path, store, embedder):
    import os, time
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    old = inbox / "old.zip"
    new = inbox / "new.zip"
    _make_zip(old, {"notes/g_old.note": NOTE_BASIC})
    _make_zip(
        new,
        {"notes/g_new.note": NOTE_BASIC.replace("일반 노트", "최신 노트")},
    )
    # Force new to have later mtime
    now = time.time()
    os.utime(old, (now - 100, now - 100))
    os.utime(new, (now, now))
    n = await bootstrap_from_zip(inbox, store, embedder)
    assert n == 1
    assert store.get_content_hash("g_new") is not None
    assert store.get_content_hash("g_old") is None
```

- [ ] **Step 2: Run tests, expect FAIL**

```bash
cd pipeline && python -m pytest tests/rag/test_zip_bootstrap.py -v
```

- [ ] **Step 3: Implement `pipeline/desktop/rag/zip_bootstrap.py`**

```python
"""One-shot bulk index from a Tomboy backup zip.

Called by the indexer on startup ONLY when the vector store is empty.
Format: the zip downloaded from /admin/tools "로컬 백업" — entries are
`notes/{guid}.note`, plus auxiliary files (meta.txt, local-manifest.json,
tombstones.txt) which we ignore.
"""
from __future__ import annotations

import logging
import re
import zipfile
from pathlib import Path

from .embeddings import EmbedError, OllamaEmbedder
from .note_parser import parse_note_xml
from .vector_store import VectorStore


_log = logging.getLogger(__name__)

# Match `notes/<guid>.note` entries at the zip root. guid = 36-char UUID.
_NOTE_ENTRY_RE = re.compile(
    r"^notes/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.note$"
)


def _find_latest_zip(inbox: Path) -> Path | None:
    if not inbox.exists():
        return None
    zips = sorted(inbox.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    return zips[0] if zips else None


async def bootstrap_from_zip(
    inbox: Path,
    store: VectorStore,
    embedder: OllamaEmbedder,
) -> int:
    """Index every `notes/{guid}.note` in the latest zip. Returns the
    number of notes successfully indexed."""
    zip_path = _find_latest_zip(inbox)
    if zip_path is None:
        _log.info("bootstrap: no zip in %s — skipping", inbox)
        return 0

    _log.info("bootstrap: opening %s", zip_path.name)
    indexed = 0
    skipped = 0
    try:
        with zipfile.ZipFile(zip_path) as z:
            for info in z.infolist():
                m = _NOTE_ENTRY_RE.match(info.filename)
                if not m:
                    continue
                guid = m.group(1)
                try:
                    xml = z.read(info).decode("utf-8")
                except Exception as e:
                    _log.warning("bootstrap: read fail guid=%s err=%s", guid, e)
                    skipped += 1
                    continue
                parsed = parse_note_xml(xml)
                if parsed is None:
                    _log.warning("bootstrap: parse fail guid=%s", guid)
                    skipped += 1
                    continue
                if parsed.is_special:
                    _log.debug("bootstrap: skip special guid=%s title=%r", guid, parsed.title)
                    skipped += 1
                    continue
                try:
                    embedding = await embedder.embed(
                        parsed.title + "\n" + parsed.body_text
                    )
                except EmbedError as e:
                    _log.error("bootstrap: embed fail guid=%s kind=%s", guid, e.kind)
                    skipped += 1
                    continue
                store.upsert(
                    guid,
                    parsed.title,
                    parsed.body_text,
                    parsed.content_hash,
                    embedding,
                )
                indexed += 1
    except zipfile.BadZipFile as e:
        _log.error("bootstrap: bad zip %s err=%s", zip_path, e)
        return 0

    _log.info("bootstrap: done indexed=%d skipped=%d", indexed, skipped)
    return indexed
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd pipeline && python -m pytest tests/rag/test_zip_bootstrap.py -v
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add pipeline/desktop/rag/zip_bootstrap.py pipeline/tests/rag/test_zip_bootstrap.py
git commit -m "feat(rag): zip_bootstrap — startup-only bulk index"
```

```json:metadata
{"files":["pipeline/desktop/rag/zip_bootstrap.py","pipeline/tests/rag/test_zip_bootstrap.py"],"verifyCommand":"cd pipeline && python -m pytest tests/rag/test_zip_bootstrap.py -v","acceptanceCriteria":["bootstrap_from_zip returns indexed count","no zip → 0","latest mtime zip 선택","is_special skipped","corrupt note skipped","aux files (meta.txt 등) 무시"]}
```

---

## Task 10: Python `rag/firestore_source.py` — polling + watermark

**Goal:** Firestore `users/{uid}/notes` 컬렉션을 30초마다 polling. `serverUpdatedAt > watermark` 인 doc 을 fetch 해서 yield. `deleted` 필드와 `xmlContent` 필드를 처리해 인덱서에 전달. Watermark 는 JSON 파일에 저장.

**Files:**
- Create: `pipeline/desktop/rag/firestore_source.py`
- Create: `pipeline/tests/rag/test_firestore_source.py`

**Acceptance Criteria:**
- [ ] `WatermarkStore(path)` 클래스 — get/set ISO timestamp, 파일이 없으면 epoch 0 반환
- [ ] `FirestoreSource(client, watermark_store)` 클래스
- [ ] `poll_once() -> list[NoteEvent]` — watermark 초과 doc 들을 fetch, 처리 후 watermark 갱신
- [ ] `NoteEvent` dataclass: `{guid, xml_content, deleted, server_updated_at}`
- [ ] `xml_content` 가 None 이면서 deleted=False → skip
- [ ] 한 번에 100 docs 까지 처리

**Verify:** `cd pipeline && python -m pytest tests/rag/test_firestore_source.py -v`

**Steps:**

- [ ] **Step 1: Write failing tests**

`pipeline/tests/rag/test_firestore_source.py`:

```python
import json
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from desktop.rag.firestore_source import (
    WatermarkStore,
    FirestoreSource,
    NoteEvent,
)


def test_watermark_store_default_epoch(tmp_path):
    ws = WatermarkStore(tmp_path / "w.json")
    assert ws.get() == "1970-01-01T00:00:00+00:00"


def test_watermark_store_roundtrip(tmp_path):
    ws = WatermarkStore(tmp_path / "w.json")
    ws.set("2026-05-13T12:00:00+00:00")
    assert ws.get() == "2026-05-13T12:00:00+00:00"
    ws2 = WatermarkStore(tmp_path / "w.json")
    assert ws2.get() == "2026-05-13T12:00:00+00:00"


class _FakeSnap:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = data
    def to_dict(self):
        return self._data


def _fake_client_query(docs):
    """Mock that mimics .collection().document().collection().where().order_by().limit().stream()"""
    client = MagicMock()
    # The query chain returns the same mock; stream() returns docs
    chain = client.collection.return_value.document.return_value.collection.return_value
    chain.where.return_value = chain
    chain.order_by.return_value = chain
    chain.limit.return_value = chain
    chain.stream.return_value = iter(docs)
    return client


def test_poll_once_yields_events(tmp_path):
    docs = [
        _FakeSnap("guid-1", {
            "xmlContent": "<note>1</note>",
            "deleted": False,
            "serverUpdatedAt": "2026-05-13T10:00:00+00:00",
        }),
        _FakeSnap("guid-2", {
            "deleted": True,
            "serverUpdatedAt": "2026-05-13T11:00:00+00:00",
        }),
    ]
    client = _fake_client_query(docs)
    ws = WatermarkStore(tmp_path / "w.json")
    src = FirestoreSource(client=client, uid="dbx-test", watermark_store=ws)

    events = src.poll_once()
    assert len(events) == 2
    assert events[0] == NoteEvent(
        guid="guid-1", xml_content="<note>1</note>", deleted=False,
        server_updated_at="2026-05-13T10:00:00+00:00",
    )
    assert events[1].deleted is True
    assert events[1].xml_content is None
    # Watermark advanced to last event's timestamp
    assert ws.get() == "2026-05-13T11:00:00+00:00"


def test_poll_once_skips_doc_without_xml(tmp_path):
    docs = [
        _FakeSnap("g1", {
            "deleted": False,
            "serverUpdatedAt": "2026-05-13T10:00:00+00:00",
            # no xmlContent
        }),
    ]
    client = _fake_client_query(docs)
    ws = WatermarkStore(tmp_path / "w.json")
    src = FirestoreSource(client=client, uid="dbx-test", watermark_store=ws)
    events = src.poll_once()
    assert events == []
    # Watermark still advances (so we don't reprocess on every poll)
    assert ws.get() == "2026-05-13T10:00:00+00:00"


def test_poll_once_no_docs(tmp_path):
    client = _fake_client_query([])
    ws = WatermarkStore(tmp_path / "w.json")
    src = FirestoreSource(client=client, uid="dbx-test", watermark_store=ws)
    events = src.poll_once()
    assert events == []
    # Watermark unchanged
    assert ws.get() == "1970-01-01T00:00:00+00:00"
```

- [ ] **Step 2: Run tests, expect FAIL**

```bash
cd pipeline && python -m pytest tests/rag/test_firestore_source.py -v
```

- [ ] **Step 3: Implement `pipeline/desktop/rag/firestore_source.py`**

```python
"""Firestore polling source for the RAG indexer.

Polls `users/{uid}/notes WHERE serverUpdatedAt > watermark ORDER BY
serverUpdatedAt LIMIT 100`. Persistent watermark stored as JSON.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


_log = logging.getLogger(__name__)

_EPOCH = "1970-01-01T00:00:00+00:00"
_BATCH = 100


@dataclass(frozen=True)
class NoteEvent:
    guid: str
    xml_content: str | None
    deleted: bool
    server_updated_at: str


class WatermarkStore:
    def __init__(self, path: Path) -> None:
        self._path = Path(path)

    def get(self) -> str:
        if not self._path.exists():
            return _EPOCH
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return str(data.get("watermark", _EPOCH))
        except (json.JSONDecodeError, OSError):
            return _EPOCH

    def set(self, watermark: str) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps({"watermark": watermark}),
            encoding="utf-8",
        )


class FirestoreSource:
    def __init__(
        self,
        client: Any,
        uid: str,
        watermark_store: WatermarkStore,
    ) -> None:
        self._client = client
        self._uid = uid
        self._ws = watermark_store

    def poll_once(self) -> list[NoteEvent]:
        wm = self._ws.get()
        col = (
            self._client.collection("users")
            .document(self._uid)
            .collection("notes")
        )
        query = (
            col.where("serverUpdatedAt", ">", wm)
            .order_by("serverUpdatedAt")
            .limit(_BATCH)
        )
        events: list[NoteEvent] = []
        last_wm = wm
        for snap in query.stream():
            data = snap.to_dict() or {}
            sua = data.get("serverUpdatedAt")
            if not isinstance(sua, str):
                continue
            last_wm = sua
            deleted = bool(data.get("deleted", False))
            xml = data.get("xmlContent")
            if not deleted and (not isinstance(xml, str) or not xml):
                _log.debug("skip doc guid=%s (no xmlContent, not deleted)", snap.id)
                continue
            events.append(
                NoteEvent(
                    guid=snap.id,
                    xml_content=xml if isinstance(xml, str) else None,
                    deleted=deleted,
                    server_updated_at=sua,
                )
            )
        if last_wm != wm:
            self._ws.set(last_wm)
        return events
```

Note: the test mock fakes `to_dict()` returning a Python dict directly. Real Firestore's `serverUpdatedAt` is a `datetime.datetime` object, not a string. To handle that without breaking tests, we accept strings; the real-world adapter call site (in `indexer.py`) is responsible for converting datetime to ISO string before this layer if needed. Alternatively the implementation should normalize datetime → ISO here. Add that as an extra branch:

In the `poll_once` method, replace the `sua = ...; if not isinstance(sua, str): continue` block with:

```python
            sua_raw = data.get("serverUpdatedAt")
            if hasattr(sua_raw, "isoformat"):
                sua = sua_raw.isoformat()
            elif isinstance(sua_raw, str):
                sua = sua_raw
            else:
                continue
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd pipeline && python -m pytest tests/rag/test_firestore_source.py -v
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add pipeline/desktop/rag/firestore_source.py pipeline/tests/rag/test_firestore_source.py
git commit -m "feat(rag): firestore_source — polling + watermark"
```

```json:metadata
{"files":["pipeline/desktop/rag/firestore_source.py","pipeline/tests/rag/test_firestore_source.py"],"verifyCommand":"cd pipeline && python -m pytest tests/rag/test_firestore_source.py -v","acceptanceCriteria":["WatermarkStore JSON persist","FirestoreSource.poll_once","serverUpdatedAt > watermark filter","datetime/str normalization","watermark advance even when filtered"]}
```

---

## Task 11: Python `rag/indexer.py` — main loop

**Goal:** Top-level entry. Config 로드 → 데이터 디렉토리 셋업 → VectorStore + OllamaEmbedder + Firestore client + WatermarkStore + FirestoreSource 결선 → `count == 0` 일 때 `bootstrap_from_zip` 1회 → 무한 루프로 30초 sleep + `poll_once` → 각 event 마다 dedupe + embed + upsert/delete.

**Files:**
- Create: `pipeline/desktop/rag/indexer.py`
- Create: `pipeline/tests/rag/test_indexer.py`

**Acceptance Criteria:**
- [ ] `process_event(store, embedder, event)` 함수: 단일 event 를 store 에 반영 (해시 dedupe 포함)
- [ ] `main()` async entry — config 로드, signal handler 로 SIGTERM 깔끔 종료
- [ ] `count == 0` → bootstrap 호출 후 polling 시작
- [ ] `count > 0` → bootstrap skip, 즉시 polling
- [ ] `process_event` 가 deleted=True → store.delete
- [ ] `process_event` 가 정상 + content_hash 변경 없음 → skip (embed 호출 안 됨)
- [ ] `process_event` 가 정상 + 변경 → embed + upsert
- [ ] `process_event` 가 is_special → skip

**Verify:** `cd pipeline && python -m pytest tests/rag/test_indexer.py -v`

**Steps:**

- [ ] **Step 1: Write failing tests for `process_event` (the unit-testable part)**

`pipeline/tests/rag/test_indexer.py`:

```python
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from desktop.rag.firestore_source import NoteEvent
from desktop.rag.indexer import process_event
from desktop.rag.vector_store import VectorStore


NOTE_BASIC = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns="http://beatniksoftware.com/tomboy">
  <title>일반 노트</title>
  <text xml:space="preserve"><note-content version="0.1">일반 노트
본문 줄</note-content></text>
</note>"""


NOTE_BASIC_V2 = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns="http://beatniksoftware.com/tomboy">
  <title>일반 노트</title>
  <text xml:space="preserve"><note-content version="0.1">일반 노트
변경된 본문</note-content></text>
</note>"""


NOTE_LLM = """<?xml version="1.0" encoding="utf-8"?>
<note version="0.3" xmlns="http://beatniksoftware.com/tomboy">
  <title>LLM</title>
  <text xml:space="preserve"><note-content version="0.1">LLM
llm://x</note-content></text>
</note>"""


@pytest.fixture
def store():
    with tempfile.TemporaryDirectory() as tmp:
        s = VectorStore(Path(tmp) / "index.db")
        yield s
        s.close()


@pytest.fixture
def embedder():
    e = AsyncMock()
    e.embed = AsyncMock(return_value=[0.1] * 1024)
    return e


@pytest.mark.asyncio
async def test_new_note_indexed(store, embedder):
    ev = NoteEvent(guid="g1", xml_content=NOTE_BASIC, deleted=False,
                   server_updated_at="2026-05-13T10:00:00+00:00")
    await process_event(store, embedder, ev)
    assert store.count_notes() == 1
    embedder.embed.assert_called_once()


@pytest.mark.asyncio
async def test_same_hash_skipped(store, embedder):
    ev = NoteEvent(guid="g1", xml_content=NOTE_BASIC, deleted=False,
                   server_updated_at="2026-05-13T10:00:00+00:00")
    await process_event(store, embedder, ev)
    embedder.embed.reset_mock()
    await process_event(store, embedder, ev)
    embedder.embed.assert_not_called()
    assert store.count_notes() == 1


@pytest.mark.asyncio
async def test_content_change_reindexed(store, embedder):
    ev1 = NoteEvent(guid="g1", xml_content=NOTE_BASIC, deleted=False,
                    server_updated_at="2026-05-13T10:00:00+00:00")
    ev2 = NoteEvent(guid="g1", xml_content=NOTE_BASIC_V2, deleted=False,
                    server_updated_at="2026-05-13T11:00:00+00:00")
    await process_event(store, embedder, ev1)
    embedder.embed.reset_mock()
    await process_event(store, embedder, ev2)
    embedder.embed.assert_called_once()
    assert store.count_notes() == 1


@pytest.mark.asyncio
async def test_deleted_removes_from_store(store, embedder):
    ev1 = NoteEvent(guid="g1", xml_content=NOTE_BASIC, deleted=False,
                    server_updated_at="2026-05-13T10:00:00+00:00")
    await process_event(store, embedder, ev1)
    assert store.count_notes() == 1
    ev2 = NoteEvent(guid="g1", xml_content=None, deleted=True,
                    server_updated_at="2026-05-13T11:00:00+00:00")
    await process_event(store, embedder, ev2)
    assert store.count_notes() == 0


@pytest.mark.asyncio
async def test_special_note_skipped(store, embedder):
    ev = NoteEvent(guid="g1", xml_content=NOTE_LLM, deleted=False,
                   server_updated_at="2026-05-13T10:00:00+00:00")
    await process_event(store, embedder, ev)
    assert store.count_notes() == 0
    embedder.embed.assert_not_called()


@pytest.mark.asyncio
async def test_corrupt_xml_skipped(store, embedder):
    ev = NoteEvent(guid="g1", xml_content="<note>broken", deleted=False,
                   server_updated_at="2026-05-13T10:00:00+00:00")
    await process_event(store, embedder, ev)
    assert store.count_notes() == 0
    embedder.embed.assert_not_called()
```

- [ ] **Step 2: Run tests, expect FAIL (ImportError)**

```bash
cd pipeline && python -m pytest tests/rag/test_indexer.py -v
```

- [ ] **Step 3: Implement `pipeline/desktop/rag/indexer.py`**

```python
"""Top-level RAG indexer: bootstrap + Firestore polling loop.

Run:  python -m desktop.rag.indexer
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from pathlib import Path

from firebase_admin import credentials, firestore, initialize_app, get_app

from desktop.lib.config import load_config

from .embeddings import EmbedError, OllamaEmbedder
from .firestore_source import FirestoreSource, NoteEvent, WatermarkStore
from .note_parser import parse_note_xml
from .vector_store import VectorStore
from .zip_bootstrap import bootstrap_from_zip


_log = logging.getLogger(__name__)

_DATA_DIR = Path("~/.local/share/tomboy-rag").expanduser()
_POLL_INTERVAL_S = 30
_OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
_EMBED_MODEL = os.environ.get("RAG_EMBED_MODEL", "bge-m3")

_PIPELINE_CONFIG_PATH = (
    Path(__file__).resolve().parents[2] / "config" / "pipeline.yaml"
)


async def process_event(
    store: VectorStore,
    embedder: OllamaEmbedder,
    event: NoteEvent,
) -> None:
    """Apply a single Firestore event to the index. Idempotent."""
    if event.deleted:
        store.delete(event.guid)
        _log.info("deleted guid=%s", event.guid)
        return

    if not event.xml_content:
        _log.debug("no xml content, skipping guid=%s", event.guid)
        return

    parsed = parse_note_xml(event.xml_content)
    if parsed is None:
        _log.warning("parse fail guid=%s", event.guid)
        return
    if parsed.is_special:
        _log.debug("special note, skipping guid=%s title=%r", event.guid, parsed.title)
        # If a note flipped from regular → special (e.g. user edited a note
        # to become an LLM note), drop it from the index.
        store.delete(event.guid)
        return

    existing_hash = store.get_content_hash(event.guid)
    if existing_hash == parsed.content_hash:
        _log.debug("hash unchanged, skipping guid=%s", event.guid)
        return

    try:
        embedding = await embedder.embed(parsed.title + "\n" + parsed.body_text)
    except EmbedError as e:
        _log.error("embed fail guid=%s kind=%s — will retry next tick", event.guid, e.kind)
        return

    store.upsert(
        event.guid,
        parsed.title,
        parsed.body_text,
        parsed.content_hash,
        embedding,
    )
    _log.info("indexed guid=%s title=%r", event.guid, parsed.title[:60])


def _get_firestore_client(service_account_path: str):
    try:
        app = get_app("rag-indexer")
    except ValueError:
        cred = credentials.Certificate(service_account_path)
        app = initialize_app(cred, name="rag-indexer")
    return firestore.client(app)


async def _main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    cfg = load_config(_PIPELINE_CONFIG_PATH)
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    inbox_dir = _DATA_DIR / "inbox"
    inbox_dir.mkdir(parents=True, exist_ok=True)

    store = VectorStore(_DATA_DIR / "index.db")
    embedder = OllamaEmbedder(base_url=_OLLAMA_BASE_URL, model=_EMBED_MODEL)
    fs_client = _get_firestore_client(cfg.firebase_service_account)
    ws = WatermarkStore(_DATA_DIR / "firestore_watermark.json")
    source = FirestoreSource(client=fs_client, uid=cfg.firebase_uid, watermark_store=ws)

    _log.info("RAG indexer starting — uid=%s data=%s", cfg.firebase_uid, _DATA_DIR)

    # Bootstrap if empty
    if store.count_notes() == 0:
        _log.info("index empty, attempting zip bootstrap from %s", inbox_dir)
        n = await bootstrap_from_zip(inbox_dir, store, embedder)
        _log.info("bootstrap done: indexed %d notes", n)
    else:
        _log.info("index has %d notes — skipping bootstrap", store.count_notes())

    stop = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    _log.info("entering Firestore polling loop (interval=%ds)", _POLL_INTERVAL_S)
    while not stop.is_set():
        try:
            events = await asyncio.to_thread(source.poll_once)
        except Exception as e:
            _log.error("poll_once error: %s", e)
            await _interruptible_sleep(_POLL_INTERVAL_S, stop)
            continue
        for ev in events:
            if stop.is_set():
                break
            await process_event(store, embedder, ev)
        if events:
            _log.info("processed %d events", len(events))
        await _interruptible_sleep(_POLL_INTERVAL_S, stop)

    _log.info("shutdown — closing store")
    store.close()
    return 0


async def _interruptible_sleep(seconds: float, stop: asyncio.Event) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        return


def main() -> int:
    return asyncio.run(_main())


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd pipeline && python -m pytest tests/rag/test_indexer.py -v
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add pipeline/desktop/rag/indexer.py pipeline/tests/rag/test_indexer.py
git commit -m "feat(rag): indexer — main loop (bootstrap + Firestore polling)"
```

```json:metadata
{"files":["pipeline/desktop/rag/indexer.py","pipeline/tests/rag/test_indexer.py"],"verifyCommand":"cd pipeline && python -m pytest tests/rag/test_indexer.py -v","acceptanceCriteria":["process_event 단위 테스트","bootstrap entry condition count==0","deleted → store.delete","hash 변경 없으면 embed skip","is_special → delete + skip","SIGTERM 처리"]}
```

---

## Task 12: Python `rag/search_server.py` — FastAPI

**Goal:** `0.0.0.0:8743/search` 에 단발 POST endpoint. JSON body `{query, k}` → bge-m3 임베딩 → vector store top-K → JSON 응답.

**Files:**
- Create: `pipeline/desktop/rag/search_server.py`
- Create: `pipeline/tests/rag/test_search_server.py`

**Acceptance Criteria:**
- [ ] `POST /search` 정상 → `[{guid, title, body, score}]`
- [ ] `query` 누락/빈 문자열 → 400
- [ ] `k` clamp 1-20
- [ ] 임베딩 실패 (EmbedError) → 503
- [ ] FastAPI TestClient 로 단위 테스트 가능
- [ ] 모듈 import 시 인증 없음 (firewall 가정)

**Verify:** `cd pipeline && python -m pytest tests/rag/test_search_server.py -v`

**Steps:**

- [ ] **Step 1: Write failing tests**

`pipeline/tests/rag/test_search_server.py`:

```python
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from desktop.rag.embeddings import EmbedError
from desktop.rag.search_server import build_app
from desktop.rag.vector_store import VectorStore


@pytest.fixture
def store():
    with tempfile.TemporaryDirectory() as tmp:
        s = VectorStore(Path(tmp) / "index.db")
        # Seed 2 notes
        s.upsert("g1", "T1", "body 1", "h1", [0.1] * 1024)
        s.upsert("g2", "T2", "body 2", "h2", [0.2] * 1024)
        yield s
        s.close()


@pytest.fixture
def embedder():
    e = AsyncMock()
    e.embed = AsyncMock(return_value=[0.1] * 1024)
    return e


def _client(store, embedder):
    app = build_app(store=store, embedder=embedder)
    return TestClient(app)


def test_search_success(store, embedder):
    resp = _client(store, embedder).post("/search", json={"query": "hello", "k": 2})
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 2
    for hit in data:
        assert set(hit.keys()) >= {"guid", "title", "body", "score"}


def test_search_empty_query_400(store, embedder):
    resp = _client(store, embedder).post("/search", json={"query": "", "k": 5})
    assert resp.status_code == 400


def test_search_missing_query_400(store, embedder):
    resp = _client(store, embedder).post("/search", json={"k": 5})
    assert resp.status_code == 422  # FastAPI validation


def test_search_k_clamped(store, embedder):
    resp = _client(store, embedder).post("/search", json={"query": "x", "k": 999})
    assert resp.status_code == 200
    # Only 2 items in store, but k=999 should not error
    assert len(resp.json()) <= 2


def test_search_embed_error_503(store):
    bad_embedder = AsyncMock()
    bad_embedder.embed = AsyncMock(side_effect=EmbedError("unavailable", "ollama down"))
    resp = _client(store, bad_embedder).post("/search", json={"query": "x", "k": 5})
    assert resp.status_code == 503
    assert resp.json()["error"] == "embed_failed"
```

- [ ] **Step 2: Run tests, expect FAIL**

```bash
cd pipeline && python -m pytest tests/rag/test_search_server.py -v
```

- [ ] **Step 3: Implement `pipeline/desktop/rag/search_server.py`**

```python
"""FastAPI search server for the RAG index.

POST /search  { query: str, k: int = 5 }  →  [{guid, title, body, score}]
Bind 0.0.0.0:8743. No auth (firewall protects).
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .embeddings import EmbedError, OllamaEmbedder
from .vector_store import SearchHit, VectorStore


_log = logging.getLogger(__name__)


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=0)  # We do our own empty check for clearer 400
    k: int = 5


class SearchResponseItem(BaseModel):
    guid: str
    title: str
    body: str
    score: float


def build_app(store: VectorStore, embedder: OllamaEmbedder) -> FastAPI:
    app = FastAPI(title="tomboy-rag-search")

    @app.post("/search", response_model=list[SearchResponseItem])
    async def search(req: SearchRequest):
        if not req.query.strip():
            raise HTTPException(status_code=400, detail={"error": "empty_query"})
        k = max(1, min(req.k, 20))
        try:
            embedding = await embedder.embed(req.query)
        except EmbedError as e:
            _log.error("embed fail: kind=%s", e.kind)
            raise HTTPException(status_code=503, detail={"error": "embed_failed", "kind": e.kind})
        hits = store.search(embedding, k=k)
        return [
            SearchResponseItem(guid=h.guid, title=h.title, body=h.body, score=h.score)
            for h in hits
        ]

    return app


# Module-level app for uvicorn (`uvicorn desktop.rag.search_server:app`)
_DATA_DIR = Path("~/.local/share/tomboy-rag").expanduser()
_OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
_EMBED_MODEL = os.environ.get("RAG_EMBED_MODEL", "bge-m3")


def _make_default_app() -> FastAPI:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    store = VectorStore(_DATA_DIR / "index.db")
    embedder = OllamaEmbedder(base_url=_OLLAMA_BASE_URL, model=_EMBED_MODEL)
    return build_app(store=store, embedder=embedder)


app = _make_default_app()
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd pipeline && python -m pytest tests/rag/test_search_server.py -v
```

Expected: 5 tests pass.

Note: `FastAPI`, `pydantic`, `httpx` test deps may require `cd pipeline && pip install -e .` again if the dev extras weren't pulled.

- [ ] **Step 5: Commit**

```bash
git add pipeline/desktop/rag/search_server.py pipeline/tests/rag/test_search_server.py
git commit -m "feat(rag): search_server — FastAPI /search 단발 POST"
```

```json:metadata
{"files":["pipeline/desktop/rag/search_server.py","pipeline/tests/rag/test_search_server.py"],"verifyCommand":"cd pipeline && python -m pytest tests/rag/test_search_server.py -v","acceptanceCriteria":["POST /search → [{guid,title,body,score}]","empty query → 400","k clamp 1-20","EmbedError → 503","build_app(store, embedder) factory for tests","module app for uvicorn"]}
```

---

## Task 13: Systemd unit files

**Goal:** `rag-indexer.service` 와 `rag-search.service` 두 user-level systemd unit 파일을 deploy 디렉토리에 추가.

**Files:**
- Create: `pipeline/desktop/deploy/rag-indexer.service`
- Create: `pipeline/desktop/deploy/rag-search.service`

**Acceptance Criteria:**
- [ ] 두 파일 모두 `Type=simple`, `Restart=on-failure`
- [ ] After=ollama.service (의존성 명시)
- [ ] WorkingDirectory + ExecStart 가 `pipeline/` 와 `.venv/bin/python` 또는 `.venv/bin/uvicorn` 사용
- [ ] StandardOutput=journal, StandardError=journal
- [ ] `[Install] WantedBy=default.target`

**Verify:** `grep -c "ExecStart" pipeline/desktop/deploy/rag-*.service` → `2:1` (각 1줄)

**Steps:**

- [ ] **Step 1: Create `pipeline/desktop/deploy/rag-indexer.service`**

```ini
[Unit]
Description=Tomboy RAG indexer (zip bootstrap + Firestore poller)
After=ollama.service
Wants=ollama.service

[Service]
Type=simple
WorkingDirectory=%h/workspace/tomboy-web/pipeline
ExecStart=%h/workspace/tomboy-web/pipeline/.venv/bin/python -m desktop.rag.indexer
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Create `pipeline/desktop/deploy/rag-search.service`**

```ini
[Unit]
Description=Tomboy RAG search server (FastAPI)
After=ollama.service
Wants=ollama.service

[Service]
Type=simple
WorkingDirectory=%h/workspace/tomboy-web/pipeline
ExecStart=%h/workspace/tomboy-web/pipeline/.venv/bin/uvicorn desktop.rag.search_server:app --host 0.0.0.0 --port 8743
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

- [ ] **Step 3: Verify**

```bash
grep -c "ExecStart" pipeline/desktop/deploy/rag-indexer.service pipeline/desktop/deploy/rag-search.service
```

Expected:
```
pipeline/desktop/deploy/rag-indexer.service:1
pipeline/desktop/deploy/rag-search.service:1
```

- [ ] **Step 4: Commit**

```bash
git add pipeline/desktop/deploy/rag-indexer.service pipeline/desktop/deploy/rag-search.service
git commit -m "feat(rag): systemd units — rag-indexer + rag-search"
```

```json:metadata
{"files":["pipeline/desktop/deploy/rag-indexer.service","pipeline/desktop/deploy/rag-search.service"],"verifyCommand":"grep -c ExecStart pipeline/desktop/deploy/rag-indexer.service pipeline/desktop/deploy/rag-search.service","acceptanceCriteria":["두 unit 파일 모두 Type=simple","After=ollama.service","ExecStart 경로 표준 .venv","Restart=on-failure","WantedBy=default.target"]}
```

---

## Task 14: Diary unit 의 ExecStartPre 에 bge-m3 evict 추가

**Goal:** Diary 파이프라인이 transformers VLM 로딩 직전 모든 Ollama 모델을 evict 시키도록 `bge-m3` 도 evict 목록에 추가 → VRAM 확보.

**Files:**
- Modify: `pipeline/desktop/deploy/desktop-pipeline.service`

**Acceptance Criteria:**
- [ ] ExecStartPre 의 모델 루프 변수에 `bge-m3` 포함
- [ ] 다른 줄 변경 없음

**Verify:** `grep "bge-m3" pipeline/desktop/deploy/desktop-pipeline.service` → 라인 1개

**Steps:**

- [ ] **Step 1: Edit `pipeline/desktop/deploy/desktop-pipeline.service`**

Replace the existing `ExecStartPre` line (currently `for m in qwen2.5-coder:3b qwen2.5:7b; do …`) with:

```ini
ExecStartPre=/bin/bash -c 'for m in qwen2.5-coder:3b qwen2.5:7b bge-m3; do curl -sf -X POST http://localhost:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null || true; done'
```

- [ ] **Step 2: Verify**

```bash
grep "bge-m3" pipeline/desktop/deploy/desktop-pipeline.service
```

Expected: 1 line containing `bge-m3` in the model list.

- [ ] **Step 3: Commit**

```bash
git add pipeline/desktop/deploy/desktop-pipeline.service
git commit -m "chore(diary): evict bge-m3 in ExecStartPre alongside chat models"
```

```json:metadata
{"files":["pipeline/desktop/deploy/desktop-pipeline.service"],"verifyCommand":"grep bge-m3 pipeline/desktop/deploy/desktop-pipeline.service","acceptanceCriteria":["bge-m3 added to evict list","나머지 줄 변경 없음"]}
```

---

## Task 15: 운영 배포 + 13-step PWA smoke

**Goal:** Spec §5 의 운영 단계 (Ollama 모델 pull, firewall, env 변수, systemd 활성화) + spec §5 의 13-step smoke 수동 검증.

**Files:** (코드 변경 없음 — 운영 단계 + 수동 검증)

**Acceptance Criteria:**
- [ ] `ollama pull bge-m3` 완료, `ollama list` 에서 보임
- [ ] Desktop firewall 이 `8743/tcp` 를 Pi IP 만 allow
- [ ] `~/.config/term-bridge.env` 에 `RAG_SEARCH_URL=http://<desktop-ip>:8743/search` 추가 + bridge 재시작
- [ ] `systemctl --user daemon-reload` + `enable --now rag-indexer rag-search` 성공
- [ ] `journalctl --user -u rag-indexer.service -n 50` 에서 "RAG indexer starting" + "bootstrap done" (or "skipping bootstrap") 로그 보임
- [ ] Pi 에서 `curl http://<desktop-ip>:8743/search -d '{"query":"테스트","k":3}' -H 'content-type:application/json'` → JSON 결과
- [ ] PWA 에서 spec §5 의 13-step 모두 통과

**Verify:** Manual checklist per spec §5

**Steps:**

- [ ] **Step 1: Pull bge-m3 model on desktop**

```bash
ollama pull bge-m3
ollama list  # confirm bge-m3 in list
```

Expected: `bge-m3` shown with ~600 MB size.

- [ ] **Step 2: Build the .venv and install new Python deps**

```bash
cd ~/workspace/tomboy-web/pipeline
source .venv/bin/activate  # or activate however the project does
pip install -e .
pip install 'sqlite-vec' 'fastapi' 'uvicorn' 'httpx'
```

(If pyproject.toml already includes them from Task 7 / 8, `pip install -e .` alone is sufficient.)

- [ ] **Step 3: Prepare the data directory + drop a zip**

```bash
mkdir -p ~/.local/share/tomboy-rag/inbox
# In your phone/laptop browser, navigate to /admin/tools and click
# "로컬 백업". Download tomboy-local-backup-<ts>.zip.
# Then copy it to the desktop:
#   scp tomboy-local-backup-*.zip user@desktop:~/.local/share/tomboy-rag/inbox/
ls ~/.local/share/tomboy-rag/inbox/  # confirm zip present
```

- [ ] **Step 4: Install systemd units**

```bash
mkdir -p ~/.config/systemd/user
cp ~/workspace/tomboy-web/pipeline/desktop/deploy/rag-indexer.service ~/.config/systemd/user/
cp ~/workspace/tomboy-web/pipeline/desktop/deploy/rag-search.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now rag-indexer.service
systemctl --user enable --now rag-search.service
sleep 5
systemctl --user status rag-indexer.service rag-search.service
```

Expected: both `active (running)`. If they fail with "transient or generated", consult spec §5 — `enable --now` is fine for non-Quadlet user units.

- [ ] **Step 5: Confirm bootstrap ran**

```bash
journalctl --user -u rag-indexer.service -n 100 --no-pager
```

Expected log lines:
- `RAG indexer starting — uid=dbx-... data=...`
- `index empty, attempting zip bootstrap from .../inbox`
- `bootstrap: opening tomboy-local-backup-*.zip`
- `bootstrap: done indexed=N skipped=M`
- `entering Firestore polling loop (interval=30s)`

- [ ] **Step 6: Smoke test desktop endpoint directly**

```bash
curl -s http://localhost:8743/search \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"query":"테스트","k":3}' | jq .
```

Expected: array of up to 3 hits, each with guid/title/body/score.

- [ ] **Step 7: Configure firewall to allow Pi access to 8743**

```bash
# firewalld example (adjust zone if different):
sudo firewall-cmd --permanent --zone=internal --add-rich-rule="rule family=ipv4 source address=<PI-IP> port port=8743 protocol=tcp accept"
sudo firewall-cmd --reload
```

Verify from the Pi:
```bash
curl -s http://<DESKTOP-IP>:8743/search \
  -X POST -H 'content-type: application/json' \
  -d '{"query":"테스트","k":3}'
```

Expected: same JSON output as Step 6.

- [ ] **Step 8: Update bridge env + restart**

On the Pi:
```bash
echo 'RAG_SEARCH_URL=http://<DESKTOP-IP>:8743/search' >> ~/.config/term-bridge.env
systemctl --user restart term-bridge.service
systemctl --user status term-bridge.service
```

Expected: `active (running)`.

- [ ] **Step 9: Smoke test bridge proxy from PWA host**

```bash
curl -s https://<bridge-domain>/rag/search \
  -X POST \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"query":"테스트","k":3}' | jq .
```

Expected: same JSON as Steps 6/7. Without Bearer → 401.

- [ ] **Step 10: PWA end-to-end smoke — create rag-on LLM note**

In the browser (PWA):
1. Open any note, type as a new note:
```
지난 한 달 정리
llm://qwen2.5:7b
system: 너는 내 노트의 어시스턴트.
temperature: 0.3
rag: 5

Q: 가장 최근에 차 정비한 게 언제였지?
```

2. Click 보내기. Watch the network tab: should see `POST /rag/search` then `POST /llm/chat`.
3. Verify A: stream completes.
4. After completion, a new paragraph `참고: [[제목1]] [[제목2]] …` appears.
5. Click any `[[제목]]` — should open the referenced note.

- [ ] **Step 11: Verify `rag: off` (or absent) does NOT call /rag/search**

In a different LLM note without the `rag:` header, send a Q. Network tab should show only `/llm/chat`, no `/rag/search`.

- [ ] **Step 12: Verify graceful degradation — stop rag-search**

```bash
systemctl --user stop rag-search.service
```

Send a Q in a `rag: on` note. Expected:
- Toast appears: `RAG 검색 실패 — 참고 노트 없이 응답 (rag_unavailable)`
- A: response still streams normally (no `참고:` line at end)

Restart:
```bash
systemctl --user start rag-search.service
```

- [ ] **Step 13: Verify Firestore steady-state**

In the PWA (with Firebase note sync enabled at 설정 → 동기화 설정):
1. Edit an existing note — change body. Save.
2. Wait ~30-60 seconds.
3. In a `rag: on` LLM note, ask a question about the new content.
4. Verify the new content appears in the retrieved bodies (e.g., LLM mentions the new info or `참고: [[수정된 제목]]` is present).

Optional: tail indexer logs in parallel:
```bash
journalctl --user -u rag-indexer.service -f
```

Expected log: `processed 1 events` after each note save.

- [ ] **Step 14: Final commit (if any manual config files changed)**

If you modified anything tracked (e.g., a sample env file), commit. Otherwise no commit — this task is operational only.

```json:metadata
{"files":[],"verifyCommand":"# Manual: 13-step PWA smoke per spec §5","acceptanceCriteria":["ollama pull bge-m3","firewall 8743/tcp Pi IP allowlist","systemd units active","bootstrap logs visible","desktop /search curl OK","bridge /rag/search Bearer OK","PWA rag:on 노트 동작 + [[title]] 부착","rag:off 노트 /rag/search 호출 안 함","rag-search down 시 toast + 정상 응답","Firestore steady-state 반영"]}
```

---

## Self-Review

### Spec coverage check

- **Spec §1 (노트 grammar — rag 헤더)** → Task 1 (parser), Task 2 (plugin)
- **Spec §1 (`참고:` 줄 부착)** → Task 4 (LlmSendBar)
- **Spec §2 (구성요소 7)** →
  - rag-indexer.service → Task 11
  - rag-search.service → Task 12
  - bridge /rag/search → Task 5
  - LlmSendBar rag 분기 → Task 4
  - searchRag.ts → Task 3
  - parseLlmNote 확장 → Task 1
  - /admin/tools 기존 zip → 변경 없음 ✓
- **Spec §3 (인덱싱)** →
  - zip bootstrap → Task 9
  - Firestore polling → Task 10
  - sqlite 스키마 → Task 7
  - process_event 흐름 (특히 is_special, content_hash dedupe, deleted) → Task 11
- **Spec §4 (검색)** → Task 3 (Browser), Task 5 (Bridge), Task 12 (Desktop)
- **Spec §5 (운영)** → Task 13 (systemd), Task 14 (diary evict), Task 15 (deployment + smoke)
- **Spec §6 invariant** — 각 invariant 가 어느 task 의 acceptance criteria 에서 보장되는지:
  - #1 default OFF — Task 1 (rag undefined when absent)
  - #2 검색 실패 = RAG 없이 진행 — Task 4 (toast + continue)
  - #3 `참고:` 줄 본문 일부 — Task 4 (appendParagraph 한 번)
  - #4 LLM/터미널 제외 — Task 6 (is_special), Task 9, Task 11
  - #5 Ollama bge-m3 — Task 8, Task 13
  - #6 sqlite-vec 단일 파일 — Task 7
  - #7 read-only search — Task 12 (search endpoint 만)
  - #8 bootstrap startup-only — Task 11 (count==0 gate)
  - #9 uid 공유 — Task 11 (config.firebase_uid 재사용)
  - #10 serverUpdatedAt watermark — Task 10
  - #11 Pi proxy only — Task 5 (proxy only)
  - #12 search server no auth — Task 12 (no auth middleware)
  - #13 노트 1개 = 1 chunk — Task 11 (한 노트 1개 임베딩)
- **Spec §7 비-목표** — 의도적으로 task 없음 ✓

### Placeholder scan
- ✓ 모든 step 에 구체적인 코드/명령어/예상 결과
- ✓ "implement later" 류 없음
- ✓ "similar to Task N" 류 없음 — 각 task 가 독립적

### Type consistency
- `LlmNoteSpec.options.rag?: number` (Task 1) → `LlmSendBar` 의 `spec.options.rag` (Task 4) ✓
- `RagHit { guid, title, body, score }` (Task 3) → searchRag 반환 (Task 3) → `LlmSendBar` 사용 (Task 4) ✓
- `RagSearchError.kind` (Task 3) → `LlmSendBar` toast (Task 4) ✓
- Python `ParsedNote(title, body_text, content_hash, is_special)` (Task 6) → `zip_bootstrap`, `indexer.process_event` 모두 같은 필드 사용 ✓
- Python `SearchHit(guid, title, body, score)` (Task 7) → `search_server.SearchResponseItem` (Task 12) 같은 필드 매핑 ✓
- Python `NoteEvent(guid, xml_content, deleted, server_updated_at)` (Task 10) → `process_event` 시그너처 (Task 11) ✓
- `OllamaEmbedder.embed(text) -> list[float]` (Task 8) → `zip_bootstrap`, `process_event`, `search_server` 모두 동일 시그너처 사용 ✓

Plan ready.
