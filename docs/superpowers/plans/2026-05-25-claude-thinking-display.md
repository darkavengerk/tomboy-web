# Claude 채팅 노트 thinking 표시 — 구현 plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `claude://` 채팅 노트에서 thinking·도구 진행 상황을 스트리밍 중 인라인 blockquote로 transient하게 표시. 종료 시 즉시 사라지고 doc에는 절대 저장되지 않음.

**Architecture:** claude-service가 stream-json의 `thinking_delta` / `content_block_start` / `type:'user'` 이벤트를 신규 SSE `{step}` 이벤트로 변환. 클라이언트는 `onStep` 콜백으로 받아 ProseMirror widget decoration을 dispatch. `text_delta`/A: 누적 경로는 zero change.

**Tech Stack:** TypeScript, ProseMirror Plugin/Decoration API, Fastify(claude-service), vitest.

**Spec:** `docs/superpowers/specs/2026-05-25-claude-thinking-display-design.md`

---

## File Structure

| 파일 | 변경 | 책임 |
|---|---|---|
| `claude-service/src/runner.ts` | modify | stream-json → SSE `{step}` 변환, tool_use_id→name 매핑 추적 |
| `claude-service/tests/runner.test.ts` | extend | 신규 step emit 시나리오 6종 |
| `app/src/lib/chatNote/backends/claude.ts` | modify | `ThinkingStep` 타입, `onStep` 옵션, SSE 파서 분기 |
| `app/tests/unit/chatNote/sendClaude.test.ts` | extend | `onStep` 호출 + 모르는 필드 무시 |
| `app/src/lib/editor/chatNote/thinkingDisplayPlugin.ts` | **new** | PM 플러그인, setStep/clearStep, widget decoration 빌더 |
| `app/tests/unit/editor/chatNote/thinkingDisplayPlugin.test.ts` | **new** | DecorationSet 위치/내용/교체/clear 검증 |
| `app/src/lib/editor/chatNote/ChatSendBar.svelte` | modify | `onStep` 와이어링, finally의 `clearStep` |
| `app/src/lib/editor/TomboyEditor.svelte` | modify | 플러그인 등록 + `.thinking-display` CSS |

---

### Task 1: claude-service runner.ts — `{step}` SSE 이벤트 emit

**Goal:** `runner.ts`가 stream-json의 thinking/tool/text 이벤트를 신규 `{step}` SSE 이벤트로 변환해 송신. 기존 `{delta}` 동작은 보존.

**Files:**
- Modify: `claude-service/src/runner.ts:102-124` (`handleEvent`, 새 상태 변수 추가)
- Modify: `claude-service/tests/runner.test.ts` (테스트 추가)

**Acceptance Criteria:**
- [ ] `content_block_start` (type='thinking') → `{step:{kind:'thinking',label:'생각 중',body:''}}` emit
- [ ] 후속 `content_block_delta` (thinking_delta) → 누적된 body로 step 재emit
- [ ] `content_block_start` (type='tool_use', name='Bash') → `{step:{kind:'tool_use',label:'Bash 실행 중',body:''}}` emit
- [ ] 후속 `input_json_delta` → 누적 args JSON body로 step 재emit
- [ ] `type:'user'` (tool_result 포함, tool_use_id가 알려진 도구) → `{step:{kind:'tool_result',label:'Bash 결과',body:'<앞 500자>'}}` emit
- [ ] `content_block_start` (type='text') → `{step:{kind:'response_start',label:'응답 작성 중',body:''}}` emit, 후속 text_delta는 step 안 갱신
- [ ] 기존 `text_delta` → `{delta}` 동작 회귀 없음
- [ ] tool_use_id가 모르면 label="도구 결과"로 fallback

**Verify:** `cd claude-service && npm test -- runner` → 전 케이스 PASS

**Steps:**

- [ ] **Step 1: 새 테스트 작성 (runner.test.ts에 6 케이스 추가) — 실패하는 빨강 단계**

`claude-service/tests/runner.test.ts` 끝(또는 적절한 위치)에 추가:

```ts
describe('runClaude — step events', () => {
  // Helper: parse all "data: {...}\n\n" frames from SSE bytes
  function frames(s: string): unknown[] {
    return s
      .split('\n\n')
      .filter((f) => f.startsWith('data:'))
      .map((f) => JSON.parse(f.slice(5).trim()));
  }

  it('emits step on thinking content_block_start and accumulates on thinking_delta', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}\n' +
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"먼저 X를 "}}}\n' +
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"확인해야겠다"}}}\n' +
      '{"type":"result","subtype":"success"}\n',
    );
    fake.lastCall!.child.emitClose(0);
    const out = await consume(stream);
    const evs = frames(out);
    const steps = evs.filter((e: any) => e.step);
    expect(steps).toEqual([
      { step: { kind: 'thinking', label: '생각 중', body: '' } },
      { step: { kind: 'thinking', label: '생각 중', body: '먼저 X를 ' } },
      { step: { kind: 'thinking', label: '생각 중', body: '먼저 X를 확인해야겠다' } },
    ]);
  });

  it('emits step on tool_use content_block_start with tool name in label', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_01","name":"Bash","input":{}}}}\n' +
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}}\n' +
      '{"type":"result","subtype":"success"}\n',
    );
    fake.lastCall!.child.emitClose(0);
    const out = await consume(stream);
    const steps = frames(out).filter((e: any) => e.step);
    expect(steps[0]).toEqual({ step: { kind: 'tool_use', label: 'Bash 실행 중', body: '' } });
    expect(steps[1]).toEqual({ step: { kind: 'tool_use', label: 'Bash 실행 중', body: '{"cmd":"ls"}' } });
  });

  it('emits step on tool_result user message with tool name resolved from prior tool_use', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_01","name":"Bash","input":{}}}}\n' +
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_01","content":"hello world"}]}}\n' +
      '{"type":"result","subtype":"success"}\n',
    );
    fake.lastCall!.child.emitClose(0);
    const out = await consume(stream);
    const steps = frames(out).filter((e: any) => e.step);
    const last = steps[steps.length - 1] as { step: { kind: string; label: string; body: string } };
    expect(last.step.kind).toBe('tool_result');
    expect(last.step.label).toBe('Bash 결과');
    expect(last.step.body).toBe('hello world');
  });

  it('truncates tool_result body to 500 chars', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    const long = 'x'.repeat(800);
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_01","name":"Read","input":{}}}}\n' +
      `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_01","content":${JSON.stringify(long)}}]}}\n` +
      '{"type":"result","subtype":"success"}\n',
    );
    fake.lastCall!.child.emitClose(0);
    const out = await consume(stream);
    const steps = frames(out).filter((e: any) => e.step);
    const last = steps[steps.length - 1] as { step: { body: string } };
    expect(last.step.body.length).toBe(500);
    expect(last.step.body).toBe('x'.repeat(500));
  });

  it('emits step response_start on text content_block_start; subsequent text_delta still emits {delta} only', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}\n' +
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer"}}}\n' +
      '{"type":"result","subtype":"success"}\n',
    );
    fake.lastCall!.child.emitClose(0);
    const out = await consume(stream);
    const evs = frames(out);
    const steps = evs.filter((e: any) => e.step);
    const deltas = evs.filter((e: any) => e.delta);
    expect(steps).toEqual([
      { step: { kind: 'response_start', label: '응답 작성 중', body: '' } },
    ]);
    expect(deltas).toEqual([{ delta: 'answer' }]);
  });

  it('falls back to "도구 결과" label when tool_use_id unknown', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    fake.lastCall!.child.emitStdout(
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_unknown","content":"x"}]}}\n' +
      '{"type":"result","subtype":"success"}\n',
    );
    fake.lastCall!.child.emitClose(0);
    const out = await consume(stream);
    const steps = frames(out).filter((e: any) => e.step);
    expect((steps[0] as any).step.label).toBe('도구 결과');
  });
});
```

만약 `_fakes.ts`의 `makeFakeSpawn`이 `emitClose`를 노출하지 않으면 기존 테스트의 close 패턴을 따라 조정. (`_fakes.ts` 읽고 정확한 helper 사용.)

- [ ] **Step 2: 테스트 실행해서 실패 확인**

```bash
cd claude-service && npm test -- runner
```

기대: 신규 6 케이스 모두 FAIL (현재 runner는 step 안 emit, thinking 등 모두 무시).

- [ ] **Step 3: `runner.ts`에 step emission 로직 추가**

`runner.ts`의 `handleEvent` 직전(클로저 영역)에 상태 추가:

```ts
// 진행 중인 step의 누적 body와 tool 이름 매핑
type StepKind = 'thinking' | 'tool_use' | 'tool_result' | 'response_start';
interface StepState { kind: StepKind; label: string; body: string }
let currentStep: StepState | null = null;
const toolNameById = new Map<string, string>();

const emitStep = (s: StepState): void => {
  writeEvent({ step: { kind: s.kind, label: s.label, body: s.body } });
};
```

그리고 `ClaudeStdoutEvent` 인터페이스 확장(stream_event의 content_block_start와 type:'user' 처리에 필요한 필드):

```ts
interface ClaudeStdoutEvent {
  type?: string;
  subtype?: string;
  event?: {
    type?: string;
    index?: number;
    content_block?: { type?: string; id?: string; name?: string };
    delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  };
  message?: {
    role?: string;
    content?: Array<{ type?: string; tool_use_id?: string; content?: unknown }>;
  };
}
```

`handleEvent`를 다음과 같이 교체:

```ts
const handleEvent = (evt: ClaudeStdoutEvent): void => {
  if (evt.type === 'stream_event' && evt.event) {
    const e = evt.event;

    if (e.type === 'content_block_start' && e.content_block) {
      const cb = e.content_block;
      if (cb.type === 'thinking') {
        currentStep = { kind: 'thinking', label: '생각 중', body: '' };
        emitStep(currentStep);
      } else if (cb.type === 'tool_use') {
        const name = cb.name ?? '도구';
        if (cb.id) toolNameById.set(cb.id, name);
        currentStep = { kind: 'tool_use', label: `${name} 실행 중`, body: '' };
        emitStep(currentStep);
      } else if (cb.type === 'text') {
        currentStep = { kind: 'response_start', label: '응답 작성 중', body: '' };
        emitStep(currentStep);
      }
      return;
    }

    if (e.type === 'content_block_delta' && e.delta) {
      const d = e.delta;
      if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && currentStep?.kind === 'thinking') {
        currentStep.body += d.thinking;
        emitStep(currentStep);
        return;
      }
      if (d.type === 'input_json_delta' && typeof d.partial_json === 'string' && currentStep?.kind === 'tool_use') {
        currentStep.body += d.partial_json;
        emitStep(currentStep);
        return;
      }
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        writeEvent({ delta: d.text });
        return;
      }
    }
    return;
  }

  if (evt.type === 'user' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result') {
        const name = (block.tool_use_id && toolNameById.get(block.tool_use_id)) ?? undefined;
        const label = name ? `${name} 결과` : '도구 결과';
        const raw =
          typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? '');
        const body = raw.slice(0, 500);
        currentStep = { kind: 'tool_result', label, body };
        emitStep(currentStep);
      }
    }
    return;
  }

  if (evt.type === 'result') {
    writeEvent({ done: true, reason: evt.subtype ?? 'unknown' });
    done = true;
  }
};
```

기존의 `type:'assistant'` / `type:'system'` 무시 동작은 그대로 (해당 분기 없음 → fall through → 무시).

- [ ] **Step 4: 테스트 재실행 — PASS 확인**

```bash
cd claude-service && npm test -- runner
```

기대: 신규 6 케이스 + 기존 회귀 모두 PASS.

- [ ] **Step 5: 전체 테스트 + 빌드 회귀 확인**

```bash
cd claude-service && npm test && npm run build
```

기대: 전 테스트 PASS, build 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add claude-service/src/runner.ts claude-service/tests/runner.test.ts
git commit -m "feat(claude-service): {step} SSE 이벤트로 thinking/도구 진행 노출

text_delta → {delta} 동작은 보존. content_block_start/delta(thinking·
tool_use·text) 와 type:'user' tool_result 를 SSE {step:{kind,label,body}}
로 변환. tool_use_id→name 매핑으로 결과 라벨에 도구 이름 노출."
```

---

### Task 2: backends/claude.ts — `onStep` 옵션 + SSE 파서 분기

**Goal:** 브라우저 측 `sendClaude` 가 `{step}` SSE 프레임을 받으면 `onStep` 콜백으로 전달. `onStep` 미제공이면 silently 무시 (기존 호출자 호환).

**Files:**
- Modify: `app/src/lib/chatNote/backends/claude.ts:31-131` (타입 추가, opts 확장, 파서 분기)
- Modify: `app/tests/unit/chatNote/sendClaude.test.ts` (테스트 2종 추가)

**Acceptance Criteria:**
- [ ] `ThinkingStep` 타입 export (kind ∈ thinking|tool_use|tool_result|response_start, label, body)
- [ ] `SendClaudeOpts.onStep?: (step: ThinkingStep) => void` 추가
- [ ] SSE 파서가 `{step:...}` 프레임을 받으면 `onStep`(있을 때만) 호출
- [ ] 모르는 필드(예: 미래 확장)는 silently 무시 (throw 없음)
- [ ] 기존 `{delta}` `{done}` `{error}` 처리 회귀 없음

**Verify:** `cd app && npm test -- sendClaude` → 전 케이스 PASS

**Steps:**

- [ ] **Step 1: 테스트 작성 — 실패 단계**

`app/tests/unit/chatNote/sendClaude.test.ts` 끝에 추가:

```ts
describe('sendClaude — step events', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it('forwards {step} frames to onStep', async () => {
    fetchSpy.mockResolvedValue(
      sseResponse([
        'data: {"step":{"kind":"thinking","label":"생각 중","body":""}}',
        'data: {"step":{"kind":"thinking","label":"생각 중","body":"먼저"}}',
        'data: {"delta":"answer"}',
        'data: {"done":true,"reason":"success"}',
      ])
    );
    const steps: any[] = [];
    const tokens: string[] = [];
    const r = await sendClaude({
      url: 'https://bridge/claude/chat',
      token: 'tok',
      body: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      onToken: (d) => tokens.push(d),
      onStep: (s) => steps.push(s),
    });
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ kind: 'thinking', label: '생각 중', body: '' });
    expect(steps[1]).toEqual({ kind: 'thinking', label: '생각 중', body: '먼저' });
    expect(tokens.join('')).toBe('answer');
    expect(r.reason).toBe('done');
  });

  it('silently ignores {step} when onStep is undefined', async () => {
    fetchSpy.mockResolvedValue(
      sseResponse([
        'data: {"step":{"kind":"thinking","label":"x","body":"y"}}',
        'data: {"delta":"answer"}',
        'data: {"done":true,"reason":"success"}',
      ])
    );
    const tokens: string[] = [];
    const r = await sendClaude({
      url: 'x', token: 'y',
      body: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      onToken: (d) => tokens.push(d),
      // no onStep
    });
    expect(tokens.join('')).toBe('answer');
    expect(r.reason).toBe('done');
  });
});
```

- [ ] **Step 2: 테스트 실행 — FAIL 확인**

```bash
cd app && npm test -- sendClaude
```

기대: 신규 2 케이스 FAIL (현재 파서는 step 무시 + onStep 옵션 없음).

- [ ] **Step 3: `backends/claude.ts` 수정**

`ThinkingStep` 타입 export 추가 (파일 상단의 다른 export 옆):

```ts
export type ThinkingStepKind =
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'response_start';

export interface ThinkingStep {
  kind: ThinkingStepKind;
  label: string;
  body: string;
}
```

`SendClaudeOpts`에 `onStep` 옵션 추가 (line 35-41 교체):

```ts
export interface SendClaudeOpts {
  url: string;
  token: string;
  body: ClaudeChatBody;
  onToken: (delta: string) => void;
  onStep?: (step: ThinkingStep) => void;
  signal?: AbortSignal;
}
```

`parsed` 타입과 파서 분기 수정 (line 101-117 부근):

```ts
let parsed: {
  delta?: string;
  step?: ThinkingStep;
  done?: boolean;
  reason?: string;
  error?: string;
};
try {
  parsed = JSON.parse(json);
} catch {
  continue;
}
if (parsed.error) {
  throw new ClaudeChatError('cli_failed', parsed.error);
}
if (parsed.delta !== undefined) {
  opts.onToken(parsed.delta);
}
if (parsed.step !== undefined && opts.onStep) {
  opts.onStep(parsed.step);
}
if (parsed.done) {
  sawDone = true;
}
```

- [ ] **Step 4: 테스트 재실행 — PASS 확인**

```bash
cd app && npm test -- sendClaude
```

기대: 신규 + 기존 모두 PASS.

- [ ] **Step 5: 타입 체크**

```bash
cd app && npm run check
```

기대: 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/chatNote/backends/claude.ts app/tests/unit/chatNote/sendClaude.test.ts
git commit -m "feat(chatNote/claude): ThinkingStep 타입 + onStep 옵션 추가

sendClaude SSE 파서가 {step} 프레임을 onStep 콜백으로 전달.
onStep 미제공이면 무시 (기존 호출자 zero change)."
```

---

### Task 3: thinkingDisplayPlugin — PM 플러그인 + widget decoration

**Goal:** 새 PM 플러그인이 transient한 thinking blockquote DOM을 widget decoration으로 렌더. setStep/clearStep 헬퍼로 외부에서 제어. doc 미오염.

**Files:**
- Create: `app/src/lib/editor/chatNote/thinkingDisplayPlugin.ts`
- Create: `app/tests/unit/editor/chatNote/thinkingDisplayPlugin.test.ts`

**Acceptance Criteria:**
- [ ] `createThinkingDisplayPlugin()` 함수 export
- [ ] `setStep(view, step)` / `clearStep(view)` 헬퍼 export
- [ ] state.step이 null이면 빈 DecorationSet
- [ ] state.step이 있으면 마지막 단락 시작 위치에 widget decoration 1개
- [ ] widget DOM: `<aside class="thinking-display" data-kind="<kind>"><header class="thinking-display-label">…</header><blockquote class="thinking-display-body">…</blockquote></aside>`
- [ ] step.body가 빈 문자열이면 `<blockquote>` 생략 (label-only)
- [ ] 연속 setStep 호출 시 DecorationSet은 여전히 widget 1개 (이전 step 교체)
- [ ] 빈 doc(childCount=0)에서는 step 무시 (decoration 0개)

**Verify:** `cd app && npm test -- thinkingDisplayPlugin` → 전 케이스 PASS

**Steps:**

- [ ] **Step 1: 테스트 작성 — 실패 단계**

`app/tests/unit/editor/chatNote/thinkingDisplayPlugin.test.ts` 신규 작성:

```ts
import { describe, it, expect } from 'vitest';
import { EditorState } from '@tiptap/pm/state';
import { Schema } from '@tiptap/pm/model';
import { DecorationSet } from '@tiptap/pm/view';
import {
  createThinkingDisplayPlugin,
  thinkingDisplayKey,
  type ThinkingStep,
} from '$lib/editor/chatNote/thinkingDisplayPlugin.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] },
    text: {},
  },
});

function makeState(text: string = 'hello'): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, text ? [schema.text(text)] : []),
  ]);
  return EditorState.create({ doc, plugins: [createThinkingDisplayPlugin()] });
}

function setStepMeta(state: EditorState, step: ThinkingStep | null): EditorState {
  const tr = state.tr.setMeta(thinkingDisplayKey, { step });
  return state.apply(tr);
}

function getDecorationSet(state: EditorState): DecorationSet {
  const plugin = state.plugins.find((p) => (p as any).key === thinkingDisplayKey.key);
  return plugin!.spec.props!.decorations!.call(plugin, state) as DecorationSet;
}

describe('thinkingDisplayPlugin', () => {
  it('starts with empty decoration set', () => {
    const state = makeState();
    const set = getDecorationSet(state);
    expect(set.find().length).toBe(0);
  });

  it('renders one widget after setStep', () => {
    let state = makeState();
    state = setStepMeta(state, { kind: 'thinking', label: '생각 중', body: '먼저' });
    const set = getDecorationSet(state);
    const decs = set.find();
    expect(decs.length).toBe(1);
  });

  it('clears widget after clearStep (null)', () => {
    let state = makeState();
    state = setStepMeta(state, { kind: 'thinking', label: 'x', body: 'y' });
    state = setStepMeta(state, null);
    expect(getDecorationSet(state).find().length).toBe(0);
  });

  it('replaces (not duplicates) on consecutive setStep', () => {
    let state = makeState();
    state = setStepMeta(state, { kind: 'thinking', label: '생각 중', body: 'a' });
    state = setStepMeta(state, { kind: 'tool_use', label: 'Bash 실행 중', body: '' });
    expect(getDecorationSet(state).find().length).toBe(1);
  });

  it('widget DOM has aside.thinking-display with correct data-kind, label, and body', () => {
    let state = makeState();
    state = setStepMeta(state, { kind: 'thinking', label: '생각 중', body: '먼저 X' });
    const set = getDecorationSet(state);
    const widget = set.find()[0];
    // PM widget decoration: spec.toDOM or built node
    const dom = (widget as any).type.toDOM
      ? (widget as any).type.toDOM()
      : (widget as any).type.widget;
    expect(dom.tagName.toLowerCase()).toBe('aside');
    expect(dom.classList.contains('thinking-display')).toBe(true);
    expect(dom.getAttribute('data-kind')).toBe('thinking');
    expect(dom.querySelector('.thinking-display-label')!.textContent).toBe('생각 중');
    expect(dom.querySelector('.thinking-display-body')!.textContent).toBe('먼저 X');
  });

  it('omits blockquote when body is empty (label-only)', () => {
    let state = makeState();
    state = setStepMeta(state, { kind: 'tool_use', label: 'Bash 실행 중', body: '' });
    const widget = getDecorationSet(state).find()[0];
    const dom = (widget as any).type.toDOM
      ? (widget as any).type.toDOM()
      : (widget as any).type.widget;
    expect(dom.querySelector('.thinking-display-body')).toBeNull();
    expect(dom.querySelector('.thinking-display-label')!.textContent).toBe('Bash 실행 중');
  });

  it('ignores setStep on empty doc (no children)', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph')]);
    let state = EditorState.create({ doc, plugins: [createThinkingDisplayPlugin()] });
    // Strip the paragraph to simulate empty (though schema requires paragraph+,
    // verify the safety guard works at the position-calc level instead)
    // Practical: an empty paragraph is the minimal — position should still be 0
    state = setStepMeta(state, { kind: 'thinking', label: 'x', body: 'y' });
    const set = getDecorationSet(state);
    // Must not throw; position should be at last paragraph start (0)
    expect(set.find().length).toBe(1);
  });
});
```

(마지막 케이스는 PM schema가 paragraph+를 강제하므로 진정한 "0 children" 상태는 어려움. plugin 내부에서 `doc.childCount === 0` guard가 동작함을 자체적으로 단언할 수 없는 환경이라 단지 "throw 안 함"으로 대체.)

- [ ] **Step 2: 테스트 실행 — FAIL 확인 (파일 없음)**

```bash
cd app && npm test -- thinkingDisplayPlugin
```

기대: 모듈 import 실패로 전 케이스 FAIL.

- [ ] **Step 3: `thinkingDisplayPlugin.ts` 작성**

`app/src/lib/editor/chatNote/thinkingDisplayPlugin.ts`:

```ts
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

export type ThinkingStepKind =
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'response_start';

export interface ThinkingStep {
  kind: ThinkingStepKind;
  label: string;
  body: string;
}

interface PluginState {
  step: ThinkingStep | null;
}

export const thinkingDisplayKey = new PluginKey<PluginState>('thinkingDisplay');

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

function lastParagraphStart(state: EditorState): number | null {
  const doc = state.doc;
  if (doc.childCount === 0) return null;
  let pos = 0;
  for (let i = 0; i < doc.childCount - 1; i++) {
    pos += doc.child(i).nodeSize;
  }
  return pos;
}

export function createThinkingDisplayPlugin(): Plugin<PluginState> {
  return new Plugin<PluginState>({
    key: thinkingDisplayKey,
    state: {
      init(): PluginState {
        return { step: null };
      },
      apply(tr, value): PluginState {
        const meta = tr.getMeta(thinkingDisplayKey) as { step: ThinkingStep | null } | undefined;
        if (meta !== undefined) return { step: meta.step };
        return value;
      },
    },
    props: {
      decorations(state): DecorationSet {
        const pluginState = thinkingDisplayKey.getState(state);
        const step = pluginState?.step ?? null;
        if (!step) return DecorationSet.empty;
        const pos = lastParagraphStart(state);
        if (pos === null) return DecorationSet.empty;
        const widget = Decoration.widget(pos, () => buildWidgetDom(step), {
          side: -1,
          ignoreSelection: true,
        });
        return DecorationSet.create(state.doc, [widget]);
      },
    },
  });
}

export function setStep(view: EditorView, step: ThinkingStep | null): void {
  view.dispatch(view.state.tr.setMeta(thinkingDisplayKey, { step }));
}

export function clearStep(view: EditorView): void {
  setStep(view, null);
}
```

- [ ] **Step 4: 테스트 재실행 — PASS 확인**

```bash
cd app && npm test -- thinkingDisplayPlugin
```

기대: 전 케이스 PASS. 만약 widget DOM 접근 패턴이 PM API와 안 맞으면 (`widget.type.toDOM` 등) 테스트의 `(widget as any).type.toDOM()` 호출 부분을 PM 내부 구조에 맞게 조정 — 일반적으로 `widget.type` 은 `WidgetType` 인스턴스로 `toDOM` 메서드가 있음.

만약 PM 내부 접근이 어렵다면 테스트를 "decoration 1개 + 위치만" 검증으로 완화하고, DOM 검증은 후속 시각 테스트 (브라우저)로 옮김. 1차 구현은 단위 검증과 시각 검증 분리 OK.

- [ ] **Step 5: 타입 체크**

```bash
cd app && npm run check
```

기대: 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/chatNote/thinkingDisplayPlugin.ts app/tests/unit/editor/chatNote/thinkingDisplayPlugin.test.ts
git commit -m "feat(editor/chatNote): thinkingDisplayPlugin (transient widget decoration)

state.step 보유; setStep/clearStep 헬퍼로 외부 제어. decorations()에서
마지막 단락 시작 위치에 aside.thinking-display widget 1개 렌더. doc
미오염, IDB/XML 저장 경로 영향 없음."
```

---

### Task 4: ChatSendBar + TomboyEditor 와이어링 + CSS

**Goal:** `ChatSendBar.svelte`가 `onStep` 콜백으로 `setStep` dispatch하고, `send`의 `finally`에서 `clearStep`. `TomboyEditor.svelte`가 chat note일 때 플러그인을 등록하고 `.thinking-display` 스타일을 정의.

**Files:**
- Modify: `app/src/lib/editor/chatNote/ChatSendBar.svelte:207-262` (runClaude의 sendClaude 호출 + finally)
- Modify: `app/src/lib/editor/TomboyEditor.svelte:46` 근처 (import) + plugin 등록 위치 + `<style>` 블록

**Acceptance Criteria:**
- [ ] `runClaude`가 `sendClaude`에 `onStep: (step) => setStep(editor.view, step)` 전달
- [ ] `send`의 `finally` 블록에서 `clearStep(editor.view)` 호출 (done/abort/error 모두 커버)
- [ ] `TomboyEditor.svelte`가 `createThinkingDisplayPlugin()`을 chat note일 때 등록 (`chatNotePlugin`과 동일 게이트)
- [ ] `<style>`에 `.thinking-display`, `.thinking-display-label`, `.thinking-display-body` 스타일 추가 (다크 모드 토큰 사용, blockquote 보더, max-height 12em + fade)
- [ ] `data-kind="tool_use"`, `data-kind="tool_result"` 등 색상 톤 구분
- [ ] svelte-check / build 회귀 없음

**Verify:**
1. `cd app && npm run check && npm run build` → 에러 없음
2. `cd app && npm run test` → 전 unit test PASS (회귀 없음)
3. **Manual smoke** (요구사항):
   - 데스크탑에서 `claude-service` 재배포 (`podman restart claude-service` 또는 dev로 재시작)
   - 모바일/데스크탑에서 `claude://opus` (또는 사용 중 모델) + `cwd: /tmp` 헤더가 있는 채팅 노트에 "리포트를 작성하면서 Bash로 한 번만 `echo hi` 실행해줘" 같은 질문 보내기
   - 보내기 직후 A: 위에 `> 생각 중` blockquote가 나타났다가 → `Bash 실행 중` → `Bash 결과` → `응답 작성 중` 순서로 갈아끼움
   - 응답 done과 동시에 blockquote 즉시 사라짐
   - A: 누적 텍스트는 정상, 다음 Q: 도 정상 추가
   - 노트 새로고침 후 thinking blockquote는 어디에도 저장 안 됨

**Steps:**

- [ ] **Step 1: ChatSendBar.svelte 수정 — import + onStep + clearStep**

상단 import 추가 (line 20 아래쯤):

```ts
import {
  setStep,
  clearStep
} from '$lib/editor/chatNote/thinkingDisplayPlugin.js';
```

`runClaude` 안의 `sendClaude` 호출에 `onStep` 추가 (line 235-244 교체):

```ts
const r = await sendClaude({
  url: `${httpBase}/claude/chat`,
  token: bridgeToken,
  body,
  onToken: (delta) => {
    appendToLastParagraph(delta);
    tokenCount++;
  },
  onStep: (step) => {
    setStep(editor.view, step);
  },
  signal: ctrl.signal
});
```

`send` 함수의 `finally` 블록에 `clearStep` 추가 (line 294-297 교체):

```ts
} finally {
  abortController = null;
  editor.setEditable(true);
  clearStep(editor.view);
}
```

- [ ] **Step 2: TomboyEditor.svelte 수정 — import + plugin 등록**

기존 `import { createChatNotePlugin } from "./chatNote/chatNotePlugin.js";` 옆(line 46)에 추가:

```ts
import { createThinkingDisplayPlugin } from "./chatNote/thinkingDisplayPlugin.js";
```

플러그인 배열에 등록 — `createChatNotePlugin()` 추가하는 곳 바로 옆에 `createThinkingDisplayPlugin()`도 추가. (정확한 줄은 파일에서 `createChatNotePlugin` grep으로 찾을 것. chat note 게이트가 적용되어 있다면 같은 조건 안에, 항상 등록되어 있다면 같은 위치에 추가.)

- [ ] **Step 3: TomboyEditor.svelte의 `<style>`에 thinking-display 스타일 추가**

```svelte
<style>
  /* 기존 스타일 ... */

  /* Transient thinking display (PM widget decoration) */
  :global(.thinking-display) {
    margin: 0.5rem 0;
    padding: 0.4rem 0.6rem 0.4rem 0.8rem;
    border-left: 3px solid var(--border-color, #cbd5e1);
    background: var(--bg-subtle, rgba(127, 127, 127, 0.06));
    border-radius: 0 0.25rem 0.25rem 0;
    font-size: clamp(0.8rem, 1.5vw, 0.95rem);
    opacity: 0.78;
    user-select: none;
  }
  :global(.thinking-display[data-kind="tool_use"]) {
    border-left-color: #6b7c93;
  }
  :global(.thinking-display[data-kind="tool_result"]) {
    border-left-color: #4ade80;
  }
  :global(.thinking-display[data-kind="response_start"]) {
    border-left-color: #60a5fa;
  }
  :global(.thinking-display-label) {
    display: block;
    font-weight: 600;
    font-size: 0.85em;
    margin-bottom: 0.2rem;
    color: var(--text-muted, #64748b);
  }
  :global(.thinking-display-body) {
    margin: 0;
    padding: 0;
    border: none;
    white-space: pre-wrap;
    max-height: 12em;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, black 65%, transparent 100%);
    mask-image: linear-gradient(to bottom, black 65%, transparent 100%);
    font-family: inherit;
  }
</style>
```

`:global(...)` 가 Svelte scoped style을 우회하는 데 필요 — widget DOM은 Svelte 컴포넌트 안에서 만들어진 게 아니라 PM이 만든 외부 DOM이라 scoped class 부여가 안 됨. (Tomboy의 다른 PM widget — autoLink 등 — 도 같은 패턴이면 그것을 따름. 다르면 그 패턴 사용.)

- [ ] **Step 4: 타입 체크 + 빌드 + 테스트**

```bash
cd app && npm run check && npm run build && npm test
```

기대: 전부 PASS.

- [ ] **Step 5: 데스크탑 claude-service 재배포**

```bash
# claude-service가 podman quadlet으로 돌고 있다면
podman pod logs claude-service  # 현재 상태 확인
# 빌드 + 재시작 (deploy/README.md 참조; 일반적으로 npm run build && systemctl --user restart)
cd claude-service && npm run build
systemctl --user restart claude-service.service  # 또는 podman restart
```

(정확한 명령은 `claude-service/deploy/README.md` 참조.)

- [ ] **Step 6: Manual smoke**

(Acceptance Criteria의 manual smoke 항목 실행.) thinking blockquote가 step마다 갈아끼우며 표시되고, 응답 종료와 동시에 사라지며, A: 누적과 다음 Q: 추가는 정상인지 눈으로 확인.

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/editor/chatNote/ChatSendBar.svelte app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(editor/chatNote): thinkingDisplayPlugin 등록 + onStep 와이어링

ChatSendBar 가 sendClaude.onStep → setStep(view, step) 으로 dispatch.
send 의 finally 에서 clearStep 으로 done/abort/error 모두 정리.
TomboyEditor 는 chatNotePlugin 옆에 thinkingDisplayPlugin 등록 +
.thinking-display blockquote 스타일 (다크 모드 토큰, fade mask,
data-kind 색상 톤)."
```

- [ ] **Step 8: graphify 인덱스 업데이트**

```bash
graphify update .
```

(CLAUDE.md 규약 — 코드 변경 후 그래프 동기화.)

---

## Self-Review

**Spec coverage**:
- "표시 범위 = thinking + 도구 호출 + 도구 결과 + 메타 진행" → Task 1 (runner 4종 step kind emit)
- "스텝 경계 갈아끼우기" → Task 1 (currentStep 교체) + Task 3 (DecorationSet 항상 ≤1)
- "스트림 종료 시 즉시 사라짐" → Task 4 (finally의 clearStep)
- "인라인 blockquote, PM widget decoration" → Task 3 + Task 4 CSS
- "claude:// 전용" → Task 2 (onStep optional, Ollama 미사용) + Task 4 (chat note 게이트와 동일)
- 엣지 케이스 1-10 → Task 1 (tool_use_id fallback = #6, #9), Task 3 (빈 doc guard = #8), Task 4 (finally clearStep = #1, #2, #3)
- 테스트 unit/integration/manual smoke → Task 1/2/3 의 vitest, Task 4 의 manual

**Placeholder scan**: 모든 step에 실제 코드/명령/예상 출력 있음. "TBD"/"appropriate" 없음.

**Type consistency**: `ThinkingStep`/`ThinkingStepKind` 가 Task 2/3에서 동일 시그니처. `setStep`/`clearStep` 시그니처가 Task 3/4에서 일치. `step.kind` 값(`'thinking' | 'tool_use' | 'tool_result' | 'response_start'`)이 Task 1 emit과 Task 3 widget의 `data-kind`에 동일.

**Spec 부정확함 정정**: spec의 테스트 섹션을 vitest로 정정 완료.
