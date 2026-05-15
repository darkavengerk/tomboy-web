import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mintToken } from './auth.js';
import { handleGpuStatus } from './gpu.js';

const SECRET = 'test-secret';
const OCR_URL = 'http://ocr.test';
const OLLAMA_URL = 'http://ollama.test';

function mockReq(headers: Record<string, string>): IncomingMessage {
	const r = Readable.from([]) as unknown as IncomingMessage;
	(r as { headers: Record<string, string> }).headers = headers;
	(r as { method: string }).method = 'GET';
	return r;
}

function mockRes(): {
	res: ServerResponse;
	get: () => { status: number; headers: Record<string, string>; body: unknown };
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
	return {
		res,
		get: () => {
			const raw = writes.join('');
			let parsed: unknown = null;
			try {
				parsed = raw ? JSON.parse(raw) : null;
			} catch {
				parsed = raw;
			}
			return { status, headers, body: parsed };
		}
	};
}

// Save the real fetch so each test can restore it.
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

test('handleGpuStatus: 401 without Bearer', async () => {
	const { res, get } = mockRes();
	await handleGpuStatus(mockReq({}), res, SECRET, OCR_URL, OLLAMA_URL);
	assert.equal(get().status, 401);
	assert.deepEqual(get().body, { error: 'unauthorized' });
});

test('handleGpuStatus: 401 with malformed Bearer token', async () => {
	const { res, get } = mockRes();
	await handleGpuStatus(
		mockReq({ authorization: 'Bearer not-a-real-token' }),
		res,
		SECRET,
		OCR_URL,
		OLLAMA_URL
	);
	assert.equal(get().status, 401);
});

test('handleGpuStatus: merges all three upstreams when healthy', async () => {
	const token = mintToken(SECRET);
	const calls: string[] = [];
	// expires_at = 5 minutes from now → idle ≈ 0
	const expiresAt = new Date(Date.now() + 300_000).toISOString();
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const s = String(url);
		calls.push(s);
		const auth = ((init?.headers ?? {}) as Record<string, string>)['Authorization'] ?? '';
		if (s === `${OCR_URL}/gpu/raw`) {
			assert.equal(auth, `Bearer ${SECRET}`);
			return new Response(
				JSON.stringify({
					available: true,
					total_mb: 10240,
					used_mb: 4000,
					free_mb: 6240,
					processes: [{ pid: 1234, name: 'ollama', vram_mb: 1700 }]
				}),
				{ status: 200 }
			);
		}
		if (s === `${OCR_URL}/status`) {
			assert.equal(auth, `Bearer ${SECRET}`);
			return new Response(
				JSON.stringify({ loaded: true, last_called_at: Date.now() / 1000 - 10, in_flight: 0 }),
				{ status: 200 }
			);
		}
		if (s === `${OLLAMA_URL}/api/ps`) {
			return new Response(
				JSON.stringify({
					models: [
						{
							name: 'exaone3.5:2.4b',
							size_vram: 1700 * 1024 * 1024,
							expires_at: expiresAt
						}
					]
				}),
				{ status: 200 }
			);
		}
		throw new Error(`unexpected ${s}`);
	}) as typeof fetch;

	const { res, get } = mockRes();
	await handleGpuStatus(
		mockReq({ authorization: `Bearer ${token}` }),
		res,
		SECRET,
		OCR_URL,
		OLLAMA_URL
	);
	const out = get();
	assert.equal(out.status, 200);
	assert.equal(out.headers['Content-Type'], 'application/json');
	const body = out.body as {
		vram: { total_mb: number; used_mb: number; free_mb: number } | null;
		models: Array<Record<string, unknown>>;
		processes: Array<Record<string, unknown>>;
		ollama_available: boolean;
		ocr_available: boolean;
		gpu_available: boolean;
		fetched_at: string;
	};
	assert.deepEqual(body.vram, { total_mb: 10240, used_mb: 4000, free_mb: 6240 });
	assert.equal(body.gpu_available, true);
	assert.equal(body.ollama_available, true);
	assert.equal(body.ocr_available, true);
	assert.equal(body.processes.length, 1);
	assert.deepEqual(body.processes[0], { pid: 1234, name: 'ollama', vram_mb: 1700 });

	const ollamaModel = body.models.find(
		(m) => m.backend === 'ollama' && m.name === 'exaone3.5:2.4b'
	);
	assert.ok(ollamaModel, 'expected ollama model in models[]');
	assert.equal(ollamaModel!.size_mb, 1700);
	assert.equal(ollamaModel!.unloadable, true);
	assert.ok(typeof ollamaModel!.idle_for_s === 'number');
	// idle ≈ 0 (expires_at is now + 300s, so last_used ≈ now)
	assert.ok((ollamaModel!.idle_for_s as number) >= 0);
	assert.ok((ollamaModel!.idle_for_s as number) < 2);

	const ocrModel = body.models.find(
		(m) => m.backend === 'ocr' && m.name === 'got-ocr2'
	);
	assert.ok(ocrModel, 'expected ocr model in models[]');
	assert.equal(ocrModel!.unloadable, true);
	assert.ok((ocrModel!.idle_for_s as number) >= 9 && (ocrModel!.idle_for_s as number) <= 12);

	// fetched_at is ISO8601-ish
	assert.match(body.fetched_at, /^\d{4}-\d{2}-\d{2}T/);

	// All three upstreams were called
	assert.equal(calls.length, 3);
});

test('handleGpuStatus: graceful degrade on partial failure (ollama down)', async () => {
	const token = mintToken(SECRET);
	globalThis.fetch = (async (url: string | URL | Request) => {
		const s = String(url);
		if (s.startsWith(OLLAMA_URL)) throw new Error('ECONNREFUSED');
		if (s === `${OCR_URL}/gpu/raw`) {
			return new Response(
				JSON.stringify({
					available: true,
					total_mb: 10240,
					used_mb: 0,
					free_mb: 10240,
					processes: []
				}),
				{ status: 200 }
			);
		}
		if (s === `${OCR_URL}/status`) {
			return new Response(
				JSON.stringify({ loaded: false, last_called_at: 0, in_flight: 0 }),
				{ status: 200 }
			);
		}
		throw new Error(`unexpected ${s}`);
	}) as typeof fetch;

	const { res, get } = mockRes();
	await handleGpuStatus(
		mockReq({ authorization: `Bearer ${token}` }),
		res,
		SECRET,
		OCR_URL,
		OLLAMA_URL
	);
	const out = get();
	assert.equal(out.status, 200);
	const body = out.body as {
		vram: { total_mb: number } | null;
		models: Array<Record<string, unknown>>;
		ollama_available: boolean;
		ocr_available: boolean;
		gpu_available: boolean;
	};
	assert.equal(body.ollama_available, false);
	assert.equal(body.ocr_available, true);
	assert.equal(body.gpu_available, true);
	assert.ok(body.vram, 'vram should still be present');
	assert.equal(body.vram!.total_mb, 10240);
	// No ollama models, and ocr is not loaded → empty models list
	assert.equal(body.models.length, 0);
});

test('handleGpuStatus: graceful degrade when all upstreams fail', async () => {
	const token = mintToken(SECRET);
	globalThis.fetch = (async () => {
		throw new Error('network unreachable');
	}) as typeof fetch;

	const { res, get } = mockRes();
	await handleGpuStatus(
		mockReq({ authorization: `Bearer ${token}` }),
		res,
		SECRET,
		OCR_URL,
		OLLAMA_URL
	);
	const out = get();
	assert.equal(out.status, 200);
	const body = out.body as {
		vram: unknown;
		models: unknown[];
		processes: unknown[];
		ollama_available: boolean;
		ocr_available: boolean;
		gpu_available: boolean;
	};
	assert.equal(body.vram, null);
	assert.deepEqual(body.models, []);
	assert.deepEqual(body.processes, []);
	assert.equal(body.ollama_available, false);
	assert.equal(body.ocr_available, false);
	assert.equal(body.gpu_available, false);
});

test('handleGpuStatus: ocr model marked unloadable=false when in_flight>0', async () => {
	const token = mintToken(SECRET);
	globalThis.fetch = (async (url: string | URL | Request) => {
		const s = String(url);
		if (s === `${OCR_URL}/gpu/raw`) {
			return new Response(
				JSON.stringify({ available: false, reason: 'no_gpu' }),
				{ status: 200 }
			);
		}
		if (s === `${OCR_URL}/status`) {
			return new Response(
				JSON.stringify({ loaded: true, last_called_at: Date.now() / 1000, in_flight: 1 }),
				{ status: 200 }
			);
		}
		if (s === `${OLLAMA_URL}/api/ps`) {
			return new Response(JSON.stringify({ models: [] }), { status: 200 });
		}
		throw new Error(`unexpected ${s}`);
	}) as typeof fetch;

	const { res, get } = mockRes();
	await handleGpuStatus(
		mockReq({ authorization: `Bearer ${token}` }),
		res,
		SECRET,
		OCR_URL,
		OLLAMA_URL
	);
	const body = get().body as {
		vram: unknown;
		gpu_available: boolean;
		models: Array<Record<string, unknown>>;
	};
	// gpu_raw said available=false, so vram is null and gpu_available is false
	// even though the /gpu/raw call itself succeeded.
	assert.equal(body.vram, null);
	assert.equal(body.gpu_available, false);
	const ocrModel = body.models.find((m) => m.backend === 'ocr');
	assert.ok(ocrModel);
	assert.equal(ocrModel!.unloadable, false);
});
