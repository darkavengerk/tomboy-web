import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleStatus, buildStatus, defaultProbe, type StatusConfig, type ServiceSpec } from './status.js';
import { mintToken } from './auth.js';

const SECRET = 'test-secret';

function mockReq(headers: Record<string, string>): IncomingMessage {
	return { headers, method: 'GET', url: '/status' } as unknown as IncomingMessage;
}
function mockRes() {
	const writes: string[] = [];
	let status = 0;
	let headers: Record<string, string> = {};
	const res = {
		writeHead: (s: number, h?: Record<string, string>) => {
			status = s;
			headers = { ...headers, ...(h ?? {}) };
			return res;
		},
		end: (b?: string) => {
			if (b) writes.push(b);
		}
	} as unknown as ServerResponse;
	return { res, get: () => ({ status, headers, body: writes.join('') }) };
}

const baseConfig: StatusConfig = {
	secret: SECRET,
	filesDir: '/tmp/__nonexistent_bridge_files__',
	publicBaseUrl: 'https://bridge.example/base',
	port: 3000,
	services: [
		{ name: 'ocr', url: 'http://ocr.test', path: '/status', auth: true },
		{ name: 'music', url: '' },
		{ name: 'rag', url: 'http://rag.test/search' }
	]
};

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

test('401 without Bearer', async () => {
	const { res, get } = mockRes();
	await handleStatus(mockReq({}), res, baseConfig);
	assert.equal(get().status, 401);
	assert.match(get().body, /unauthorized/);
});

test('200 + JSON shape with valid token (probe injected)', async () => {
	const { res, get } = mockRes();
	await handleStatus(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }), res, baseConfig, {
		now: 1_700_000_000_000,
		probe: async (spec: ServiceSpec) => ({
			name: spec.name,
			status: spec.url ? 'up' : 'unconfigured',
			latency_ms: spec.url ? 11 : null
		})
	});
	assert.equal(get().status, 200);
	const body = JSON.parse(get().body);
	assert.equal(body.fetched_at, new Date(1_700_000_000_000).toISOString());
	assert.ok(body.system && typeof body.system.uptime_s === 'number');
	assert.ok(Array.isArray(body.system.load));
	assert.ok(typeof body.bridge.port === 'number');
	assert.equal(body.bridge.public_host, 'bridge.example');
	// 서비스 프로브 결과가 그대로 실린다.
	const names = body.services.map((s: { name: string }) => s.name);
	assert.deepEqual(names, ['ocr', 'music', 'rag']);
	const music = body.services.find((s: { name: string }) => s.name === 'music');
	assert.equal(music.status, 'unconfigured');
	// 없는 디렉터리 → 파일 0개, 에러 없이 진행.
	assert.equal(body.files.count, 0);
	assert.equal(body.files.latest_mtime, null);
	// connections 필드 존재.
	assert.ok(typeof body.connections.spectator_sessions === 'number');
});

test('buildStatus calls probe once per service with secret', async () => {
	const seen: Array<{ name: string; secret: string }> = [];
	const status = await buildStatus(baseConfig, {
		probe: async (spec, secret) => {
			seen.push({ name: spec.name, secret });
			return { name: spec.name, status: 'down', latency_ms: null };
		}
	});
	assert.equal(seen.length, 3);
	assert.deepEqual(
		seen.map((s) => s.name),
		['ocr', 'music', 'rag']
	);
	assert.ok(seen.every((s) => s.secret === SECRET));
	assert.equal(status.services.length, 3);
});

test('defaultProbe: empty url → unconfigured, no fetch', async () => {
	let called = false;
	globalThis.fetch = (async () => {
		called = true;
		return new Response('{}');
	}) as typeof fetch;
	const r = await defaultProbe({ name: 'x', url: '' }, SECRET);
	assert.equal(r.status, 'unconfigured');
	assert.equal(r.latency_ms, null);
	assert.equal(called, false);
});

test('defaultProbe: any HTTP response → up (even 404), auth header when asked', async () => {
	let calledUrl = '';
	let auth = '';
	globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
		calledUrl = String(u);
		auth = ((init?.headers ?? {}) as Record<string, string>)['Authorization'] ?? '';
		return new Response('not found', { status: 404 });
	}) as typeof fetch;
	const r = await defaultProbe({ name: 'ocr', url: 'http://ocr.test/', path: '/status', auth: true }, SECRET);
	assert.equal(r.status, 'up');
	assert.equal(typeof r.latency_ms, 'number');
	assert.equal(calledUrl, 'http://ocr.test/status');
	assert.equal(auth, `Bearer ${SECRET}`);
});

test('defaultProbe: network error → down', async () => {
	globalThis.fetch = (async () => {
		throw new Error('ECONNREFUSED');
	}) as typeof fetch;
	const r = await defaultProbe({ name: 'music', url: 'http://music.test' }, SECRET);
	assert.equal(r.status, 'down');
	assert.equal(r.latency_ms, null);
});
