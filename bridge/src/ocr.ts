import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

interface OcrBody {
	image_b64?: unknown;
}

/**
 * Proxy POST /ocr → desktop ocr-service.
 *
 * - Auth: client must present a Bearer token minted by /login (same as the
 *   other bridge endpoints).
 * - Forwarding: re-Bearer with `BRIDGE_SECRET`. The ocr-service is expected
 *   to be configured so its `BRIDGE_SHARED_TOKEN` == this bridge's
 *   `BRIDGE_SECRET`.
 * - Upstream-down: returns 503 with `{error: 'ocr_service_unavailable'}` so
 *   the editor can surface a single localized error and the user knows to
 *   wake the desktop / start the service.
 *
 * Response body and Content-Type are piped from the upstream as-is so any
 * structured error from ocr-service (e.g. 503 model_busy with a JSON body)
 * reaches the client verbatim.
 */
export async function handleOcrProxy(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	ocrServiceUrl: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	let body: OcrBody;
	try {
		body = (await readJson(req)) as OcrBody;
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}

	const imageB64 = typeof body.image_b64 === 'string' ? body.image_b64 : '';
	if (!imageB64) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_request', detail: 'missing_image_b64' }));
		return;
	}

	let upstream: Response;
	try {
		upstream = await fetch(`${ocrServiceUrl}/ocr`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${secret}`
			},
			body: JSON.stringify({ image_b64: imageB64 })
		});
	} catch (err) {
		console.warn(`[term-bridge ocr] upstream error: ${(err as Error).message}`);
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'ocr_service_unavailable' }));
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
	const MAX = 8 * 1024 * 1024; // 8 MiB — base64-encoded page images can be large
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
