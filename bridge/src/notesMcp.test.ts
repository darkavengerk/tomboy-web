import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mintToken } from './auth.js';
import { handleNotesMcp } from './notesMcp.js';
import type { NoteDoc, NotesCreds, NotesStore } from './notesStore.js';

const SECRET = 'test-secret';

function mockReq(headers: Record<string, string>, body: object | string): IncomingMessage {
	const raw = typeof body === 'string' ? body : JSON.stringify(body);
	const r = Readable.from([Buffer.from(raw, 'utf8')]) as unknown as IncomingMessage;
	(r as { headers: Record<string, string> }).headers = headers;
	(r as { method: string }).method = 'POST';
	return r;
}
function mockRes() {
	const writes: string[] = [];
	let status = 0;
	const res = {
		writeHead: (s: number) => { status = s; return res; },
		end: (b?: string) => { if (b) writes.push(b); }
	} as unknown as ServerResponse;
	return { res, get: () => ({ status, body: writes.join('') ? JSON.parse(writes.join('')) : null }) };
}
function auth(): Record<string, string> {
	return { authorization: `Bearer ${mintToken(SECRET)}` };
}
function fakeStore(initial: NoteDoc[] = []): NotesStore {
	const docs = new Map(initial.map((d) => [d.guid, d]));
	return {
		async findByTitle(_c: NotesCreds, title: string) {
			for (const d of docs.values()) if (d.title === title) return structuredClone(d);
			return null;
		},
		async listByNotebook(c: NotesCreds) {
			return [...docs.values()].filter((d) => d.tags.includes(`system:notebook:${c.notebook}`));
		},
		async write(_c: NotesCreds, doc: NoteDoc) { docs.set(doc.guid, structuredClone(doc)); }
	};
}

beforeEach(() => {
	const p = join(mkdtempSync(join(tmpdir(), 'mcp-')), 'creds.json');
	writeFileSync(p, JSON.stringify({ uid: 'dbx-x', notebook: '개발', serviceAccount: { project_id: 'p', client_email: 'e', private_key: 'k' } }));
	process.env.BRIDGE_NOTES_FILE = p;
});

test('401 without auth', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq({}, { jsonrpc: '2.0', id: 1, method: 'initialize' }), res, SECRET, fakeStore());
	assert.equal(get().status, 401);
});

test('initialize', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(
		mockReq(auth(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
		res, SECRET, fakeStore()
	);
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.result.protocolVersion, '2025-06-18');
	assert.equal(r.body.result.serverInfo.name, 'tomboy-worklog');
	assert.ok(r.body.result.capabilities.tools);
});

test('initialize: protocolVersion 미지정 → 기본값 2025-03-26', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq(auth(), { jsonrpc: '2.0', id: 1, method: 'initialize' }), res, SECRET, fakeStore());
	assert.equal(get().body.result.protocolVersion, '2025-03-26');
});

test('notifications/initialized → 202', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq(auth(), { jsonrpc: '2.0', method: 'notifications/initialized' }), res, SECRET, fakeStore());
	assert.equal(get().status, 202);
});

test('notifications/* 임의 메서드 → 202 빈 응답', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq(auth(), { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), res, SECRET, fakeStore());
	const r = get();
	assert.equal(r.status, 202);
	assert.equal(r.body, null);
});

test('ping → {} result', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq(auth(), { jsonrpc: '2.0', id: 42, method: 'ping' }), res, SECRET, fakeStore());
	const r = get();
	assert.equal(r.status, 200);
	assert.deepEqual(r.body.result, {});
});

test('tools/list → 4개', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq(auth(), { jsonrpc: '2.0', id: 2, method: 'tools/list' }), res, SECRET, fakeStore());
	const names = get().body.result.tools.map((t: { name: string }) => t.name);
	assert.deepEqual(names.sort(), ['worklog_append', 'worklog_list', 'worklog_read', 'worklog_write']);
});

test('tools/list 설명에 md 서브셋 규약 + ifChangeDate 안내 포함, 전원 inputSchema 보유', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq(auth(), { jsonrpc: '2.0', id: 2, method: 'tools/list' }), res, SECRET, fakeStore());
	const tools = get().body.result.tools as Array<{ name: string; description: string; inputSchema: unknown }>;
	assert.equal(tools.length, 4);
	for (const t of tools) {
		assert.ok(t.description.length > 0, `${t.name} missing description`);
		assert.ok(/^[\s\S]*[가-힣]/.test(t.description), `${t.name} description should be Korean`);
		assert.ok(t.inputSchema && typeof t.inputSchema === 'object', `${t.name} missing inputSchema`);
	}
	const write = tools.find((t) => t.name === 'worklog_write')!;
	assert.ok(write.description.includes('ifChangeDate'));
	assert.ok(/마크다운 서브셋/.test(write.description));
});

test('tools/call worklog_write → worklog_read 왕복', async () => {
	const store = fakeStore();
	const a = mockRes();
	await handleNotesMcp(
		mockReq(auth(), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'worklog_write', arguments: { title: '[p/b] 작업', markdown: '본문' } } }),
		a.res, SECRET, store
	);
	assert.equal(a.get().status, 200);
	const wrote = JSON.parse(a.get().body.result.content[0].text);
	assert.equal(wrote.created, true);
	const b = mockRes();
	await handleNotesMcp(
		mockReq(auth(), { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'worklog_read', arguments: { title: '[p/b] 작업' } } }),
		b.res, SECRET, store
	);
	const read = JSON.parse(b.get().body.result.content[0].text);
	assert.equal(read.markdown, '본문');
});

test('tools/call 충돌 → isError + 현재 changeDate/본문 동봉', async () => {
	const store = fakeStore();
	const seed = mockRes();
	await handleNotesMcp(
		mockReq(auth(), { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'worklog_write', arguments: { title: '[p/b] 작업', markdown: '원본' } } }),
		seed.res, SECRET, store
	);
	const seededChangeDate = JSON.parse(seed.get().body.result.content[0].text).changeDate;
	const { res, get } = mockRes();
	await handleNotesMcp(
		mockReq(auth(), { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'worklog_write', arguments: { title: '[p/b] 작업', markdown: '충돌' } } }),
		res, SECRET, store
	);
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.result.isError, true);
	const payload = JSON.parse(r.body.result.content[0].text);
	assert.equal(payload.error, 'conflict');
	assert.equal(payload.markdown, '원본');
	assert.equal(payload.changeDate, seededChangeDate);
});

test('tools/call creds 없음 → isError not_configured', async () => {
	delete process.env.BRIDGE_NOTES_FILE;
	const { res, get } = mockRes();
	await handleNotesMcp(
		mockReq(auth(), { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'worklog_list', arguments: {} } }),
		res, SECRET, fakeStore()
	);
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.result.isError, true);
	const payload = JSON.parse(r.body.result.content[0].text);
	assert.equal(payload.error, 'not_configured');
});

test('tools/call 알 수 없는 툴 → JSON-RPC -32602', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(
		mockReq(auth(), { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'nonexistent_tool', arguments: {} } }),
		res, SECRET, fakeStore()
	);
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.error.code, -32602);
});

test('tools/call 스토어 예외(NotesOpError 아님) → isError upstream_failed, crash 없음', async () => {
	const boomStore: NotesStore = {
		async findByTitle() { throw new Error('boom'); },
		async listByNotebook() { return []; },
		async write() { /* unused */ }
	};
	const { res, get } = mockRes();
	await handleNotesMcp(
		mockReq(auth(), { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'worklog_read', arguments: { title: '[p/b] 작업' } } }),
		res, SECRET, boomStore
	);
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.result.isError, true);
	const payload = JSON.parse(r.body.result.content[0].text);
	assert.equal(payload.error, 'upstream_failed');
});

test('unknown method → -32601', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq(auth(), { jsonrpc: '2.0', id: 7, method: 'resources/list' }), res, SECRET, fakeStore());
	assert.equal(get().body.error.code, -32601);
});

test('body 파싱 실패 → -32700 (HTTP 200)', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq(auth(), '{not valid json'), res, SECRET, fakeStore());
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.error.code, -32700);
});

test('body가 JSON null → -32600 invalid request (throw 없이 정상 완료)', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq(auth(), 'null'), res, SECRET, fakeStore());
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.error.code, -32600);
});

test('body가 배열 → -32600 invalid request (기존 accidental -32601 아님)', async () => {
	const { res, get } = mockRes();
	await handleNotesMcp(mockReq(auth(), '[]'), res, SECRET, fakeStore());
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.error.code, -32600);
});
