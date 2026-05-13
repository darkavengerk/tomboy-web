import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

const RAG_SEARCH_URL =
	process.env.RAG_SEARCH_URL || 'http://localhost:8743/search';

interface RagSearchBody {
	query?: unknown;
	k?: unknown;
}

export async function handleRagSearch(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	let body: RagSearchBody;
	try {
		body = (await readJson(req)) as RagSearchBody;
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}

	const query = typeof body.query === 'string' ? body.query : '';
	if (!query || query.length > 8192) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_query' }));
		return;
	}

	const kRaw = typeof body.k === 'number' ? body.k : parseInt(String(body.k ?? '5'), 10);
	const k = Math.min(Math.max(Number.isFinite(kRaw) ? kRaw : 5, 1), 20);

	const abortCtrl = new AbortController();
	req.on('close', () => abortCtrl.abort());

	let upstream: Response;
	try {
		upstream = await fetch(RAG_SEARCH_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query, k }),
			signal: abortCtrl.signal
		});
	} catch (err) {
		const e = err as { code?: string; name?: string; message?: string; cause?: { code?: string } };
		if (e.name === 'AbortError' || abortCtrl.signal.aborted) {
			return;
		}
		if (
			e.code === 'ECONNREFUSED' ||
			e.cause?.code === 'ECONNREFUSED' ||
			(e.name === 'TypeError' && /fetch failed/i.test(e.message ?? ''))
		) {
			console.log(`[term-bridge rag] rag_unavailable q.len=${query.length}`);
			res.writeHead(503, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'rag_unavailable' }));
			return;
		}
		console.log(`[term-bridge rag] fetch_failed msg=${e.message}`);
		res.writeHead(502, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'upstream_error' }));
		return;
	}

	if (upstream.status >= 500) {
		console.log(`[term-bridge rag] upstream_${upstream.status}`);
		res.writeHead(502, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'upstream_error', status: upstream.status }));
		return;
	}
	if (!upstream.ok) {
		res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
		const text = await upstream.text();
		res.end(text);
		return;
	}

	const text = await upstream.text();
	let hits: unknown = [];
	try {
		hits = JSON.parse(text);
	} catch {
		hits = [];
	}
	const hitCount = Array.isArray(hits) ? hits.length : 0;
	console.log(`[term-bridge rag] ok q.len=${query.length} k=${k} hits=${hitCount}`);
	res.writeHead(200, { 'Content-Type': 'application/json' });
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
