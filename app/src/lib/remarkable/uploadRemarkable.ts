import {
  getDefaultTerminalBridge,
  getTerminalBridgeToken,
  bridgeToHttpBase
} from '$lib/editor/terminal/bridgeSettings.js';

export type RemarkableUploadErrorKind =
  | 'not_configured'
  | 'unauthorized'
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
  step: 'trigger_pipeline';
}

export interface RemarkableUploadResult {
  notebook: string;
}

export interface RemarkableUploadOpts {
  notebook?: string;
  onStatus?: (s: RemarkableUploadStatus) => void;
  signal?: AbortSignal;
}

/**
 * POST /remarkable/upload to the bridge and stream the SSE response.
 * Resolves on `done` event, throws `RemarkableUploadError` on any
 * `error` event, non-200 status, or network failure.
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
  if (opts.notebook !== undefined) body.notebook = opts.notebook;

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

  return await consumeSse(res.body, opts.onStatus, opts.signal);
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onStatus?: (s: RemarkableUploadStatus) => void,
  signal?: AbortSignal
): Promise<RemarkableUploadResult> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done: RemarkableUploadResult | null = null;

  // Cancel the reader if the caller aborts mid-stream (mirrors ollama.ts pattern).
  const onAbort = () => reader.cancel();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { value, done: streamDone } = await reader.read();
      if (value) {
        // Normalize CRLF so frame splitting on '\n\n' works regardless of
        // whether the server sends LF-only or CRLF line endings.
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      }
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
          // Cancel the reader immediately — don't wait for stream close.
          reader.cancel();
          throw new RemarkableUploadError(kind, e.message);
        }
      }
      if (streamDone) break;
      // If aborted, reader.cancel() has already been called via the listener;
      // the next read will return done=true so the loop exits naturally.
      if (signal?.aborted) break;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  if (signal?.aborted) {
    throw new RemarkableUploadError('network', 'aborted');
  }
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
