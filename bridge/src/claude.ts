import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

interface ClaudeBody {
	messages?: unknown;
	model?: unknown;
	system?: unknown;
	cwd?: unknown;
	allowedTools?: unknown;
}

/**
 * Proxy POST /claude/chat → desktop claude-service.
 *
 * - Auth: client must present a Bearer token minted by /login (same secret as
 *   other bridge endpoints).
 * - Forwarding: re-Bearer with `BRIDGE_SECRET`. The claude-service is expected
 *   to be configured so its `BRIDGE_SHARED_TOKEN` == this bridge's `BRIDGE_SECRET`.
 * - Streaming: the upstream response body is piped verbatim (SSE pass-through)
 *   so the client gets tokens as they arrive.
 * - Client disconnect: an AbortController aborts the upstream fetch so the
 *   claude-service stops generating.
 * - Upstream-down: returns 503 with `{error:'claude_service_unavailable'}`.
 * - Not-configured: returns 503 with `{error:'claude_service_not_configured'}`
 *   when CLAUDE_SERVICE_URL is empty so the bridge still boots without the
 *   service running.
 */
export async function handleClaudeChat(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	claudeServiceUrl: string,
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	if (!claudeServiceUrl) {
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'claude_service_not_configured' }));
		return;
	}

	let body: ClaudeBody;
	try {
		body = (await readJson(req)) as ClaudeBody;
	} catch (err) {
		const detail = (err as Error).message;
		const status = detail === 'body too large' ? 413 : 400;
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: status === 413 ? 'payload_too_large' : 'bad_json' }));
		return;
	}

	if (!Array.isArray(body.messages)) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_request', detail: 'messages must be an array' }));
		return;
	}

	const ctrl = new AbortController();
	// Watch the RESPONSE socket for disconnect, not req.
	// `req.on('close')` fires as soon as the request body is fully read,
	// which for a small JSON POST happens immediately — before we've even
	// started the upstream fetch. Aborting on req close kills upstream
	// before claude-service can produce any output. Use res.on('close')
	// instead — only fires on actual client disconnect.
	const onClose = (): void => {
		if (!res.writableEnded) ctrl.abort();
	};
	res.on('close', onClose);

	let upstream: Response;
	try {
		upstream = await fetch(`${claudeServiceUrl}/chat`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${secret}`,
			},
			body: JSON.stringify(body),
			signal: ctrl.signal,
		});
	} catch (err) {
		if (ctrl.signal.aborted) {
			// client already disconnected — no response to write
			res.off('close', onClose);
			return;
		}
		console.warn(`[term-bridge claude] upstream error: ${(err as Error).message}`);
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'claude_service_unavailable' }));
		res.off('close', onClose);
		return;
	}

	const ct = upstream.headers.get('content-type') ?? 'application/json';
	res.writeHead(upstream.status, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });

	if (!upstream.body) {
		res.end();
		res.off('close', onClose);
		return;
	}

	const reader = upstream.body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!res.write(Buffer.from(value))) {
				await new Promise<void>((r) => res.once('drain', r));
			}
		}
	} catch {
		// upstream stream errored or aborted mid-stream — close gracefully
	} finally {
		res.end();
		reader.releaseLock();
		res.off('close', onClose);
	}
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	const MAX = 2 * 1024 * 1024; // 2 MiB — claude payloads are text/URLs, not base64 images
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
