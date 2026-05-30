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
    | {
        type: 'image';
        source:
          | { type: 'url'; url: string }
          | { type: 'base64'; media_type: string; data: string };
      }
  >;
}

const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_SYSTEM = '당신은 사용자를 돕는 어시스턴트입니다.';

function normalizeEffort(v?: string): string {
  return v && VALID_EFFORTS.includes(v) ? v : 'high';
}

export interface RunRequest {
  messages: AnthropicMessage[];
  model?: string;
  system?: string;
  effort?: string;
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
  args.push('--system-prompt', req.system || DEFAULT_SYSTEM);
  args.push('--exclude-dynamic-system-prompt-sections');
  args.push('--disallowedTools', '*');
  args.push('--effort', normalizeEffort(req.effort));

  const child = spawn('claude', args, {
    cwd: process.env.HOME,
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
    // type:'result' may carry is_error=true alongside subtype='success'
    // when the API call failed (e.g. image URL blocked by robots.txt).
    // In that case `result` holds the user-visible error message.
    is_error?: boolean;
    result?: unknown;
    // type:'stream_event' carries Anthropic Messages API streaming events.
    event?: {
      type?: string;
      index?: number;
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
    };
    // type:'user' carries an Anthropic message echo with tool_result blocks.
    message?: {
      role?: string;
      content?: Array<{ type?: string; tool_use_id?: string; content?: unknown }>;
    };
  }

  // 진행 중인 step의 누적 body와 tool 이름 매핑
  type StepKind = 'thinking' | 'tool_use' | 'tool_result' | 'response_start';
  interface StepState { kind: StepKind; label: string; body: string }
  let currentStep: StepState | null = null;
  const toolNameById = new Map<string, string>();

  const emitStep = (s: StepState): void => {
    writeEvent({ step: { kind: s.kind, label: s.label, body: s.body } });
  };

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
      const reason = evt.subtype ?? 'unknown';
      // API call failed but stream-json wrapped it as a successful result
      // (e.g. image URL blocked by robots.txt). Surface as an explicit
      // error frame so the UI shows it instead of silently appending an
      // empty A: turn. Done frame still follows so the client cleanly
      // ends the request.
      if (evt.is_error) {
        const msg =
          typeof evt.result === 'string' ? evt.result : 'API error';
        process.stderr.write(`[runner] result is_error: ${msg}\n`);
        writeEvent({ error: msg });
      } else if (reason !== 'success') {
        process.stderr.write(`[runner] result subtype=${reason}\n`);
      }
      writeEvent({ done: true, reason });
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
    const s = chunk.toString('utf8');
    stderrBuf += s;
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    process.stderr.write(`[claude stderr] ${s}`);
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
    process.stderr.write(`[runner] close code=${exitCode} done=${done} stderr_bytes=${stderrBuf.length}\n`);
    if (!done && (exitCode ?? 0) !== 0) {
      writeEvent({ error: `claude exit ${exitCode}: ${stderrBuf.trim().slice(-200)}` });
    } else if (!done) {
      writeEvent({ error: 'stream ended without result' });
    }
    finish();
  });

  child.on('error', (err: Error) => {
    process.stderr.write(`[runner] spawn error: ${err.message}\n`);
    writeEvent({ error: `spawn error: ${err.message}` });
    finish();
  });

  return out;
}
