import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

interface RunBody {
  command?: unknown;
}

/**
 * Proxy POST /automation/run → desktop automation-service.
 * Auth mirrors /ocr: client Bearer (minted by /login) verified here, then
 * re-Bearer with BRIDGE_SECRET (== service BRIDGE_SHARED_TOKEN) upstream.
 */
export async function handleAutomationRun(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string,
  automationServiceUrl: string
): Promise<void> {
  const token = extractBearer(req.headers.authorization);
  if (!verifyToken(secret, token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (!automationServiceUrl) {
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
  const command = typeof body.command === 'string' ? body.command : '';
  if (!command) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_request', detail: 'missing_command' }));
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${automationServiceUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ command })
    });
  } catch (err) {
    console.warn(`[term-bridge automation] upstream error: ${(err as Error).message}`);
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'automation_service_unavailable' }));
    return;
  }

  const text = await upstream.text();
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json'
  });
  res.end(text);
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
