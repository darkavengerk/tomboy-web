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
    '--include-partial-messages',
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

  interface ClaudeStdoutEvent {
    type?: string;
    // type:'result' subtype: 'success' | 'error_max_turns' | etc.
    subtype?: string;
    // type:'stream_event' carries Anthropic Messages API streaming events.
    event?: {
      type?: string;
      delta?: { type?: string; text?: string };
    };
  }

  const handleEvent = (evt: ClaudeStdoutEvent): void => {
    if (evt.type === 'stream_event' && evt.event) {
      const e = evt.event;
      // Only forward text_delta. Skip thinking_delta (extended thinking is
      // internal), signature_delta, input_json_delta (tool args), and
      // structural events (message_start/stop, content_block_start/stop,
      // message_delta).
      if (
        e.type === 'content_block_delta' &&
        e.delta?.type === 'text_delta' &&
        typeof e.delta.text === 'string'
      ) {
        writeEvent({ delta: e.delta.text });
      }
    } else if (evt.type === 'result') {
      writeEvent({ done: true, reason: evt.subtype ?? 'unknown' });
      done = true;
    }
    // type:'assistant' (cumulative message recap — partial mode emits this
    // after each block completes; forwarding would duplicate text already
    // streamed via text_delta), type:'system', type:'rate_limit_event' →
    // ignore.
  };

  child.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt: ClaudeStdoutEvent;
      try { evt = JSON.parse(line); }
      catch { continue; }
      handleEvent(evt);
    }
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
  });

  // Use 'close' (not 'exit'): 'close' fires after all stdio streams have
  // drained and all 'data' events have been emitted, so we don't race the
  // final result event. Also flush any trailing partial line that didn't
  // end with '\n' before deciding "no result seen".
  let exitCode: number | null = null;
  child.on('exit', (code: number | null) => { exitCode = code; });
  child.on('close', () => {
    if (buf.length > 0) {
      const line = buf.trim();
      buf = '';
      if (line) {
        try {
          handleEvent(JSON.parse(line) as ClaudeStdoutEvent);
        } catch { /* ignore non-JSON trailing line */ }
      }
    }
    if (!done && (exitCode ?? 0) !== 0) {
      writeEvent({ error: `claude exit ${exitCode}: ${stderrBuf.trim().slice(-200)}` });
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
