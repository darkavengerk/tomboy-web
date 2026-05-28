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

  it('passes --include-partial-messages flag', () => {
    const fake = makeFakeSpawn();
    void runClaude(
      { messages: [] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    expect(fake.lastCall!.args).toContain('--include-partial-messages');
  });

  it('converts text_delta stream events to SSE delta (streams in real time)', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    // Real CLI output shape under --include-partial-messages: each
    // content_block_delta/text_delta is a single chunk of the response.
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}}\n',
    );
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}}\n',
    );
    fake.lastCall!.child.emitStdout('{"type":"result","subtype":"success"}\n');
    fake.lastCall!.child.exit(0);
    const out = await consume(stream);
    expect(out).toContain('data: {"delta":"hello"}');
    expect(out).toContain('data: {"delta":" world"}');
    expect(out).toContain('data: {"done":true');
  });

  it('ignores thinking_delta (extended thinking must not leak into note)', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"internal reasoning"}}}\n',
    );
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"actual reply"}}}\n',
    );
    fake.lastCall!.child.emitStdout('{"type":"result","subtype":"success"}\n');
    fake.lastCall!.child.exit(0);
    const out = await consume(stream);
    expect(out).not.toContain('internal reasoning');
    expect(out).toContain('actual reply');
  });

  it('ignores type:"assistant" cumulative recap (would duplicate text already streamed)', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed"}}}\n',
    );
    // After content_block_stop, partial mode emits a recap "assistant" message
    // with the cumulative content. If we forwarded it, the client would see
    // "streamed" twice.
    fake.lastCall!.child.emitStdout(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"streamed"}]}}\n',
    );
    fake.lastCall!.child.emitStdout('{"type":"result","subtype":"success"}\n');
    fake.lastCall!.child.exit(0);
    const out = await consume(stream);
    // Exactly one "streamed" delta should be present (no recap duplication).
    const matches = out.match(/"delta":"streamed"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('handles partial line buffering', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    // Emit a JSON line split across two chunks
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_',
    );
    fake.lastCall!.child.emitStdout('delta","text":"split"}}}\n');
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

  it('emits error event when result is_error=true (e.g. robots.txt block)', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    fake.lastCall!.child.emitStdout(
      '{"type":"result","subtype":"success","is_error":true,"result":"API Error: 400 This URL is disallowed by the website\'s robots.txt file."}\n',
    );
    fake.lastCall!.child.exit(1);
    const out = await consume(stream);
    expect(out).toContain('data: {"error":"API Error: 400');
    // done frame still emitted so the client cleanly closes the request
    expect(out).toContain('"done":true');
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

  it('still forwards text_delta within a tool_use → text sequence (text delta regression guard)', async () => {
    const fake = makeFakeSpawn();
    const stream = runClaude(
      { messages: [] },
      new AbortController().signal,
      { spawn: fake.spawn },
    );
    // Tool-use block: content_block_start with tool_use type + input_json_delta chunks.
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Read"}}}\n',
    );
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/foo\\"}"}}}\n',
    );
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}\n',
    );
    // Following text block.
    fake.lastCall!.child.emitStdout(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"after tool"}}}\n',
    );
    fake.lastCall!.child.emitStdout('{"type":"result","subtype":"success"}\n');
    fake.lastCall!.child.exit(0);
    const out = await consume(stream);
    expect(out).toContain('"delta":"after tool"');
  });
});

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
    fake.lastCall!.child.exit(0);
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
    fake.lastCall!.child.exit(0);
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
    fake.lastCall!.child.exit(0);
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
    fake.lastCall!.child.exit(0);
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
    fake.lastCall!.child.exit(0);
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
    fake.lastCall!.child.exit(0);
    const out = await consume(stream);
    const steps = frames(out).filter((e: any) => e.step);
    expect((steps[0] as any).step.label).toBe('도구 결과');
  });
});
