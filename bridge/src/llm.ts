import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

interface ChatRequestBody {
	model?: unknown;
	options?: Record<string, unknown>;
	messages?: unknown;
	[k: string]: unknown;
}

const MODEL_RE = /^[A-Za-z0-9._:/-]+$/;

export async function handleLlmChat(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string
): Promise<void> {
	// Auth
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	let body: ChatRequestBody;
	try {
		body = (await readJson(req)) as ChatRequestBody;
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}

	const model = typeof body.model === 'string' ? body.model : '';
	if (!model || !MODEL_RE.test(model)) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_request', detail: 'invalid_model' }));
		return;
	}

	const messages = Array.isArray(body.messages) ? body.messages : [];
	if (messages.length === 0) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'empty_messages' }));
		return;
	}

	const msgCount = messages.length;
	const startTs = Date.now();
	console.log(`[term-bridge llm] model=${model} msgs=${msgCount}`);

	const ollamaBody = {
		model,
		messages,
		options: body.options ?? {},
		stream: true
	};

	const abortCtrl = new AbortController();
	req.on('close', () => {
		abortCtrl.abort();
	});

	let upstream: Response;
	try {
		upstream = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(ollamaBody),
			signal: abortCtrl.signal
		});
	} catch (err) {
		const e = err as { code?: string; name?: string; message?: string; cause?: { code?: string } };
		if (
			e.code === 'ECONNREFUSED' ||
			e.cause?.code === 'ECONNREFUSED' ||
			(e.name === 'TypeError' && /fetch failed/i.test(e.message ?? ''))
		) {
			console.log(`[term-bridge llm] error ollama_unavailable model=${model}`);
			res.writeHead(503, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'ollama_unavailable' }));
			return;
		}
		if (e.name === 'AbortError' || abortCtrl.signal.aborted) {
			console.log(`[term-bridge llm] aborted model=${model} (pre-stream)`);
			return; // client already disconnected
		}
		console.log(`[term-bridge llm] error fetch_failed model=${model} msg=${e.message}`);
		res.writeHead(502, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'upstream_error' }));
		return;
	}

	if (upstream.status === 404) {
		console.log(`[term-bridge llm] error model_not_found model=${model}`);
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'model_not_found', model }));
		return;
	}
	if (upstream.status >= 500) {
		console.log(`[term-bridge llm] error upstream_${upstream.status} model=${model}`);
		res.writeHead(502, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'upstream_error', status: upstream.status }));
		return;
	}
	if (!upstream.ok) {
		console.log(`[term-bridge llm] error upstream_${upstream.status} model=${model}`);
		res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'upstream_client_error', status: upstream.status }));
		return;
	}

	res.writeHead(200, {
		'Content-Type': 'application/x-ndjson',
		'Transfer-Encoding': 'chunked',
		'Cache-Control': 'no-cache'
	});

	let frames = 0;
	const decoder = new TextDecoder();
	const reader = upstream.body?.getReader();
	if (!reader) {
		res.end();
		return;
	}

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) {
				res.write(value);
				const text = decoder.decode(value, { stream: true });
				frames += (text.match(/\n/g) ?? []).length;
			}
		}
		res.end();
		const duration = ((Date.now() - startTs) / 1000).toFixed(2);
		console.log(
			`[term-bridge llm] done model=${model} duration=${duration}s frames=${frames}`
		);
	} catch (err) {
		try { res.end(); } catch { /* ignore */ }
		const e = err as { name?: string };
		if (e.name === 'AbortError' || abortCtrl.signal.aborted) {
			console.log(`[term-bridge llm] aborted model=${model} frames=${frames}`);
		} else {
			console.log(`[term-bridge llm] stream_error model=${model} frames=${frames}`);
		}
	}
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	const MAX = 1024 * 1024; // 1 MiB
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
