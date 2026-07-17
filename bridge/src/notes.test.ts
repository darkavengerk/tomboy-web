import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mintToken } from './auth.js';
import { handleNotesRead, handleNotesWrite, handleNotesList, handleNotesAppend } from './notes.js';
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
		writeHead: (s: number) => {
			status = s;
			return res;
		},
		end: (b?: string) => {
			if (b) writes.push(b);
		}
	} as unknown as ServerResponse;
	return { res, get: () => ({ status, body: writes.join('') ? JSON.parse(writes.join('')) : null }) };
}

function auth(): Record<string, string> {
	return { authorization: `Bearer ${mintToken(SECRET)}` };
}

// 인메모리 fake store
function fakeStore(initial: NoteDoc[] = []): NotesStore & { docs: Map<string, NoteDoc> } {
	const docs = new Map(initial.map((d) => [d.guid, d]));
	return {
		docs,
		async findByTitle(_c: NotesCreds, title: string) {
			for (const d of docs.values()) if (d.title === title) return structuredClone(d);
			return null;
		},
		async listByNotebook(c: NotesCreds) {
			return [...docs.values()].filter((d) => d.tags.includes(`system:notebook:${c.notebook}`)).map((d) => structuredClone(d));
		},
		async write(_c: NotesCreds, doc: NoteDoc) {
			docs.set(doc.guid, structuredClone(doc));
		}
	};
}

function makeDoc(over: Partial<NoteDoc>): NoteDoc {
	return {
		guid: 'g1',
		uri: 'note://tomboy/g1',
		title: '[p/b] 작업',
		xmlContent: '<note-content version="0.1">[p/b] 작업\n\n본문</note-content>',
		createDate: '2026-01-01T00:00:00.0000000+00:00',
		changeDate: '2026-01-02T00:00:00.0000000+00:00',
		metadataChangeDate: '2026-01-02T00:00:00.0000000+00:00',
		tags: ['system:notebook:개발'],
		deleted: false,
		public: false,
		...over
	};
}

// 핸들러가 readNotesCreds()를 부르므로 임시 creds 파일 세팅
beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), 'notes-'));
	const p = join(dir, 'creds.json');
	writeFileSync(p, JSON.stringify({ uid: 'dbx-x', notebook: '개발', serviceAccount: { project_id: 'p', client_email: 'e', private_key: 'k' } }));
	process.env.BRIDGE_NOTES_FILE = p;
});

test('401: 토큰 없음', async () => {
	const { res, get } = mockRes();
	await handleNotesRead(mockReq({}, { title: '[p/b] 작업' }), res, SECRET, fakeStore());
	assert.equal(get().status, 401);
});

test('원시 시크릿 Bearer 수락', async () => {
	const { res, get } = mockRes();
	await handleNotesRead(mockReq({ authorization: `Bearer ${SECRET}` }, { title: '[p/b] 작업' }), res, SECRET, fakeStore([makeDoc({})]));
	assert.equal(get().status, 200);
});

test('503: creds 미설정', async () => {
	delete process.env.BRIDGE_NOTES_FILE;
	const { res, get } = mockRes();
	await handleNotesRead(mockReq(auth(), { title: '[p/b] 작업' }), res, SECRET, fakeStore());
	assert.equal(get().status, 503);
	assert.equal(get().body.error, 'not_configured');
});

test('read: 정상 → markdown + changeDate', async () => {
	const { res, get } = mockRes();
	await handleNotesRead(mockReq(auth(), { title: '[p/b] 작업' }), res, SECRET, fakeStore([makeDoc({})]));
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.markdown, '본문');
	assert.equal(r.body.changeDate, '2026-01-02T00:00:00.0000000+00:00');
});

test('read: 제목 가드 위반 → 403', async () => {
	const { res, get } = mockRes();
	await handleNotesRead(mockReq(auth(), { title: '아무 노트' }), res, SECRET, fakeStore());
	assert.equal(get().status, 403);
	assert.equal(get().body.error, 'forbidden_title');
});

test('read: 노트북 태그 없는 문서 → 403 (슬립노트 보호)', async () => {
	const { res, get } = mockRes();
	const store = fakeStore([makeDoc({ title: '[0] Slip-Box', tags: [] })]);
	await handleNotesRead(mockReq(auth(), { title: '[0] Slip-Box' }), res, SECRET, store);
	assert.equal(get().status, 403);
	assert.equal(get().body.error, 'forbidden_notebook');
});

test('read: 없음/톰스톤 → 404', async () => {
	const s = fakeStore([makeDoc({ deleted: true })]);
	const a = mockRes();
	await handleNotesRead(mockReq(auth(), { title: '[p/b] 작업' }), a.res, SECRET, s);
	assert.equal(a.get().status, 404);
	const b = mockRes();
	await handleNotesRead(mockReq(auth(), { title: '[p/b] 없음' }), b.res, SECRET, s);
	assert.equal(b.get().status, 404);
});

test('write 생성: 10필드 완전 + 노트북 태그', async () => {
	const store = fakeStore();
	const { res, get } = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: '## 범위\n- a' }), res, SECRET, store);
	const r = get();
	assert.equal(r.status, 200);
	assert.equal(r.body.created, true);
	const doc = store.docs.get(r.body.guid)!;
	assert.deepEqual(Object.keys(doc).sort(), [
		'changeDate', 'createDate', 'deleted', 'guid', 'metadataChangeDate', 'public', 'tags', 'title', 'uri', 'xmlContent'
	]);
	assert.equal(doc.uri, `note://tomboy/${doc.guid}`);
	assert.deepEqual(doc.tags, ['system:notebook:개발']);
	assert.equal(doc.public, false);
	assert.ok(doc.xmlContent.startsWith('<note-content version="0.1">[p/b] 작업\n\n'));
});

test('write: 제목 내 개행 → 403 (TITLE_RE 앵커링, guard hole 회귀)', async () => {
	const store = fakeStore();
	const a = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p] x\n두번째줄', markdown: 'x' }), a.res, SECRET, store);
	assert.equal(a.get().status, 403);
	assert.equal(a.get().body.error, 'forbidden_title');
	const b = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p\nq] x', markdown: 'x' }), b.res, SECRET, store);
	assert.equal(b.get().status, 403);
	assert.equal(b.get().body.error, 'forbidden_title');
});

test('write 갱신: ifChangeDate 일치 → 성공, guid/createDate/tags 보존', async () => {
	const store = fakeStore([makeDoc({ tags: ['system:notebook:개발', 'system:pinned'] })]);
	const { res, get } = mockRes();
	await handleNotesWrite(
		mockReq(auth(), { title: '[p/b] 작업', markdown: '새 본문', ifChangeDate: '2026-01-02T00:00:00.0000000+00:00' }),
		res, SECRET, store
	);
	assert.equal(get().status, 200);
	const doc = store.docs.get('g1')!;
	assert.equal(doc.createDate, '2026-01-01T00:00:00.0000000+00:00');
	assert.deepEqual(doc.tags, ['system:notebook:개발', 'system:pinned']);
	assert.ok(doc.xmlContent.includes('새 본문'));
	assert.notEqual(doc.changeDate, '2026-01-02T00:00:00.0000000+00:00');
});

test('write 갱신: ifChangeDate 불일치/부재 → 409 + 현재 본문', async () => {
	const store = fakeStore([makeDoc({})]);
	const a = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: 'x', ifChangeDate: '틀림' }), a.res, SECRET, store);
	assert.equal(a.get().status, 409);
	assert.equal(a.get().body.changeDate, '2026-01-02T00:00:00.0000000+00:00');
	assert.equal(a.get().body.markdown, '본문');
	const b = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: 'x' }), b.res, SECRET, store);
	assert.equal(b.get().status, 409);
});

test('write: force 덮어쓰기 / createOnly 존재 시 409', async () => {
	const store = fakeStore([makeDoc({})]);
	const a = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: 'x', force: true }), a.res, SECRET, store);
	assert.equal(a.get().status, 200);
	const b = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: 'y', createOnly: true }), b.res, SECRET, store);
	assert.equal(b.get().status, 409);
});

test('write: 톰스톤 부활 — guid 재사용', async () => {
	const store = fakeStore([makeDoc({ deleted: true })]);
	const { res, get } = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: '부활' }), res, SECRET, store);
	assert.equal(get().status, 200);
	assert.equal(get().body.guid, 'g1');
	assert.equal(store.docs.get('g1')!.deleted, false);
});

test('write: 태그 없는 톰스톤 → 부활 허용 (guid 재사용 + 개발 태그 부여)', async () => {
	const store = fakeStore([makeDoc({ deleted: true, tags: [] })]);
	const { res, get } = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: 'x' }), res, SECRET, store);
	assert.equal(get().status, 200);
	assert.equal(get().body.guid, 'g1');
	assert.deepEqual(store.docs.get('g1')!.tags, ['system:notebook:개발']);
});

test('write: 타 노트북 톰스톤 → 403', async () => {
	const store = fakeStore([makeDoc({ deleted: true, tags: ['system:notebook:일기'] })]);
	const { res, get } = mockRes();
	await handleNotesWrite(mockReq(auth(), { title: '[p/b] 작업', markdown: 'x' }), res, SECRET, store);
	assert.equal(get().status, 403);
});

test('append: 기존 뒤에 블록 추가 / 없으면 생성', async () => {
	const store = fakeStore([makeDoc({})]);
	const a = mockRes();
	await handleNotesAppend(mockReq(auth(), { title: '[p/b] 작업', markdown: '## 2026-07-16\n- 완료' }), a.res, SECRET, store);
	assert.equal(a.get().status, 200);
	assert.ok(store.docs.get('g1')!.xmlContent.includes('본문\n\n<bold>2026-07-16</bold>'));
	const b = mockRes();
	await handleNotesAppend(mockReq(auth(), { title: '[p] 로그', markdown: '첫 항목' }), b.res, SECRET, store);
	assert.equal(b.get().status, 200);
	assert.equal(b.get().body.created, true);
});

test('list: deleted 제외 + 제목 가드 + 정렬', async () => {
	const store = fakeStore([
		makeDoc({ guid: 'g1', title: '[p/b] 작업' }),
		makeDoc({ guid: 'g2', title: '[p] 로그' }),
		makeDoc({ guid: 'g3', title: '[p] 삭제됨', deleted: true }),
		makeDoc({ guid: 'g4', title: '가드밖제목' })
	]);
	const { res, get } = mockRes();
	await handleNotesList(mockReq(auth(), {}), res, SECRET, store);
	const r = get();
	assert.equal(r.status, 200);
	assert.deepEqual(
		r.body.notes.map((n: { title: string }) => n.title),
		['[p] 로그', '[p/b] 작업']
	);
});
