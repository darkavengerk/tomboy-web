import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

interface Deps {
  secret: string;
  automationServiceUrl: string;
}

type ErrorKind =
  | 'unauthorized'
  | 'automation_unreachable'
  | 'internal';

interface RunBody {
  notebook?: unknown;
}

function sendEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

// rM → Pi inbox 자동 동기화는 리마커블 위 `diary-push.timer`(1분 주기, mtime
// 가드)가 담당. 이 라우트는 데스크탑 OCR 파이프라인을 즉시 깨우는 역할만
// 한다 — 1분 안 기다리고 결과를 보고 싶을 때.
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

  if (!deps.automationServiceUrl) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'automation_service_not_configured' }));
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
      : '';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  const emitError = (kind: ErrorKind, message?: string) => {
    sendEvent(res, 'error', { kind, message });
    res.end();
  };

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

  sendEvent(res, 'done', { notebook });
  res.end();
}
