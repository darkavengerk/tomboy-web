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
