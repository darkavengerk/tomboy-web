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
