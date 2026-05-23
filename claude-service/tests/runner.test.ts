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

  it('ignores tool_use input_json_delta and structural events (MVP)', async () => {
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
    expect(out).not.toContain('tool_use');
    expect(out).not.toContain('input_json_delta');
    expect(out).not.toContain('content_block_start');
    expect(out).toContain('"delta":"after tool"');
  });
});
