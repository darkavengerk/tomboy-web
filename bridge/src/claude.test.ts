import { test, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { Readable } from 'node:stream';
import { handleClaudeChat } from './claude.js';
import { mintToken } from './auth.js';

const SECRET = 'test-secret';
const CLAUDE_URL = 'http://claude.test';

// ---- helpers ----------------------------------------------------------------

function mockReq(headers: Record<string, string>, body: object | string): IncomingMessage {
	const raw = typeof body === 'string' ? body : JSON.stringify(body);
	const r = Readable.from([Buffer.from(raw, 'utf8')]) as unknown as IncomingMessage;
	(r as { headers: Record<string, string> }).headers = headers;
	(r as { method: string }).method = 'POST';
	// Provide a no-op event emitter interface for 'close' listener
	return r;
}

/**
 * Streaming-aware mockRes: captures both write() calls and end().
 * Unlike ocr.test.ts (which only captures end(body)), claude's streaming
 * path calls res.write(chunk) for each upstream chunk followed by res.end().
 */
function mockRes(): {
	res: ServerResponse;
	get: () => { status: number; headers: Record<string, string>; body: string };
} {
	const chunks: Buffer[] = [];
	let status = 0;
	let headers: Record<string, string> = {};
	const res = {
		writeHead: (s: number, h?: Record<string, string>) => {
			status = s;
			headers = { ...headers, ...(h ?? {}) };
			return res;
		},
		write: (chunk: Buffer | string) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
			chunks.push(buf);
			return true; // no backpressure in tests
		},
		end: (body?: string | Buffer) => {
			if (body) {
				const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
				chunks.push(buf);
			}
		},
		once: (_event: string, _cb: () => void) => res,
		on: (_event: string, _cb: () => void) => res,
		off: (_event: string, _cb: () => void) => res,
		writableEnded: false,
		setHeader: (k: string, v: string) => {
			headers[k] = v;
		}
	} as unknown as ServerResponse;
	return { res, get: () => ({ status, headers, body: Buffer.concat(chunks).toString('utf8') }) };
}

// Save the real fetch so each test can restore it.
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

// ---- auth tests -------------------------------------------------------------

test('handleClaudeChat: 401 missing Bearer', async () => {
	const { res, get } = mockRes();
	const req = mockReq({}, { messages: [{ role: 'user', content: 'hi' }] });
	await handleClaudeChat(req, res, SECRET, CLAUDE_URL);
	assert.equal(get().status, 401);
	assert.match(get().body, /unauthorized/);
});

test('handleClaudeChat: 401 wrong Bearer token', async () => {
	const { res, get } = mockRes();
	const badToken = mintToken('wrong-secret');
	const req = mockReq({ authorization: `Bearer ${badToken}` }, { messages: [] });
	await handleClaudeChat(req, res, SECRET, CLAUDE_URL);
	assert.equal(get().status, 401);
	assert.match(get().body, /unauthorized/);
});

// ---- config tests -----------------------------------------------------------

test('handleClaudeChat: 503 when CLAUDE_SERVICE_URL is empty', async () => {
	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	const req = mockReq({ authorization: `Bearer ${token}` }, { messages: [] });
	await handleClaudeChat(req, res, SECRET, '');
	assert.equal(get().status, 503);
	assert.match(get().body, /claude_service_not_configured/);
});

// ---- body validation tests --------------------------------------------------

test('handleClaudeChat: 400 missing messages field', async () => {
	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	const req = mockReq({ authorization: `Bearer ${token}` }, {});
	await handleClaudeChat(req, res, SECRET, CLAUDE_URL);
	assert.equal(get().status, 400);
	assert.match(get().body, /messages must be an array|bad_request/);
});

test('handleClaudeChat: 400 messages not an array', async () => {
	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	const req = mockReq({ authorization: `Bearer ${token}` }, { messages: 'not-array' });
	await handleClaudeChat(req, res, SECRET, CLAUDE_URL);
	assert.equal(get().status, 400);
	assert.match(get().body, /messages must be an array|bad_request/);
});

test('handleClaudeChat: 400 on malformed JSON body', async () => {
	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	const req = mockReq({ authorization: `Bearer ${token}` }, '{not-json');
	await handleClaudeChat(req, res, SECRET, CLAUDE_URL);
	assert.equal(get().status, 400);
	assert.match(get().body, /bad_json/);
});

// ---- upstream proxy tests ---------------------------------------------------

test('handleClaudeChat: 200 SSE pass-through from upstream', async () => {
	// Stub upstream with a fake Response that streams SSE chunks
	const ssePayload = 'data: {"type":"text","text":"hello"}\n\ndata: [DONE]\n\n';
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		assert.equal(String(url), `${CLAUDE_URL}/chat`);
		// Verify re-Bearer with secret
		const auth = ((init?.headers ?? {}) as Record<string, string>)['Authorization'] ?? '';
		assert.equal(auth, `Bearer ${SECRET}`);
		// Verify messages forwarded
		const sentBody = JSON.parse((init?.body as string) ?? '{}');
		assert.ok(Array.isArray(sentBody.messages));

		const encoder = new TextEncoder();
		const chunks = [encoder.encode(ssePayload)];
		let idx = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(ctrl) {
				if (idx < chunks.length) {
					ctrl.enqueue(chunks[idx++]);
				} else {
					ctrl.close();
				}
			}
		});
		return new Response(stream, {
			status: 200,
			headers: { 'content-type': 'text/event-stream' }
		});
	}) as typeof fetch;

	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	const req = mockReq(
		{ authorization: `Bearer ${token}` },
		{ messages: [{ role: 'user', content: 'hi' }] }
	);
	await handleClaudeChat(req, res, SECRET, CLAUDE_URL);
	const out = get();
	assert.equal(out.status, 200);
	assert.match(out.headers['Content-Type'], /event-stream/);
	assert.match(out.body, /hello/);
	assert.match(out.body, /DONE/);
});

test('handleClaudeChat: upstream 5xx is passed through (not swallowed)', async () => {
	globalThis.fetch = (async () => {
		return new Response(JSON.stringify({ error: 'internal' }), {
			status: 502,
			headers: { 'content-type': 'application/json' }
		});
	}) as typeof fetch;

	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	const req = mockReq(
		{ authorization: `Bearer ${token}` },
		{ messages: [{ role: 'user', content: 'hello' }] }
	);
	await handleClaudeChat(req, res, SECRET, CLAUDE_URL);
	assert.equal(get().status, 502);
	assert.match(get().body, /internal/);
});

test('handleClaudeChat: 503 upstream unreachable (fetch throws)', async () => {
	globalThis.fetch = (async () => {
		throw new Error('ECONNREFUSED');
	}) as typeof fetch;

	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	const req = mockReq(
		{ authorization: `Bearer ${token}` },
		{ messages: [{ role: 'user', content: 'hi' }] }
	);
	await handleClaudeChat(req, res, SECRET, CLAUDE_URL);
	assert.equal(get().status, 503);
	assert.match(get().body, /claude_service_unavailable/);
});

// ---- real upstream server SSE test ------------------------------------------

test('handleClaudeChat: 200 SSE pass-through via real HTTP upstream server', async () => {
	const ssePayload = 'data: {"type":"text","text":"streamed"}\n\ndata: [DONE]\n\n';
	let upstreamPort = 0;
	let srv: Server | null = null;

	srv = createServer((req: IncomingMessage, upRes: ServerResponse) => {
		upRes.writeHead(200, { 'content-type': 'text/event-stream' });
		upRes.write(ssePayload);
		upRes.end();
	});

	srv.listen(0);
	await once(srv, 'listening');
	const addr = srv.address();
	upstreamPort = typeof addr === 'object' && addr ? addr.port : 0;
	assert.ok(upstreamPort > 0, 'upstream server failed to start');

	try {
		const claudeUrl = `http://127.0.0.1:${upstreamPort}`;
		const token = mintToken(SECRET);
		const { res, get } = mockRes();
		const req = mockReq(
			{ authorization: `Bearer ${token}` },
			{ messages: [{ role: 'user', content: 'hi' }] }
		);
		await handleClaudeChat(req, res, SECRET, claudeUrl);
		const out = get();
		assert.equal(out.status, 200);
		assert.match(out.headers['Content-Type'], /event-stream/);
		assert.match(out.body, /streamed/);
		assert.match(out.body, /DONE/);
	} finally {
		await new Promise<void>((resolve) => srv!.close(() => resolve()));
	}
});

// ---- body size limit --------------------------------------------------------

test('handleClaudeChat: 413 on body > 16 MiB', async () => {
	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	// Build a body that is just over 16 MiB
	const bigString = 'x'.repeat(16 * 1024 * 1024 + 1);
	const raw = bigString; // raw non-JSON, so body too large check fires first
	const r = Readable.from([Buffer.from(raw, 'utf8')]) as unknown as IncomingMessage;
	(r as { headers: Record<string, string> }).headers = { authorization: `Bearer ${token}` };
	(r as { method: string }).method = 'POST';
	await handleClaudeChat(r, res, SECRET, CLAUDE_URL);
	assert.equal(get().status, 413);
	assert.match(get().body, /payload_too_large/);
});

test('handleClaudeChat: 3 MiB body(base64 이미지 인라인)는 413 아님', async () => {
	// 클라 다운스케일이 이미지들을 base64로 인라인하면 페이로드가 수 MiB가
	// 된다 — 옛 2 MiB 캡이면 payload_too_large로 전송 자체가 죽는다.
	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	const bigString = 'x'.repeat(3 * 1024 * 1024);
	const r = Readable.from([Buffer.from(bigString, 'utf8')]) as unknown as IncomingMessage;
	(r as { headers: Record<string, string> }).headers = { authorization: `Bearer ${token}` };
	(r as { method: string }).method = 'POST';
	await handleClaudeChat(r, res, SECRET, CLAUDE_URL);
	// non-JSON이므로 400 bad_json — 크기 거절(413)만 아니면 통과한 것
	assert.equal(get().status, 400);
	assert.match(get().body, /bad_json/);
});
