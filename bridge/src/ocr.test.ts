import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleOcrProxy } from './ocr.js';
import { mintToken } from './auth.js';

const SECRET = 'test-secret';
const OCR_URL = 'http://ocr.test';

function mockReq(headers: Record<string, string>, body: object | string): IncomingMessage {
	const raw = typeof body === 'string' ? body : JSON.stringify(body);
	// `for await (chunk of req)` in readJson treats `chunk as Buffer`, so feed Buffers.
	const r = Readable.from([Buffer.from(raw, 'utf8')]) as unknown as IncomingMessage;
	(r as { headers: Record<string, string> }).headers = headers;
	(r as { method: string }).method = 'POST';
	return r;
}

function mockRes(): {
	res: ServerResponse;
	get: () => { status: number; headers: Record<string, string>; body: string };
} {
	const writes: string[] = [];
	let status = 0;
	let headers: Record<string, string> = {};
	const res = {
		writeHead: (s: number, h?: Record<string, string>) => {
			status = s;
			headers = { ...headers, ...(h ?? {}) };
			return res;
		},
		end: (body?: string) => {
			if (body) writes.push(body);
		},
		setHeader: (k: string, v: string) => {
			headers[k] = v;
		}
	} as unknown as ServerResponse;
	return { res, get: () => ({ status, headers, body: writes.join('') }) };
}

// Save the real fetch so each test can restore it.
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

test('handleOcrProxy: 401 without Bearer', async () => {
	const { res, get } = mockRes();
	const req = mockReq({}, { image_b64: 'abc' });
	await handleOcrProxy(req, res, SECRET, OCR_URL);
	assert.equal(get().status, 401);
	assert.match(get().body, /unauthorized/);
});

test('handleOcrProxy: 401 with malformed Bearer token', async () => {
	const { res, get } = mockRes();
	const req = mockReq({ authorization: 'Bearer not-a-real-token' }, { image_b64: 'abc' });
	await handleOcrProxy(req, res, SECRET, OCR_URL);
	assert.equal(get().status, 401);
});

test('handleOcrProxy: 400 on missing image_b64 (does not call upstream)', async () => {
	let fetchCalled = false;
	globalThis.fetch = (async () => {
		fetchCalled = true;
		return new Response('{}', { status: 200 });
	}) as typeof fetch;
	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	const req = mockReq({ authorization: `Bearer ${token}` }, {});
	await handleOcrProxy(req, res, SECRET, OCR_URL);
	assert.equal(get().status, 400);
	assert.match(get().body, /missing_image_b64/);
	assert.equal(fetchCalled, false);
});

test('handleOcrProxy: 400 on malformed JSON body', async () => {
	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	const req = mockReq({ authorization: `Bearer ${token}` }, '{not-json');
	await handleOcrProxy(req, res, SECRET, OCR_URL);
	assert.equal(get().status, 400);
	assert.match(get().body, /bad_json/);
});

test('handleOcrProxy: forwards to upstream with re-Bearer and pipes response', async () => {
	let calledUrl = '';
	let calledAuth = '';
	let calledBody = '';
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		calledUrl = String(url);
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calledAuth = headers['Authorization'] ?? headers['authorization'] ?? '';
		calledBody = typeof init?.body === 'string' ? init.body : '';
		return new Response(JSON.stringify({ text: 'hello world' }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}) as typeof fetch;

	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	const req = mockReq(
		{ authorization: `Bearer ${token}` },
		{ image_b64: 'abc' }
	);
	await handleOcrProxy(req, res, SECRET, OCR_URL);
	assert.equal(get().status, 200);
	assert.match(get().body, /hello world/);
	assert.equal(calledUrl, 'http://ocr.test/ocr');
	// Bridge re-bearers with its own secret, NOT the client's minted token.
	assert.equal(calledAuth, `Bearer ${SECRET}`);
	assert.deepEqual(JSON.parse(calledBody), { image_b64: 'abc' });
	assert.equal(get().headers['Content-Type'], 'application/json');
});

test('handleOcrProxy: propagates upstream non-200 status (e.g. 503 model_busy)', async () => {
	globalThis.fetch = (async () => {
		return new Response(JSON.stringify({ error: 'model_busy' }), {
			status: 503,
			headers: { 'content-type': 'application/json' }
		});
	}) as typeof fetch;

	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	const req = mockReq(
		{ authorization: `Bearer ${token}` },
		{ image_b64: 'abc' }
	);
	await handleOcrProxy(req, res, SECRET, OCR_URL);
	assert.equal(get().status, 503);
	assert.match(get().body, /model_busy/);
});

test('handleOcrProxy: 503 on upstream network error', async () => {
	globalThis.fetch = (async () => {
		throw new Error('ECONNREFUSED');
	}) as typeof fetch;

	const token = mintToken(SECRET);
	const { res, get } = mockRes();
	const req = mockReq(
		{ authorization: `Bearer ${token}` },
		{ image_b64: 'abc' }
	);
	await handleOcrProxy(req, res, SECRET, OCR_URL);
	assert.equal(get().status, 503);
	assert.match(get().body, /ocr_service_unavailable/);
});
