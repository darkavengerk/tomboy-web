import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleMusicExtract, handleMusicEnumerate, handleSunoPlaylist } from './music.js';
import { mintToken } from './auth.js';

const SECRET = 'test-secret';
const URL_ = 'http://music.test';

function mockReq(headers: Record<string, string>, body: object | string): IncomingMessage {
	const raw = typeof body === 'string' ? body : JSON.stringify(body);
	const r = Readable.from([Buffer.from(raw, 'utf8')]) as unknown as IncomingMessage;
	(r as { headers: Record<string, string> }).headers = headers;
	(r as { method: string }).method = 'POST';
	return r;
}
function mockRes() {
	const writes: string[] = []; let status = 0; let headers: Record<string, string> = {};
	const res = {
		writeHead: (s: number, h?: Record<string, string>) => { status = s; headers = { ...headers, ...(h ?? {}) }; return res; },
		end: (b?: string) => { if (b) writes.push(b); }
	} as unknown as ServerResponse;
	return { res, get: () => ({ status, headers, body: writes.join('') }) };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('401 without Bearer', async () => {
	const { res, get } = mockRes();
	await handleMusicExtract(mockReq({}, { source: 'x' }), res, SECRET, URL_);
	assert.equal(get().status, 401);
});

test('400 on missing source (no upstream call)', async () => {
	let called = false;
	globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicExtract(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, {}), res, SECRET, URL_);
	assert.equal(get().status, 400);
	assert.equal(called, false);
});

test('503 when service url not configured', async () => {
	const { res, get } = mockRes();
	await handleMusicExtract(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: 'x' }), res, SECRET, '');
	assert.equal(get().status, 503);
	assert.match(get().body, /not_configured/);
});

test('forwards to upstream with re-Bearer and pipes response', async () => {
	let calledUrl = '', calledAuth = '', calledBody = '';
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		calledUrl = String(url);
		calledAuth = ((init?.headers ?? {}) as Record<string, string>)['Authorization'] ?? '';
		calledBody = typeof init?.body === 'string' ? init.body : '';
		return new Response(JSON.stringify({ url: 'http://b/files/x/y.mp3', title: 'Y' }), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicExtract(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: 'https://yt/abc' }), res, SECRET, URL_);
	assert.equal(get().status, 200);
	assert.equal(calledUrl, 'http://music.test/extract');
	assert.equal(calledAuth, `Bearer ${SECRET}`);
	assert.deepEqual(JSON.parse(calledBody), { source: 'https://yt/abc' });
	assert.match(get().body, /y\.mp3/);
});

test('503 on upstream network error', async () => {
	globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicExtract(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: 'x' }), res, SECRET, URL_);
	assert.equal(get().status, 503);
	assert.match(get().body, /unavailable/);
});

test('400 on malformed JSON body (no upstream call)', async () => {
	let called = false;
	globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicExtract(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, 'not-json'), res, SECRET, URL_);
	assert.equal(get().status, 400);
	assert.equal(called, false);
});

test('400 on whitespace-only source (no upstream call)', async () => {
	let called = false;
	globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicExtract(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: '   ' }), res, SECRET, URL_);
	assert.equal(get().status, 400);
	assert.equal(called, false);
});

test('enumerate: 401 without Bearer', async () => {
	const { res, get } = mockRes();
	await handleMusicEnumerate(mockReq({}, { source: 'x' }), res, SECRET, URL_);
	assert.equal(get().status, 401);
});

test('enumerate: 503 when service url not configured', async () => {
	const { res, get } = mockRes();
	await handleMusicEnumerate(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: 'x' }), res, SECRET, '');
	assert.equal(get().status, 503);
	assert.match(get().body, /not_configured/);
});

test('enumerate: forwards to /enumerate with re-Bearer and pipes response', async () => {
	let calledUrl = '', calledAuth = '', calledBody = '';
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		calledUrl = String(url);
		calledAuth = ((init?.headers ?? {}) as Record<string, string>)['Authorization'] ?? '';
		calledBody = typeof init?.body === 'string' ? init.body : '';
		return new Response(JSON.stringify({ label: 'L', entries: [{ url: 'https://yt/1', title: 'a' }], total: 1, truncated: false }), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicEnumerate(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: 'https://yt/p?list=PL' }), res, SECRET, URL_);
	assert.equal(get().status, 200);
	assert.equal(calledUrl, 'http://music.test/enumerate');
	assert.equal(calledAuth, `Bearer ${SECRET}`);
	assert.deepEqual(JSON.parse(calledBody), { source: 'https://yt/p?list=PL' });
	assert.match(get().body, /entries/);
});

test('enumerate: 503 on upstream network error', async () => {
	globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicEnumerate(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: 'x' }), res, SECRET, URL_);
	assert.equal(get().status, 503);
	assert.match(get().body, /unavailable/);
});

test('enumerate: 400 on missing source (no upstream call)', async () => {
	let called = false;
	globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicEnumerate(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, {}), res, SECRET, URL_);
	assert.equal(get().status, 400);
	assert.equal(called, false);
});

test('enumerate: 400 on malformed JSON body (no upstream call)', async () => {
	let called = false;
	globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicEnumerate(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, 'not-json'), res, SECRET, URL_);
	assert.equal(get().status, 400);
	assert.equal(called, false);
});

test('enumerate: 400 on whitespace-only source (no upstream call)', async () => {
	let called = false;
	globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleMusicEnumerate(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { source: '   ' }), res, SECRET, URL_);
	assert.equal(get().status, 400);
	assert.equal(called, false);
});

test('suno: 401 without Bearer', async () => {
	const { res, get } = mockRes();
	await handleSunoPlaylist(mockReq({}, { url: 'https://suno.com/playlist/x' }), res, SECRET);
	assert.equal(get().status, 401);
});

test('suno: 400 on missing url (no fetch)', async () => {
	let called = false;
	globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
	const { res, get } = mockRes();
	await handleSunoPlaylist(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, {}), res, SECRET);
	assert.equal(get().status, 400);
	assert.equal(called, false);
});

test('suno: 200 returns tracks from fetchSunoPlaylist', async () => {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const u = String(input);
		if (u.includes('/api/playlist/PL-okay/?page=1'))
			return new Response(JSON.stringify({ name: 'M', num_total_results: 1, playlist_clips: [{ clip: { audio_url: 'https://cdn1.suno.ai/a.mp3', title: 'A' } }] }), { status: 200 });
		return new Response(JSON.stringify({ playlist_clips: [] }), { status: 200 });
	}) as typeof fetch;
	const { res, get } = mockRes();
	await handleSunoPlaylist(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { url: 'https://suno.com/playlist/PL-okay' }), res, SECRET);
	assert.equal(get().status, 200);
	const body = JSON.parse(get().body);
	assert.equal(body.label, 'M');
	assert.deepEqual(body.tracks, [{ url: 'https://cdn1.suno.ai/a.mp3', title: 'A' }]);
});

test('suno: 400 on bad playlist url', async () => {
	const { res, get } = mockRes();
	await handleSunoPlaylist(mockReq({ authorization: `Bearer ${mintToken(SECRET)}` }, { url: 'https://suno.com/song/x' }), res, SECRET);
	assert.equal(get().status, 400);
});
