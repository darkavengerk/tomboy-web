# Claude 채팅 노트 (`claude://`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `claude://` 채팅 노트 추가. 모바일/데스크탑에서 노트로 클로드와 대화하고 구독 OAuth 경로(Claude CLI subprocess)를 통해 결제. 기존 `llmNote/`를 `chatNote/`로 일반화하면서 이미지 URL 패스스루까지 지원.

**Architecture:** 앱은 `parseChatNote`가 `llm://` + `claude://`를 모두 인식, `ChatSendBar`가 백엔드 분기. 브릿지에 `/claude/chat` 라우트 추가, 데스크탑에 새 `claude-service` (Node + claude CLI spawn)가 stream-json을 SSE로 변환. 이미지는 Dropbox URL을 Anthropic `image/url` content block으로 직통.

**Tech Stack:** SvelteKit + Svelte 5 runes + TipTap 3 + TypeScript + vitest (앱), node:test (브릿지), Node 22 + Fastify (claude-service), Podman/Quadlet (배포), `@anthropic-ai/claude-code` CLI.

**참조 스펙:** `docs/superpowers/specs/2026-05-23-claude-chat-note-design.md`

---

## File Structure

```
app/src/lib/chatNote/                 (← llmNote/ 리네임 + 확장)
├── parseChatNote.ts                  (← parseLlmNote.ts 리네임 + claude:// 인식)
├── defaults.ts                       (← 분리: chat-common + ollama + claude)
├── buildClaudeMessages.ts            (신규 — Q:/A: → Anthropic messages)
└── backends/
    ├── ollama.ts                     (← sendChat.ts + buildChatRequest.ts + searchRag.ts 통합)
    └── claude.ts                     (신규 — sendClaude, ClaudeChatError, SSE 파서)

app/src/lib/editor/chatNote/          (← editor/llmNote/ 리네임)
├── ChatSendBar.svelte                (← LlmSendBar.svelte 리네임 + 백엔드 분기)
└── chatNotePlugin.ts                 (← llmNotePlugin.ts 리네임)

app/tests/unit/chatNote/              (← unit/llmNote/ 리네임)
├── parseChatNote.test.ts             (기존 + claude:// 케이스)
├── buildClaudeMessages.test.ts       (신규)
└── sendClaude.test.ts                (신규)

bridge/src/
├── claude.ts                         (신규 — POST /claude/chat 프록시)
├── claude.test.ts                    (신규, node:test)
└── server.ts                         (수정 — 라우트 등록 + CLAUDE_SERVICE_URL env)

claude-service/                       (신규 디렉토리 전체)
├── package.json
├── tsconfig.json
├── Containerfile
├── src/
│   ├── server.ts                     (Fastify POST /chat)
│   ├── runner.ts                     (claude CLI spawn + stream-json adapter)
│   └── auth.ts                       (Bearer 검증)
├── tests/
│   ├── runner.test.ts                (vitest + FakeClaudeRunner)
│   └── server.test.ts
└── deploy/
    ├── claude-service.container      (Quadlet unit)
    └── README.md                     (셋업 가이드)
```

**임포트 영향 받는 파일** (Task 1에서 일괄 업데이트):
- `app/src/routes/note/[id]/+page.svelte` — `llmNote` import 경로
- `app/src/lib/desktop/NoteWindow.svelte` — 동일
- `app/src/lib/editor/TomboyEditor.svelte` — 동일
- `app/src/lib/ocrNote/runOcrInEditor.ts` — `sendChat`, `LlmChatError`, `ChatRequestBody` import 경로

---

## Task 1: Refactor — `llmNote/` → `chatNote/` (mechanical rename)

**Goal:** 디렉토리/파일 리네임 + 모든 import 경로 업데이트. 기능 변경 0. 모든 기존 테스트 그대로 통과.

**Files:**
- Move: `app/src/lib/llmNote/` → `app/src/lib/chatNote/`
- Move: `app/src/lib/editor/llmNote/` → `app/src/lib/editor/chatNote/`
- Move: `app/tests/unit/llmNote/` → `app/tests/unit/chatNote/`
- Move: `app/tests/unit/editor/llmNotePlugin.test.ts` → `app/tests/unit/editor/chatNotePlugin.test.ts`
- Rename inside: `parseLlmNote.ts` → `parseChatNote.ts`, `LlmSendBar.svelte` → `ChatSendBar.svelte`, `llmNotePlugin.ts` → `chatNotePlugin.ts`, `parseLlmNote.test.ts` → `parseChatNote.test.ts`
- Modify imports in:
  - `app/src/routes/note/[id]/+page.svelte`
  - `app/src/lib/desktop/NoteWindow.svelte`
  - `app/src/lib/editor/TomboyEditor.svelte`
  - `app/src/lib/ocrNote/runOcrInEditor.ts`
  - All files within renamed directories that import siblings

**Acceptance Criteria:**
- [ ] No file under `app/src/lib/llmNote/` or `app/src/lib/editor/llmNote/` remains
- [ ] No reference to `llmNote/` or `LlmSendBar` or `llmNotePlugin` in code
- [ ] Exported symbols (`parseLlmNote`, `LlmChatError`, `LlmSendBar`, etc.) renamed to `Chat*` equivalents OR temporarily aliased — see step 4
- [ ] `npm run check` passes
- [ ] `npm run test` passes (all existing tests green)
- [ ] `npm run build` succeeds

**Verify:** `cd app && npm run check && npm run test -- --run`

**Steps:**

- [ ] **Step 1: Inventory references to rename**

```bash
cd app
grep -rln "llmNote\|LlmSendBar\|llmNotePlugin\|parseLlmNote\|LlmChatError\|LlmNoteSpec\|LlmHeaderKey\|LlmChatError\|LLM_SIGNATURE_RE\|LLM_HEADER_KEY_RE\|LLM_RECOGNIZED_HEADER_KEYS\|LLM_HEADER_DEFAULTS" src tests
```

Expected output: list of files to touch. Capture this — it's the change set.

- [ ] **Step 2: Move directories using `git mv`**

```bash
cd app
git mv src/lib/llmNote src/lib/chatNote
git mv src/lib/editor/llmNote src/lib/editor/chatNote
git mv tests/unit/llmNote tests/unit/chatNote
git mv tests/unit/editor/llmNotePlugin.test.ts tests/unit/editor/chatNotePlugin.test.ts
```

- [ ] **Step 3: Rename individual files inside the moved directories**

```bash
cd app
git mv src/lib/chatNote/parseLlmNote.ts src/lib/chatNote/parseChatNote.ts
git mv src/lib/editor/chatNote/LlmSendBar.svelte src/lib/editor/chatNote/ChatSendBar.svelte
git mv src/lib/editor/chatNote/llmNotePlugin.ts src/lib/editor/chatNote/chatNotePlugin.ts
git mv tests/unit/chatNote/parseLlmNote.test.ts tests/unit/chatNote/parseChatNote.test.ts
```

- [ ] **Step 4: Rename symbols and update imports**

This is a mechanical search-and-replace. For each mapping below, update every occurrence in `app/src/` and `app/tests/`:

| Old | New |
|---|---|
| `from '$lib/llmNote/parseLlmNote.js'` | `from '$lib/chatNote/parseChatNote.js'` |
| `from '$lib/llmNote/sendChat.js'` | `from '$lib/chatNote/sendChat.js'` (unchanged file inside renamed dir) |
| `from '$lib/llmNote/buildChatRequest.js'` | `from '$lib/chatNote/buildChatRequest.js'` |
| `from '$lib/llmNote/searchRag.js'` | `from '$lib/chatNote/searchRag.js'` |
| `from '$lib/llmNote/defaults.js'` | `from '$lib/chatNote/defaults.js'` |
| `from '$lib/editor/llmNote/llmNotePlugin.js'` | `from '$lib/editor/chatNote/chatNotePlugin.js'` |
| `LlmSendBar` (import + component usage) | `ChatSendBar` |
| `parseLlmNote` (symbol) | `parseChatNote` |
| `LlmChatError` | `LlmChatError` (KEEP — we'll add `ClaudeChatError` later as a sibling, no need to rename) |
| `LlmNoteSpec` | `LlmNoteSpec` (KEEP for now — Task 3 generalizes to `ChatNoteSpec`) |

Note: `LlmChatError` and `LlmNoteSpec` are renamed in Task 3 when we extend the type, not here. This keeps the diff in Task 1 purely mechanical.

For symbol renames inside the moved files themselves:
- `parseLlmNote.ts` → exports `parseLlmNote` function → rename function to `parseChatNote`
- `parseChatNote.test.ts` → imports `parseLlmNote` from new path → rename to `parseChatNote`
- `LlmSendBar.svelte` content: any internal references to its own name don't exist (Svelte components are auto-bound to filename); just save under new name
- `llmNotePlugin.ts` → exports `createLlmNotePlugin` (likely) → rename to `createChatNotePlugin`

Suggested approach using ripgrep-replace:
```bash
cd app
# Symbol-level renames
for f in $(grep -rl "parseLlmNote" src tests); do
  sed -i 's/parseLlmNote/parseChatNote/g' "$f"
done
for f in $(grep -rl "LlmSendBar" src tests); do
  sed -i 's/LlmSendBar/ChatSendBar/g' "$f"
done
for f in $(grep -rl "createLlmNotePlugin\|llmNotePlugin" src tests); do
  sed -i 's/createLlmNotePlugin/createChatNotePlugin/g; s/llmNotePlugin/chatNotePlugin/g' "$f"
done
# Import path renames
for f in $(grep -rl "lib/llmNote\|editor/llmNote" src tests); do
  sed -i 's|lib/llmNote|lib/chatNote|g; s|editor/llmNote|editor/chatNote|g' "$f"
done
```

- [ ] **Step 5: Run check + tests**

Run: `cd app && npm run check`
Expected: 0 errors. If errors mention symbols not yet covered, do another sed pass.

Run: `cd app && npm run test -- --run`
Expected: all tests green. The `parseChatNote.test.ts` (renamed from `parseLlmNote.test.ts`) and other tests pass without modification.

- [ ] **Step 6: Smoke verify llm:// notes still work**

Manual: `npm run dev`, open existing `llm://` note, click 보내기. Expected: Ollama response streams normally.

If this fails, the refactor regressed something — investigate before commit.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(chatNote): llmNote → chatNote rename, no behavior change

Mechanical rename of app/src/lib/llmNote/, app/src/lib/editor/llmNote/,
app/tests/unit/llmNote/ to chatNote/. Symbols parseLlmNote, LlmSendBar,
llmNotePlugin renamed to chat-prefixed. LlmChatError and LlmNoteSpec kept
as-is until Task 3 generalizes them with claude:// backend support.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Reorganize — `backends/ollama.ts` consolidation

**Goal:** `chatNote/sendChat.ts` + `chatNote/buildChatRequest.ts` + `chatNote/searchRag.ts` 를 `chatNote/backends/ollama.ts` 단일 파일로 통합. 향후 `backends/claude.ts` 와 대칭 구조. 기능 변경 0.

**Files:**
- Create: `app/src/lib/chatNote/backends/ollama.ts` — 세 파일 내용 합쳐 export
- Delete: `app/src/lib/chatNote/sendChat.ts`, `app/src/lib/chatNote/buildChatRequest.ts`, `app/src/lib/chatNote/searchRag.ts`
- Modify imports:
  - `app/src/lib/editor/chatNote/ChatSendBar.svelte`
  - `app/src/lib/ocrNote/runOcrInEditor.ts`
  - 기타 grep으로 찾은 파일들

**Acceptance Criteria:**
- [ ] `backends/ollama.ts`에서 export: `sendChat`, `LlmChatError`, `buildChatRequest`, `ChatRequestBody`, `searchRag`, `RagSearchError`, `RagHit`
- [ ] 세 원본 파일 삭제됨
- [ ] 모든 import가 새 경로로 업데이트
- [ ] `npm run check` 통과
- [ ] `npm run test` 통과
- [ ] 기존 `llm://` 노트로 보내기 수동 검증 통과

**Verify:** `cd app && npm run check && npm run test -- --run`

**Steps:**

- [ ] **Step 1: Create `backends/ollama.ts` by concatenating the three files**

```bash
mkdir -p app/src/lib/chatNote/backends
```

Create `app/src/lib/chatNote/backends/ollama.ts` with the following structure:

```ts
// Ollama backend for chatNote.
//
// Consolidates the previous sendChat.ts (HTTP streaming client),
// buildChatRequest.ts (request body builder), searchRag.ts (RAG retrieval)
// into one file. These three were only ever used together as the Ollama
// backend; co-locating them mirrors backends/claude.ts.
//
// Re-exports are alphabetical; new code should import from
// '$lib/chatNote/backends/ollama.js' (not from this file's removed
// predecessors).

// ─── from sendChat.ts ──────────────────────────────────────────
export class LlmChatError extends Error {
  constructor(
    public kind:
      | 'unauthorized' | 'model_not_found' | 'ollama_unavailable'
      | 'bad_request' | 'upstream_error' | 'network',
    public model?: string,
    detail?: string,
  ) {
    super(`${kind}${detail ? `: ${detail}` : ''}`);
  }
}

// ... (paste sendChat function body verbatim from sendChat.ts)

// ─── from buildChatRequest.ts ──────────────────────────────────
export interface ChatRequestBody { /* ... verbatim ... */ }

export function buildChatRequest(spec: LlmNoteSpec): ChatRequestBody { /* ... */ }

// ─── from searchRag.ts ─────────────────────────────────────────
export interface RagHit { /* ... */ }
export class RagSearchError extends Error { /* ... */ }
export async function searchRag(opts: { /* ... */ }): Promise<RagHit[]> { /* ... */ }
```

Copy each file's contents verbatim (with their existing imports adjusted to relative paths within the new directory, e.g., `from '../parseChatNote.js'` instead of `./parseChatNote.js`).

- [ ] **Step 2: Update imports across the codebase**

```bash
cd app
# Old paths → new path
for f in $(grep -rl "lib/chatNote/sendChat\|lib/chatNote/buildChatRequest\|lib/chatNote/searchRag" src tests); do
  sed -i \
    -e 's|lib/chatNote/sendChat|lib/chatNote/backends/ollama|g' \
    -e 's|lib/chatNote/buildChatRequest|lib/chatNote/backends/ollama|g' \
    -e 's|lib/chatNote/searchRag|lib/chatNote/backends/ollama|g' \
    "$f"
done
```

Files that should change at minimum:
- `app/src/lib/editor/chatNote/ChatSendBar.svelte`
- `app/src/lib/ocrNote/runOcrInEditor.ts`

- [ ] **Step 3: Delete the three old files**

```bash
cd app
git rm src/lib/chatNote/sendChat.ts \
       src/lib/chatNote/buildChatRequest.ts \
       src/lib/chatNote/searchRag.ts
```

- [ ] **Step 4: Run check + tests**

Run: `cd app && npm run check`
Expected: 0 errors. If errors complain about missing exports from ollama.ts, ensure all symbols were copied.

Run: `cd app && npm run test -- --run`
Expected: all tests green. RAG test files (if any) and sendChat tests (if any) continue to import from `backends/ollama.js`.

- [ ] **Step 5: Smoke test**

Manual: `npm run dev`, open `llm://` note with RAG enabled, send a query. Expected: RAG search runs, retrieved notes shown, response streams normally.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(chatNote): consolidate ollama backend into backends/ollama.ts

Three Ollama-specific files (sendChat, buildChatRequest, searchRag) merged
into one backend module. Mirrors the structure backends/claude.ts will
take. No behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Parser — `claude://` signature + headers + backend field

**Goal:** `parseChatNote` 가 `llm://` 와 `claude://` 둘 다 인식. `ChatNoteSpec` 타입에 `backend: 'ollama' | 'claude'` 필드 추가. Claude 전용 헤더(`cwd`, `allowedTools`) 파싱.

**Files:**
- Modify: `app/src/lib/chatNote/parseChatNote.ts` — backend 분기, claude 헤더
- Modify: `app/src/lib/chatNote/defaults.ts` — CLAUDE_HEADER_KEY_RE, CHAT_SIGNATURE_RE
- Modify: `app/src/lib/chatNote/backends/ollama.ts` — `LlmNoteSpec` 를 `ChatNoteSpec` 으로 마이그레이션 (또는 호환 alias)
- Modify: `app/tests/unit/chatNote/parseChatNote.test.ts` — claude:// 테스트 추가

**Acceptance Criteria:**
- [ ] `parseChatNote(claude://)` 가 `{backend: 'claude', model: '', ...}` 리턴
- [ ] `parseChatNote(claude://opus)` 가 `{backend: 'claude', model: 'opus', ...}` 리턴
- [ ] `parseChatNote(llm://...)` 는 기존 동작 그대로 (`{backend: 'ollama', ...}` 추가만)
- [ ] `cwd:` 헤더 파싱 — 절대경로 문자열 그대로 보존
- [ ] `allowedTools:` 헤더 파싱 — 콤마 분리해서 배열로
- [ ] `rag:` 가 `claude://` 노트에 있어도 무시됨 (옵션에 들어가지 않음)
- [ ] `cwd:` 가 `llm://` 노트에 있어도 무시됨
- [ ] 알 수 없는 헤더 키 = 조용히 drop
- [ ] 모든 기존 `llmNote` 테스트 통과 (호환성)

**Verify:** `cd app && npm run test -- --run chatNote/parseChatNote`

**Steps:**

- [ ] **Step 1: Update `defaults.ts`**

Edit `app/src/lib/chatNote/defaults.ts`:

```ts
/**
 * Matches the chat note signature line for both backends:
 *   llm://qwen2.5-coder:3b       (ollama: model required)
 *   claude://                     (claude: model optional → CLI default)
 *   claude://opus                 (claude: shortname)
 *   claude://claude-opus-4-7      (claude: full model id)
 */
export const CHAT_SIGNATURE_RE =
  /^(llm|claude):\/\/([A-Za-z0-9._:/-]+)?\s*$/;

/**
 * Per-backend header key sets. Keys not in the active set are silently
 * ignored (no warning) — this lets users keep headers when switching
 * backends without losing data, and avoids cross-backend confusion.
 */
export const OLLAMA_HEADER_KEY_RE =
  /^(system|temperature|num_ctx|top_p|seed|num_predict|rag):\s*(.*)$/;

export const CLAUDE_HEADER_KEY_RE =
  /^(system|model|cwd|allowedTools):\s*(.*)$/;

export const OLLAMA_RECOGNIZED_HEADER_KEYS = [
  'system', 'temperature', 'num_ctx', 'top_p', 'seed', 'num_predict', 'rag',
] as const;
export type OllamaHeaderKey = (typeof OLLAMA_RECOGNIZED_HEADER_KEYS)[number];

export const CLAUDE_RECOGNIZED_HEADER_KEYS = [
  'system', 'model', 'cwd', 'allowedTools',
] as const;
export type ClaudeHeaderKey = (typeof CLAUDE_RECOGNIZED_HEADER_KEYS)[number];

/** Backwards-compat alias — old code still references this. */
export const LLM_SIGNATURE_RE = /^llm:\/\/([A-Za-z0-9._:/-]+)\s*$/;
export const LLM_HEADER_KEY_RE = OLLAMA_HEADER_KEY_RE;
export const LLM_RECOGNIZED_HEADER_KEYS = OLLAMA_RECOGNIZED_HEADER_KEYS;
export type LlmHeaderKey = OllamaHeaderKey;

export const LLM_HEADER_DEFAULTS = {
  system: '',
  temperature: 0.3,
  num_ctx: 4096,
} as const;
```

- [ ] **Step 2: Update `parseChatNote.ts` type**

Edit `app/src/lib/chatNote/parseChatNote.ts`:

```ts
import type { JSONContent } from '@tiptap/core';
import {
  CHAT_SIGNATURE_RE,
  OLLAMA_HEADER_KEY_RE,
  CLAUDE_HEADER_KEY_RE,
  type OllamaHeaderKey,
  type ClaudeHeaderKey,
} from './defaults.js';

export type ChatBackend = 'ollama' | 'claude';

export interface ChatNoteSpec {
  backend: ChatBackend;
  model: string;                       // ollama: 필수; claude: 빈 문자열 가능
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  trailingEmptyUserTurn: boolean;
  options: {
    // ollama
    temperature?: number;
    num_ctx?: number;
    top_p?: number;
    seed?: number;
    num_predict?: number;
    rag?: number;
    // claude
    cwd?: string;
    allowedTools?: string[];
  };
}

/** Backwards-compat alias used by ollama backend. */
export type LlmNoteSpec = ChatNoteSpec;
```

- [ ] **Step 3: Update `parseChatNote.ts` signature detection**

Replace the signature-detection block:

```ts
export function parseChatNote(doc: JSONContent | null | undefined): ChatNoteSpec | null {
  if (!doc || !Array.isArray(doc.content) || doc.content.length === 0) return null;

  // Find signature at doc.content[1] preferred, doc.content[0] tolerated.
  let sigIndex: number;
  let backend: ChatBackend;
  let model: string;

  const c1FirstLine = doc.content.length > 1 ? paragraphLines(doc.content[1])[0] ?? '' : '';
  const m1 = CHAT_SIGNATURE_RE.exec(c1FirstLine);
  if (m1) {
    sigIndex = 1;
    backend = m1[1] as ChatBackend;
    model = m1[2] ?? '';
  } else {
    const c0FirstLine = paragraphLines(doc.content[0])[0] ?? '';
    const m0 = CHAT_SIGNATURE_RE.exec(c0FirstLine);
    if (!m0) return null;
    sigIndex = 0;
    backend = m0[1] as ChatBackend;
    model = m0[2] ?? '';
  }

  // `llm://` requires a model; `claude://` does not.
  if (backend === 'ollama' && !model) return null;
  // ...
}
```

- [ ] **Step 4: Update header parsing for backend-specific keys**

In the header-line loop, switch to the backend-appropriate regex:

```ts
const headerKeyRe = backend === 'ollama' ? OLLAMA_HEADER_KEY_RE : CLAUDE_HEADER_KEY_RE;

for (const line of headerLines) {
  const keyMatch = headerKeyRe.exec(line);
  if (keyMatch) {
    flushKey();
    currentKey = keyMatch[1];          // string, narrowed by handler below
    currentValueLines = [keyMatch[2]];
  } else if (currentKey !== null) {
    const stripped = line.replace(/^\s+/, '');
    currentValueLines.push(stripped);
  }
}
flushKey();
```

Update `flushKey` to dispatch by backend-specific keys:

```ts
const flushKey = (): void => {
  if (currentKey === null) return;
  const value = currentValueLines.join('\n');

  if (currentKey === 'system') {
    result.system = value;
  } else if (backend === 'claude' && currentKey === 'model') {
    const trimmed = value.trim();
    if (trimmed) result.model = trimmed;       // header overrides signature
  } else if (backend === 'claude' && currentKey === 'cwd') {
    const trimmed = value.trim();
    if (trimmed) result.options.cwd = trimmed;
  } else if (backend === 'claude' && currentKey === 'allowedTools') {
    const list = value.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length > 0) result.options.allowedTools = list;
  } else if (backend === 'ollama' && currentKey === 'rag') {
    // keep existing rag logic verbatim
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'on') result.options.rag = 5;
    else if (trimmed !== 'off' && trimmed !== '') {
      const n = parseInt(trimmed, 10);
      if (Number.isFinite(n)) result.options.rag = Math.min(Math.max(n, 1), 20);
    }
  } else if (backend === 'ollama') {
    // numeric ollama options (temperature, num_ctx, top_p, seed, num_predict)
    const trimmed = value.trim();
    const isInt = currentKey === 'num_ctx' || currentKey === 'seed' || currentKey === 'num_predict';
    const n = isInt ? parseInt(trimmed, 10) : parseFloat(trimmed);
    if (Number.isFinite(n)) {
      (result.options as Record<string, number>)[currentKey] = n;
    }
  }
  currentKey = null;
  currentValueLines = [];
};
```

- [ ] **Step 5: Write tests FIRST (TDD)**

Append to `app/tests/unit/chatNote/parseChatNote.test.ts`:

```ts
describe('parseChatNote — claude:// backend', () => {
  it('recognizes claude:// with no model', () => {
    const r = parseChatNote(doc('타이틀', 'claude://'));
    expect(r).not.toBeNull();
    expect(r!.backend).toBe('claude');
    expect(r!.model).toBe('');
  });

  it('recognizes claude://opus shortname', () => {
    const r = parseChatNote(doc('타이틀', 'claude://opus'));
    expect(r!.backend).toBe('claude');
    expect(r!.model).toBe('opus');
  });

  it('recognizes claude://full-model-id', () => {
    const r = parseChatNote(doc('타이틀', 'claude://claude-opus-4-7'));
    expect(r!.model).toBe('claude-opus-4-7');
  });

  it('parses cwd: header', () => {
    const r = parseChatNote(
      doc('t', 'claude://', 'cwd: /home/jh/workspace/foo')
    );
    expect(r!.options.cwd).toBe('/home/jh/workspace/foo');
  });

  it('parses allowedTools: header into array', () => {
    const r = parseChatNote(
      doc('t', 'claude://', 'cwd: /tmp', 'allowedTools: Read, Bash, Edit')
    );
    expect(r!.options.allowedTools).toEqual(['Read', 'Bash', 'Edit']);
  });

  it('ignores rag: header on claude:// note', () => {
    const r = parseChatNote(doc('t', 'claude://', 'rag: on'));
    expect(r!.options.rag).toBeUndefined();
  });

  it('ignores cwd: header on llm:// note', () => {
    const r = parseChatNote(doc('t', 'llm://qwen2.5', 'cwd: /tmp'));
    expect((r!.options as { cwd?: string }).cwd).toBeUndefined();
  });

  it('header model: overrides signature model', () => {
    const r = parseChatNote(
      doc('t', 'claude://opus', 'model: claude-opus-4-7')
    );
    expect(r!.model).toBe('claude-opus-4-7');
  });

  it('claude:// preserves Q:/A: turn parsing (same as llm://)', () => {
    const r = parseChatNote(
      doc('t', 'claude://', '', 'Q: hello', 'A: hi', 'Q: what is 2+2', 'Q: ')
    );
    expect(r!.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'what is 2+2' },
    ]);
    expect(r!.trailingEmptyUserTurn).toBe(true);
  });
});

describe('parseChatNote — backwards compat with llm://', () => {
  it('returns backend: "ollama" for llm:// notes', () => {
    const r = parseChatNote(doc('t', 'llm://qwen2.5'));
    expect(r!.backend).toBe('ollama');
  });

  it('all existing llm:// tests still pass (this file)', () => {
    // sentinel — the rest of this file's tests should pass unchanged
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 6: Run tests — expected to fail initially, then pass**

```bash
cd app && npm run test -- --run chatNote/parseChatNote
```

Initial run (before Steps 1-4 fully applied): some new tests fail with type errors or wrong backend.
After all steps applied: green.

- [ ] **Step 7: Run full test suite + check**

```bash
cd app && npm run check && npm run test -- --run
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(chatNote): parse claude:// signature + claude-specific headers

parseChatNote now returns ChatBackend ∈ {ollama, claude}. Claude headers
(cwd, allowedTools) parsed; ollama-only headers (temperature, rag, etc.)
silently ignored on claude:// notes and vice versa. Q:/A: turn parsing
unchanged. LlmNoteSpec kept as alias for ChatNoteSpec for compat with
backends/ollama.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Client — `buildClaudeMessages` + `backends/claude.ts`

**Goal:** Q:/A: 턴을 Anthropic content block 배열로 직렬화하는 `buildClaudeMessages`, 그리고 SSE 스트림 소비자 `sendClaude` + `ClaudeChatError` 신설.

**Files:**
- Create: `app/src/lib/chatNote/buildClaudeMessages.ts`
- Create: `app/src/lib/chatNote/backends/claude.ts`
- Create: `app/tests/unit/chatNote/buildClaudeMessages.test.ts`
- Create: `app/tests/unit/chatNote/sendClaude.test.ts`

**Acceptance Criteria:**
- [ ] `buildClaudeMessages(doc, spec)` 가 `{role, content[]}` 배열 리턴
- [ ] 텍스트만 turn → text block 1개
- [ ] 텍스트 + 이미지 URL → text/image block 순서 보존
- [ ] 이미지 식별: `tomboyUrlLink` 마크 + 확장자 `.png|.jpg|.jpeg|.gif|.webp|.svg`
- [ ] 연속 이미지 사이 빈 text block 안 끼움
- [ ] `Q: ` / `A: ` 프리픽스는 content에서 제외, role로만 표현
- [ ] hardBreak → `\n`
- [ ] `sendClaude` 가 SSE delta 파싱해서 `onToken` 호출
- [ ] `done` 이벤트로 정상 종료
- [ ] HTTP 401/503/429/413/500 → 적절한 `ClaudeChatErrorKind` throw
- [ ] AbortSignal → fetch abort + reason 'abort'

**Verify:** `cd app && npm run test -- --run chatNote`

**Steps:**

- [ ] **Step 1: Write `buildClaudeMessages.test.ts` first (TDD)**

Create `app/tests/unit/chatNote/buildClaudeMessages.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { buildClaudeMessages } from '$lib/chatNote/buildClaudeMessages.js';

function textPara(text: string): JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function imageLinkPara(url: string, prefix = ''): JSONContent {
  const content: JSONContent[] = [];
  if (prefix) content.push({ type: 'text', text: prefix });
  content.push({
    type: 'text',
    text: url,
    marks: [{ type: 'tomboyUrlLink', attrs: { href: url } }],
  });
  return { type: 'paragraph', content };
}

function docFrom(...paras: JSONContent[]): JSONContent {
  return { type: 'doc', content: paras };
}

describe('buildClaudeMessages', () => {
  it('text-only Q produces single text block', () => {
    const d = docFrom(
      textPara('title'),
      textPara('claude://'),
      textPara(''),
      textPara('Q: hello'),
    );
    const msgs = buildClaudeMessages(d);
    expect(msgs).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('Q + A + Q produces three messages', () => {
    const d = docFrom(
      textPara('title'),
      textPara('claude://'),
      textPara(''),
      textPara('Q: hi'),
      textPara('A: hello!'),
      textPara('Q: what is 2+2'),
    );
    const msgs = buildClaudeMessages(d);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[2].role).toBe('user');
    expect(msgs[2].content).toEqual([{ type: 'text', text: 'what is 2+2' }]);
  });

  it('image URL in Q produces image content block', () => {
    const d = docFrom(
      textPara('title'),
      textPara('claude://'),
      textPara(''),
      imageLinkPara('https://dropbox.com/scl/foo/img.png?raw=1', 'Q: '),
    );
    const msgs = buildClaudeMessages(d);
    expect(msgs[0].content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://dropbox.com/scl/foo/img.png?raw=1' } },
    ]);
  });

  it('text + image + text in one Q preserves order', () => {
    const url = 'https://dropbox.com/foo.jpg?raw=1';
    const d: JSONContent = {
      type: 'doc',
      content: [
        textPara('title'),
        textPara('claude://'),
        textPara(''),
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Q: look at ' },
            { type: 'text', text: url, marks: [{ type: 'tomboyUrlLink', attrs: { href: url } }] },
            { type: 'text', text: ' and tell me' },
          ],
        },
      ],
    };
    const msgs = buildClaudeMessages(d);
    expect(msgs[0].content).toEqual([
      { type: 'text', text: 'look at ' },
      { type: 'image', source: { type: 'url', url } },
      { type: 'text', text: ' and tell me' },
    ]);
  });

  it('non-image URL stays as text', () => {
    const url = 'https://example.com/page';
    const d: JSONContent = {
      type: 'doc',
      content: [
        textPara('title'),
        textPara('claude://'),
        textPara(''),
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Q: see ' },
            { type: 'text', text: url, marks: [{ type: 'tomboyUrlLink', attrs: { href: url } }] },
          ],
        },
      ],
    };
    const msgs = buildClaudeMessages(d);
    expect(msgs[0].content).toEqual([
      { type: 'text', text: `see ${url}` },
    ]);
  });

  it('hardBreak becomes \\n', () => {
    const d: JSONContent = {
      type: 'doc',
      content: [
        textPara('t'),
        textPara('claude://'),
        textPara(''),
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Q: line 1' },
            { type: 'hardBreak' },
            { type: 'text', text: 'line 2' },
          ],
        },
      ],
    };
    const msgs = buildClaudeMessages(d);
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'line 1\nline 2' }]);
  });

  it('multi-paragraph Q joins with \\n', () => {
    const d = docFrom(
      textPara('t'),
      textPara('claude://'),
      textPara(''),
      textPara('Q: line 1'),
      textPara('line 2'),
      textPara('line 3'),
    );
    const msgs = buildClaudeMessages(d);
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'line 1\nline 2\nline 3' }]);
  });

  it('Q: prefix is stripped (role becomes user)', () => {
    const d = docFrom(textPara('t'), textPara('claude://'), textPara(''), textPara('Q: hello'));
    const msgs = buildClaudeMessages(d);
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(msgs[0].role).toBe('user');
  });

  it('empty trailing Q (boundary case) produces empty user content', () => {
    const d = docFrom(textPara('t'), textPara('claude://'), textPara(''), textPara('Q:'));
    const msgs = buildClaudeMessages(d);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toEqual([{ type: 'text', text: '' }]);
  });

  it('returns empty array when no turns', () => {
    const d = docFrom(textPara('t'), textPara('claude://'));
    const msgs = buildClaudeMessages(d);
    expect(msgs).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify tests fail (function doesn't exist yet)**

Run: `cd app && npm run test -- --run chatNote/buildClaudeMessages`
Expected: FAIL — `Cannot resolve '$lib/chatNote/buildClaudeMessages.js'`

- [ ] **Step 3: Implement `buildClaudeMessages.ts`**

Create `app/src/lib/chatNote/buildClaudeMessages.ts`:

```ts
import type { JSONContent } from '@tiptap/core';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'url'; url: string } };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i;

function isImageUrl(href: string): boolean {
  return IMG_EXT_RE.test(href);
}

function paragraphInlines(block: JSONContent): JSONContent[] {
  return Array.isArray(block.content) ? block.content : [];
}

function paragraphText(block: JSONContent): string {
  let out = '';
  for (const c of paragraphInlines(block)) {
    if (c.type === 'text') out += c.text ?? '';
    else if (c.type === 'hardBreak') out += '\n';
  }
  return out;
}

/**
 * Skip the header region of a chat note doc. Returns the doc.content index
 * where turn paragraphs start (the first blank paragraph after the
 * signature, or `doc.content.length` if no blank seen).
 */
function findTurnStart(doc: JSONContent): number {
  if (!Array.isArray(doc.content) || doc.content.length === 0) return 0;
  // Skip title (0). Signature is at 1 (or 0 in transient state).
  let i = 1;
  // If signature is at 0, header starts at 1.
  for (; i < doc.content.length; i++) {
    if (paragraphText(doc.content[i]) === '') return i + 1;
  }
  return doc.content.length;
}

/** Append a text run to the last block if that's a text block; else push a new text block. */
function appendText(blocks: ContentBlock[], text: string): void {
  if (text === '') return;
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') {
    last.text += text;
  } else {
    blocks.push({ type: 'text', text });
  }
}

/** Convert a stream of inline nodes (across one or more paragraphs) into ContentBlock[]. */
function inlinesToBlocks(inlineStream: JSONContent[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const node of inlineStream) {
    if (node.type === 'hardBreak') {
      appendText(blocks, '\n');
      continue;
    }
    if (node.type !== 'text') continue;
    const marks = (node.marks ?? []) as Array<{ type: string; attrs?: { href?: string } }>;
    const urlMark = marks.find(m => m.type === 'tomboyUrlLink');
    const href = urlMark?.attrs?.href ?? node.text ?? '';
    if (urlMark && isImageUrl(href)) {
      blocks.push({ type: 'image', source: { type: 'url', url: href } });
    } else {
      appendText(blocks, node.text ?? '');
    }
  }
  return blocks;
}

/**
 * Build Anthropic-format messages array from a chat note doc.
 *
 * Walks paragraphs after the signature/header region. Q:/A: prefixed
 * paragraphs start a new turn (the prefix is stripped). Subsequent
 * non-prefixed paragraphs in the same turn are joined with '\n'.
 *
 * Within a turn, inline nodes are flattened to content blocks: text is
 * accumulated, but a `tomboyUrlLink` mark with an image-extension href
 * becomes an `image` block (URL passed through to Anthropic, which
 * fetches it server-side).
 */
export function buildClaudeMessages(doc: JSONContent): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  const turnStart = findTurnStart(doc);
  const blocks = Array.isArray(doc.content) ? doc.content : [];

  let currentRole: 'user' | 'assistant' | null = null;
  let currentInlines: JSONContent[] = [];

  const flush = (): void => {
    if (currentRole === null) return;
    messages.push({
      role: currentRole,
      content: inlinesToBlocks(currentInlines),
    });
    currentRole = null;
    currentInlines = [];
  };

  for (let i = turnStart; i < blocks.length; i++) {
    const para = blocks[i];
    if (para.type !== 'paragraph') continue;
    const inlines = paragraphInlines(para);
    const text = paragraphText(para);

    // Detect Q:/A: prefix on the first text inline of the paragraph.
    const firstTextInline = inlines.find(n => n.type === 'text');
    const firstText = firstTextInline?.text ?? '';

    let newRole: 'user' | 'assistant' | null = null;
    let prefixLen = 0;
    if (firstText.startsWith('Q: ')) {
      newRole = 'user';
      prefixLen = 3;
    } else if (firstText === 'Q:') {
      newRole = 'user';
      prefixLen = 2;
    } else if (firstText.startsWith('A: ')) {
      newRole = 'assistant';
      prefixLen = 3;
    } else if (firstText === 'A:') {
      newRole = 'assistant';
      prefixLen = 2;
    }

    if (newRole !== null) {
      flush();
      currentRole = newRole;
      // Reconstruct inlines for the current turn, stripping the prefix from
      // the first text node.
      const stripped = inlines.map((n, idx) => {
        if (idx === 0 && n === firstTextInline) {
          return { ...n, text: (n.text ?? '').slice(prefixLen) };
        }
        return n;
      });
      // Filter out an empty first text node (when prefix was the whole inline).
      const cleaned = stripped[0] && stripped[0].type === 'text' && stripped[0].text === ''
        ? stripped.slice(1)
        : stripped;
      currentInlines.push(...cleaned);
    } else if (currentRole !== null) {
      // Continuation paragraph — join with newline.
      currentInlines.push({ type: 'hardBreak' }, ...inlines);
    }
    // Paragraphs before any Q:/A: are ignored (shouldn't happen given
    // findTurnStart, but defensive).
    void text;
  }
  flush();

  return messages;
}
```

- [ ] **Step 4: Run tests — expected to pass**

Run: `cd app && npm run test -- --run chatNote/buildClaudeMessages`
Expected: all green.

- [ ] **Step 5: Write `sendClaude.test.ts`**

Create `app/tests/unit/chatNote/sendClaude.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendClaude, ClaudeChatError } from '$lib/chatNote/backends/claude.js';

// Helper: build a Response with a streaming SSE body.
function sseResponse(lines: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('sendClaude', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('accumulates text deltas via onToken and resolves with done', async () => {
    fetchSpy.mockResolvedValue(
      sseResponse([
        'data: {"delta":"hello"}',
        'data: {"delta":" world"}',
        'data: {"done":true,"reason":"success"}',
      ])
    );
    const tokens: string[] = [];
    const r = await sendClaude({
      url: 'https://bridge/claude/chat',
      token: 'tok',
      body: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      onToken: (d) => tokens.push(d),
    });
    expect(tokens.join('')).toBe('hello world');
    expect(r.reason).toBe('done');
  });

  it('throws ClaudeChatError(unauthorized) on 401', async () => {
    fetchSpy.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    await expect(
      sendClaude({ url: 'x', token: 'y', body: { messages: [] }, onToken: () => {} })
    ).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('throws ClaudeChatError(service_unavailable) on 503', async () => {
    fetchSpy.mockResolvedValue(new Response('{"error":"claude_service_not_configured"}', { status: 503 }));
    await expect(
      sendClaude({ url: 'x', token: 'y', body: { messages: [] }, onToken: () => {} })
    ).rejects.toMatchObject({ kind: 'service_unavailable' });
  });

  it('throws ClaudeChatError(rate_limited) on 429', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(
      sendClaude({ url: 'x', token: 'y', body: { messages: [] }, onToken: () => {} })
    ).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('throws ClaudeChatError(payload_too_large) on 413', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 413 }));
    await expect(
      sendClaude({ url: 'x', token: 'y', body: { messages: [] }, onToken: () => {} })
    ).rejects.toMatchObject({ kind: 'payload_too_large' });
  });

  it('throws ClaudeChatError(stream_error) when stream ends without done', async () => {
    fetchSpy.mockResolvedValue(
      sseResponse([
        'data: {"delta":"partial"}',
      ])
    );
    await expect(
      sendClaude({ url: 'x', token: 'y', body: { messages: [] }, onToken: () => {} })
    ).rejects.toMatchObject({ kind: 'stream_error' });
  });

  it('throws ClaudeChatError(cli_failed) on error event with detail', async () => {
    fetchSpy.mockResolvedValue(
      sseResponse([
        'data: {"delta":"some output"}',
        'data: {"error":"claude exit 1: command not found"}',
      ])
    );
    const err = await sendClaude({
      url: 'x', token: 'y', body: { messages: [] }, onToken: () => {}
    }).catch(e => e);
    expect(err).toBeInstanceOf(ClaudeChatError);
    expect(err.kind).toBe('cli_failed');
    expect(err.detail).toContain('command not found');
  });

  it('propagates AbortSignal to fetch and resolves with abort reason', async () => {
    const ctrl = new AbortController();
    fetchSpy.mockImplementation((_url: RequestInfo, init?: RequestInit) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    setTimeout(() => ctrl.abort(), 10);
    const r = await sendClaude({
      url: 'x', token: 'y', body: { messages: [] }, onToken: () => {}, signal: ctrl.signal,
    });
    expect(r.reason).toBe('abort');
  });

  it('sends Bearer header and JSON body', async () => {
    fetchSpy.mockResolvedValue(sseResponse(['data: {"done":true,"reason":"success"}']));
    await sendClaude({
      url: 'https://example/claude/chat',
      token: 'mytoken',
      body: {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        model: 'opus',
        cwd: '/tmp',
      },
      onToken: () => {},
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe('https://example/claude/chat');
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string,string>).Authorization).toBe('Bearer mytoken');
    expect(JSON.parse(init.body as string)).toMatchObject({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      model: 'opus',
      cwd: '/tmp',
    });
  });
});
```

- [ ] **Step 6: Verify tests fail (sendClaude doesn't exist)**

Run: `cd app && npm run test -- --run chatNote/sendClaude`
Expected: FAIL.

- [ ] **Step 7: Implement `backends/claude.ts`**

Create `app/src/lib/chatNote/backends/claude.ts`:

```ts
import type { AnthropicMessage } from '../buildClaudeMessages.js';

export type ClaudeChatErrorKind =
  | 'unauthorized'
  | 'service_unavailable'
  | 'rate_limited'
  | 'cli_failed'
  | 'bad_request'
  | 'payload_too_large'
  | 'upstream_error'
  | 'stream_error'
  | 'network';

export class ClaudeChatError extends Error {
  constructor(public kind: ClaudeChatErrorKind, public detail?: string) {
    super(`${kind}${detail ? `: ${detail}` : ''}`);
  }
}

export interface ClaudeChatBody {
  messages: AnthropicMessage[];
  model?: string;
  system?: string;
  cwd?: string;
  allowedTools?: string[];
}

export interface SendClaudeResult {
  reason: 'done' | 'abort';
}

export interface SendClaudeOpts {
  url: string;
  token: string;
  body: ClaudeChatBody;
  onToken: (delta: string) => void;
  signal?: AbortSignal;
}

const STATUS_TO_KIND: Record<number, ClaudeChatErrorKind> = {
  401: 'unauthorized',
  413: 'payload_too_large',
  429: 'rate_limited',
  503: 'service_unavailable',
};

export async function sendClaude(opts: SendClaudeOpts): Promise<SendClaudeResult> {
  let res: Response;
  try {
    res = await fetch(opts.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { reason: 'abort' };
    }
    throw new ClaudeChatError('network', (err as Error).message);
  }

  if (!res.ok) {
    const kind = STATUS_TO_KIND[res.status] ??
      (res.status >= 500 ? 'upstream_error' : 'bad_request');
    let detail: string | undefined;
    try {
      const text = await res.text();
      detail = text.slice(0, 200);
    } catch { /* ignore */ }
    throw new ClaudeChatError(kind, detail);
  }

  // Parse SSE: each event is "data: <json>\n\n"
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let sawDone = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nlnl: number;
      while ((nlnl = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, nlnl).trimEnd();
        buf = buf.slice(nlnl + 2);
        if (!event.startsWith('data:')) continue;
        const json = event.slice(5).trim();
        if (!json) continue;
        let parsed: { delta?: string; done?: boolean; reason?: string; error?: string };
        try {
          parsed = JSON.parse(json);
        } catch {
          continue;            // malformed event line — skip
        }
        if (parsed.error) {
          throw new ClaudeChatError('cli_failed', parsed.error);
        }
        if (parsed.delta !== undefined) {
          opts.onToken(parsed.delta);
        }
        if (parsed.done) {
          sawDone = true;
        }
      }
    }
  } catch (err) {
    if (err instanceof ClaudeChatError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { reason: 'abort' };
    }
    throw new ClaudeChatError('stream_error', (err as Error).message);
  }

  if (!sawDone) {
    throw new ClaudeChatError('stream_error', 'stream ended without done');
  }
  return { reason: 'done' };
}
```

- [ ] **Step 8: Run tests — expected to pass**

Run: `cd app && npm run test -- --run chatNote`
Expected: all green (buildClaudeMessages + sendClaude tests).

- [ ] **Step 9: Run full check**

Run: `cd app && npm run check`
Expected: 0 errors.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(chatNote): add claude backend (sendClaude + buildClaudeMessages)

buildClaudeMessages serializes Q:/A: turns into Anthropic content-block
format, recognizing tomboyUrlLink + image extension as image/url blocks.
backends/claude.ts implements SSE-streaming sendClaude with full
ClaudeChatError discrimination and AbortSignal support.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: UI — `ChatSendBar` backend branching

**Goal:** `ChatSendBar.svelte` 가 `spec.backend` 보고 분기. claude 백엔드면 `sendClaude` 호출, 기존 ollama 경로는 그대로.

**Files:**
- Modify: `app/src/lib/editor/chatNote/ChatSendBar.svelte`
- Create: `app/tests/unit/editor/chatNote/ChatSendBar.test.ts` (시간 허락하면; svelte 컴포넌트 테스트는 setup 부담이 크면 통합 검증으로 대체)

**Acceptance Criteria:**
- [ ] `parseChatNote()` 결과의 `backend === 'claude'` 면 `sendClaude` 호출
- [ ] `backend === 'ollama'` 면 기존 `sendChat` 호출 경로 그대로
- [ ] Claude 경로에서 `buildClaudeMessages(editor.getJSON())` 를 호출해 body 구성
- [ ] Claude body 에 `cwd`, `allowedTools`, `model`, `system` 헤더가 옵션으로 포함
- [ ] 응답 스트림 → 노트 마지막 `A: ` 단락에 누적
- [ ] 정상 종료 후 빈 줄 + 새 `Q: ` 단락 추가
- [ ] 에러 시 `[오류: <kind 한국어 메시지>]` 인라인 + 새 `Q: ` 추가
- [ ] Abort 시 부분 응답 보존
- [ ] 기존 llm:// 노트 동작 회귀 없음

**Verify:** `cd app && npm run check && npm run test -- --run && npm run build`

**Steps:**

- [ ] **Step 1: Read existing `ChatSendBar.svelte` (formerly LlmSendBar) to find the `send()` function**

Existing structure (from Task 1's rename): the file has a `send()` async function that builds `body` via `buildChatRequest(spec)` then calls `sendChat(...)`. We'll add a parallel `runClaude(spec)` path.

- [ ] **Step 2: Edit `ChatSendBar.svelte` — add backend branch**

In `app/src/lib/editor/chatNote/ChatSendBar.svelte`:

```svelte
<script lang="ts">
  // existing imports + add:
  import { parseChatNote } from '$lib/chatNote/parseChatNote.js';
  import { buildClaudeMessages } from '$lib/chatNote/buildClaudeMessages.js';
  import { sendClaude, ClaudeChatError } from '$lib/chatNote/backends/claude.js';
  // existing ollama imports remain
  import { buildChatRequest, sendChat, LlmChatError, searchRag, RagSearchError, type RagHit } from '$lib/chatNote/backends/ollama.js';
  // ...

  async function send(): Promise<void> {
    if (sendDisabled || !spec) return;

    const ragQuery = lastUserContent;
    const ragK = spec.backend === 'ollama' ? spec.options.rag : undefined;

    const ctrl = new AbortController();
    abortController = ctrl;
    tokenCount = 0;
    editor.setEditable(false);

    appendParagraph('A: ');

    const httpBase = bridgeUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://')
      .replace(/\/(ws|llm\/chat|claude\/chat)\/?$/, '')
      .replace(/\/$/, '');

    try {
      if (spec.backend === 'claude') {
        await runClaude(spec, httpBase, ctrl);
      } else {
        await runOllama(spec, httpBase, ctrl, ragQuery, ragK);
      }
    } finally {
      abortController = null;
      editor.setEditable(true);
    }
  }

  async function runClaude(
    spec: ChatNoteSpec & { backend: 'claude' },
    httpBase: string,
    ctrl: AbortController,
  ): Promise<void> {
    const messages = buildClaudeMessages(editor.getJSON());
    const body = {
      messages,
      model: spec.model || undefined,
      system: spec.system,
      cwd: spec.options.cwd,
      allowedTools: spec.options.allowedTools,
    };

    try {
      const r = await sendClaude({
        url: `${httpBase}/claude/chat`,
        token: bridgeToken,
        body,
        onToken: (delta) => {
          appendToLastParagraph(delta);
          tokenCount++;
        },
        signal: ctrl.signal,
      });
      if (r.reason === 'done') {
        appendParagraph('');
        appendParagraph('Q: ');
        const endPos = editor.state.doc.content.size;
        editor.commands.setTextSelection(endPos - 1);
      }
      // abort: leave the partial A: in place, no new Q:
    } catch (err) {
      if (err instanceof ClaudeChatError) {
        const line = formatClaudeError(err);
        appendToLastParagraph(line);
        appendParagraph('');
        appendParagraph('Q: ');
      } else {
        throw err;
      }
    }
  }

  function formatClaudeError(err: ClaudeChatError): string {
    switch (err.kind) {
      case 'unauthorized':       return '[오류: 인증 실패 — 설정에서 브릿지 재로그인]';
      case 'service_unavailable': return '[오류: 데스크탑 Claude 서비스 응답 없음]';
      case 'rate_limited':       return '[오류: Claude 사용량 한도 도달. 잠시 후 재시도]';
      case 'cli_failed':         return `[오류: claude 실행 실패 — ${(err.detail ?? '').slice(0, 200)}]`;
      case 'bad_request':        return `[오류: 요청 형식 오류 ${err.detail ?? ''}]`;
      case 'payload_too_large':  return '[오류: 노트가 너무 큼]';
      case 'network':
      case 'upstream_error':
      case 'stream_error':
      default:                   return '[오류: 연결 실패. 재시도?]';
    }
  }

  // Refactor: extract existing ollama send path into runOllama(...) — move
  // the body of the old send() function (everything from RAG retrieval
  // through sendChat call and error handling) into runOllama. No behavior
  // change for ollama notes.
  async function runOllama(
    spec: ChatNoteSpec & { backend: 'ollama' },
    httpBase: string,
    ctrl: AbortController,
    ragQuery: string,
    ragK: number | undefined,
  ): Promise<void> {
    // ... existing ollama logic verbatim, with abort signal threaded through
  }
</script>
```

Key change to `parseChatNote` usage (already done by Task 3): `spec.backend` is now available.

- [ ] **Step 3: Verify ollama path unchanged by running existing tests**

```bash
cd app && npm run test -- --run
```

Expected: all green. (Existing chatNote parseChatNote tests still pass.)

- [ ] **Step 4: Verify build**

```bash
cd app && npm run check && npm run build
```

Expected: 0 errors, build succeeds.

- [ ] **Step 5: Smoke test manually**

Run `npm run dev`. Open existing `llm://` note (with RAG if you have one). Click 보내기. Expected: Ollama response streams normally — no regression.

(Claude end-to-end smoke deferred to Task 9.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(chatNote): ChatSendBar branches on spec.backend (ollama vs claude)

Claude path: buildClaudeMessages → sendClaude with cwd/allowedTools/model
headers. Ollama path extracted into runOllama() helper, behavior
unchanged. Error formatter localized for ClaudeChatError kinds.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Bridge — `POST /claude/chat` proxy route

**Goal:** Pi 브릿지에 `/claude/chat` 라우트 추가. 클라이언트 Bearer 검증 후 데스크탑 `claude-service` 로 SSE pass-through. `OCR` 라우트 패턴 미러.

**Files:**
- Create: `bridge/src/claude.ts`
- Create: `bridge/src/claude.test.ts`
- Modify: `bridge/src/server.ts` — 라우트 등록 + `CLAUDE_SERVICE_URL` env 로딩

**Acceptance Criteria:**
- [ ] `POST /claude/chat` Bearer 누락/오류 → 401
- [ ] `CLAUDE_SERVICE_URL` 미설정 → 503 `claude_service_not_configured`
- [ ] 정상 → 업스트림 SSE 스트림 pass-through (Content-Type, body)
- [ ] 클라이언트 connection close → 업스트림 fetch abort
- [ ] 업스트림 5xx → 동일 상태 + body 전달
- [ ] 업스트림 timeout (5분 fetch timeout) → 504 또는 503
- [ ] `bridge && npm test` 통과 (node:test 기반)

**Verify:** `cd bridge && npm test`

**Steps:**

- [ ] **Step 1: Write `bridge/src/claude.test.ts` first**

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { handleClaudeChat } from './claude.js';

const SECRET = 'test-secret';

// Helper: start an upstream stub server returning whatever the handler decides
async function withUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const srv = createServer(handler);
  srv.listen(0);
  await once(srv, 'listening');
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { srv.close(); }
}

// Helper: make a Bearer-authorized POST request to handleClaudeChat
async function callHandler(
  body: unknown,
  authHeader: string | undefined,
  upstreamUrl: string,
): Promise<{ status: number; body: string; contentType: string }> {
  const reqObj: Partial<IncomingMessage> & { _body: string } = {
    headers: authHeader ? { authorization: authHeader } : {},
    method: 'POST',
    _body: JSON.stringify(body),
  };
  // ... use a real http server roundtrip — see existing patterns in bridge/src/ocr.test.ts
  // (full helper omitted for brevity; mirror ocr.test.ts setup)
  return { status: 0, body: '', contentType: '' }; // placeholder — replace with actual helper
}

test('rejects with 401 when Bearer missing', async () => {
  await withUpstream(
    (_req, res) => { res.end(); },
    async (upstreamUrl) => {
      const r = await callHandler({ messages: [] }, undefined, upstreamUrl);
      assert.strictEqual(r.status, 401);
    },
  );
});

test('returns 503 when CLAUDE_SERVICE_URL is empty', async () => {
  const r = await callHandler({ messages: [] }, `Bearer ${SECRET}`, '');
  assert.strictEqual(r.status, 503);
  assert.ok(r.body.includes('claude_service_not_configured'));
});

test('proxies SSE response from upstream', async () => {
  await withUpstream(
    (req, res) => {
      assert.strictEqual(req.headers.authorization, `Bearer ${SECRET}`);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"delta":"hi"}\n\n');
      res.write('data: {"done":true,"reason":"success"}\n\n');
      res.end();
    },
    async (upstreamUrl) => {
      const r = await callHandler({ messages: [] }, `Bearer ${SECRET}`, upstreamUrl);
      assert.strictEqual(r.status, 200);
      assert.match(r.contentType, /event-stream/);
      assert.ok(r.body.includes('"delta":"hi"'));
      assert.ok(r.body.includes('"done":true'));
    },
  );
});

test('propagates upstream 5xx status verbatim', async () => {
  await withUpstream(
    (_req, res) => { res.writeHead(502); res.end('upstream broken'); },
    async (upstreamUrl) => {
      const r = await callHandler({ messages: [] }, `Bearer ${SECRET}`, upstreamUrl);
      assert.strictEqual(r.status, 502);
      assert.strictEqual(r.body, 'upstream broken');
    },
  );
});
```

> Note: the exact `callHandler` helper depends on bridge's existing test
> infrastructure. Inspect `bridge/src/ocr.test.ts` and copy the
> request-driving harness verbatim. Tests should run via `node --test`.

- [ ] **Step 2: Run tests — expected to fail (handleClaudeChat doesn't exist)**

```bash
cd bridge && npm test
```

Expected: FAIL — cannot resolve `./claude.js`.

- [ ] **Step 3: Implement `bridge/src/claude.ts`**

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

interface ClaudeBody {
  messages?: unknown;
  model?: unknown;
  system?: unknown;
  cwd?: unknown;
  allowedTools?: unknown;
}

/**
 * Proxy POST /claude/chat → desktop claude-service.
 *
 * - Auth: client must present Bearer == this bridge's secret.
 * - Forwarding: re-Bearer with the same secret (claude-service is configured
 *   with BRIDGE_SHARED_TOKEN == bridge's secret).
 * - Streaming: upstream Content-Type is text/event-stream; pipe through
 *   as-is so delta events reach the client without buffering.
 * - Upstream-down: returns 503 with `{error:'claude_service_unavailable'}`.
 */
export async function handleClaudeChat(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string,
  claudeServiceUrl: string,
): Promise<void> {
  const token = extractBearer(req.headers.authorization);
  if (!verifyToken(secret, token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (!claudeServiceUrl) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'claude_service_not_configured' }));
    return;
  }

  let body: ClaudeBody;
  try {
    body = (await readJson(req)) as ClaudeBody;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_json' }));
    return;
  }

  if (!Array.isArray(body.messages)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_request', detail: 'messages must be an array' }));
    return;
  }

  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());

  let upstream: Response;
  try {
    upstream = await fetch(`${claudeServiceUrl}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (ctrl.signal.aborted) return;
    console.warn(`[term-bridge claude] upstream error: ${(err as Error).message}`);
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'claude_service_unavailable' }));
    return;
  }

  const ct = upstream.headers.get('content-type') ?? 'application/json';
  res.writeHead(upstream.status, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((r) => res.once('drain', r));
      }
    }
  } catch {
    // upstream errored or aborted mid-stream
  } finally {
    res.end();
    reader.releaseLock();
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 2 * 1024 * 1024;     // 2 MiB — claude payload is small (URLs, no base64)
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

- [ ] **Step 4: Register route in `bridge/src/server.ts`**

Find the routing block (around line 110-125 per earlier grep), add:

```ts
// At top of file:
import { handleClaudeChat } from './claude.js';

// After other env reads:
const CLAUDE_SERVICE_URL = process.env.CLAUDE_SERVICE_URL ?? '';

// In the route dispatch block (e.g., after /ocr):
if (url === '/claude/chat' && req.method === 'POST') {
  await handleClaudeChat(req, res, SECRET, CLAUDE_SERVICE_URL);
  return;
}
```

Note: `CLAUDE_SERVICE_URL` is OPTIONAL (default ''). When missing, the handler returns 503 — see Step 3. We do NOT use `requireEnv` for it, so the bridge can still boot without claude-service configured.

- [ ] **Step 5: Run tests — expected to pass**

```bash
cd bridge && npm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(bridge): add /claude/chat proxy route

Mirrors the /ocr proxy pattern: Bearer auth, optional CLAUDE_SERVICE_URL
env (503 when unset), upstream SSE pass-through, AbortSignal on client
close. Body capped at 2 MiB (URLs only, no base64 images).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `claude-service` — core (project + runner + server)

**Goal:** 데스크탑에 새 Node 서비스를 만들고 `POST /chat` 으로 `claude -p` subprocess + stream-json → SSE 변환을 한다. 인증, 검증, abort 모두 포함. `FakeClaudeRunner` 로 단위 테스트.

**Files:**
- Create: `claude-service/package.json`
- Create: `claude-service/tsconfig.json`
- Create: `claude-service/src/server.ts`
- Create: `claude-service/src/runner.ts`
- Create: `claude-service/src/auth.ts`
- Create: `claude-service/tests/runner.test.ts`
- Create: `claude-service/tests/server.test.ts`
- Create: `claude-service/tests/_fakes.ts`

**Acceptance Criteria:**
- [ ] `npm test` in `claude-service/` runs vitest with FakeClaudeRunner — no real `claude` CLI spawned
- [ ] `runner.runClaude({messages, ...})` 가 stream-json JSONL 을 stdin 으로 child 에 흘림
- [ ] stream-json 출력 → `data: {"delta":"..."}\n\n` SSE 이벤트로 변환
- [ ] `type: "result"` → `data: {"done":true,"reason":<subtype>}\n\n`
- [ ] child exit code != 0 → `data: {"error":"<stderr summary>"}\n\n`
- [ ] AbortSignal → `child.kill('SIGTERM')`, stream end
- [ ] `--disallowedTools '*'` 가 cwd 없을 때 args 에 포함
- [ ] `--cwd <path>` 적용 시 args 에 `--allowedTools <list>` (있을 때만)
- [ ] `ANTHROPIC_API_KEY` env 가 명시적으로 빈 문자열로 설정됨
- [ ] `POST /chat` Bearer 검증 (401)
- [ ] 페이로드 size limit (413)
- [ ] `messages` 검증 (400)
- [ ] `cwd` 존재시 `isDirectory()` 검증 (400)
- [ ] SSE 응답 streaming

**Verify:** `cd claude-service && npm test`

**Steps:**

- [ ] **Step 1: Scaffold project files**

Create `claude-service/package.json`:

```json
{
  "name": "claude-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "tsx src/server.ts",
    "test": "vitest --run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "fastify": "^4.28.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

Create `claude-service/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: Install deps**

```bash
cd claude-service && npm install
```

Expected: `node_modules/` populated, no errors.

- [ ] **Step 3: Create `_fakes.ts`**

```ts
// claude-service/tests/_fakes.ts
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { ClaudeRunnerSpawn, RunRequest } from '../src/runner.js';

/**
 * Fake spawn function — replaces node:child_process.spawn in tests.
 * Records args/env/cwd and exposes controls to drive stdout/stderr/exit.
 */
export class FakeChildProcess extends EventEmitter {
  stdin = new Writable({ write: (_chunk, _enc, cb) => cb() });
  stdoutBuf: Buffer[] = [];
  stderrBuf: Buffer[] = [];
  stdout = new Readable({ read() { /* push via emitStdout */ } });
  stderr = new Readable({ read() { /* push via emitStderr */ } });
  killed = false;

  emitStdout(s: string): void { this.stdout.push(s); }
  emitStderr(s: string): void { this.stderr.push(s); }
  endStdout(): void { this.stdout.push(null); }
  endStderr(): void { this.stderr.push(null); }
  exit(code: number): void { this.emit('exit', code, null); this.endStdout(); this.endStderr(); }

  kill(_sig?: string): boolean { this.killed = true; this.exit(0); return true; }
}

export function makeFakeSpawn(): {
  spawn: ClaudeRunnerSpawn;
  lastCall: { args: string[]; env: NodeJS.ProcessEnv; cwd: string; child: FakeChildProcess } | null;
} {
  const state = { spawn: null as unknown as ClaudeRunnerSpawn, lastCall: null as any };
  state.spawn = ((command, args, opts) => {
    const child = new FakeChildProcess();
    state.lastCall = { args: args ?? [], env: opts?.env ?? {}, cwd: (opts?.cwd ?? '') as string, child };
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as ClaudeRunnerSpawn;
  return state;
}
```

- [ ] **Step 4: Write `runner.test.ts`**

```ts
// claude-service/tests/runner.test.ts
import { describe, it, expect } from 'vitest';
import { runClaude } from '../src/runner.js';
import { makeFakeSpawn } from './_fakes.js';

async function consume(stream: NodeJS.ReadableStream): Promise<string> {
  let s = '';
  for await (const chunk of stream) s += chunk.toString();
  return s;
}

describe('runClaude', () => {
  it('passes --disallowedTools * when no cwd', () => {
    const fake = makeFakeSpawn();
    void runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    expect(fake.lastCall!.args).toContain('--disallowedTools');
    const i = fake.lastCall!.args.indexOf('--disallowedTools');
    expect(fake.lastCall!.args[i + 1]).toBe('*');
  });

  it('omits --disallowedTools when cwd present', () => {
    const fake = makeFakeSpawn();
    void runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], cwd: '/tmp' },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    expect(fake.lastCall!.args).not.toContain('--disallowedTools');
  });

  it('passes --allowedTools when cwd + allowedTools', () => {
    const fake = makeFakeSpawn();
    void runClaude(
      {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        cwd: '/tmp',
        allowedTools: ['Read', 'Bash'],
      },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    const i = fake.lastCall!.args.indexOf('--allowedTools');
    expect(fake.lastCall!.args[i + 1]).toBe('Read,Bash');
  });

  it('clears ANTHROPIC_API_KEY env', () => {
    const fake = makeFakeSpawn();
    void runClaude(
      { messages: [] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    expect(fake.lastCall!.env.ANTHROPIC_API_KEY).toBe('');
  });

  it('converts assistant text events to SSE delta', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    // Simulate stream-json output
    fake.lastCall!.child.emitStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n');
    fake.lastCall!.child.emitStdout('{"type":"assistant","message":{"content":[{"type":"text","text":" world"}]}}\n');
    fake.lastCall!.child.emitStdout('{"type":"result","subtype":"success"}\n');
    fake.lastCall!.child.exit(0);
    const out = await consume(stream);
    expect(out).toContain('data: {"delta":"hello"}');
    expect(out).toContain('data: {"delta":" world"}');
    expect(out).toContain('data: {"done":true');
  });

  it('handles partial line buffering', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    // Emit a JSON line split across two chunks
    fake.lastCall!.child.emitStdout('{"type":"assistant","message":{"content":[{"type":"');
    fake.lastCall!.child.emitStdout('text","text":"split"}]}}\n');
    fake.lastCall!.child.emitStdout('{"type":"result","subtype":"success"}\n');
    fake.lastCall!.child.exit(0);
    const out = await consume(stream);
    expect(out).toContain('data: {"delta":"split"}');
  });

  it('emits error event on non-zero exit', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    fake.lastCall!.child.emitStderr('command not found\n');
    fake.lastCall!.child.exit(127);
    const out = await consume(stream);
    expect(out).toContain('data: {"error"');
    expect(out).toContain('command not found');
  });

  it('kills child on AbortSignal', () => {
    const fake = makeFakeSpawn();
    const ctrl = new AbortController();
    void runClaude(
      { messages: [] },
      ctrl.signal,
      { spawn: fake.spawn },
    );
    ctrl.abort();
    expect(fake.lastCall!.child.killed).toBe(true);
  });

  it('ignores tool_use events (MVP)', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    fake.lastCall!.child.emitStdout('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"path":"/foo"}}]}}\n');
    fake.lastCall!.child.emitStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"after tool"}]}}\n');
    fake.lastCall!.child.emitStdout('{"type":"result","subtype":"success"}\n');
    fake.lastCall!.child.exit(0);
    const out = await consume(stream);
    expect(out).not.toContain('tool_use');
    expect(out).toContain('"delta":"after tool"');
  });
});
```

- [ ] **Step 5: Implement `runner.ts`**

```ts
// claude-service/src/runner.ts
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { Readable } from 'node:stream';

export type ClaudeRunnerSpawn = (
  command: string,
  args?: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'url'; url: string } }
  >;
}

export interface RunRequest {
  messages: AnthropicMessage[];
  model?: string;
  system?: string;
  cwd?: string;
  allowedTools?: string[];
}

interface RunnerDeps {
  spawn?: ClaudeRunnerSpawn;
}

/**
 * Spawn `claude -p` with stream-json input/output, return a Readable that
 * emits SSE events. Caller pipes this to an HTTP response.
 *
 * Output events:
 *   data: {"delta":"<text>"}                        — assistant text run
 *   data: {"done":true,"reason":"<subtype>"}        — normal completion
 *   data: {"error":"<message>"}                     — failure
 */
export function runClaude(
  req: RunRequest,
  signal: AbortSignal,
  deps: RunnerDeps = {},
): Readable {
  const spawn = deps.spawn ?? nodeSpawn;

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (req.model) args.push('--model', req.model);
  if (req.system) args.push('--append-system-prompt', req.system);
  if (!req.cwd) {
    args.push('--disallowedTools', '*');
  } else if (req.allowedTools?.length) {
    args.push('--allowedTools', req.allowedTools.join(','));
  }

  const child = spawn('claude', args, {
    cwd: req.cwd ?? process.env.HOME,
    env: { ...process.env, ANTHROPIC_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Pipe messages as stream-json input
  for (const msg of req.messages) {
    child.stdin!.write(JSON.stringify({ type: 'user', message: msg }) + '\n');
  }
  child.stdin!.end();

  signal.addEventListener('abort', () => {
    if (!child.killed) child.kill('SIGTERM');
  });

  const out = new Readable({ read() { /* push-driven */ } });
  let buf = '';
  let stderrBuf = '';
  let done = false;

  const writeEvent = (obj: unknown): void => {
    if (out.destroyed) return;
    out.push(`data: ${JSON.stringify(obj)}\n\n`);
  };

  const finish = (): void => {
    if (!out.destroyed) out.push(null);
  };

  child.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt: { type?: string; message?: { content?: Array<{ type: string; text?: string }> }; subtype?: string };
      try { evt = JSON.parse(line); }
      catch { continue; }

      if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
        for (const c of evt.message.content) {
          if (c.type === 'text' && typeof c.text === 'string') {
            writeEvent({ delta: c.text });
          }
          // tool_use / tool_result ignored in MVP
        }
      } else if (evt.type === 'result') {
        writeEvent({ done: true, reason: evt.subtype ?? 'unknown' });
        done = true;
      }
    }
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
  });

  child.on('exit', (code: number | null) => {
    if (!done && (code ?? 0) !== 0) {
      writeEvent({ error: `claude exit ${code}: ${stderrBuf.trim().slice(-200)}` });
    } else if (!done) {
      writeEvent({ error: 'stream ended without result' });
    }
    finish();
  });

  child.on('error', (err: Error) => {
    writeEvent({ error: `spawn error: ${err.message}` });
    finish();
  });

  return out;
}
```

- [ ] **Step 6: Run runner tests**

```bash
cd claude-service && npm test -- runner
```

Expected: all green.

- [ ] **Step 7: Write `server.test.ts`**

```ts
// claude-service/tests/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { makeFakeSpawn } from './_fakes.js';

describe('claude-service POST /chat', () => {
  let app: ReturnType<typeof buildServer>;
  let fake: ReturnType<typeof makeFakeSpawn>;

  beforeEach(() => {
    fake = makeFakeSpawn();
    app = buildServer({ sharedToken: 'test-token', spawn: fake.spawn });
  });
  afterEach(async () => { await app.close(); });

  it('401 without Bearer', async () => {
    const r = await app.inject({ method: 'POST', url: '/chat', payload: { messages: [] } });
    expect(r.statusCode).toBe(401);
  });

  it('401 with wrong Bearer', async () => {
    const r = await app.inject({
      method: 'POST', url: '/chat',
      headers: { authorization: 'Bearer wrong' },
      payload: { messages: [] },
    });
    expect(r.statusCode).toBe(401);
  });

  it('400 when messages missing', async () => {
    const r = await app.inject({
      method: 'POST', url: '/chat',
      headers: { authorization: 'Bearer test-token' },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });

  it('400 when messages is empty array', async () => {
    const r = await app.inject({
      method: 'POST', url: '/chat',
      headers: { authorization: 'Bearer test-token' },
      payload: { messages: [] },
    });
    expect(r.statusCode).toBe(400);
  });

  it('200 streams SSE for valid request', async () => {
    // Start request — fake spawn captures child.
    const inject = app.inject({
      method: 'POST', url: '/chat',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      },
    });
    // Wait a tick for spawn to be called
    await new Promise((r) => setImmediate(r));
    fake.lastCall!.child.emitStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n');
    fake.lastCall!.child.emitStdout('{"type":"result","subtype":"success"}\n');
    fake.lastCall!.child.exit(0);

    const r = await inject;
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/event-stream/);
    expect(r.body).toContain('data: {"delta":"hi"}');
    expect(r.body).toContain('data: {"done":true');
  });

  it('413 when payload exceeds limit', async () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    const r = await app.inject({
      method: 'POST', url: '/chat',
      headers: { authorization: 'Bearer test-token' },
      payload: { messages: [{ role: 'user', content: [{ type: 'text', text: huge }] }] },
    });
    expect(r.statusCode).toBe(413);
  });
});
```

- [ ] **Step 8: Implement `auth.ts`**

```ts
// claude-service/src/auth.ts
export function extractBearer(authHeader?: string): string {
  if (!authHeader) return '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1].trim() : '';
}

export function verifyToken(secret: string, token: string): boolean {
  if (!secret || !token) return false;
  // Constant-time compare: not strictly needed for personal-use service,
  // but cheap insurance.
  if (secret.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
```

- [ ] **Step 9: Implement `server.ts`**

```ts
// claude-service/src/server.ts
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, statSync } from 'node:fs';
import { runClaude, type ClaudeRunnerSpawn, type RunRequest } from './runner.js';
import { extractBearer, verifyToken } from './auth.js';

const MAX_BYTES = Number(process.env.CLAUDE_MAX_REQUEST_BYTES ?? 2 * 1024 * 1024);

export interface BuildServerOpts {
  sharedToken: string;
  spawn?: ClaudeRunnerSpawn;        // for tests
}

export function buildServer(opts: BuildServerOpts): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: MAX_BYTES });

  app.setErrorHandler((err, _req, reply) => {
    if (err.statusCode === 413) {
      reply.code(413).send({ error: 'payload_too_large' });
      return;
    }
    reply.code(500).send({ error: 'internal_error', detail: err.message });
  });

  app.post('/chat', async (req, reply) => {
    const token = extractBearer(req.headers.authorization);
    if (!verifyToken(opts.sharedToken, token)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const body = req.body as Partial<RunRequest> | undefined;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.code(400).send({ error: 'bad_request', detail: 'messages required' });
    }
    if (body.cwd) {
      if (!existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) {
        return reply.code(400).send({ error: 'bad_request', detail: 'cwd not a directory' });
      }
    }

    const ctrl = new AbortController();
    req.raw.on('close', () => ctrl.abort());

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });

    const stream = runClaude(body as RunRequest, ctrl.signal, { spawn: opts.spawn });
    stream.pipe(reply.raw);

    // Prevent fastify from auto-replying — we manage the response stream.
    return reply;
  });

  return app;
}

// CLI entry — only when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const sharedToken = process.env.BRIDGE_SHARED_TOKEN;
  if (!sharedToken) {
    console.error('BRIDGE_SHARED_TOKEN is required');
    process.exit(1);
  }
  const port = Number(process.env.CLAUDE_SERVICE_PORT ?? 7842);
  const app = buildServer({ sharedToken });
  app.listen({ port, host: '0.0.0.0' }).then(() => {
    console.log(`claude-service listening on :${port}`);
  });
}
```

- [ ] **Step 10: Run all tests**

```bash
cd claude-service && npm test
```

Expected: all green.

- [ ] **Step 11: Build verification**

```bash
cd claude-service && npm run build
```

Expected: `dist/` populated with .js files, no TS errors.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(claude-service): new Node service for claude CLI subprocess

Mirrors ocr-service deployment pattern. POST /chat: Bearer auth, body
validation, cwd directory check, spawns `claude -p --input-format
stream-json --output-format stream-json --verbose`, converts assistant
text events to SSE delta and result events. Tool events (tool_use,
tool_result) silently dropped in MVP. ANTHROPIC_API_KEY env explicitly
cleared to force subscription OAuth path. FakeClaudeRunner enables
unit tests without real CLI / subscription.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `claude-service` — deployment (Containerfile + Quadlet)

**Goal:** 데스크탑에서 실제로 돌릴 수 있는 컨테이너 이미지 + Quadlet unit + 셋업 가이드.

**Files:**
- Create: `claude-service/Containerfile`
- Create: `claude-service/deploy/claude-service.container`
- Create: `claude-service/deploy/README.md`

**Acceptance Criteria:**
- [ ] `podman build -t claude-service:latest claude-service/` 성공
- [ ] 컨테이너 안에서 `node /app/dist/server.js` 가 동작 (실제 claude CLI는 host volume에서 접근하거나 컨테이너 내 설치)
- [ ] Quadlet unit이 `~/.config/containers/systemd/claude-service.container` 에 떨어지면 `systemctl --user daemon-reload && systemctl --user enable --now claude-service.service` 로 시작 가능
- [ ] README가 셋업 단계(빌드, 환경변수, claude login, 시작)를 명시
- [ ] 빌드 후 `podman run --rm claude-service:latest --help` 가 정상 출력 (또는 server start 메시지)

**Verify:**

```bash
cd claude-service && podman build -t claude-service:latest .
# (수동) Quadlet unit 배포 후 systemctl --user status claude-service.service
```

**Steps:**

- [ ] **Step 1: Write `Containerfile`**

```dockerfile
# claude-service/Containerfile
# Runs the Node service that proxies POST /chat → `claude -p` subprocess.
# Built on the DESKTOP (host with the user's Claude Code OAuth credentials).

FROM docker.io/library/node:22-bookworm-slim

# Install claude CLI globally so we can spawn it.
RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# OAuth credentials are mounted at runtime via Quadlet (Volume= directive).
ENV HOME=/data
RUN mkdir -p /data/.claude

EXPOSE 7842

CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Write Quadlet unit `claude-service.container`**

```ini
# claude-service/deploy/claude-service.container
#
# Podman Quadlet unit for tomboy-web claude-service.
#
# Install (on the DESKTOP — never on the Pi):
#   1. Build the image:
#        cd claude-service && podman build -t claude-service:latest .
#   2. One-time: log into Claude on the host so OAuth credentials exist:
#        claude login
#        # this writes ~/.claude/credentials.json (or similar)
#   3. Drop this file at ~/.config/containers/systemd/claude-service.container
#   4. Create ~/.config/claude-service.env with:
#        BRIDGE_SHARED_TOKEN=<same value as bridge BRIDGE_SECRET>
#        CLAUDE_SERVICE_PORT=7842
#        CLAUDE_MAX_REQUEST_BYTES=2097152
#   5. systemctl --user daemon-reload
#      systemctl --user enable --now claude-service.service
#   6. Linger so it survives logout:
#        loginctl enable-linger $USER
#
# Network: listens on 0.0.0.0:7842 INSIDE THE LAN ONLY. Do NOT expose
# 7842 to the public internet — Bearer auth is the only protection.
# The Pi bridge calls this via LAN.

[Unit]
Description=tomboy-web claude-service
After=network-online.target
Wants=network-online.target

[Container]
Image=localhost/claude-service:latest
ContainerName=claude-service
PublishPort=7842:7842
EnvironmentFile=%h/.config/claude-service.env

# OAuth credentials directory — claude CLI reads ~/.claude/*.
# Mount the host's ~/.claude into the container's $HOME/.claude (HOME=/data).
Volume=%h/.claude:/data/.claude:Z

[Service]
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

- [ ] **Step 3: Write `deploy/README.md`**

```markdown
# claude-service 셋업

데스크탑(Ollama, ocr-service 와 같은 머신)에서 돌린다.
브릿지(Pi)에는 절대 깔지 않는다.

## 사전 조건

- Podman 4+ (Quadlet 지원)
- `claude` CLI를 host에서 한 번 로그인하기 위한 GUI/터미널 접근
- `BRIDGE_SHARED_TOKEN` 값 (Pi 브릿지의 `BRIDGE_SECRET` 과 동일)

## 셋업

```bash
# 1. host에서 claude login (OAuth credentials 생성)
claude login
# → ~/.claude/credentials.json (또는 유사한 파일) 생성됨

# 2. 이미지 빌드
cd claude-service
podman build -t claude-service:latest .

# 3. Quadlet unit 설치
mkdir -p ~/.config/containers/systemd
cp deploy/claude-service.container ~/.config/containers/systemd/

# 4. 환경변수 파일
cat > ~/.config/claude-service.env <<EOF
BRIDGE_SHARED_TOKEN=<바꿔라 — 브릿지 BRIDGE_SECRET 과 동일 값>
CLAUDE_SERVICE_PORT=7842
EOF

# 5. 활성화
systemctl --user daemon-reload
systemctl --user enable --now claude-service.service
loginctl enable-linger $USER

# 6. 헬스 체크
curl -i -H "Authorization: Bearer $BRIDGE_SHARED_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[]}' \
  http://localhost:7842/chat
# → 400 (bad_request: messages required) 가 정상.
#   401 이 나오면 토큰 확인.
```

## 브릿지 설정

Pi 브릿지의 환경변수에 추가:

```
CLAUDE_SERVICE_URL=http://<데스크탑-LAN-IP>:7842
```

이후 브릿지 재시작.

## 트러블슈팅

- **401 unauthorized**: `BRIDGE_SHARED_TOKEN` 이 브릿지 `BRIDGE_SECRET` 과
  byte-identical 이어야 함.
- **claude not found** stderr: 컨테이너 안에 `@anthropic-ai/claude-code`
  가 설치 안 됐음. `podman exec -it claude-service which claude` 확인.
- **OAuth credentials missing**: `~/.claude/` 디렉토리가 비어 있거나
  volume mount 실패. host에서 `ls ~/.claude/` 후 `claude login` 재실행.
- **`claude` 가 API key 모드로 빠짐**: 서비스가 `ANTHROPIC_API_KEY=''` 를
  강제로 비우는지 `runner.ts` 확인. 컨테이너 환경변수에서 host의
  `ANTHROPIC_API_KEY` 가 leak 되지 않는지 EnvironmentFile 확인.

## 보안

- 7842 포트를 외부에 노출하지 말 것. LAN only.
- Bearer 토큰이 유일한 보호 수단.
- OAuth credentials는 컨테이너 안에서 read-only 로 마운트해도 됨
  (Volume 옵션에 `:ro` 추가). 단, `claude login` 으로 갱신할 땐 host에서
  실행 후 컨테이너 재시작.
```

- [ ] **Step 4: Verify build works**

```bash
cd claude-service && podman build -t claude-service:latest .
```

Expected: 빌드 성공. `npm install` 단계에서 fastify, vitest 등이 다운로드.
`npx tsc` 가 `dist/` 생성.

이미지 크기 확인:
```bash
podman images claude-service:latest
```

Expected: ~200-300 MB.

- [ ] **Step 5: Smoke run (without real claude)**

```bash
podman run --rm \
  -e BRIDGE_SHARED_TOKEN=test \
  -p 7842:7842 \
  claude-service:latest &

sleep 2
curl -i -H "Authorization: Bearer test" \
  -H "Content-Type: application/json" \
  -d '{"messages":[]}' \
  http://localhost:7842/chat
```

Expected: HTTP 400 `bad_request: messages required`. (401 = token mismatch,
500 = startup failure.)

```bash
podman stop $(podman ps -q --filter ancestor=claude-service:latest) 2>/dev/null
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(claude-service): add Containerfile + Quadlet deploy unit

Container ships claude CLI globally + the compiled Node service.
Host's ~/.claude is volume-mounted into the container so OAuth
credentials persist across rebuilds. deploy/README.md documents
setup, env vars, and trust model (LAN-only, Bearer auth).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Manual verification + CLAUDE.md update (USER GATE)

**Goal:** End-to-end smoke 통과 + 운영 문서화. 실제 데스크탑에서 claude-service 켜고, Pi 브릿지에 `CLAUDE_SERVICE_URL` 주입, 앱에서 `claude://` 노트 만들어 보내기 → 응답 스트림 확인. 회귀(llm:// 노트) 없음 확인.

**USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation (스펙 verification 섹션). It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:**
- Modify: `CLAUDE.md` — `## llmNote/chatNote 채팅 노트` 섹션 갱신 (Claude 백엔드 명시, 운영 invariants)
- (Optional, parallel) Create: `.claude/skills/tomboy-chatnote/SKILL.md` — 새 스킬 정의

**Acceptance Criteria:**
- [ ] 데스크탑에 claude-service 실제 기동, `systemctl --user status claude-service` 가 `active (running)` 출력
- [ ] Pi 브릿지에 `CLAUDE_SERVICE_URL` 설정 후 재시작, 브릿지 로그에 `[term-bridge] listening` 정상
- [ ] 앱에서 새 노트 → `claude://` 시그니처 → `Q: 간단한 질문` → 보내기 → `A:` 자리에 응답 텍스트 스트림 (캡처: 노트 전체 스크린샷 또는 텍스트)
- [ ] `claude://opus` 로 모델 명시 → opus 의 응답 톤 (캡처)
- [ ] `cwd: /home/jh/workspace/tomboy-web` 헤더 → `Q: app/src/lib/chatNote/ 에 무슨 파일들 있어?` → 실제 디렉토리 정보 포함 응답 (캡처)
- [ ] Dropbox 이미지 포함 Q → Claude 가 이미지 인식한 응답 (캡처)
- [ ] 스트림 중 중지 버튼 → 즉시 중단, 부분 응답 보존, 새 `Q: ` 추가됨 (캡처)
- [ ] 데스크탑 claude-service 죽임 → 보내기 → `[오류: 데스크탑 Claude 서비스 응답 없음]` 토스트 (캡처)
- [ ] 기존 `llm://` 노트로 보내기 → Ollama 응답 정상 (회귀 없음 확인, 캡처)
- [ ] claude-service 로그에 API key 모드 호출 흔적 없음 (`grep -i 'api.key' /var/log/...` 또는 `journalctl --user -u claude-service` — 캡처)
- [ ] `CLAUDE.md` 의 채팅 노트 섹션이 Claude 백엔드를 반영

**Verify:**

```bash
# 데스크탑
systemctl --user status claude-service.service
# 출력에 active (running) 포함

# Pi 브릿지
ssh pi 'systemctl --user status term-bridge.service'

# 앱 수동 테스트 — 위 AC 8가지 캡처
```

**Steps:**

- [ ] **Step 1: 데스크탑에서 claude-service 실제 셋업**

```bash
# Task 8의 README 따라 실행
cd claude-service && podman build -t claude-service:latest .
claude login          # OAuth credentials 생성
cp deploy/claude-service.container ~/.config/containers/systemd/
# ~/.config/claude-service.env 작성
systemctl --user daemon-reload
systemctl --user enable --now claude-service.service
systemctl --user status claude-service.service
```

Expected output: `Active: active (running)`. 출력 캡처.

문제 시: `journalctl --user -u claude-service -n 100` 으로 로그 확인.

- [ ] **Step 2: 브릿지에 CLAUDE_SERVICE_URL 주입 + 재시작**

```bash
# Pi에서
ssh pi
# 브릿지 환경변수 파일에 추가:
# CLAUDE_SERVICE_URL=http://<데스크탑-IP>:7842
systemctl --user restart term-bridge.service
journalctl --user -u term-bridge -n 50
```

Expected: `listening on …` 메시지, 에러 없음.

- [ ] **Step 3: 앱에서 claude:// 노트 작성 (chat-only)**

`npm run dev` 또는 production URL 접속. 새 노트:

```
클로드 테스트

claude://

Q: 안녕? 너 어떤 모델이야?
```

보내기 클릭. 응답 스트림 확인. 정상 종료 후 `Q: ` 가 새로 추가됐는지 확인.
**스크린샷 또는 노트 텍스트 캡처.**

- [ ] **Step 4: 모델 명시 (claude://opus)**

```
모델 비교

claude://opus

Q: 100자 이내로 자기소개.
```

응답 톤이 단계 3 (기본 모델)과 다른지 확인. **캡처.**

- [ ] **Step 5: 도구 모드 (cwd:)**

```
리포 탐색

claude://
cwd: /home/jh/workspace/tomboy-web

Q: app/src/lib/chatNote/ 에 무슨 파일들이 있어? 간단히 나열만 해줘.
```

응답에 실제 파일명(parseChatNote.ts, defaults.ts, buildClaudeMessages.ts, backends/) 이 포함되는지 확인. **캡처.**

- [ ] **Step 6: 이미지 입력**

도구 모드 끄고 새 노트:

```
이미지 분석

claude://

Q: 다음 이미지에 뭐가 있어?
```

`Q:` 단락 뒤에 이미지 파일(Tomboy 노트에서 이미지 붙여넣기) → Dropbox 업로드 → URL이 자동 삽입됨. 보내기.

응답이 이미지를 실제로 인식했는지 확인. **캡처.**

- [ ] **Step 7: Abort 테스트**

긴 응답이 나올 만한 Q를 보내고 (예: "장편소설 도입부 작성"), 응답 중에 중지 버튼 클릭. 즉시 멈추는지, 부분 응답이 보존되는지, 새 `Q: ` 가 추가되는지 확인. **캡처.**

- [ ] **Step 8: 에러 처리 — claude-service 다운**

```bash
# 데스크탑에서
systemctl --user stop claude-service.service
```

앱에서 보내기 클릭 → `[오류: 데스크탑 Claude 서비스 응답 없음]` 토스트 + 노트에 해당 에러 라인. **캡처.**

복구:
```bash
systemctl --user start claude-service.service
```

- [ ] **Step 9: llm:// 회귀 테스트**

기존 `llm://` 노트로 보내기. Ollama 응답이 정상 스트림되는지 확인. **캡처.**

- [ ] **Step 10: API key fallback leak 검증**

```bash
journalctl --user -u claude-service -n 200 | grep -i 'api.key\|anthropic_api_key\|sk-ant-'
```

Expected: 출력 없음 (또는 환경변수 명시적 clear 로그만). 만약 API key 호출 흔적이 있으면 `runner.ts` 의 env clear 누락이 의심됨.

- [ ] **Step 11: `CLAUDE.md` 업데이트**

`CLAUDE.md` 의 LLM 노트 관련 섹션을 찾아 (현재는 아마 ollama 만 언급) 다음 내용으로 보강:

```markdown
## 채팅 노트 (`llm://` + `claude://`)

두 백엔드를 지원하는 채팅 노트. 시그니처:
- `llm://<model>` — Ollama (기존)
- `claude://[<model>]` — Claude Code CLI subprocess (구독 OAuth 경로)

공통: Q:/A: 턴 구조, 보내기 버튼, 스트리밍, abort.

Quick map:
- `app/src/lib/chatNote/parseChatNote.ts` — 시그니처 + 헤더 + 턴 파싱, 두 백엔드 공통
- `app/src/lib/chatNote/backends/ollama.ts` — Ollama 전송 (RAG 포함)
- `app/src/lib/chatNote/backends/claude.ts` — Claude SSE 소비자 + ClaudeChatError
- `app/src/lib/chatNote/buildClaudeMessages.ts` — Q:/A: → Anthropic content blocks
- `app/src/lib/editor/chatNote/ChatSendBar.svelte` — 백엔드 분기
- `bridge/src/claude.ts` — POST /claude/chat 프록시
- `claude-service/` — 데스크탑 Node 서비스, `claude -p` subprocess
- 셋업 문서: `claude-service/deploy/README.md`

Cross-cutting invariants worth caching:

- **Claude 백엔드는 구독 OAuth 경로 강제**: `claude-service/src/runner.ts`
  가 `ANTHROPIC_API_KEY` 환경변수를 명시적으로 빈 문자열로 설정.
  실수로 host의 API 키가 leak되면 종량제로 빠짐.
- **이미지는 URL 패스스루**: Dropbox `?raw=1` URL 을 Anthropic
  `image/url` content block 으로 직통. base64 변환 없음.
- **도구 활성 게이트는 `cwd:` 헤더 존재 여부**: 없으면
  `--disallowedTools '*'`, 있으면 디폴트 도구셋(또는 `allowedTools:`
  로 제한).
- **claude-service는 데스크탑에만**: ocr-service와 같은 머신.
  Pi 브릿지에는 절대 깔지 않는다.
- **세션 resume 안 함**: 노트가 single source of truth. 매 전송마다
  transcript 전체 재전송.

⚠️ Claude 백엔드 사용 전: 데스크탑 `claude login` 으로 OAuth 자격증명
생성 필수. 자격증명이 없으면 `claude-service` 가 매 요청에서 실패함.
```

- [ ] **Step 12: Commit 모든 캡처 + CLAUDE.md 변경**

(이전 태스크들에서 코드가 다 커밋됐다면 이 태스크에서는 CLAUDE.md만 커밋.)

캡처는 PR description 또는 `docs/superpowers/results/2026-05-23-claude-chat-note-verification.md` 에 인라인.

```bash
git add CLAUDE.md docs/superpowers/results/2026-05-23-claude-chat-note-verification.md
git commit -m "$(cat <<'EOF'
docs(chatNote): document Claude backend in CLAUDE.md + verification log

수동 검증 9가지(chat-only, opus, cwd 도구, 이미지, abort, service down,
llm:// 회귀, API key leak 검증, OAuth credentials 셋업) 모두 통과.
캡처는 verification log 참조.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Notes on Future Work (V2+)

스펙의 § 10 "후속 작업 candidates" 참고. 이 plan은 MVP 만 다루며, 다음은 별도 plan:

1. 도구 호출 이벤트 (tool_use) 인라인 marker 표시
2. 동시성 cap + 큐
3. 자동 cwd 휴리스틱 (노트북 기반)
4. GitHub 이슈 자동화 진입점 (`/dispatch` 등 추가)
5. 이미지 base64 fallback (Dropbox 외 호스팅)
6. 백엔드 추가 (`openai://`, `gemini://`)
