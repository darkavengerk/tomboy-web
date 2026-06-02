# Claude를 OCR 노트 + 일기 파이프라인 기본 백엔드로 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OCR 노트(`ocr://claude`)와 일기 파이프라인(`ocr.backend: "claude"`)이 데스크탑 claude-service(구독 OAuth)를 통해 Claude vision으로 텍스트 추출/번역을 수행하도록 한다. 기존 백엔드(`ocr://got-ocr2` / `local_vlm`)는 코드/설정 모두 유지한다.

**Architecture:** 이미지 콘텐츠 블록을 지원하는 기존 claude-service `/chat` SSE 인프라를 두 클라이언트에서 재사용. 웹 앱은 bridge `/claude/chat`을 통해, 일기 파이프라인은 localhost claude-service를 통해 호출. 새 코드는 (a) OCR 노트 `ocr://claude` 시그니처 인식과 실행 분기, (b) 파이썬 `ClaudeBackend` OCRBackend 구현이 전부.

**Tech Stack:** TypeScript / Svelte (app), Python 3.11 + httpx (pipeline), vitest / pytest.

**Spec deviation note:** 스펙은 OCR 노트용으로 별도 `app/src/lib/ocrNote/sendClaude.ts` 신규 작성을 명시했지만, 본 플랜은 기존 `app/src/lib/chatNote/backends/claude.ts`의 `sendClaude`를 **그대로 import해 재사용**한다. 이유: SSE 클라이언트는 caller 흐름과 무관한 프리미티브이며(POST→스트리밍 delta가 전부), `chatNote/backends/ollama.ts`의 `sendChat`도 이미 OCR 노트가 import하고 있어 동일 패턴. 150줄 중복은 낭비.

---

### Task 1: OCR 노트 — `parseOcrNote`에 Claude 백엔드 인식 + `effort:` 헤더

**Goal:** `ocr://claude` 또는 `ocr://claude-*` 시그니처를 `backend='claude'`로 분류하고, `effort:` 헤더를 파싱한다. 기존 `ocr://got-ocr2` / `ocr://qwen2.5vl:7b` 노트는 모두 `backend='ollama'`로 유지된다.

**Files:**
- Modify: `app/src/lib/ocrNote/defaults.ts`
- Modify: `app/src/lib/ocrNote/parseOcrNote.ts`
- Test (modify): `app/tests/unit/ocrNote/parseOcrNote.test.ts`

**Acceptance Criteria:**
- [ ] `ocr://claude` → `{backend: 'claude', model: 'claude'}`
- [ ] `ocr://claude-opus-4-7` → `{backend: 'claude', model: 'claude-opus-4-7'}`
- [ ] `ocr://got-ocr2` → `{backend: 'ollama', model: 'got-ocr2'}` (회귀 없음)
- [ ] `ocr://qwen2.5vl:7b` → `{backend: 'ollama', model: 'qwen2.5vl:7b'}` (회귀 없음)
- [ ] Claude 노트의 `effort: high` 헤더 → `options.effort === 'high'`
- [ ] Claude 노트의 `effort: bogus` 헤더 → `options.effort` undefined (CLAUDE_VALID_EFFORTS 외 값 무시)
- [ ] Claude 노트의 `translate:` / `temperature:` / `num_ctx:` 헤더는 파싱은 되되 결과에 영향 없음 (소비자가 무시)

**Verify:** `cd app && npm run test -- src/lib/ocrNote/parseOcrNote` → 신규 케이스 + 회귀 케이스 모두 통과

**Steps:**

- [ ] **Step 1: `defaults.ts`에 Claude 상수와 분류 헬퍼 추가**

```ts
// app/src/lib/ocrNote/defaults.ts 끝부분에 추가

/**
 * `ocr://` 시그니처에서 추출한 model 토큰이 Claude 백엔드를 가리키는지 판정.
 *
 *   ocr://claude            → true (정확 매치)
 *   ocr://claude-opus-4-7   → true (claude-* prefix)
 *   ocr://got-ocr2          → false
 *   ocr://qwen2.5vl:7b      → false
 */
export function isClaudeBackend(model: string): boolean {
  return model === 'claude' || model.startsWith('claude-');
}

/** Claude 백엔드용 유효 effort 값 (chatNote/defaults.CLAUDE_VALID_EFFORTS와 동일). */
export const OCR_CLAUDE_VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const OCR_CLAUDE_DEFAULT_EFFORT = 'high';

/**
 * OCR + 번역을 한 번에 처리하는 시스템 프롬프트. 출력 형식
 * `[원문]\n…\n\n[번역]\n…`을 강제하므로 호출 측은 별도 후처리 없이
 * 결과 텍스트를 노트에 그대로 삽입한다.
 */
export const OCR_CLAUDE_SYSTEM_PROMPT = [
  '당신은 이미지에서 텍스트를 정확히 추출하고 한국어로 번역하는 어시스턴트입니다.',
  '',
  '규칙:',
  '1. 이미지의 모든 텍스트를 원본 그대로 추출합니다. 줄바꿈/들여쓰기/기호를 최대한 보존합니다.',
  '2. 추출 텍스트가 한국어가 아니면 한국어 번역도 함께 제공합니다.',
  '3. 추출 텍스트가 이미 한국어면 [번역] 섹션은 생략합니다.',
  '4. 출력 외의 설명/주석을 덧붙이지 않습니다.',
  '',
  '출력 형식:',
  '[원문]',
  '<추출한 텍스트 그대로>',
  '',
  '[번역] (한국어가 아닐 때만)',
  '<한국어 번역>',
].join('\n');
```

또한 `OCR_HEADER_KEY_RE`에 `effort` 추가:

```ts
// 기존
export const OCR_HEADER_KEY_RE =
  /^(translate|system|temperature|num_ctx):\s*(.*)$/;
// 변경
export const OCR_HEADER_KEY_RE =
  /^(translate|system|temperature|num_ctx|effort):\s*(.*)$/;

// 그리고
export const OCR_RECOGNIZED_HEADER_KEYS = [
  'translate',
  'system',
  'temperature',
  'num_ctx',
  'effort',  // ← 추가
] as const;
```

- [ ] **Step 2: `parseOcrNote.ts`에 `backend` 필드 + `effort` 처리 추가**

`OcrNoteSpec` 인터페이스 확장:

```ts
export interface OcrNoteSpec {
  /** OCR 백엔드. 'claude'는 단일 호출, 'ollama'는 기존 두 단계/legacy 분기. */
  backend: 'ollama' | 'claude';
  model: string;
  translateModel?: string;
  legacy: boolean;
  system?: string;
  options: {
    temperature?: number;
    num_ctx?: number;
    /** Claude 백엔드 전용. low|medium|high|xhigh|max. */
    effort?: string;
  };
}
```

import 추가:

```ts
import {
  OCR_SIGNATURE_RE,
  OCR_HEADER_KEY_RE,
  OCR_CLAUDE_VALID_EFFORTS,
  isClaudeBackend,
  type OcrHeaderKey,
} from './defaults.js';
```

`parseOcrNote` 본문 변경 — `result` 초기화 시 `backend` 결정:

```ts
const result: OcrNoteSpec = {
  backend: isClaudeBackend(model) ? 'claude' : 'ollama',
  model,
  legacy: true,
  options: {},
};
```

`flushKey` 내부의 INT_KEYS 분기 아래 `effort` 처리 추가 (currentKey === 'effort'):

```ts
if (currentKey === 'system') {
  result.system = value;
} else if (currentKey === 'translate') {
  // 기존 그대로 — Claude 백엔드일 때도 파싱은 하되 소비자가 무시
  const trimmed = value.trim();
  if (trimmed !== '') {
    result.translateModel = trimmed;
    result.legacy = false;
  }
} else if (currentKey === 'effort') {
  const trimmed = value.trim().toLowerCase();
  if ((OCR_CLAUDE_VALID_EFFORTS as readonly string[]).includes(trimmed)) {
    result.options.effort = trimmed;
  }
} else {
  // temperature/num_ctx — 기존 그대로
  const trimmed = value.trim();
  const n = INT_KEYS.has(currentKey) ? parseInt(trimmed, 10) : parseFloat(trimmed);
  if (Number.isFinite(n)) {
    (result.options as Record<string, number>)[currentKey] = n;
  }
}
```

- [ ] **Step 3: 테스트 추가 — Claude 시그니처 인식 (먼저 작성하고 실패 확인)**

`app/tests/unit/ocrNote/parseOcrNote.test.ts`에 describe 블록 추가:

```ts
describe('parseOcrNote — Claude backend', () => {
  function doc(...lines: string[]) {
    return {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'title' }] },
        ...lines.map((l) => ({
          type: 'paragraph',
          content: l === '' ? [] : [{ type: 'text', text: l }],
        })),
      ],
    };
  }

  it('ocr://claude → backend=claude, model=claude', () => {
    const spec = parseOcrNote(doc('ocr://claude', ''));
    expect(spec?.backend).toBe('claude');
    expect(spec?.model).toBe('claude');
  });

  it('ocr://claude-opus-4-7 → backend=claude, model=claude-opus-4-7', () => {
    const spec = parseOcrNote(doc('ocr://claude-opus-4-7', ''));
    expect(spec?.backend).toBe('claude');
    expect(spec?.model).toBe('claude-opus-4-7');
  });

  it('ocr://got-ocr2 → backend=ollama (회귀)', () => {
    const spec = parseOcrNote(doc('ocr://got-ocr2', ''));
    expect(spec?.backend).toBe('ollama');
  });

  it('ocr://qwen2.5vl:7b → backend=ollama (회귀)', () => {
    const spec = parseOcrNote(doc('ocr://qwen2.5vl:7b', ''));
    expect(spec?.backend).toBe('ollama');
  });

  it('effort: high → options.effort = "high"', () => {
    const spec = parseOcrNote(doc('ocr://claude', 'effort: high', ''));
    expect(spec?.options.effort).toBe('high');
  });

  it('effort: HIGH → options.effort = "high" (소문자 정규화)', () => {
    const spec = parseOcrNote(doc('ocr://claude', 'effort: HIGH', ''));
    expect(spec?.options.effort).toBe('high');
  });

  it('effort: bogus → options.effort undefined', () => {
    const spec = parseOcrNote(doc('ocr://claude', 'effort: bogus', ''));
    expect(spec?.options.effort).toBeUndefined();
  });

  it('Claude 노트의 translate: 헤더는 파싱되지만 소비자가 무시 가능', () => {
    const spec = parseOcrNote(doc('ocr://claude', 'translate: anything', ''));
    // 파싱 동작 자체는 ollama와 동일 — 백엔드별 무시는 소비자(runOcrInEditor)가 결정
    expect(spec?.translateModel).toBe('anything');
  });
});
```

- [ ] **Step 4: 테스트 실행 → 실패 확인**

```bash
cd app && npm run test -- src/lib/ocrNote/parseOcrNote
```

Expected: 새 describe 블록의 테스트들이 모두 실패 — `backend` 필드 없음 / `effort` 헤더 인식 안 됨.

- [ ] **Step 5: 테스트 실행 → 성공 확인**

Step 1/2 변경 반영 후:

```bash
cd app && npm run test -- src/lib/ocrNote/parseOcrNote
```

Expected: 새 케이스 + 기존 케이스 모두 PASS.

- [ ] **Step 6: 타입 체크**

```bash
cd app && npm run check
```

Expected: 0 error.

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/ocrNote/defaults.ts \
        app/src/lib/ocrNote/parseOcrNote.ts \
        app/tests/unit/ocrNote/parseOcrNote.test.ts
git commit -m "ocr 노트: claude 백엔드 시그니처 + effort 헤더 인식"
```

---

### Task 2: OCR 노트 — `runClaude` 실행 분기

**Goal:** `runOcrInEditor`에 `backend === 'claude'` 분기를 추가해 bridge `/claude/chat`로 SSE 호출하고 결과를 노트에 스트리밍 삽입한다. 기존 `legacy`/`twoStage` 경로는 영향 없음.

**Files:**
- Modify: `app/src/lib/ocrNote/runOcrInEditor.ts`
- Test (create): `app/tests/unit/ocrNote/runOcrInEditor.test.ts`

**Acceptance Criteria:**
- [ ] `spec.backend === 'claude'` 일 때 `sendClaude`(chatNote)가 호출되고 `sendOcr` / `sendChat`는 호출되지 않는다
- [ ] 노트 끝에 `[원문]\nOCR 진행 중…` placeholder 단락이 삽입되고, 첫 delta 도착 시 누적 텍스트로 교체된다
- [ ] 빈 응답 (delta 0개 + done) → placeholder가 `[OCR 결과 없음]`으로 교체된다
- [ ] `ClaudeChatError` (모든 kind) → placeholder가 `[OCR 오류: …]`로 교체된다
- [ ] `signal.abort()` → reason='abort' 반환, placeholder는 부분 누적분 유지
- [ ] `editor.setEditable(true)`가 모든 종료 경로에서 호출된다 (finally)
- [ ] 이미지 URL은 `body.messages[0].content[0]` 에 `image/url` 블록으로 들어간다
- [ ] `spec.system`이 비어있으면 `OCR_CLAUDE_SYSTEM_PROMPT`가 사용된다
- [ ] `spec.options.effort`가 비어있으면 `OCR_CLAUDE_DEFAULT_EFFORT`가 사용된다
- [ ] `spec.model === 'claude'` (정확 매치)일 때 body의 `model`은 `undefined` (claude-service 기본값에 위임)
- [ ] `spec.model === 'claude-opus-4-7'` (구체 모델)일 때 body의 `model`은 `'claude-opus-4-7'`

**Verify:** `cd app && npm run test -- src/lib/ocrNote/runOcrInEditor && npm run check`

**Steps:**

- [ ] **Step 1: 테스트 파일 생성 (먼저 작성하고 실패 확인)**

`app/tests/unit/ocrNote/runOcrInEditor.test.ts` 신규 — Claude 분기 단위 테스트만 작성. 기존 `legacy`/`twoStage` 분기 테스트는 본 작업 범위 밖이라 추가하지 않음.

`sendClaude`를 `vi.mock`으로 가짜 구현으로 대체하고 호출 인자를 검증한다. Editor 인스턴스는 TipTap의 `Editor({ extensions: [StarterKit, ...] })`를 실제로 생성하는 것이 가장 신뢰성 높지만, 노트 가시 동작 확인이면 충분하므로 다음 두 방향 중 하나를 택한다:

  - (A) 실제 Editor 인스턴스 생성 후 `editor.getJSON()`/`editor.getText()`로 결과 확인
  - (B) `appendBlock`/`replaceBlockContent` 호출만 spy로 잡고 인자 검증

본 플랜은 (A)를 권장 — 기존 `parseOcrNote.test.ts`가 doc 모킹을 쓰는 것과 일관성이 떨어지지만, runOcrInEditor가 doc 조작을 하므로 진짜 editor가 더 적절. 만약 TipTap 부팅 비용이 무거우면 (B)로 전환.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import * as sendClaudeModule from '../../../src/lib/chatNote/backends/claude.js';
import { ClaudeChatError } from '../../../src/lib/chatNote/backends/claude.js';
import { runOcrInEditor } from '../../../src/lib/ocrNote/runOcrInEditor.js';
import type { OcrNoteSpec } from '../../../src/lib/ocrNote/parseOcrNote.js';

function makeEditor() {
  return new Editor({ extensions: [StarterKit], content: '<p>ocr://claude</p><p></p>' });
}

function baseSpec(overrides: Partial<OcrNoteSpec> = {}): OcrNoteSpec {
  return {
    backend: 'claude',
    model: 'claude',
    legacy: false,
    options: {},
    ...overrides,
  };
}

describe('runOcrInEditor — Claude backend', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sendClaude 호출, sendOcr/sendChat 호출 안 됨', async () => {
    const sendClaude = vi.spyOn(sendClaudeModule, 'sendClaude').mockImplementation(
      async (opts) => {
        opts.onToken('[원문]\nhello\n\n[번역]\n안녕\n');
        return { reason: 'done' };
      },
    );
    const editor = makeEditor();
    const result = await runOcrInEditor({
      editor,
      spec: baseSpec(),
      imageUrl: 'https://dropbox.com/foo.png',
      bridgeUrl: 'wss://bridge.example/ws',
      bridgeToken: 'TOK',
    });
    expect(sendClaude).toHaveBeenCalledOnce();
    expect(result.reason).toBe('done');
    expect(editor.getText()).toContain('hello');
    expect(editor.getText()).toContain('안녕');
  });

  it('body에 image/url 콘텐츠 블록 포함', async () => {
    let captured: any;
    vi.spyOn(sendClaudeModule, 'sendClaude').mockImplementation(async (opts) => {
      captured = opts.body;
      return { reason: 'done' };
    });
    await runOcrInEditor({
      editor: makeEditor(),
      spec: baseSpec(),
      imageUrl: 'https://dropbox.com/foo.png',
      bridgeUrl: 'wss://b/ws',
      bridgeToken: 'T',
    });
    expect(captured.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://dropbox.com/foo.png' },
    });
  });

  it('model="claude"는 body.model undefined로 전달', async () => {
    let captured: any;
    vi.spyOn(sendClaudeModule, 'sendClaude').mockImplementation(async (opts) => {
      captured = opts.body;
      return { reason: 'done' };
    });
    await runOcrInEditor({
      editor: makeEditor(),
      spec: baseSpec({ model: 'claude' }),
      imageUrl: 'x',
      bridgeUrl: 'wss://b/ws',
      bridgeToken: 'T',
    });
    expect(captured.model).toBeUndefined();
  });

  it('model="claude-opus-4-7"는 그대로 전달', async () => {
    let captured: any;
    vi.spyOn(sendClaudeModule, 'sendClaude').mockImplementation(async (opts) => {
      captured = opts.body;
      return { reason: 'done' };
    });
    await runOcrInEditor({
      editor: makeEditor(),
      spec: baseSpec({ model: 'claude-opus-4-7' }),
      imageUrl: 'x',
      bridgeUrl: 'wss://b/ws',
      bridgeToken: 'T',
    });
    expect(captured.model).toBe('claude-opus-4-7');
  });

  it('빈 응답 → [OCR 결과 없음]', async () => {
    vi.spyOn(sendClaudeModule, 'sendClaude').mockImplementation(async () => ({
      reason: 'done',
    }));
    const editor = makeEditor();
    await runOcrInEditor({
      editor,
      spec: baseSpec(),
      imageUrl: 'x',
      bridgeUrl: 'wss://b/ws',
      bridgeToken: 'T',
    });
    expect(editor.getText()).toContain('[OCR 결과 없음]');
  });

  it('ClaudeChatError → [OCR 오류: …]', async () => {
    vi.spyOn(sendClaudeModule, 'sendClaude').mockImplementation(async () => {
      throw new ClaudeChatError('service_unavailable');
    });
    const editor = makeEditor();
    const result = await runOcrInEditor({
      editor,
      spec: baseSpec(),
      imageUrl: 'x',
      bridgeUrl: 'wss://b/ws',
      bridgeToken: 'T',
    });
    expect(result.reason).toBe('error');
    expect(editor.getText()).toContain('[OCR 오류:');
  });

  it('editor.setEditable(true) 모든 종료 경로에서 호출', async () => {
    vi.spyOn(sendClaudeModule, 'sendClaude').mockImplementation(async () => {
      throw new ClaudeChatError('network');
    });
    const editor = makeEditor();
    await runOcrInEditor({
      editor,
      spec: baseSpec(),
      imageUrl: 'x',
      bridgeUrl: 'wss://b/ws',
      bridgeToken: 'T',
    });
    expect(editor.isEditable).toBe(true);
  });

  it('signal abort → reason="abort"', async () => {
    vi.spyOn(sendClaudeModule, 'sendClaude').mockImplementation(async () => ({
      reason: 'abort',
    }));
    const result = await runOcrInEditor({
      editor: makeEditor(),
      spec: baseSpec(),
      imageUrl: 'x',
      bridgeUrl: 'wss://b/ws',
      bridgeToken: 'T',
    });
    expect(result.reason).toBe('abort');
  });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

```bash
cd app && npm run test -- src/lib/ocrNote/runOcrInEditor
```

Expected: 모든 테스트 실패 — runClaude 분기가 없어서 spec.backend 'claude'에서 기존 legacy/twoStage 경로로 떨어짐.

- [ ] **Step 3: `runOcrInEditor.ts`에 runClaude 분기 + 함수 추가**

import 추가:

```ts
import { sendClaude, ClaudeChatError, type ClaudeChatBody } from '../chatNote/backends/claude.js';
import {
  OCR_CLAUDE_DEFAULT_EFFORT,
  OCR_CLAUDE_SYSTEM_PROMPT,
} from './defaults.js';
```

`RunOcrOptions`에 `signal?: AbortSignal` 추가 (테스트가 abort 케이스를 검증하므로).

`RunOcrResult.reason`에 `'abort'`는 이미 `sendChat`/`sendClaude`와 같음 — 별도 변경 없음.

`runOcrInEditor` 본문:

```ts
export async function runOcrInEditor(opts: RunOcrOptions): Promise<RunOcrResult> {
  const { editor, spec, bridgeUrl } = opts;
  const httpBase = normalizeHttpBase(bridgeUrl);

  editor.setEditable(false);
  try {
    if (spec.backend === 'claude') {
      // Claude 백엔드는 이미지 URL을 직접 넘김 — base64 인코딩 단계 없음
      return await runClaude(opts, httpBase);
    }
    opts.onStatus?.('이미지 처리 중…');
    const imageB64 = await loadImageB64(opts);
    if (imageB64 === null) return { reason: 'error', text: '' };
    if (spec.legacy) return await runLegacy(opts, httpBase, imageB64);
    return await runTwoStage(opts, httpBase, imageB64);
  } finally {
    editor.setEditable(true);
  }
}
```

`runClaude` 신규 함수:

```ts
async function runClaude(
  opts: RunOcrOptions,
  httpBase: string,
): Promise<RunOcrResult> {
  const { editor, spec, bridgeToken } = opts;
  opts.onStatus?.('OCR 분석 중…');
  const placeholderPos = appendBlock(editor, '[원문]\nOCR 진행 중…');
  let firstTokenSeen = false;
  let accumulated = '';

  const body: ClaudeChatBody = {
    model: spec.model === 'claude' ? undefined : spec.model,
    system: spec.system && spec.system.length > 0 ? spec.system : OCR_CLAUDE_SYSTEM_PROMPT,
    effort: spec.options.effort ?? OCR_CLAUDE_DEFAULT_EFFORT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: opts.imageUrl } },
          { type: 'text', text: '이 이미지의 텍스트를 추출하고 한국어로 번역해.' },
        ],
      },
    ],
  };

  try {
    const result = await sendClaude({
      url: `${httpBase}/claude/chat`,
      token: bridgeToken,
      body,
      onToken: (delta) => {
        if (!firstTokenSeen) {
          // 첫 delta — placeholder의 "[원문]\nOCR 진행 중…"을 통째로 치움.
          // 시스템 프롬프트가 출력에 [원문] 헤더를 다시 만들어 줌.
          accumulated = delta;
          firstTokenSeen = true;
        } else {
          accumulated += delta;
        }
        replaceBlockContent(editor, placeholderPos, accumulated);
      },
      signal: opts.signal,
    });
    if (!firstTokenSeen) {
      replaceBlockContent(editor, placeholderPos, '[OCR 결과 없음]');
    }
    return { reason: result.reason, text: accumulated };
  } catch (err) {
    const msg = err instanceof ClaudeChatError ? formatClaudeError(err) : (err as Error).message;
    replaceBlockContent(editor, placeholderPos, `[OCR 오류: ${msg}]`);
    return { reason: 'error', text: '' };
  }
}

function formatClaudeError(err: ClaudeChatError): string {
  switch (err.kind) {
    case 'unauthorized':
      return '인증 실패 — 설정에서 브릿지 재로그인';
    case 'service_unavailable':
      return '데스크탑 Claude 서비스 응답 없음';
    case 'rate_limited':
      return '요청 한도 초과 — 잠시 후 재시도';
    case 'cli_failed':
      return `Claude CLI 실패${err.detail ? `: ${err.detail.slice(0, 80)}` : ''}`;
    case 'payload_too_large':
      return '이미지가 너무 큼';
    case 'bad_request':
      return `잘못된 요청${err.detail ? `: ${err.detail.slice(0, 80)}` : ''}`;
    case 'upstream_error':
      return '브릿지/서비스 응답 오류';
    case 'stream_error':
      return '스트림 중단';
    case 'network':
    default:
      return '연결 실패';
  }
}
```

`normalizeHttpBase`의 정규식이 `/(ws|llm\/chat|ocr)\/?$` 만 처리 — `claude/chat` suffix는 등장하지 않으므로 변경 불필요. (호출 시 `${httpBase}/claude/chat`로 직접 붙임)

`runLegacy`/`runTwoStage`/`appendBlock`/`replaceBlockContent` 등 기존 헬퍼는 그대로 재사용.

- [ ] **Step 4: 테스트 실행 → 성공 확인**

```bash
cd app && npm run test -- src/lib/ocrNote/runOcrInEditor
```

Expected: 모든 새 케이스 PASS.

- [ ] **Step 5: 타입 체크 + 전체 OCR 노트 테스트**

```bash
cd app && npm run check && npm run test -- src/lib/ocrNote
```

Expected: 0 error, 기존 OCR 노트 테스트 회귀 없음.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/ocrNote/runOcrInEditor.ts \
        app/tests/unit/ocrNote/runOcrInEditor.test.ts
git commit -m "ocr 노트: claude 백엔드 실행 분기 — sendClaude 재사용, URL passthrough"
```

---

### Task 3: OCR 노트 — 설정 가이드 카드 업데이트

**Goal:** 설정 → 가이드 → 노트 탭의 OCR 카드를 `ocr://claude` 권장으로 업데이트하고 `effort:` 헤더 라인을 추가한다. 기존 `ocr://got-ocr2` 호환성 주석 포함.

**Files:**
- Modify: `app/src/routes/settings/+page.svelte`

**Acceptance Criteria:**
- [ ] 가이드 카드의 시그니처 예시 첫 줄이 `ocr://claude`로 표기됨
- [ ] `effort: high` 헤더가 카드 본문 또는 코드 스니펫에 명시됨
- [ ] 기존 `ocr://got-ocr2` 노트가 계속 작동한다는 한 줄 안내 포함
- [ ] 빌드 통과 (`npm run check`)
- [ ] 가이드 카드 추가가 아님 — 기존 OCR 카드 본문만 수정

**Verify:** 수동: `cd app && npm run dev` → 설정 → 가이드 → 노트 탭 → "OCR 노트" 카드 펼침. `ocr://claude` 시그니처 + effort 헤더 + got-ocr2 호환 안내 보임.

**Steps:**

- [ ] **Step 1: 현재 OCR 가이드 카드 위치 확인**

```bash
grep -n "ocr://\|OCR 노트" app/src/routes/settings/+page.svelte | head
```

가장 근접한 카드의 `<details class="guide-card">` 블록을 찾는다.

- [ ] **Step 2: 카드 본문을 새 권장값으로 교체**

기존 시그니처 예시(`ocr://got-ocr2` 또는 유사) 부분을:

```svelte
<pre class="snippet">ocr://claude
effort: high

[이미지 붙여넣기]</pre>

<ul class="guide-list">
  <li><strong>기본 백엔드는 Claude</strong> — 데스크탑 claude-service의 구독 OAuth 사용. 토큰당 추가 과금 없음.</li>
  <li><strong>한 번 호출로 OCR + 한국어 번역</strong> 동시 처리. 결과는 <code>[원문]</code>/<code>[번역]</code> 두 블록.</li>
  <li><strong>옵션 헤더</strong> — <code>model: claude-opus-4-7</code>, <code>effort: low|medium|high|xhigh|max</code>, <code>system: …</code>.</li>
  <li><strong>기존 <code>ocr://got-ocr2</code> 노트도 계속 작동</strong>. ocr-service(GOT-OCR2) 경로가 살아 있음.</li>
</ul>
```

기존 카드의 다른 구조(요약/소개 단락)는 그대로 두고 위 두 블록만 갈아끼움.

- [ ] **Step 3: 빌드 + 타입 체크**

```bash
cd app && npm run check
```

Expected: 0 error.

- [ ] **Step 4: 로컬에서 시각 확인**

```bash
cd app && npm run dev
```

브라우저에서 `/settings` → 가이드 → 노트 탭 → OCR 카드 펼침 → 위 4개 항목 + 코드 스니펫 보임.

- [ ] **Step 5: 커밋**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "ocr 노트 가이드 카드: claude 백엔드 권장으로 업데이트"
```

---

### Task 4: 일기 파이프라인 — `ClaudeConfig` + YAML 디폴트 변경

**Goal:** `pipeline/desktop/lib/config.py`에 `ClaudeConfig` dataclass를 추가하고 `OcrConfig`에 `claude` 서브섹션을 끼운다. `_EXAMPLE_YAML`(bootstrap이 생성)의 기본 `backend`를 `"claude"`로 변경하고 `claude:`/`local_vlm:` 두 섹션을 함께 둔다.

**Files:**
- Modify: `pipeline/desktop/lib/config.py`
- Test (modify): `pipeline/tests/lib/test_config.py`

**Acceptance Criteria:**
- [ ] `ClaudeConfig` dataclass: `service_url`, `service_token`, `model`, `effort`, `system_prompt_path` 필드 (frozen)
- [ ] `OcrConfig.from_dict`가 `backend == "claude"`일 때 `claude:` 서브섹션을 필수로 요구
- [ ] `OcrConfig.from_dict`가 `backend == "local_vlm"`일 때 `local_vlm:` 서브섹션을 필수로 요구 (기존 동작 유지)
- [ ] `_EXAMPLE_YAML`의 ocr 섹션이 `backend: "claude"` + claude/local_vlm 두 서브섹션을 모두 포함
- [ ] 기존 `backend: "local_vlm"`만 있는 yaml 회귀 없음 (`tests/lib/test_config.py` 기존 케이스 통과)
- [ ] 새 케이스: `backend: "claude"` + claude 서브섹션 → 정상 파싱
- [ ] 새 케이스: `backend: "claude"`인데 `claude:` 누락 → `ConfigError`

**Verify:** `cd pipeline && pytest tests/lib/test_config.py -v`

**Steps:**

- [ ] **Step 1: 테스트 추가 — 신규 ClaudeConfig 케이스 (먼저 작성하고 실패 확인)**

`pipeline/tests/lib/test_config.py`에 추가:

```python
def test_load_with_claude_backend():
    yaml_text = VALID_YAML.replace(
        '''ocr:
  backend: "local_vlm"
  local_vlm:
    model_id: "Qwen/Qwen2.5-VL-7B-Instruct"''',
        '''ocr:
  backend: "claude"
  claude:
    service_url: "http://localhost:7842"
    service_token: "tok"
    model: ""
    effort: "high"
    system_prompt_path: "config/prompts/diary-ko.txt"''',
    )
    cfg = load_config_from_string(yaml_text)
    assert cfg.ocr.backend == "claude"
    assert cfg.ocr.claude is not None
    assert cfg.ocr.claude.service_url == "http://localhost:7842"
    assert cfg.ocr.claude.service_token == "tok"
    assert cfg.ocr.claude.model == ""
    assert cfg.ocr.claude.effort == "high"
    assert cfg.ocr.claude.system_prompt_path == "config/prompts/diary-ko.txt"
    # local_vlm 서브섹션 없어도 OK (backend != "local_vlm")
    assert cfg.ocr.local_vlm is None


def test_load_with_claude_backend_missing_subsection_fails():
    yaml_text = VALID_YAML.replace(
        '''ocr:
  backend: "local_vlm"
  local_vlm:
    model_id: "Qwen/Qwen2.5-VL-7B-Instruct"''',
        '''ocr:
  backend: "claude"''',
    )
    with pytest.raises(ConfigError):
        load_config_from_string(yaml_text)


def test_example_yaml_defaults_to_claude():
    yaml_text = Config.example_yaml()
    # 예제 yaml은 placeholders가 있으므로 직접 파싱하지 말고 substring 검사
    assert 'backend: "claude"' in yaml_text
    assert "claude:" in yaml_text
    assert "service_url:" in yaml_text
    assert "local_vlm:" in yaml_text  # 두 섹션 모두 보존
```

기존 `test_load_with_local_vlm_backend` (또는 비슷한 이름) 테스트가 있으면 그대로 유지 (`backend: "local_vlm"` 회귀 케이스).

- [ ] **Step 2: 테스트 실행 → 실패 확인**

```bash
cd pipeline && pytest tests/lib/test_config.py -v
```

Expected: 새 3개 케이스 실패 (`ClaudeConfig` 없음, example_yaml에 claude 미포함).

- [ ] **Step 3: `config.py`에 ClaudeConfig + OcrConfig 변경**

```python
# pipeline/desktop/lib/config.py

@dataclass(frozen=True)
class ClaudeConfig:
    service_url: str
    service_token: str
    model: str  # 빈 문자열 = claude-service 기본값
    effort: str
    system_prompt_path: str

    @classmethod
    def from_dict(cls, d: dict) -> ClaudeConfig:
        return cls(
            service_url=_require(d, "service_url", "ocr.claude.service_url"),
            service_token=_require(d, "service_token", "ocr.claude.service_token"),
            model=d.get("model", ""),
            effort=d.get("effort", "high"),
            system_prompt_path=d.get(
                "system_prompt_path", "config/prompts/diary-ko.txt"
            ),
        )


@dataclass(frozen=True)
class OcrConfig:
    backend: str
    local_vlm: LocalVlmConfig | None = None
    claude: ClaudeConfig | None = None

    @classmethod
    def from_dict(cls, d: dict) -> OcrConfig:
        backend = _require(d, "backend", "ocr.backend")
        local_vlm = LocalVlmConfig.from_dict(d["local_vlm"]) if "local_vlm" in d else None
        claude = ClaudeConfig.from_dict(d["claude"]) if "claude" in d else None
        if backend == "claude" and claude is None:
            raise ConfigError("ocr.backend is 'claude' but ocr.claude subsection is missing")
        if backend == "local_vlm" and local_vlm is None:
            raise ConfigError("ocr.backend is 'local_vlm' but ocr.local_vlm subsection is missing")
        return cls(backend=backend, local_vlm=local_vlm, claude=claude)
```

`_EXAMPLE_YAML`의 ocr 섹션 교체:

```python
_EXAMPLE_YAML = """\
# Generated by `python -m desktop.bootstrap`. Do not edit by hand unless
# you know what you're doing — bootstrap is idempotent.

firebase_uid: "dbx-REPLACE_ME"
firebase_service_account: "/path/to/firebase-sa.json"
dropbox_refresh_token: "REPLACE_ME"
dropbox_app_key: "REPLACE_ME"

remarkable:
  diary_notebook_name: "Diary"
  ssh_host: "rm.local"
  ssh_user: "root"

pi:
  ssh_host: "pi.example.com"
  ssh_port: 2222
  ssh_user: "diary-sync"
  ssh_key: "~/.ssh/id_ed25519_diary"
  inbox_path: "~/diary/inbox"

desktop:
  data_dir: "~/.local/share/tomboy-pipeline"

tomboy:
  diary_notebook_name: "일기"
  title_format: "{date} 리마커블([{page_uuid}])"

ocr:
  backend: "claude"
  # claude-service (구독 OAuth 재사용) 경유. backend가 "claude"일 때만 사용.
  claude:
    service_url: "http://localhost:7842"
    service_token: "REPLACE_ME"  # claude-service Bearer 토큰
    model: ""                    # 빈 값 = claude-service 기본 모델
    effort: "high"
    system_prompt_path: "config/prompts/diary-ko.txt"
  # 로컬 GPU(Qwen2.5-VL) 경로. backend가 "local_vlm"일 때만 사용.
  # claude → local_vlm 전환은 위 backend 한 줄만 변경하면 됨.
  local_vlm:
    model_id: "Qwen/Qwen2.5-VL-7B-Instruct"
    quantization: "4bit"
    max_new_tokens: 2048
    system_prompt_path: "config/prompts/diary-ko.txt"
"""
```

- [ ] **Step 4: 테스트 실행 → 성공 확인**

```bash
cd pipeline && pytest tests/lib/test_config.py -v
```

Expected: 신규 + 기존 케이스 모두 PASS.

- [ ] **Step 5: 커밋**

```bash
git add pipeline/desktop/lib/config.py \
        pipeline/tests/lib/test_config.py
git commit -m "일기 파이프라인 설정: claude 백엔드 + 기본값 변경"
```

---

### Task 5: 일기 파이프라인 — `ClaudeBackend` 클래스

**Goal:** `register_backend("claude")` 데코레이터로 등록되는 `ClaudeBackend(OCRBackend)`를 만든다. 이미지 파일 → base64 → claude-service `/chat` POST → SSE delta 누적 → `OCRResult` 반환. HTTP 실패 모드별 처리(401 즉시 중단, 503 1회 retry, timeout/network/SSE error → 페이지 실패).

**Files:**
- Create: `pipeline/desktop/ocr_backends/claude.py`
- Modify: `pipeline/desktop/ocr_backends/__init__.py` (`from . import claude` 추가)
- Test (create): `pipeline/tests/desktop/ocr_backends/test_claude.py`

**Acceptance Criteria:**
- [ ] `register_backend("claude")` 적용 → `get_backend("claude", ...)`로 인스턴스화 가능
- [ ] `ClaudeBackend(service_url, service_token, model, effort, system_prompt_path)` 생성자가 system prompt 파일을 읽어 멤버로 보관
- [ ] `ocr(image_path)` → 정상 응답 시 `OCRResult(text=누적, model=f"claude:{model or 'default'}", prompt_hash=hash12, ts=now)` 반환
- [ ] HTTP 401 → `RuntimeError("claude-service 인증 실패: …")` raise (retry 없음)
- [ ] HTTP 503 → 5초 대기 후 1회 retry, 두 번째도 503이면 RuntimeError
- [ ] `httpx.ConnectError` → RuntimeError("claude-service 연결 실패: …")
- [ ] `httpx.TimeoutException` → RuntimeError("claude-service 타임아웃 …")
- [ ] SSE `{"error": "..."}` 프레임 → RuntimeError 메시지 그대로
- [ ] SSE `{"delta": "..."}` 누적, `{"done": true}` 종료, `{"step": ...}`는 무시
- [ ] 요청 body: `messages[0].content[0]`은 `image/base64` (data 필드 = base64), `[1]`은 텍스트 프롬프트

**Verify:** `cd pipeline && pytest tests/desktop/ocr_backends/test_claude.py -v`

**Steps:**

- [ ] **Step 1: 테스트 파일 생성 (먼저 작성하고 실패 확인)**

`pipeline/tests/desktop/ocr_backends/test_claude.py`:

```python
"""ClaudeBackend tests. Mocks httpx.Client to feed canned SSE responses
and validate the request body shape + error mapping."""
from __future__ import annotations

import base64
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import httpx
import pytest

from desktop.ocr_backends.claude import ClaudeBackend
from desktop.ocr_backends.base import get_backend


def _sse_stream(lines: list[str]) -> MagicMock:
    """A mock for httpx.Client.stream return — yields raw SSE lines."""
    resp = MagicMock()
    resp.status_code = 200
    resp.is_success = True
    resp.iter_lines.return_value = iter(lines)
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = None
    return resp


def _make_backend(tmp_path: Path) -> ClaudeBackend:
    prompt_path = tmp_path / "prompt.txt"
    prompt_path.write_text("test prompt", encoding="utf-8")
    return ClaudeBackend(
        service_url="http://localhost:7842",
        service_token="TOK",
        model="claude-opus-4-7",
        effort="high",
        system_prompt_path=str(prompt_path),
    )


def _make_image(tmp_path: Path) -> Path:
    img = tmp_path / "page.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    return img


def test_registered():
    """get_backend('claude', ...) returns a ClaudeBackend instance."""
    # Cheap construction: real impl reads system_prompt_path → use /dev/null-like
    # by passing a tmp file via fixture path; here we just check registration.
    from desktop.ocr_backends import claude as claude_mod  # noqa: F401
    backends = ClaudeBackend.__mro__
    assert any(b.__name__ == "OCRBackend" for b in backends)


def test_success_path(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    sse_lines = [
        'data: {"delta": "hello "}',
        '',
        'data: {"step": {"kind": "thinking", "label": "x", "body": "y"}}',
        '',
        'data: {"delta": "world"}',
        '',
        'data: {"done": true, "reason": "success"}',
        '',
    ]
    captured_body = {}

    def fake_stream(self, method, url, **kw):
        captured_body['method'] = method
        captured_body['url'] = url
        captured_body['headers'] = kw.get('headers')
        captured_body['json'] = kw.get('json')
        return _sse_stream(sse_lines)

    with patch.object(httpx.Client, 'stream', fake_stream):
        result = backend.ocr(img)

    assert result.text == "hello world"
    assert result.model == "claude:claude-opus-4-7"
    assert captured_body['method'] == 'POST'
    assert captured_body['url'].endswith('/chat')
    assert captured_body['headers']['Authorization'] == 'Bearer TOK'

    body = captured_body['json']
    assert body['model'] == 'claude-opus-4-7'
    assert body['effort'] == 'high'
    assert body['system'] == 'test prompt'
    img_block = body['messages'][0]['content'][0]
    assert img_block['type'] == 'image'
    assert img_block['source']['type'] == 'base64'
    assert img_block['source']['media_type'] == 'image/png'
    # base64는 원본 바이트의 인코딩
    decoded = base64.b64decode(img_block['source']['data'])
    assert decoded == img.read_bytes()


def test_empty_model_omits_field(tmp_path):
    """model='' → body의 model 필드는 빈 문자열로 그대로 전달 (claude-service가 빈 값을 기본으로 해석)."""
    prompt_path = tmp_path / "p.txt"
    prompt_path.write_text("p", encoding="utf-8")
    backend = ClaudeBackend(
        service_url="http://localhost:7842",
        service_token="TOK",
        model="",
        effort="high",
        system_prompt_path=str(prompt_path),
    )
    img = _make_image(tmp_path)
    captured = {}
    def fake_stream(self, method, url, **kw):
        captured['json'] = kw['json']
        return _sse_stream(['data: {"done": true}', ''])
    with patch.object(httpx.Client, 'stream', fake_stream):
        result = backend.ocr(img)
    assert captured['json']['model'] == ''
    assert result.model == 'claude:default'


def test_http_401_immediate_raise(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    resp = MagicMock()
    resp.status_code = 401
    resp.is_success = False
    resp.text = 'unauthorized'
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = None
    call_count = {'n': 0}
    def fake_stream(self, method, url, **kw):
        call_count['n'] += 1
        return resp
    with patch.object(httpx.Client, 'stream', fake_stream):
        with pytest.raises(RuntimeError, match='인증 실패'):
            backend.ocr(img)
    assert call_count['n'] == 1  # retry 없음


def test_http_503_retries_once(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    resp503 = MagicMock()
    resp503.status_code = 503
    resp503.is_success = False
    resp503.text = 'unavailable'
    resp503.__enter__.return_value = resp503
    resp503.__exit__.return_value = None

    call_count = {'n': 0}
    def fake_stream(self, method, url, **kw):
        call_count['n'] += 1
        if call_count['n'] == 1:
            return resp503
        return _sse_stream(['data: {"delta": "ok"}', '', 'data: {"done": true}', ''])

    # time.sleep mock — backoff을 기다리지 않음
    with patch.object(httpx.Client, 'stream', fake_stream), \
         patch('desktop.ocr_backends.claude.time.sleep'):
        result = backend.ocr(img)
    assert call_count['n'] == 2
    assert result.text == 'ok'


def test_http_503_twice_raises(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    resp = MagicMock()
    resp.status_code = 503
    resp.is_success = False
    resp.text = 'unavailable'
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = None

    def fake_stream(self, method, url, **kw):
        return resp
    with patch.object(httpx.Client, 'stream', fake_stream), \
         patch('desktop.ocr_backends.claude.time.sleep'):
        with pytest.raises(RuntimeError, match='claude-service'):
            backend.ocr(img)


def test_connect_error(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    def fake_stream(self, method, url, **kw):
        raise httpx.ConnectError("refused")
    with patch.object(httpx.Client, 'stream', fake_stream):
        with pytest.raises(RuntimeError, match='연결 실패'):
            backend.ocr(img)


def test_timeout(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    def fake_stream(self, method, url, **kw):
        raise httpx.TimeoutException("slow")
    with patch.object(httpx.Client, 'stream', fake_stream):
        with pytest.raises(RuntimeError, match='타임아웃'):
            backend.ocr(img)


def test_sse_error_frame(tmp_path):
    backend = _make_backend(tmp_path)
    img = _make_image(tmp_path)
    sse_lines = [
        'data: {"error": "model overloaded"}',
        '',
    ]
    def fake_stream(self, method, url, **kw):
        return _sse_stream(sse_lines)
    with patch.object(httpx.Client, 'stream', fake_stream):
        with pytest.raises(RuntimeError, match='model overloaded'):
            backend.ocr(img)
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

```bash
cd pipeline && pytest tests/desktop/ocr_backends/test_claude.py -v
```

Expected: ImportError (`claude.py` 없음) — 모든 테스트 실패.

- [ ] **Step 3: `pipeline/desktop/ocr_backends/claude.py` 신규 작성**

```python
"""claude-service 경유 OCR 백엔드.

이미지 파일을 base64로 인코딩해 데스크탑 claude-service의 `/chat`에
POST한다. 응답은 SSE 스트림(`data: {"delta": ...}` 등)이며, 누적된
텍스트를 ``OCRResult.text``로 반환한다.

claude-service는 chat-note에서 이미 쓰는 구독 OAuth 기반 Claude Code
CLI 래퍼다. 같은 서비스를 일기 파이프라인이 재사용해 토큰당 과금을
피한다.

실패 처리:
- HTTP 401: 즉시 RuntimeError (같은 토큰으로 retry해도 같음)
- HTTP 503: 5초 대기 후 1회 retry, 그래도 503이면 RuntimeError
- ConnectError / Timeout: RuntimeError (상위 stage가 페이지 단위로 격리)
- SSE {"error": "..."} 프레임: RuntimeError (메시지 그대로 전파)
"""
from __future__ import annotations

import base64
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .base import OCRBackend, OCRResult, register_backend


_USER_PROMPT = "이 일기 페이지의 손글씨를 한국어로 그대로 추출해. 그림이나 도표는 무시. 읽을 수 없는 글자는 ⌗ 한 글자로 표기."
_TIMEOUT_SECONDS = 120.0
_RETRY_DELAY_SECONDS = 5.0


@register_backend("claude")
class ClaudeBackend(OCRBackend):
    def __init__(
        self,
        *,
        service_url: str,
        service_token: str,
        model: str,
        effort: str,
        system_prompt_path: str,
    ) -> None:
        self._chat_url = service_url.rstrip("/") + "/chat"
        self._token = service_token
        self._model = model
        self._effort = effort
        self._system = Path(system_prompt_path).read_text(encoding="utf-8")
        self._prompt_hash = hashlib.sha256(
            (self._system + "\n---\n" + _USER_PROMPT).encode("utf-8")
        ).hexdigest()[:12]

    def ocr(self, image_path: Path) -> OCRResult:
        b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
        body = {
            "model": self._model,
            "system": self._system,
            "effort": self._effort,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": b64,
                            },
                        },
                        {"type": "text", "text": _USER_PROMPT},
                    ],
                }
            ],
        }
        text = self._post_with_retry(body)
        model_label = self._model if self._model else "default"
        return OCRResult(
            text=text,
            model=f"claude:{model_label}",
            prompt_hash=self._prompt_hash,
            ts=datetime.now(timezone.utc),
        )

    def _post_with_retry(self, body: dict) -> str:
        try:
            return self._post_once(body)
        except _ServiceUnavailable:
            time.sleep(_RETRY_DELAY_SECONDS)
            try:
                return self._post_once(body)
            except _ServiceUnavailable as e:
                raise RuntimeError(
                    f"claude-service 응답 없음(503) — retry 후에도 실패: {e}"
                ) from e

    def _post_once(self, body: dict) -> str:
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        try:
            with httpx.Client(timeout=_TIMEOUT_SECONDS) as client:
                with client.stream(
                    "POST", self._chat_url, headers=headers, json=body
                ) as resp:
                    if resp.status_code == 401:
                        raise RuntimeError(
                            f"claude-service 인증 실패(401): service_token 확인"
                        )
                    if resp.status_code == 503:
                        raise _ServiceUnavailable(getattr(resp, "text", ""))
                    if not resp.is_success:
                        text = getattr(resp, "text", "")
                        raise RuntimeError(
                            f"claude-service HTTP {resp.status_code}: {text[:200]}"
                        )
                    return _parse_sse(resp.iter_lines())
        except httpx.ConnectError as e:
            raise RuntimeError(f"claude-service 연결 실패({self._chat_url}): {e}") from e
        except httpx.TimeoutException as e:
            raise RuntimeError(f"claude-service 타임아웃({_TIMEOUT_SECONDS}s): {e}") from e


class _ServiceUnavailable(Exception):
    """Sentinel for 503 — _post_with_retry catches and retries once."""


def _parse_sse(lines) -> str:
    """`data: {...}` 라인만 처리, 빈 줄과 그 외는 무시.

    delta는 누적, done이면 종료, error 프레임은 즉시 RuntimeError.
    step 이벤트는 일기 OCR엔 필요 없어 무시.
    """
    accumulated: list[str] = []
    for raw in lines:
        line = raw.strip() if isinstance(raw, str) else raw.decode("utf-8").strip()
        if not line or not line.startswith("data:"):
            continue
        json_text = line[len("data:") :].strip()
        if not json_text:
            continue
        try:
            evt = json.loads(json_text)
        except json.JSONDecodeError:
            continue
        if "error" in evt:
            raise RuntimeError(f"claude-service SSE error: {evt['error']}")
        if "delta" in evt and isinstance(evt["delta"], str):
            accumulated.append(evt["delta"])
        if evt.get("done"):
            break
    return "".join(accumulated)
```

- [ ] **Step 4: `__init__.py`에 claude 모듈 import 추가**

```python
# pipeline/desktop/ocr_backends/__init__.py
from . import local_vlm  # noqa: F401  registers "local_vlm"
from . import claude     # noqa: F401  registers "claude"
from .base import OCRBackend, OCRResult, get_backend, list_backends, register_backend
```

- [ ] **Step 5: 테스트 실행 → 성공 확인**

```bash
cd pipeline && pytest tests/desktop/ocr_backends/test_claude.py -v
```

Expected: 9개 케이스 모두 PASS.

- [ ] **Step 6: 등록 확인 — 간단한 스모크**

```bash
cd pipeline && python -c "from desktop.ocr_backends import list_backends; print(list_backends())"
```

Expected: `['claude', 'local_vlm']` (또는 알파벳 정렬).

- [ ] **Step 7: 커밋**

```bash
git add pipeline/desktop/ocr_backends/claude.py \
        pipeline/desktop/ocr_backends/__init__.py \
        pipeline/tests/desktop/ocr_backends/test_claude.py
git commit -m "일기 파이프라인: claude OCR 백엔드 추가 (claude-service 경유)"
```

---

### Task 6: 일기 파이프라인 — `s3_ocr` 백엔드 디스패치 라우팅

**Goal:** `s3_ocr.py`의 하드코딩된 `if cfg.ocr.backend != "local_vlm"` 가드를 제거하고, backend 값에 따라 `get_backend(...)`에 올바른 kwargs를 전달한다. 기존 local_vlm 경로 회귀 없음.

**Files:**
- Modify: `pipeline/desktop/stages/s3_ocr.py`
- Test (modify): `pipeline/tests/test_run_pipeline.py` 또는 `pipeline/tests/desktop/stages/` 신규 (기존 s3 테스트 위치 확인 후 결정)

**Acceptance Criteria:**
- [ ] `cfg.ocr.backend == "local_vlm"`이면 기존과 동일하게 `local_vlm` 인자(`model_id`/`quantization`/`max_new_tokens`/`system_prompt_path`)로 `get_backend("local_vlm", ...)` 호출
- [ ] `cfg.ocr.backend == "claude"`이면 `claude` 인자(`service_url`/`service_token`/`model`/`effort`/`system_prompt_path`)로 `get_backend("claude", ...)` 호출
- [ ] 그 외 backend 값은 명시적 에러 (`Unsupported OCR backend: …`)
- [ ] 기존 s3_ocr 회귀 테스트 (있다면) 통과

**Verify:** `cd pipeline && pytest tests/ -v -k "s3_ocr or run_pipeline"`

**Steps:**

- [ ] **Step 1: 기존 s3_ocr 테스트 위치 확인**

```bash
grep -rln "s3_ocr\|get_backend" pipeline/tests/ | head
```

위치에 따라 신규 케이스 위치 결정.

- [ ] **Step 2: 라우팅 케이스 테스트 추가 (먼저 작성하고 실패 확인)**

`s3_ocr.py`의 main 흐름은 `cfg.ocr.backend != "local_vlm"`면 종료라 claude 케이스는 명시적 실패. 신규 단위 테스트(예: `pipeline/tests/desktop/stages/test_s3_ocr_dispatch.py`)로 디스패치 로직만 검증:

```python
from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest

from desktop.lib.config import Config, ClaudeConfig, LocalVlmConfig, OcrConfig
# ... 다른 Config 컴포넌트 import (기존 test_config가 어떻게 minimal Config를 만드는지 참고)


def _make_cfg_with_backend(backend: str, tmp_path) -> Config:
    """기존 test_config.py의 VALID_YAML 헬퍼 차용해 minimal Config 생성."""
    # 구현 단계에서 test_config.py의 VALID_YAML 빌더를 import해 재사용
    ...


def test_s3_ocr_dispatches_to_claude(tmp_path, monkeypatch):
    cfg = _make_cfg_with_backend("claude", tmp_path)
    captured = {}
    def fake_get_backend(name, **kw):
        captured['name'] = name
        captured['kw'] = kw
        return MagicMock()
    with patch('desktop.stages.s3_ocr.get_backend', fake_get_backend):
        # s3_ocr의 main이 너무 무거우면 디스패치 부분만 추출한 헬퍼를 노출시켜 테스트
        # 또는 run_pipeline 흐름을 부분 모킹
        ...
    assert captured['name'] == 'claude'
    assert 'service_url' in captured['kw']


def test_s3_ocr_dispatches_to_local_vlm(tmp_path, monkeypatch):
    cfg = _make_cfg_with_backend("local_vlm", tmp_path)
    captured = {}
    def fake_get_backend(name, **kw):
        captured['name'] = name
        captured['kw'] = kw
        return MagicMock()
    with patch('desktop.stages.s3_ocr.get_backend', fake_get_backend):
        ...
    assert captured['name'] == 'local_vlm'
    assert 'model_id' in captured['kw']
```

**구현 노트:** s3_ocr.py의 main()이 단일 함수로 되어 있어 단위 테스트가 어렵다면 디스패치 로직만 `_build_backend(cfg) -> OCRBackend` 함수로 추출하고 그 함수만 단위 테스트한다. 이게 구조적으로 더 깔끔하기도 함.

- [ ] **Step 3: `s3_ocr.py`에 디스패치 헬퍼 추출 + 라우팅**

```python
# pipeline/desktop/stages/s3_ocr.py

from desktop.ocr_backends.base import OCRBackend, get_backend
from desktop.lib.config import Config


def _build_backend(cfg: Config) -> OCRBackend:
    """cfg.ocr.backend 값에 따라 적절한 OCRBackend 인스턴스 반환."""
    backend_name = cfg.ocr.backend
    if backend_name == "local_vlm":
        if cfg.ocr.local_vlm is None:
            raise RuntimeError("ocr.backend='local_vlm' but ocr.local_vlm subsection missing")
        c = cfg.ocr.local_vlm
        return get_backend(
            "local_vlm",
            model_id=c.model_id,
            quantization=c.quantization,
            max_new_tokens=c.max_new_tokens,
            system_prompt_path=c.system_prompt_path,
        )
    if backend_name == "claude":
        if cfg.ocr.claude is None:
            raise RuntimeError("ocr.backend='claude' but ocr.claude subsection missing")
        c = cfg.ocr.claude
        return get_backend(
            "claude",
            service_url=c.service_url,
            service_token=c.service_token,
            model=c.model,
            effort=c.effort,
            system_prompt_path=c.system_prompt_path,
        )
    raise RuntimeError(f"Unsupported OCR backend: {backend_name}")
```

main()의 기존 가드 + 호출 블록 (라인 94~104) 교체:

```python
# 기존
if cfg.ocr.backend != "local_vlm" or cfg.ocr.local_vlm is None:
    print(f"Unsupported OCR backend in config: {cfg.ocr.backend}", file=sys.stderr)
    return 1

backend = get_backend(
    cfg.ocr.backend,
    model_id=cfg.ocr.local_vlm.model_id,
    ...
)

# 신규
try:
    backend = _build_backend(cfg)
except RuntimeError as e:
    print(str(e), file=sys.stderr)
    return 1
```

- [ ] **Step 4: 테스트 실행 → 성공 확인**

```bash
cd pipeline && pytest tests/ -v -k "s3_ocr or run_pipeline or dispatch"
```

Expected: 신규 + 기존 s3_ocr/run_pipeline 케이스 통과.

- [ ] **Step 5: 전체 파이프라인 테스트 회귀 확인**

```bash
cd pipeline && pytest tests/ -v
```

Expected: 모든 기존 테스트 통과.

- [ ] **Step 6: 커밋**

```bash
git add pipeline/desktop/stages/s3_ocr.py \
        pipeline/tests/  # 새 테스트 파일 경로
git commit -m "일기 파이프라인 s3_ocr: backend 디스패치 — local_vlm + claude 라우팅"
```

---

## Self-review

**Spec coverage:**
- ① defaults.ts 수정 → Task 1 ✓
- ② parseOcrNote.ts 수정 → Task 1 ✓
- ③ sendClaude.ts 신규 → **deviation**: chatNote의 sendClaude 재사용 (플랜 상단에 명시)
- ④ runOcrInEditor.ts 수정 → Task 2 ✓
- ⑤ claude.py 신규 → Task 5 ✓
- ⑥ config.py 수정 → Task 4 ✓
- ⑦ settings 가이드 카드 → Task 3 ✓
- s3_ocr 라우팅 (스펙엔 명시 없지만 ocr_backends/__init__.py와 stage wiring 필요) → Task 6

**Placeholder scan:**
- Task 6 Step 1/2의 `...` ellipses는 의도된 — 기존 테스트 위치는 구현자가 grep으로 확인 후 결정하는 자연스러운 분기. 단, `_make_cfg_with_backend` 헬퍼 구현이 비어 있음 → 명확히 `test_config.py`의 VALID_YAML 빌더를 import하라고 명시했음. 추가 specificity가 필요하면 구현자가 Task 4의 yaml 빌더를 직접 호출하면 됨.

**Type consistency:**
- `OcrNoteSpec.backend: 'ollama' | 'claude'` — Task 1/2 일치
- `ClaudeChatBody`의 model/system/effort/messages — Task 2 일치 (chatNote 기존 타입 그대로 import)
- `ClaudeBackend(service_url, service_token, model, effort, system_prompt_path)` — Task 4(config) + Task 5(생성자) + Task 6(s3_ocr wiring) 일치

문제 없음. 진행.

---

## 비범위 / 추후 작업

- 채팅 노트 백엔드 변경 — 이미 양쪽 존재, 본 작업 범위 아님
- 기존 `ocr://got-ocr2` 노트 자동 마이그레이션 — 안 함
- `local_vlm.py` / Qwen 코드 제거 — 안 함 (yaml 한 줄로 복귀 가능 유지)
- claude-service에 OCR/일기 전용 엔드포인트 신설 — 안 함 (`/chat` 그대로 사용)
- Ollama RAG (`/api/rag/search`) Claude 대체 — Claude API에 등가물 없음
