import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';

interface ExtractBody { source?: unknown; }

/**
 * Proxy POST /music/extract → desktop music-service /extract.
 * Auth mirrors /automation/run: client Bearer verified here, then re-Bearer
 * with BRIDGE_SECRET upstream. No artificial timeout — yt-dlp can be slow;
 * the music-service self-limits and we just relay its response.
 */
export async function handleMusicExtract(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	musicServiceUrl: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}
	if (!musicServiceUrl) {
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'music_service_not_configured' }));
		return;
	}
	let body: ExtractBody;
	try {
		body = (await readJson(req)) as ExtractBody;
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}
	const source = typeof body.source === 'string' ? body.source.trim() : '';
	if (!source) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_request', detail: 'missing_source' }));
		return;
	}

	// 백스톱 타임아웃 — music-service 자체 한도(MUSIC_TIMEOUT_MS, 기본 ~180s)보다 넉넉히 위로
	// 잡아, 정상 추출은 절대 끊지 않고 '서비스가 멈춘' 경우에만 발동(소켓 누수 방지). 발동 시
	// AbortError 가 아래 catch 로 떨어져 503 unavailable 로 응답.
	const UPSTREAM_TIMEOUT_MS = 600_000;
	let upstream: Response;
	try {
		upstream = await fetch(`${musicServiceUrl}/extract`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
			body: JSON.stringify({ source }),
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
		});
	} catch (err) {
		console.warn(`[term-bridge music] upstream error: ${(err as Error).message}`);
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'music_service_unavailable' }));
		return;
	}

	const text = await upstream.text();
	res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
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
