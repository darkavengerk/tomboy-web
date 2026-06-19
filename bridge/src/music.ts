import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';
import { fetchSunoPlaylist } from './suno.js';

interface MusicBody { source?: unknown; }
interface SunoBody { url?: unknown; }

/** POST /music/extract → desktop music-service /extract (yt-dlp 다운로드, 느림).
 *  600 s 백스톱 — music-service 자체 한도(MUSIC_TIMEOUT_MS, 기본 ~180 s)보다 넉넉히 위로 잡아
 *  정상 추출은 절대 끊지 않고 서비스가 멈춘 경우에만 발동(소켓 누수 방지). 발동 시
 *  AbortError 가 proxyMusic 의 catch 로 떨어져 503 unavailable 로 응답. */
export async function handleMusicExtract(req: IncomingMessage, res: ServerResponse, secret: string, musicServiceUrl: string): Promise<void> {
	return proxyMusic(req, res, secret, musicServiceUrl, '/extract', 600_000);
}

/** POST /music/enumerate → desktop music-service /enumerate (열거만, 빠름). */
export async function handleMusicEnumerate(req: IncomingMessage, res: ServerResponse, secret: string, musicServiceUrl: string): Promise<void> {
	return proxyMusic(req, res, secret, musicServiceUrl, '/enumerate', 120_000);
}

/** POST /music/chapters → desktop music-service /chapters (풀 영상 다운+분할, 느림).
 *  /extract 와 동일하게 600 s 백스톱 — 긴 영상 통째 다운로드를 끊지 않도록. */
export async function handleMusicChapters(req: IncomingMessage, res: ServerResponse, secret: string, musicServiceUrl: string): Promise<void> {
	return proxyMusic(req, res, secret, musicServiceUrl, '/chapters', 600_000);
}

/**
 * 음악 서비스 공통 프록시. 클라 Bearer 검증 후 BRIDGE_SECRET 으로 재-Bearer 하여
 * upstream path 로 릴레이하고 응답을 그대로 파이프. /automation/run 패턴과 동일.
 */
async function proxyMusic(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	musicServiceUrl: string,
	path: string,
	timeoutMs: number
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
	let body: MusicBody;
	try {
		body = (await readJson(req)) as MusicBody;
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
	let upstream: Response;
	try {
		upstream = await fetch(`${musicServiceUrl}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
			body: JSON.stringify({ source }),
			signal: AbortSignal.timeout(timeoutMs)
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

/** POST /music/suno → 브릿지가 직접 Suno 공개 재생목록을 읽어 트랙 목록 반환(데스크탑 미경유). */
export async function handleSunoPlaylist(req: IncomingMessage, res: ServerResponse, secret: string, maxPlaylist = 100): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}
	let body: SunoBody;
	try {
		body = (await readJson(req)) as SunoBody;
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}
	const url = typeof body.url === 'string' ? body.url.trim() : '';
	if (!url) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_request', detail: 'missing_url' }));
		return;
	}
	try {
		const result = await fetchSunoPlaylist(url, { maxPlaylist });
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(result));
	} catch (err) {
		const msg = (err as Error).message ?? '';
		if (msg.startsWith('bad_request')) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'bad_request' }));
			return;
		}
		console.warn(`[term-bridge suno] error: ${msg}`);
		res.writeHead(502, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'upstream_error' }));
	}
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
