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
  constructor(
    public kind: ClaudeChatErrorKind,
    public detail?: string,
  ) {
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

export interface SendClaudeResult {
  reason: 'done' | 'abort';
}

export interface SendClaudeOpts {
  url: string;
  token: string;
  body: ClaudeChatBody;
  onToken: (delta: string) => void;
  onStep?: (step: ThinkingStep) => void;
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
    const kind =
      STATUS_TO_KIND[res.status] ?? (res.status >= 500 ? 'upstream_error' : 'bad_request');
    let detail: string | undefined;
    try {
      const text = await res.text();
      detail = text.slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new ClaudeChatError(kind, detail);
  }

  // Parse SSE stream: each event is "data: <json>\n\n"
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
          // malformed event line — skip silently
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
