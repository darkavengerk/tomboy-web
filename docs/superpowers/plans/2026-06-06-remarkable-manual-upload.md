# 리마커블 수동 업로드 (`리마커블::`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `리마커블::<제목>` 노트의 "📥 업로드" 버튼 → 브릿지가 리마커블 SSH 페치 → Pi inbox 적재 → automation-service 경유로 데스크탑 파이프라인을 즉시 트리거하는 흐름을 추가한다.

**Architecture:** 자동화 노트(`자동화::`) 패턴을 1:1 미러. 클라이언트(파서/SSE 클라이언트/에디터 위젯) + 브릿지 라우트(SSH/rsync/SSE emit) + automation-service registry 항목(코드 변경 없음). 데스크탑 파이프라인 자체는 무수정 재사용.

**Tech Stack:** SvelteKit + Svelte 5 runes (브라우저), TipTap 3 (에디터), Node + http SSE (브릿지), Fastify (automation-service), vitest + @testing-library/svelte (앱 테스트), `node --test` (브릿지 테스트).

**Spec:** `docs/superpowers/specs/2026-06-06-remarkable-manual-upload-design.md`

**Spec deviation:** Spec은 "automation-service 신규 명령 핸들러"라 표현했으나, registry는 매 요청 재읽힘 구조이므로 실제로는 **registry.json에 단일 항목 추가만 필요** (코드 0줄). 이 plan에서 Task 5로 명시.

---

## Task 1: 노트 시그니처 파서

**Goal:** `리마커블::<제목>` 시그니처 + `폴더: <이름>` 헤더를 파싱하는 순수 함수.

**Files:**
- Create: `app/src/lib/remarkable/parseRemarkableNote.ts`
- Create: `app/tests/unit/remarkable/parseRemarkableNote.test.ts`

**Acceptance Criteria:**
- [ ] `리마커블::오늘 일기` → `{ isRemarkableNote: true, notebook: undefined }`
- [ ] `리마커블::오늘 일기` 첫 줄 + `폴더: Diary` 두 번째 줄 → `{ isRemarkableNote: true, notebook: "Diary" }`
- [ ] 첫 줄이 `리마커블::` 만 (제목 없음) → `null`
- [ ] 첫 줄이 다른 시그니처(`자동화::`, `DATA::`) → `null`
- [ ] `폴더: ` (빈값) → `notebook: undefined` (빈 헤더 무시)
- [ ] `폴더:Diary` (공백 없음) — 허용 (`automationNote` 패턴 유연성)
- [ ] 첫 단락 텍스트만 검사 (본문 어디든 `폴더:` 있어도 무시 — 헤더는 시그니처 라인 직후 단일 단락에만)

**Verify:** `cd app && npm run test -- remarkable/parseRemarkableNote && npm run check`

**Steps:**

- [ ] **Step 1: Write failing tests**

```typescript
// app/tests/unit/remarkable/parseRemarkableNote.test.ts
import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { parseRemarkableNote, parseRemarkableTitle } from '$lib/remarkable/parseRemarkableNote.js';

function doc(lines: string[]): JSONContent {
  return {
    type: 'doc',
    content: lines.map((text) => ({
      type: 'paragraph',
      content: text === '' ? [] : [{ type: 'text', text }]
    }))
  };
}

describe('parseRemarkableTitle', () => {
  it('detects the signature', () => {
    expect(parseRemarkableTitle('리마커블::오늘 일기')).toBe(true);
  });
  it('returns false for blank label', () => {
    expect(parseRemarkableTitle('리마커블::')).toBe(false);
  });
  it('returns false for other signatures', () => {
    expect(parseRemarkableTitle('자동화::loc-history')).toBe(false);
    expect(parseRemarkableTitle('DATA::tomboy')).toBe(false);
    expect(parseRemarkableTitle('일반 노트')).toBe(false);
  });
});

describe('parseRemarkableNote', () => {
  it('reads the first paragraph as signature, no header', () => {
    expect(parseRemarkableNote(doc(['리마커블::오늘 일기', '', '본문']))).toEqual({
      isRemarkableNote: true,
      notebook: undefined
    });
  });
  it('reads 폴더 header from second paragraph', () => {
    expect(parseRemarkableNote(doc(['리마커블::오늘 일기', '폴더: Diary', '']))).toEqual({
      isRemarkableNote: true,
      notebook: 'Diary'
    });
  });
  it('trims surrounding whitespace in header value', () => {
    expect(parseRemarkableNote(doc(['리마커블::x', '폴더:   Workout  ']))).toEqual({
      isRemarkableNote: true,
      notebook: 'Workout'
    });
  });
  it('ignores empty 폴더 value', () => {
    expect(parseRemarkableNote(doc(['리마커블::x', '폴더: ']))).toEqual({
      isRemarkableNote: true,
      notebook: undefined
    });
  });
  it('returns null when first paragraph is not signature', () => {
    expect(parseRemarkableNote(doc(['자동화::x']))).toBeNull();
    expect(parseRemarkableNote(doc(['리마커블::']))).toBeNull();
  });
  it('does not pick up 폴더 from a non-header position', () => {
    expect(parseRemarkableNote(doc(['리마커블::x', '본문 내용', '폴더: Diary']))).toEqual({
      isRemarkableNote: true,
      notebook: undefined
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```
cd app && npm run test -- remarkable/parseRemarkableNote
```

Expected: FAIL (module not found / functions undefined).

- [ ] **Step 3: Implement**

```typescript
// app/src/lib/remarkable/parseRemarkableNote.ts
import type { JSONContent } from '@tiptap/core';

const PREFIX = '리마커블::';
const HEADER_RE = /^폴더:\s*(.*)$/;

/** 시그니처 라인 여부 (제목이 비면 false). */
export function parseRemarkableTitle(titleText: string): boolean {
  const text = titleText.trim();
  if (!text.startsWith(PREFIX)) return false;
  const rest = text.slice(PREFIX.length).trim();
  return rest.length > 0;
}

function paragraphText(node: JSONContent | undefined): string {
  if (!node?.content) return '';
  return node.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

export interface RemarkableNoteSpec {
  isRemarkableNote: true;
  notebook: string | undefined;
}

/**
 * 첫 단락 = 시그니처. 둘째 단락이 `폴더: <이름>` 헤더면 notebook 설정.
 * 그 외 헤더는 v1에선 인식 안 함.
 */
export function parseRemarkableNote(doc: JSONContent): RemarkableNoteSpec | null {
  const first = doc.content?.[0];
  if (!parseRemarkableTitle(paragraphText(first))) return null;

  let notebook: string | undefined;
  const second = doc.content?.[1];
  if (second) {
    const m = HEADER_RE.exec(paragraphText(second).trim());
    if (m) {
      const value = m[1].trim();
      if (value.length > 0) notebook = value;
    }
  }
  return { isRemarkableNote: true, notebook };
}
```

- [ ] **Step 4: Run tests — verify they pass**

```
cd app && npm run test -- remarkable/parseRemarkableNote
```

Expected: PASS (all tests).

```
cd app && npm run check
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/remarkable/parseRemarkableNote.ts \
        app/tests/unit/remarkable/parseRemarkableNote.test.ts
git commit -m "feat(remarkable): 리마커블:: 시그니처 + 폴더 헤더 파서"
```

```json:metadata
{"files":["app/src/lib/remarkable/parseRemarkableNote.ts","app/tests/unit/remarkable/parseRemarkableNote.test.ts"],"verifyCommand":"cd app && npm run test -- remarkable/parseRemarkableNote && npm run check","acceptanceCriteria":["리마커블::오늘 일기 → notebook=undefined","폴더: Diary 헤더 인식","리마커블:: (빈 제목) → null","다른 시그니처 → null","빈 폴더 헤더 무시","비-헤더 위치의 폴더: 무시"]}
```

---

## Task 2: 브릿지 호출 + SSE 클라이언트

**Goal:** `POST {bridgeUrl}/remarkable/upload` SSE 스트림을 파싱하는 클라이언트. status/done/error 이벤트를 콜백으로 분기.

**Files:**
- Create: `app/src/lib/remarkable/uploadRemarkable.ts`
- Create: `app/tests/unit/remarkable/uploadRemarkable.test.ts`

**Acceptance Criteria:**
- [ ] 브릿지/토큰 없으면 `RemarkableUploadError('not_configured')`
- [ ] 200 + SSE stream: `status` 이벤트마다 `onStatus` 호출, `done` 이벤트로 정상 종료, `error` 이벤트 시 `RemarkableUploadError(kind, message)` throw
- [ ] 401 → `unauthorized`
- [ ] 5xx → `upstream_error`
- [ ] network error → `network`
- [ ] AbortSignal 지원 (fetch에 forward)
- [ ] `pages` 배열에 각 페이지의 `{uuid, date}` 포함

**Verify:** `cd app && npm run test -- remarkable/uploadRemarkable && npm run check`

**Steps:**

- [ ] **Step 1: Write failing tests**

```typescript
// app/tests/unit/remarkable/uploadRemarkable.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
  getDefaultTerminalBridge: vi.fn(),
  getTerminalBridgeToken: vi.fn(),
  bridgeToHttpBase: (b: string) => `https://${b.replace(/^wss?:\/\//, '')}`
}));

import {
  uploadRemarkable,
  RemarkableUploadError
} from '$lib/remarkable/uploadRemarkable.js';
import {
  getDefaultTerminalBridge,
  getTerminalBridgeToken
} from '$lib/editor/terminal/bridgeSettings.js';

const realFetch = globalThis.fetch;
beforeEach(() => {
  (getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue('wss://host/ws');
  (getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue('tok');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

/** SSE body를 ReadableStream으로 감싸는 헬퍼. */
function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    }
  });
}

it('throws not_configured when bridge or token missing', async () => {
  (getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  await expect(uploadRemarkable({ notebook: 'Diary' })).rejects.toMatchObject({
    kind: 'not_configured'
  });
});

it('parses status events and resolves with done payload', async () => {
  const frames = [
    'event: status\ndata: {"step":"ssh_connect"}\n\n',
    'event: status\ndata: {"step":"list_pages","notebook":"Diary","total":3,"new":2}\n\n',
    'event: done\ndata: {"notebook":"Diary","pages":[{"uuid":"u1","date":"2026-06-06"},{"uuid":"u2","date":"2026-06-06"}]}\n\n'
  ];
  globalThis.fetch = (async () =>
    new Response(sseBody(frames), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;
  const statuses: unknown[] = [];
  const out = await uploadRemarkable({
    notebook: 'Diary',
    onStatus: (s) => statuses.push(s)
  });
  expect(statuses).toEqual([
    { step: 'ssh_connect' },
    { step: 'list_pages', notebook: 'Diary', total: 3, new: 2 }
  ]);
  expect(out).toEqual({
    notebook: 'Diary',
    pages: [
      { uuid: 'u1', date: '2026-06-06' },
      { uuid: 'u2', date: '2026-06-06' }
    ]
  });
});

it('maps 401 to unauthorized', async () => {
  globalThis.fetch = (async () =>
    new Response('{"error":"unauthorized"}', {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch;
  await expect(uploadRemarkable({ notebook: 'Diary' })).rejects.toMatchObject({
    kind: 'unauthorized'
  });
});

it('throws on error event', async () => {
  const frames = [
    'event: error\ndata: {"kind":"ssh_connect_failed","message":"timeout"}\n\n'
  ];
  globalThis.fetch = (async () =>
    new Response(sseBody(frames), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;
  await expect(uploadRemarkable({ notebook: 'Diary' })).rejects.toMatchObject({
    kind: 'ssh_connect_failed',
    detail: 'timeout'
  });
});

it('maps 5xx to upstream_error', async () => {
  globalThis.fetch = (async () =>
    new Response('{"error":"x"}', {
      status: 502,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch;
  await expect(uploadRemarkable({ notebook: 'Diary' })).rejects.toMatchObject({
    kind: 'upstream_error'
  });
});

it('passes AbortSignal to fetch', async () => {
  const ac = new AbortController();
  let received: AbortSignal | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    received = init?.signal ?? undefined;
    return new Response(sseBody([]), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  }) as typeof fetch;
  await uploadRemarkable({ notebook: 'Diary', signal: ac.signal }).catch(() => {});
  expect(received).toBe(ac.signal);
});

it('omits notebook from body when undefined', async () => {
  let bodyText = '';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodyText = typeof init?.body === 'string' ? init.body : '';
    return new Response(
      sseBody(['event: done\ndata: {"notebook":"Diary","pages":[]}\n\n']),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
  }) as typeof fetch;
  await uploadRemarkable({ notebook: undefined });
  expect(JSON.parse(bodyText)).toEqual({});
});
```

- [ ] **Step 2: Run tests — verify fail**

```
cd app && npm run test -- remarkable/uploadRemarkable
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// app/src/lib/remarkable/uploadRemarkable.ts
import {
  getDefaultTerminalBridge,
  getTerminalBridgeToken,
  bridgeToHttpBase
} from '$lib/editor/terminal/bridgeSettings.js';

export type RemarkableUploadErrorKind =
  | 'not_configured'
  | 'unauthorized'
  | 'ssh_connect_failed'
  | 'notebook_not_found'
  | 'rsync_failed'
  | 'automation_unreachable'
  | 'upstream_error'
  | 'network'
  | 'internal';

export class RemarkableUploadError extends Error {
  constructor(public kind: RemarkableUploadErrorKind, public detail?: string) {
    super(`${kind}${detail ? `: ${detail}` : ''}`);
  }
}

export interface RemarkableUploadStatus {
  step: 'ssh_connect' | 'list_pages' | 'rsync_pages' | 'trigger_pipeline';
  notebook?: string;
  total?: number;
  new?: number;
}

export interface RemarkableUploadPage {
  uuid: string;
  date: string; // YYYY-MM-DD
}

export interface RemarkableUploadResult {
  notebook: string;
  pages: RemarkableUploadPage[];
}

export interface RemarkableUploadOpts {
  notebook?: string;
  onStatus?: (s: RemarkableUploadStatus) => void;
  signal?: AbortSignal;
}

/**
 * Stream the remarkable upload over SSE. Resolves on `done`, throws
 * `RemarkableUploadError` on any error event or non-200 status.
 */
export async function uploadRemarkable(
  opts: RemarkableUploadOpts
): Promise<RemarkableUploadResult> {
  const bridge = await getDefaultTerminalBridge();
  const token = await getTerminalBridgeToken();
  if (!bridge || !token) {
    throw new RemarkableUploadError('not_configured', '브릿지 설정이 필요합니다');
  }
  const url = `${bridgeToHttpBase(bridge)}/remarkable/upload`;
  const body: Record<string, unknown> = {};
  if (opts.notebook) body.notebook = opts.notebook;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(body),
      signal: opts.signal
    });
  } catch (err) {
    throw new RemarkableUploadError('network', (err as Error).message);
  }

  if (!res.ok) {
    if (res.status === 401) throw new RemarkableUploadError('unauthorized');
    if (res.status >= 500) throw new RemarkableUploadError('upstream_error');
    throw new RemarkableUploadError('internal', `status ${res.status}`);
  }
  if (!res.body) {
    throw new RemarkableUploadError('internal', 'no body');
  }

  return await consumeSse(res.body, opts.onStatus);
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onStatus?: (s: RemarkableUploadStatus) => void
): Promise<RemarkableUploadResult> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done: RemarkableUploadResult | null = null;
  let err: RemarkableUploadError | null = null;

  while (true) {
    const { value, done: streamDone } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    while (true) {
      const sep = buf.indexOf('\n\n');
      if (sep === -1) break;
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const parsed = parseFrame(frame);
      if (!parsed) continue;
      if (parsed.event === 'status') {
        onStatus?.(parsed.data as RemarkableUploadStatus);
      } else if (parsed.event === 'done') {
        done = parsed.data as RemarkableUploadResult;
      } else if (parsed.event === 'error') {
        const e = parsed.data as { kind?: string; message?: string };
        const kind = (e.kind as RemarkableUploadErrorKind) ?? 'internal';
        err = new RemarkableUploadError(kind, e.message);
      }
    }
    if (streamDone) break;
  }
  if (err) throw err;
  if (!done) throw new RemarkableUploadError('internal', 'stream ended without done');
  return done;
}

function parseFrame(frame: string): { event: string; data: unknown } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

```
cd app && npm run test -- remarkable/uploadRemarkable && npm run check
```

Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/remarkable/uploadRemarkable.ts \
        app/tests/unit/remarkable/uploadRemarkable.test.ts
git commit -m "feat(remarkable): SSE 클라이언트 + RemarkableUploadError 열거"
```

```json:metadata
{"files":["app/src/lib/remarkable/uploadRemarkable.ts","app/tests/unit/remarkable/uploadRemarkable.test.ts"],"verifyCommand":"cd app && npm run test -- remarkable/uploadRemarkable && npm run check","acceptanceCriteria":["not_configured throw","status 이벤트 onStatus 호출","done resolve","error 이벤트 throw","401→unauthorized","5xx→upstream_error","signal forward","notebook undefined 시 body 생략"]}
```

---

## Task 3: 에디터 위젯 + 클릭 핸들러 + 등록

**Goal:** TipTap plugin이 `리마커블::` 노트의 첫 단락 직후에 "📥 업로드" 위젯을 렌더하고, 클릭 시 `uploadRemarkable` 호출 + 노트 본문에 로그 라인 prepend.

**Files:**
- Create: `app/src/lib/editor/remarkableNote/remarkableNotePlugin.ts`
- Create: `app/src/lib/editor/remarkableNote/runRemarkableUpload.ts`
- Create: `app/tests/unit/editor/remarkableNote/runRemarkableUpload.test.ts`
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (import + extension 등록)

**Acceptance Criteria:**
- [ ] 첫 단락이 `리마커블::<제목>`이면 위젯 렌더, 아니면 미렌더
- [ ] 위젯 클릭 → `uploadRemarkable` 호출 (notebook = 파싱된 헤더 값 또는 undefined)
- [ ] 진행 중 placeholder 라인이 시그니처/헤더 직후에 1줄 표시되고 status 단계별로 교체
- [ ] done 시 placeholder 제거 + 영구 헤더 라인 `YYYY-MM-DD HH:mm — {notebook}, {N}건` prepend + 각 페이지 `→ [[{date} 리마커블([{uuid}])]]` 라인
- [ ] error 시 placeholder를 `[업로드 오류: <한국어>]`로 교체
- [ ] 결과 노트 제목 형식: `{date} 리마커블([{page_uuid}])` — Spec 3.4와 byte-identical
- [ ] 위젯은 `.note` XML에 포함되지 않음 (Decoration이라 DOM only)

**Verify:** `cd app && npm run test -- editor/remarkableNote && npm run check`

**Steps:**

- [ ] **Step 1: Write failing test for click handler**

```typescript
// app/tests/unit/editor/remarkableNote/runRemarkableUpload.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EditorView } from '@tiptap/pm/view';

vi.mock('$lib/remarkable/uploadRemarkable.js', () => ({
  uploadRemarkable: vi.fn(),
  RemarkableUploadError: class extends Error {
    constructor(public kind: string, public detail?: string) {
      super(kind);
    }
  }
}));
vi.mock('$lib/stores/toast.js', () => ({ pushToast: vi.fn() }));

import {
  runRemarkableUpload,
  formatLogLines
} from '$lib/editor/remarkableNote/runRemarkableUpload.js';
import { uploadRemarkable, RemarkableUploadError } from '$lib/remarkable/uploadRemarkable.js';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('formatLogLines', () => {
  it('formats header + per-page lines', () => {
    const now = new Date('2026-06-06T11:23:00');
    const lines = formatLogLines(
      now,
      { notebook: 'Diary', pages: [{ uuid: 'u1', date: '2026-06-06' }, { uuid: 'u2', date: '2026-06-06' }] }
    );
    expect(lines).toEqual([
      '2026-06-06 11:23 — Diary, 2건',
      '  → [[2026-06-06 리마커블([u1])]]',
      '  → [[2026-06-06 리마커블([u2])]]'
    ]);
  });
  it('handles zero pages', () => {
    const lines = formatLogLines(new Date('2026-06-06T10:00:00'), {
      notebook: 'Diary', pages: []
    });
    expect(lines).toEqual(['2026-06-06 10:00 — Diary, 0건']);
  });
});

describe('runRemarkableUpload (callbacks)', () => {
  it('calls uploadRemarkable with notebook from spec', async () => {
    (uploadRemarkable as ReturnType<typeof vi.fn>).mockResolvedValue({
      notebook: 'Diary', pages: []
    });
    const view = { isDestroyed: false, state: {}, dispatch: vi.fn() } as unknown as EditorView;
    await runRemarkableUpload(view, { isRemarkableNote: true, notebook: 'Diary' });
    expect(uploadRemarkable).toHaveBeenCalledWith(
      expect.objectContaining({ notebook: 'Diary' })
    );
  });

  it('formats error from RemarkableUploadError', async () => {
    (uploadRemarkable as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (RemarkableUploadError as any)('ssh_connect_failed', 'timeout')
    );
    // Should not throw — handler swallows and emits placeholder via callback.
    const view = { isDestroyed: false, state: {}, dispatch: vi.fn() } as unknown as EditorView;
    await expect(
      runRemarkableUpload(view, { isRemarkableNote: true, notebook: undefined })
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — fail**

```
cd app && npm run test -- editor/remarkableNote
```

Expected: FAIL (modules missing).

- [ ] **Step 3: Implement click handler**

```typescript
// app/src/lib/editor/remarkableNote/runRemarkableUpload.ts
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import {
  uploadRemarkable,
  RemarkableUploadError,
  type RemarkableUploadErrorKind,
  type RemarkableUploadResult,
  type RemarkableUploadStatus
} from '$lib/remarkable/uploadRemarkable.js';
import { pushToast } from '$lib/stores/toast.js';
import type { RemarkableNoteSpec } from '$lib/remarkable/parseRemarkableNote.js';

const KIND_MESSAGES: Record<RemarkableUploadErrorKind, string> = {
  not_configured: '브릿지 설정이 필요합니다',
  unauthorized: '인증 실패 — 설정에서 브릿지 재로그인',
  ssh_connect_failed: '리마커블 연결 실패 — 같은 네트워크인지 확인',
  notebook_not_found: '폴더를 찾을 수 없습니다',
  rsync_failed: '페이지 복사 실패',
  automation_unreachable: '데스크탑 파이프라인 트리거 실패 — 5분 내 자동 처리됩니다',
  upstream_error: '브릿지/서비스 응답 오류',
  network: '연결 실패',
  internal: '알 수 없는 오류'
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function dateStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatLogLines(now: Date, result: RemarkableUploadResult): string[] {
  const header = `${dateStamp(now)} — ${result.notebook}, ${result.pages.length}건`;
  const links = result.pages.map(
    (p) => `  → [[${p.date} 리마커블([${p.uuid}])]]`
  );
  return [header, ...links];
}

function statusMessage(s: RemarkableUploadStatus): string {
  switch (s.step) {
    case 'ssh_connect':
      return '리마커블 접속 중…';
    case 'list_pages':
      return `${s.notebook ?? ''} 페이지 ${s.new ?? 0}건 가져오는 중…`;
    case 'rsync_pages':
      return '페이지 복사 중…';
    case 'trigger_pipeline':
      return '파이프라인 트리거…';
  }
}

/** 본문 시작 위치 = 시그니처 paragraph(1번째) + 선택적 헤더 paragraph(2번째) 다음. */
function bodyInsertPos(doc: PMNode, hasHeader: boolean): number {
  const skip = hasHeader ? 2 : 1;
  let pos = 0;
  for (let i = 0; i < skip && i < doc.childCount; i++) {
    pos += doc.child(i).nodeSize;
  }
  return pos;
}

function makeParagraph(schema: Schema, text: string): PMNode {
  const paragraph = schema.nodes.paragraph;
  return paragraph.create(null, text ? schema.text(text) : null);
}

/** 본문 시작 위치에 placeholder 단락 삽입. 위치 반환. */
function insertPlaceholder(view: EditorView, hasHeader: boolean, text: string): number {
  const pos = bodyInsertPos(view.state.doc, hasHeader);
  const tr = view.state.tr.insert(pos, makeParagraph(view.state.schema, text));
  view.dispatch(tr);
  return pos;
}

/** 주어진 위치의 단락을 새 텍스트로 교체. */
function replacePlaceholder(view: EditorView, pos: number, text: string): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'paragraph') return;
  const innerStart = pos + 1;
  const innerEnd = pos + 1 + node.content.size;
  const replacement = view.state.schema.text(text);
  const tr = view.state.tr.replaceWith(innerStart, innerEnd, replacement);
  view.dispatch(tr);
}

/** 주어진 위치의 단락을 제거. */
function removePlaceholder(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'paragraph') return;
  const tr = view.state.tr.delete(pos, pos + node.nodeSize);
  view.dispatch(tr);
}

/** 본문 시작 위치에 결과 라인들(단락 N개)을 prepend. */
function prependLines(view: EditorView, hasHeader: boolean, lines: string[]): void {
  const pos = bodyInsertPos(view.state.doc, hasHeader);
  const nodes = lines.map((l) => makeParagraph(view.state.schema, l));
  const tr = view.state.tr.insert(pos, nodes);
  view.dispatch(tr);
}

/** 📥 업로드 클릭 처리. */
export async function runRemarkableUpload(
  view: EditorView,
  spec: RemarkableNoteSpec
): Promise<void> {
  if (view.isDestroyed) return;
  const hasHeader = spec.notebook !== undefined;
  const placeholderPos = insertPlaceholder(view, hasHeader, '리마커블 접속 중…');

  try {
    const result = await uploadRemarkable({
      notebook: spec.notebook,
      onStatus: (s) => {
        if (view.isDestroyed) return;
        replacePlaceholder(view, placeholderPos, statusMessage(s));
      }
    });
    if (view.isDestroyed) return;
    removePlaceholder(view, placeholderPos);
    prependLines(view, hasHeader, formatLogLines(new Date(), result));
    pushToast(`${result.notebook} ${result.pages.length}건 업로드`, { kind: 'info' });
  } catch (err) {
    if (view.isDestroyed) return;
    const kind = err instanceof RemarkableUploadError ? err.kind : 'internal';
    const msg = KIND_MESSAGES[kind] ?? '알 수 없는 오류';
    replacePlaceholder(view, placeholderPos, `[업로드 오류: ${msg}]`);
    pushToast(msg, { kind: 'error' });
  }
}
```

- [ ] **Step 4: Implement TipTap plugin (mirror automationNotePlugin)**

```typescript
// app/src/lib/editor/remarkableNote/remarkableNotePlugin.ts
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseRemarkableNote } from '$lib/remarkable/parseRemarkableNote.js';
import { runRemarkableUpload } from './runRemarkableUpload.js';
import type { RemarkableNoteSpec } from '$lib/remarkable/parseRemarkableNote.js';

export const remarkableNotePluginKey = new PluginKey<DecorationSet>('tomboyRemarkableNote');

function renderButton(view: EditorView, spec: RemarkableNoteSpec): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tomboy-remarkable-upload';
  btn.contentEditable = 'false';
  btn.textContent = '📥 업로드';
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '📥 업로드 중…';
    try {
      await runRemarkableUpload(view, spec);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  return btn;
}

/**
 * `doc` from a PMNode (live editor doc) into the JSONContent shape parser expects.
 * We only need the first 2 paragraphs (signature + optional header).
 */
function docJson(doc: PMNode) {
  const content: { type: string; content?: { type: string; text?: string }[] }[] = [];
  doc.forEach((node) => {
    if (content.length >= 2) return;
    const text = node.textContent;
    content.push({
      type: node.type.name,
      content: text ? [{ type: 'text', text }] : []
    });
  });
  return { type: 'doc', content };
}

function buildDecorations(doc: PMNode): DecorationSet {
  const spec = parseRemarkableNote(docJson(doc));
  if (!spec) return DecorationSet.empty;
  const first = doc.firstChild;
  if (!first) return DecorationSet.empty;
  // Anchor at the end of the title paragraph (same convention as automationNote).
  const headerEndPos = first.nodeSize - 1;
  const widget = Decoration.widget(headerEndPos, (view) => renderButton(view, spec), {
    side: 1,
    key: `remarkable:${spec.notebook ?? '_default'}`
  });
  return DecorationSet.create(doc, [widget]);
}

export function createRemarkableNotePlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: remarkableNotePluginKey,
    state: {
      init(_, { doc }): DecorationSet {
        return buildDecorations(doc);
      },
      apply(tr, old): DecorationSet {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
        return buildDecorations(tr.doc);
      }
    },
    props: {
      decorations(state): DecorationSet | undefined {
        return remarkableNotePluginKey.getState(state);
      }
    }
  });
}
```

- [ ] **Step 5: Register in TomboyEditor.svelte**

Find the import block near line 38-43 and add:

```svelte
import { createAutomationNotePlugin } from "./automationNote/automationNotePlugin.js";
import { createRemarkableNotePlugin } from "./remarkableNote/remarkableNotePlugin.js";
import { TomboyMusicNote } from "./musicNote/index.js";
```

Find the Extension.create block near line 496-501 for automationNote and add a sibling:

```svelte
Extension.create({
  name: "tomboyAutomationNote",
  addProseMirrorPlugins() {
    return [createAutomationNotePlugin()];
  },
}),
Extension.create({
  name: "tomboyRemarkableNote",
  addProseMirrorPlugins() {
    return [createRemarkableNotePlugin()];
  },
}),
```

- [ ] **Step 6: Run tests + svelte-check**

```
cd app && npm run test -- editor/remarkableNote && npm run check
```

Expected: PASS, no type/svelte errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/editor/remarkableNote/ \
        app/tests/unit/editor/remarkableNote/ \
        app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(remarkable): 본문 업로드 위젯 + 클릭 핸들러"
```

```json:metadata
{"files":["app/src/lib/editor/remarkableNote/remarkableNotePlugin.ts","app/src/lib/editor/remarkableNote/runRemarkableUpload.ts","app/tests/unit/editor/remarkableNote/runRemarkableUpload.test.ts","app/src/lib/editor/TomboyEditor.svelte"],"verifyCommand":"cd app && npm run test -- editor/remarkableNote && npm run check","acceptanceCriteria":["위젯 렌더(시그니처 노트만)","클릭→uploadRemarkable 호출","placeholder 단계별 교체","done시 헤더+링크 라인 prepend","에러시 placeholder→오류 메시지","제목 포맷 {date} 리마커블([{uuid}])"]}
```

---

## Task 4: 브릿지 라우트 `/remarkable/upload` + SSH/inbox 헬퍼

**Goal:** 브릿지에 새 라우트 + SSH로 리마커블 metadata 페치 + Pi inbox 적재 + automation-service 호출 + SSE emit. 자동화 라우트(`bridge/src/automation.ts`)의 패턴을 미러하되 SSE 추가.

**Files:**
- Create: `bridge/src/remarkable/ssh.ts` (SSH/rsync 헬퍼)
- Create: `bridge/src/remarkable/inbox.ts` (Pi inbox state 갱신)
- Create: `bridge/src/remarkableUpload.ts` (라우트 핸들러 + SSE)
- Create: `bridge/src/remarkable.test.ts` (라우트 테스트)
- Create: `bridge/src/remarkable/ssh.test.ts` (헬퍼 테스트)
- Modify: `bridge/src/server.ts` (라우트 등록)
- Modify: `bridge/README.md` 또는 `bridge/deploy/...` (env 문서)

**Acceptance Criteria:**
- [ ] Bearer 미인증 → 401
- [ ] SSE response (`Content-Type: text/event-stream`)
- [ ] step별 status 이벤트 emit: `ssh_connect` → `list_pages` → `rsync_pages` → `trigger_pipeline` → `done`
- [ ] notebook 미지정 → env `REMARKABLE_NOTEBOOK_NAME` 기본값 (기본 `Diary`)
- [ ] 리마커블에서 metadata 모두 cat → Node에서 parent 매칭으로 페이지 UUID 추출
- [ ] Pi inbox state/index.json과 diff하여 새 UUID만 rsync
- [ ] rsync 성공 시 index.json에 entry 추가 (`{present: true, mtime, received_at}`)
- [ ] page의 `lastModified` epoch → `date: YYYY-MM-DD` 포맷으로 변환해 SSE done에 포함
- [ ] automation-service POST → `pipeline-run` 명령. 200 비응답 → `automation_unreachable` 에러 emit (단, inbox 적재는 이미 완료 상태로 유지)
- [ ] 에러 enum 매핑 (SSH 실패, 노트북 없음, rsync 실패, automation 실패, 내부 오류)

**Verify:** `cd bridge && node --test src/remarkable*.test.ts src/remarkable/*.test.ts`

**Steps:**

- [ ] **Step 1: SSH 헬퍼 — failing test**

```typescript
// bridge/src/remarkable/ssh.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fetchMetadataDump, parseMetadataDump } from './ssh.js';

test('parseMetadataDump extracts uuid + fields per file', () => {
  const dump = [
    '===uuid-A.metadata===',
    JSON.stringify({ type: 'CollectionType', visibleName: 'Diary', parent: '' }),
    '===uuid-B.metadata===',
    JSON.stringify({ type: 'DocumentType', visibleName: '2026-06-06', parent: 'uuid-A', lastModified: '1780667129000' }),
    '===uuid-C.metadata===',
    JSON.stringify({ type: 'DocumentType', visibleName: 'other', parent: 'uuid-X' })
  ].join('\n');
  const out = parseMetadataDump(dump);
  assert.deepEqual(out.find((e) => e.uuid === 'uuid-A'), {
    uuid: 'uuid-A', type: 'CollectionType', visibleName: 'Diary', parent: '', lastModified: 0
  });
  assert.deepEqual(out.find((e) => e.uuid === 'uuid-B'), {
    uuid: 'uuid-B', type: 'DocumentType', visibleName: '2026-06-06', parent: 'uuid-A', lastModified: 1780667129000
  });
  assert.equal(out.length, 3);
});

test('parseMetadataDump skips malformed JSON without crashing', () => {
  const dump = [
    '===uuid-A.metadata===',
    '{"type":"DocumentType"',  // truncated
    '===uuid-B.metadata===',
    JSON.stringify({ type: 'DocumentType', visibleName: 'ok', parent: 'X' })
  ].join('\n');
  const out = parseMetadataDump(dump);
  assert.equal(out.length, 1);
  assert.equal(out[0].uuid, 'uuid-B');
});

test('fetchMetadataDump uses injected spawn and returns stdout', async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const fakeSpawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child: any = new (require('node:events').EventEmitter)();
    child.stdout = Readable.from([Buffer.from('STDOUT-MARKER', 'utf8')]);
    child.stderr = Readable.from([]);
    child.on = child.addListener;
    setImmediate(() => child.emit('close', 0));
    return child;
  }) as any;
  const out = await fetchMetadataDump(
    { host: 'rmrk.local', user: 'root', keyPath: '/tmp/key' },
    { spawn: fakeSpawn }
  );
  assert.equal(out, 'STDOUT-MARKER');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'ssh');
  assert.ok(calls[0].args.includes('root@rmrk.local'));
});
```

- [ ] **Step 2: Run — fail**

```
cd bridge && node --test src/remarkable/ssh.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement ssh.ts**

```typescript
// bridge/src/remarkable/ssh.ts
import { spawn as nodeSpawn } from 'node:child_process';

export type SpawnFn = typeof nodeSpawn;

export interface RemarkableSshConfig {
  host: string;
  user: string;
  keyPath: string;
}

export interface RemarkableMetadata {
  uuid: string;
  type: string;
  visibleName: string;
  parent: string;
  lastModified: number; // epoch ms; 0 if unknown
}

const XOCHITL_DIR = '/home/root/.local/share/remarkable/xochitl';

/**
 * SSH into rmrk and `cat` every metadata file, separated by `===<uuid>.metadata===`
 * lines. Returns the raw stdout for parseMetadataDump to consume.
 */
export async function fetchMetadataDump(
  cfg: RemarkableSshConfig,
  opts: { spawn?: SpawnFn } = {}
): Promise<string> {
  const spawn = opts.spawn ?? nodeSpawn;
  const remoteCmd = `cd ${XOCHITL_DIR} && for f in *.metadata; do echo "===$f==="; cat "$f"; done`;
  const args = [
    '-p', '22',
    '-i', cfg.keyPath,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=5',
    `${cfg.user}@${cfg.host}`,
    remoteCmd
  ];
  return await runCapture(spawn, 'ssh', args);
}

/**
 * Parse the metadata dump into a flat list. Malformed JSON entries are
 * silently skipped (defensive — xochitl may have transient writes).
 */
export function parseMetadataDump(dump: string): RemarkableMetadata[] {
  const out: RemarkableMetadata[] = [];
  const lines = dump.split('\n');
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const m = /^===(.+)\.metadata===$/.exec(header);
    if (!m) {
      i++;
      continue;
    }
    const uuid = m[1];
    // Body is the next consecutive lines until the next ===…=== or EOF.
    const body: string[] = [];
    i++;
    while (i < lines.length && !/^===.+===$/.test(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    try {
      const json = JSON.parse(body.join('\n')) as Partial<RemarkableMetadata> & {
        lastModified?: string | number;
      };
      out.push({
        uuid,
        type: String(json.type ?? ''),
        visibleName: String(json.visibleName ?? ''),
        parent: String(json.parent ?? ''),
        lastModified: Number(json.lastModified ?? 0)
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * rsync `<uuid>.metadata` + `<uuid>.rm` from rmrk to local dest.
 */
export async function rsyncPage(
  cfg: RemarkableSshConfig,
  uuid: string,
  destDir: string,
  opts: { spawn?: SpawnFn } = {}
): Promise<void> {
  const spawn = opts.spawn ?? nodeSpawn;
  const sshCmd = `ssh -p 22 -i ${cfg.keyPath} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5`;
  const remote = `${cfg.user}@${cfg.host}:${XOCHITL_DIR}/${uuid}.*`;
  const args = ['-avz', '-e', sshCmd, remote, `${destDir}/`];
  await runCapture(spawn, 'rsync', args);
}

function runCapture(spawn: SpawnFn, cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (errOut.length < 8192) errOut += d.toString('utf8');
    });
    child.on('error', (e: Error) => reject(e));
    child.on('close', (code: number | null) => {
      if (code === 0) resolve(out);
      else reject(new Error(errOut.trim().slice(0, 400) || `${cmd} exit ${code}`));
    });
  });
}
```

- [ ] **Step 4: Run — pass**

```
cd bridge && node --test src/remarkable/ssh.test.ts
```

Expected: PASS.

- [ ] **Step 5: inbox.ts — failing test**

```typescript
// bridge/src/remarkable/inbox.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInboxIndex, updateInboxIndex, diffNewUuids } from './inbox.js';

test('readInboxIndex returns {} when file missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
  assert.deepEqual(readInboxIndex(`${dir}/state`), {});
});

test('readInboxIndex parses existing index.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
  const stateDir = `${dir}/state`;
  require('node:fs').mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    `${stateDir}/index.json`,
    JSON.stringify({ 'u1': { present: true, mtime: 100, received_at: '2026-06-06T01:00:00' } })
  );
  const idx = readInboxIndex(stateDir);
  assert.equal(idx['u1'].mtime, 100);
});

test('diffNewUuids returns uuids not in index', () => {
  const idx = { u1: { present: true, mtime: 1, received_at: 'x' } };
  assert.deepEqual(diffNewUuids(['u1', 'u2', 'u3'], idx), ['u2', 'u3']);
});

test('updateInboxIndex merges new entries and persists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
  const stateDir = `${dir}/state`;
  updateInboxIndex(stateDir, {
    'u1': { present: true, mtime: 1780667129000, received_at: '2026-06-06T01:00:00' }
  });
  const persisted = JSON.parse(readFileSync(`${stateDir}/index.json`, 'utf8'));
  assert.equal(persisted.u1.mtime, 1780667129000);
});
```

- [ ] **Step 6: Run — fail then implement**

```typescript
// bridge/src/remarkable/inbox.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface InboxEntry {
  present: boolean;
  mtime: number;
  received_at: string;
}

export type InboxIndex = Record<string, InboxEntry>;

export function readInboxIndex(stateDir: string): InboxIndex {
  const path = join(stateDir, 'index.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as InboxIndex;
  } catch {
    return {};
  }
}

export function diffNewUuids(uuids: string[], idx: InboxIndex): string[] {
  return uuids.filter((u) => !idx[u]);
}

export function updateInboxIndex(stateDir: string, additions: InboxIndex): void {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const merged = { ...readInboxIndex(stateDir), ...additions };
  writeFileSync(join(stateDir, 'index.json'), JSON.stringify(merged, null, 2));
}
```

```
cd bridge && node --test src/remarkable/inbox.test.ts
```

Expected: PASS.

- [ ] **Step 7: Route handler — failing test**

```typescript
// bridge/src/remarkable.test.ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRemarkableUpload } from './remarkableUpload.js';
import { mintToken } from './auth.js';

const SECRET = 'test-secret';

function mockReq(headers: Record<string, string>, body: object | string): IncomingMessage {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const r = Readable.from([Buffer.from(raw, 'utf8')]) as unknown as IncomingMessage;
  (r as { headers: Record<string, string> }).headers = headers;
  (r as { method: string }).method = 'POST';
  return r;
}

function mockRes() {
  const writes: string[] = [];
  let status = 0;
  const headers: Record<string, string> = {};
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s;
      Object.assign(headers, h ?? {});
      return res;
    },
    write: (b: string) => writes.push(b),
    end: (b?: string) => {
      if (b) writes.push(b);
    }
  } as unknown as ServerResponse;
  return { res, get: () => ({ status, headers, body: writes.join('') }) };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const DUMP = [
  '===uuid-A.metadata===',
  JSON.stringify({ type: 'CollectionType', visibleName: 'Diary', parent: '' }),
  '===uuid-B.metadata===',
  JSON.stringify({
    type: 'DocumentType',
    visibleName: 'p1',
    parent: 'uuid-A',
    lastModified: '1780667129000'
  })
].join('\n');

test('401 without Bearer', async () => {
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({}, { notebook: 'Diary' }),
    res,
    {
      secret: SECRET,
      ssh: { host: 'h', user: 'u', keyPath: 'k' },
      inboxDir: '/tmp/inbox',
      defaultNotebook: 'Diary',
      automationServiceUrl: 'http://auto.test',
      fetchDump: async () => DUMP,
      rsync: async () => {}
    }
  );
  assert.equal(get().status, 401);
});

test('SSE 200 + status/done events on happy path', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'inbox-'));
  let automationCalled = false;
  globalThis.fetch = (async () => {
    automationCalled = true;
    return new Response(JSON.stringify({ results: {}, errors: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  const { res, get } = mockRes();
  const rsyncCalls: string[] = [];
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { notebook: 'Diary' }),
    res,
    {
      secret: SECRET,
      ssh: { host: 'h', user: 'u', keyPath: 'k' },
      inboxDir,
      defaultNotebook: 'Diary',
      automationServiceUrl: 'http://auto.test',
      fetchDump: async () => DUMP,
      rsync: async (uuid) => {
        rsyncCalls.push(uuid);
      }
    }
  );
  const { status, headers, body } = get();
  assert.equal(status, 200);
  assert.match(headers['content-type'], /text\/event-stream/);
  assert.match(body, /event: status\ndata: \{"step":"ssh_connect"\}/);
  assert.match(body, /event: status\ndata: \{"step":"list_pages"/);
  assert.match(body, /event: done\ndata: \{"notebook":"Diary"/);
  assert.match(body, /"uuid":"uuid-B"/);
  assert.match(body, /"date":"2026-06-06"/);
  assert.deepEqual(rsyncCalls, ['uuid-B']);
  assert.equal(automationCalled, true);
});

test('error event on notebook_not_found', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'inbox-'));
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { notebook: 'Missing' }),
    res,
    {
      secret: SECRET,
      ssh: { host: 'h', user: 'u', keyPath: 'k' },
      inboxDir,
      defaultNotebook: 'Diary',
      automationServiceUrl: 'http://auto.test',
      fetchDump: async () => DUMP,
      rsync: async () => {}
    }
  );
  assert.match(get().body, /event: error\ndata: \{"kind":"notebook_not_found"/);
});

test('uses defaultNotebook when body omits notebook', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'inbox-'));
  globalThis.fetch = (async () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, {}),
    res,
    {
      secret: SECRET,
      ssh: { host: 'h', user: 'u', keyPath: 'k' },
      inboxDir,
      defaultNotebook: 'Diary',
      automationServiceUrl: 'http://auto.test',
      fetchDump: async () => DUMP,
      rsync: async () => {}
    }
  );
  assert.match(get().body, /"notebook":"Diary"/);
});

test('automation failure emits automation_unreachable but keeps inbox', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'inbox-'));
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const { res, get } = mockRes();
  await handleRemarkableUpload(
    mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { notebook: 'Diary' }),
    res,
    {
      secret: SECRET,
      ssh: { host: 'h', user: 'u', keyPath: 'k' },
      inboxDir,
      defaultNotebook: 'Diary',
      automationServiceUrl: 'http://auto.test',
      fetchDump: async () => DUMP,
      rsync: async () => {}
    }
  );
  const { body } = get();
  assert.match(body, /event: error\ndata: \{"kind":"automation_unreachable"/);
  // inbox index should still have the new uuid
  const idx = JSON.parse(
    require('node:fs').readFileSync(`${inboxDir}/state/index.json`, 'utf8')
  );
  assert.ok(idx['uuid-B']);
});
```

- [ ] **Step 8: Implement remarkableUpload.ts**

```typescript
// bridge/src/remarkableUpload.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';
import {
  fetchMetadataDump as defaultFetchDump,
  parseMetadataDump,
  rsyncPage as defaultRsync,
  type RemarkableMetadata,
  type RemarkableSshConfig
} from './remarkable/ssh.js';
import {
  readInboxIndex,
  updateInboxIndex,
  diffNewUuids
} from './remarkable/inbox.js';
import { join } from 'node:path';

interface RunBody {
  notebook?: unknown;
}

interface Deps {
  secret: string;
  ssh: RemarkableSshConfig;
  inboxDir: string;        // e.g. ~/diary/inbox on Pi
  defaultNotebook: string;
  automationServiceUrl: string;
  // Injected for tests; default to real ssh/rsync.
  fetchDump?: (cfg: RemarkableSshConfig) => Promise<string>;
  rsync?: (cfg: RemarkableSshConfig, uuid: string, destDir: string) => Promise<void>;
}

type ErrorKind =
  | 'unauthorized'
  | 'ssh_connect_failed'
  | 'notebook_not_found'
  | 'rsync_failed'
  | 'automation_unreachable'
  | 'internal';

function epochToDate(ms: number): string {
  if (!ms) return new Date().toISOString().slice(0, 10);
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

function sendEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function findNotebookUuid(meta: RemarkableMetadata[], name: string): string | null {
  const hit = meta.find(
    (m) => m.type === 'CollectionType' && m.visibleName === name
  );
  return hit?.uuid ?? null;
}

function listPagesInNotebook(meta: RemarkableMetadata[], notebookUuid: string): RemarkableMetadata[] {
  return meta.filter((m) => m.type === 'DocumentType' && m.parent === notebookUuid);
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

export async function handleRemarkableUpload(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps
): Promise<void> {
  const token = extractBearer(req.headers.authorization);
  if (!verifyToken(deps.secret, token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  let body: RunBody;
  try {
    body = (await readJson(req)) as RunBody;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_json' }));
    return;
  }
  const notebook =
    typeof body.notebook === 'string' && body.notebook.length > 0
      ? body.notebook
      : deps.defaultNotebook;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  const emitError = (kind: ErrorKind, message?: string) => {
    sendEvent(res, 'error', { kind, message });
    res.end();
  };

  const fetchDump = deps.fetchDump ?? ((cfg) => defaultFetchDump(cfg));
  const rsync = deps.rsync ?? ((cfg, uuid, dest) => defaultRsync(cfg, uuid, dest));

  // ssh_connect + list_pages
  sendEvent(res, 'status', { step: 'ssh_connect' });
  let dump: string;
  try {
    dump = await fetchDump(deps.ssh);
  } catch (err) {
    emitError('ssh_connect_failed', (err as Error).message);
    return;
  }
  const meta = parseMetadataDump(dump);
  const notebookUuid = findNotebookUuid(meta, notebook);
  if (!notebookUuid) {
    emitError('notebook_not_found', `notebook ${notebook}`);
    return;
  }
  const pages = listPagesInNotebook(meta, notebookUuid);
  const stateDir = join(deps.inboxDir, '..', 'state');
  const inboxIdx = readInboxIndex(stateDir);
  const newUuids = diffNewUuids(pages.map((p) => p.uuid), inboxIdx);
  sendEvent(res, 'status', {
    step: 'list_pages',
    notebook,
    total: pages.length,
    new: newUuids.length
  });

  // rsync_pages
  sendEvent(res, 'status', { step: 'rsync_pages' });
  const additions: Record<string, { present: true; mtime: number; received_at: string }> = {};
  for (const uuid of newUuids) {
    try {
      await rsync(deps.ssh, uuid, deps.inboxDir);
      const m = pages.find((p) => p.uuid === uuid);
      additions[uuid] = {
        present: true,
        mtime: m?.lastModified ?? Date.now(),
        received_at: new Date().toISOString()
      };
    } catch (err) {
      // partial-failure: log to stderr, exclude from done
      console.warn(`[remarkable] rsync ${uuid} failed: ${(err as Error).message}`);
    }
  }
  if (Object.keys(additions).length > 0) {
    try {
      updateInboxIndex(stateDir, additions);
    } catch (err) {
      emitError('rsync_failed', `inbox index update: ${(err as Error).message}`);
      return;
    }
  }

  // trigger_pipeline (automation-service)
  sendEvent(res, 'status', { step: 'trigger_pipeline' });
  try {
    const upstream = await fetch(`${deps.automationServiceUrl}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deps.secret}`
      },
      body: JSON.stringify({ command: 'pipeline-run' })
    });
    if (!upstream.ok) {
      emitError('automation_unreachable', `status ${upstream.status}`);
      return;
    }
  } catch (err) {
    emitError('automation_unreachable', (err as Error).message);
    return;
  }

  const donePages = Object.keys(additions).map((uuid) => {
    const m = pages.find((p) => p.uuid === uuid);
    return { uuid, date: epochToDate(m?.lastModified ?? 0) };
  });
  sendEvent(res, 'done', { notebook, pages: donePages });
  res.end();
}
```

- [ ] **Step 9: Register route in server.ts**

Find the route block near line 155-167:

```typescript
if (url === '/automation/run' && req.method === 'POST') {
  await handleAutomationRun(req, res, SECRET, AUTOMATION_SERVICE_URL);
  return;
}

if (url === '/remarkable/upload' && req.method === 'POST') {
  await handleRemarkableUpload(req, res, {
    secret: SECRET,
    ssh: {
      host: process.env.REMARKABLE_SSH_HOST ?? '',
      user: process.env.REMARKABLE_SSH_USER ?? 'root',
      keyPath: process.env.REMARKABLE_SSH_KEY_PATH ?? ''
    },
    inboxDir: process.env.REMARKABLE_INBOX_DIR ?? '/home/diary-sync/diary/inbox',
    defaultNotebook: process.env.REMARKABLE_NOTEBOOK_NAME ?? 'Diary',
    automationServiceUrl: AUTOMATION_SERVICE_URL
  });
  return;
}
```

And at imports (near line 19):

```typescript
import { handleAutomationRun } from './automation.js';
import { handleRemarkableUpload } from './remarkableUpload.js';
```

- [ ] **Step 10: Run all bridge tests**

```
cd bridge && node --test src/remarkable*.test.ts src/remarkable/*.test.ts
```

Expected: PASS.

- [ ] **Step 11: Document new env vars**

Append to `bridge/README.md` (or the deploy doc the project actually uses; check `bridge/deploy/` for existing pattern):

```markdown
## 리마커블 업로드 라우트

`POST /remarkable/upload` (SSE) — `리마커블::` 노트의 업로드 버튼이 호출.
필수 환경 변수:

- `REMARKABLE_SSH_HOST` — 리마커블 IP (LAN). 예: `192.168.219.112`
- `REMARKABLE_SSH_USER` — 보통 `root`
- `REMARKABLE_SSH_KEY_PATH` — 컨테이너 내부 경로. `~/.ssh/id_remarkable` 같은 키 마운트.
- `REMARKABLE_NOTEBOOK_NAME` — 노트 헤더가 없을 때 사용할 기본 노트북 이름 (기본 `Diary`).
- `REMARKABLE_INBOX_DIR` — Pi 측 diary inbox 절대 경로. 컨테이너 마운트 필수 (기본 `/home/diary-sync/diary/inbox`).
- `AUTOMATION_SERVICE_URL` — 기존 변수 재사용 (브릿지가 `pipeline-run` 명령 호출).
```

- [ ] **Step 12: Commit**

```bash
git add bridge/src/remarkable/ bridge/src/remarkableUpload.ts \
        bridge/src/remarkable.test.ts \
        bridge/src/server.ts bridge/README.md
git commit -m "feat(bridge): /remarkable/upload SSE 라우트 + SSH/rsync 헬퍼"
```

```json:metadata
{"files":["bridge/src/remarkable/ssh.ts","bridge/src/remarkable/inbox.ts","bridge/src/remarkableUpload.ts","bridge/src/remarkable.test.ts","bridge/src/remarkable/ssh.test.ts","bridge/src/remarkable/inbox.test.ts","bridge/src/server.ts","bridge/README.md"],"verifyCommand":"cd bridge && node --test src/remarkable*.test.ts src/remarkable/*.test.ts","acceptanceCriteria":["401 without Bearer","SSE 200","status/done emit","notebook_not_found emit","defaultNotebook fallback","automation_unreachable + inbox 유지","epoch→YYYY-MM-DD"]}
```

---

## Task 5: automation-service `pipeline-run` 명령 등록

**Goal:** `~/.config/tomboy-automation.json` registry에 `pipeline-run` 항목 추가. 코드 변경 0줄. 명령은 `systemctl --user start desktop-pipeline.service`.

**Files:**
- Modify: `~/.config/tomboy-automation.json` (runtime config, not in repo)
- Modify: `automation-service/deploy/README.md` (또는 동등 파일) — 새 명령 문서화

**Acceptance Criteria:**
- [ ] `pipeline-run` 호출 시 `systemctl --user start desktop-pipeline.service` 실행
- [ ] 응답 200 + `{results: {pipeline: ""}, errors: {}}` (systemctl은 출력 없음, exit 0 즉시)
- [ ] 다음 1회 파이프라인 실행이 트리거됨 (테스트: `journalctl --user -u desktop-pipeline.service -n 5 --no-pager`에 새 entry)
- [ ] 기존 명령들은 회귀 없음

**Verify:**
```bash
curl -X POST -H "Authorization: Bearer ${BRIDGE_SHARED_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"command":"pipeline-run"}' \
  http://localhost:7843/run
# Expected: 200 + {"results":{"pipeline":""},"errors":{}}
```

**Steps:**

- [ ] **Step 1: Read current registry**

```bash
cat ~/.config/tomboy-automation.json
```

Note the existing `commands` object. Do not lose any entries.

- [ ] **Step 2: Add `pipeline-run` entry**

Edit `~/.config/tomboy-automation.json` to add:

```json
{
  "commands": {
    "...existing commands...": ["..."],
    "pipeline-run": [
      {
        "project": "pipeline",
        "exec": ["systemctl", "--user", "start", "desktop-pipeline.service"]
      }
    ]
  }
}
```

- [ ] **Step 3: No restart needed**

`automation-service`는 registry를 매 요청 다시 읽음 (`automation-service/src/server.ts:35` — `registry: () => loadRegistry(configPath)`). 그래서 systemd restart 불필요.

- [ ] **Step 4: Verify with curl**

```bash
TOKEN=$(grep '^BRIDGE_SHARED_TOKEN=' ~/.config/claude-service.env | cut -d= -f2-)
curl -s -X POST -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"command":"pipeline-run"}' \
  http://localhost:7843/run
```

Expected response: `{"results":{"pipeline":""},"errors":{}}`.

Then check that systemd actually started the unit:

```bash
journalctl --user -u desktop-pipeline.service -n 5 --no-pager
```

Expected: most recent entry within the last few seconds with `Starting desktop-pipeline.service`.

- [ ] **Step 5: Verify unknown command doesn't break**

```bash
curl -s -X POST -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"command":"nonexistent"}' \
  http://localhost:7843/run
```

Expected: `400 {"error":"unknown_command",...}`.

- [ ] **Step 6: Document**

Append to `automation-service/deploy/README.md` (or `automation-service/README.md` if no deploy dir):

```markdown
## `pipeline-run`

리마커블 수동 업로드(`리마커블::` 노트)가 호출. 단순히 `systemctl --user start desktop-pipeline.service`를 동기 실행. 파이프라인 timer는 그대로 살아있고 수동 트리거는 같은 진입점을 즉시 호출하는 것뿐.

`~/.config/tomboy-automation.json`에 등록:

\`\`\`json
"pipeline-run": [
  { "project": "pipeline", "exec": ["systemctl", "--user", "start", "desktop-pipeline.service"] }
]
\`\`\`
```

- [ ] **Step 7: Commit doc change (registry is runtime config, not committed)**

```bash
git add automation-service/deploy/README.md  # or wherever the doc lives
git commit -m "docs(automation-service): pipeline-run 명령 등록 안내"
```

```json:metadata
{"files":["automation-service/deploy/README.md"],"verifyCommand":"curl -s -X POST -H \"Authorization: Bearer $BRIDGE_SHARED_TOKEN\" -H \"Content-Type: application/json\" -d '{\"command\":\"pipeline-run\"}' http://localhost:7843/run | grep -q '\"results\":{\"pipeline\"'","acceptanceCriteria":["registry pipeline-run 추가","200 응답","systemctl start journal 등장","unknown_command 회귀 없음","문서 1줄 추가"]}
```

---

## Task 6: 가이드 카드 추가

**Goal:** `설정 → 가이드 → 노트` 서브탭에 `<details class="guide-card">` 추가 (CLAUDE.md 의무).

**Files:**
- Modify: `app/src/routes/settings/+page.svelte`

**Acceptance Criteria:**
- [ ] 가이드 → 노트 탭에 "리마커블 수동 업로드" 카드 등장
- [ ] 시그니처 예시 (`리마커블::`) + `폴더:` 헤더 옵션 + 누적 로그 동작 + 로컬 네트워크 전제 명시
- [ ] svelte-check 통과

**Verify:** `cd app && npm run check`. 그리고 `npm run dev`로 브라우저에서 `/settings` → 가이드 → 노트 탭 → "리마커블 수동 업로드" 카드 보임.

**Steps:**

- [ ] **Step 1: Find the existing guide cards pattern**

```bash
grep -n 'guide-card' app/src/routes/settings/+page.svelte | head -20
```

Identify the `guideSubTab === 'notes'` block and the existing `<details class="guide-card">` style.

- [ ] **Step 2: Add new card**

Insert into the `notes` subtab block (mirror an existing card's structure):

```svelte
<details class="guide-card">
  <summary>리마커블 수동 업로드 (<code>리마커블::</code>)</summary>
  <p class="info-text">
    기본 5분 timer 외에 사용자가 직접 트리거하는 리마커블 → 일기 OCR 경로. 노트 본문 상단에 "📥 업로드"
    버튼이 나타나고, 클릭하면 브릿지가 리마커블에 SSH 접속해 새 페이지를 가져와 데스크탑
    파이프라인을 즉시 호출한다.
  </p>
  <pre class="snippet">리마커블::오늘 일기
폴더: Diary</pre>
  <ul class="guide-list">
    <li><code>폴더:</code> 헤더 — 미지정 시 브릿지 기본값 (보통 <code>Diary</code>).</li>
    <li>같은 노트에서 여러 번 클릭 가능. 가져온 페이지마다 결과 노트 링크가 누적된다.</li>
    <li>이미 처리된 페이지는 inbox 상태로 식별되어 중복 호출에서 제외된다.</li>
    <li><b>로컬 네트워크 전제</b> — 외부망에서는 SSH 접속이 불가해 자동으로 실패한다.</li>
    <li>결과 노트는 기존 일기 파이프라인과 동일하게 자동 생성 (제목 형식 변경 없음).</li>
  </ul>
</details>
```

- [ ] **Step 3: Verify**

```bash
cd app && npm run check
```

Then manually browser-verify: `cd app && npm run dev` → http://localhost:5174/settings → 가이드 → 노트 탭 → "리마커블 수동 업로드" 카드 확장하면 위 내용 보임.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/settings/+page.svelte
git commit -m "docs(settings): 리마커블 수동 업로드 가이드 카드"
```

```json:metadata
{"files":["app/src/routes/settings/+page.svelte"],"verifyCommand":"cd app && npm run check","acceptanceCriteria":["가이드→노트 탭 카드 등장","시그니처 + 헤더 예시","누적 로그 + 로컬 네트워크 명시","svelte-check 통과"]}
```

---

## Task 7: 통합 검증

**Goal:** 실제 리마커블 디바이스 + 브릿지 + 데스크탑 파이프라인이 모두 살아있는 환경에서 end-to-end 동작 확인.

**Files:** none (수동 검증)

**Acceptance Criteria:**
- [ ] 리마커블에 새 페이지 1장 작성
- [ ] 톰보이에서 `리마커블::E2E 테스트` 노트 생성 → "📥 업로드" 버튼 보임
- [ ] 클릭 → placeholder 단계별 메시지 갱신 → done 시 헤더 라인 + `→ [[…]]` 링크 1개 prepend
- [ ] `podman logs --tail 5 claude-service` 에 새 `/chat` 요청 + `user[image,text]` shape 등장
- [ ] `journalctl --user -u desktop-pipeline.service -n 30 --no-pager` 에 `s3_ocr: 1 pages OCR'd`
- [ ] 톰보이에 새 결과 노트 (`YYYY-MM-DD 리마커블([uuid])`) 등장 + `리마커블::E2E 테스트` 노트의 broken-link 해소 (마크가 살아있는 internal link로 보임)
- [ ] 같은 노트에서 다시 클릭 → "0건" 헤더 라인이 prepend (중복 가져오기 차단 확인)

**Verify:** 수동.

**Steps:**

- [ ] **Step 1: 환경 점검**

```bash
podman ps --format '{{.Names}} {{.Status}}' | grep -E 'claude-service|automation-service'
# 둘 다 Up 이어야 함
systemctl --user is-active desktop-pipeline.service desktop-pipeline.timer
# timer는 active 이어야 함
ss -tlnp | grep -E ':7842|:7843'
# 둘 다 LISTEN
```

- [ ] **Step 2: 환경변수 점검**

브릿지 환경변수가 설정되어 있는지:

```bash
ssh <pi-host> 'cat ~/.config/term-bridge.env | grep -E "REMARKABLE_|AUTOMATION_SERVICE"'
```

리마커블 SSH 키가 브릿지 컨테이너에 마운트되어 있는지 (deploy 문서 참조).

- [ ] **Step 3: registry.json 확인**

```bash
grep -A4 '"pipeline-run"' ~/.config/tomboy-automation.json
```

Expected: Task 5 에서 추가한 entry 확인.

- [ ] **Step 4: 리마커블 페이지 작성**

리마커블 디바이스에서 `Diary` 노트북에 새 페이지 1장 작성 (간단한 손글씨 한 문장).

- [ ] **Step 5: 톰보이에서 트리거 노트 생성**

브라우저에서 톰보이 열고 새 노트:
```
리마커블::E2E 테스트
폴더: Diary
```

저장 후 노트 본문에 "📥 업로드" 버튼이 보이는지 확인.

- [ ] **Step 6: 클릭 + 관찰**

업로드 버튼 클릭. placeholder가 다음 순서대로 갱신되는지:
- 리마커블 접속 중…
- Diary 페이지 N건 가져오는 중…
- 페이지 복사 중…
- 파이프라인 트리거…

그리고 done 시 placeholder 사라지고 본문에:
```
2026-MM-DD HH:mm — Diary, 1건
  → [[2026-MM-DD 리마커블([uuid])]]
```

prepend.

- [ ] **Step 7: 백엔드 로그 검증**

```bash
podman logs --tail 5 claude-service 2>&1 | tail -5
# 최신 요청에 "shape":"user[image,text]" 보임

journalctl --user -u desktop-pipeline.service -n 30 --no-pager
# 최근 entry에 "s3_ocr: 1 pages OCR'd" 보임
```

- [ ] **Step 8: 결과 노트 확인**

톰보이 전체 노트 목록 → `YYYY-MM-DD 리마커블([uuid])` 노트 등장 확인. `리마커블::E2E 테스트` 노트의 broken-link 마크가 살아있는 internal link로 보이는지 (회색 → 파란색 등 시각적 차이).

- [ ] **Step 9: 중복 차단 검증**

같은 `리마커블::E2E 테스트` 노트에서 한 번 더 업로드 클릭. 결과:
```
2026-MM-DD HH:mm — Diary, 0건
[기존 라인들 그대로 유지]
```

새 페이지 0건으로 표시되고 새 결과 노트는 생성되지 않아야 함.

- [ ] **Step 10: 결과 보고**

상기 step 모두 통과면 "통합 검증 완료" 보고. 일부 실패 시 단계별 로그 첨부.

```json:metadata
{"files":[],"verifyCommand":"manual","acceptanceCriteria":["리마커블 페이지 작성","리마커블:: 노트에 위젯 등장","placeholder→로그 라인","claude-service shape=user[image,text]","s3_ocr:1 pages OCR'd","결과 노트 등장 + broken-link 해소","중복 클릭 0건 표시"]}
```

---

## 자가 검토 (writing-plans skill, internal)

**Spec 커버리지:**
- Spec §노트 본문 형태 → Task 1 (파서) + Task 3 (위젯 + 로그 prepend)
- Spec §브릿지 라우트 요청 → Task 4
- Spec §SSE 이벤트 스키마 → Task 2 (클라이언트) + Task 4 (서버 emit)
- Spec §클라이언트 → 노트 반영 규칙 → Task 3
- Spec §automation-service `pipeline-run` 명령 → Task 5
- Spec §리마커블 SSH 페치 흐름 → Task 4 (ssh.ts + remarkableUpload.ts)
- Spec §에러 / 부분 실패 → Task 2 (에러 enum 매핑), Task 3 (placeholder 교체), Task 4 (부분 실패 처리)
- Spec §테스트 → Task 1-4 단위 + Task 7 수동
- Spec §가이드 카드 → Task 6
- Spec 변경 범위/비범위 → 본 plan 본문에서 모두 v1 범위 안에 있음

**Placeholder 스캔:** "TBD" / "TODO" / vague "add validation" 없음. Spec deviation 1건은 plan 본문 상단에 명시.

**Type consistency:**
- `parseRemarkableNote` returns `RemarkableNoteSpec | null` — Task 1 정의, Task 3 import + 사용.
- `RemarkableUploadResult.pages` = `{uuid, date}[]` — Task 2 정의, Task 3·4 동일 형식 사용.
- `RemarkableUploadStatus.step` enum — Task 2 정의, Task 4 emit, Task 3 statusMessage switch.
- `RemarkableUploadErrorKind` — Task 2 정의, Task 3 KIND_MESSAGES, Task 4 ErrorKind 동일.
- `RemarkableSshConfig` = `{host, user, keyPath}` — Task 4 ssh.ts 정의 + remarkableUpload.ts 사용.
- 클라이언트 제목 포맷 `${date} 리마커블([${uuid}])` (Task 3) ≡ pipeline yaml `tomboy.title_format` (현재 운영 값).

**User-gate detection:** 사용자 brief 스캔 결과 gate 키워드 없음 (verbs/nouns/scope/proof 모두 unmatch). 일반 task로 작성.
