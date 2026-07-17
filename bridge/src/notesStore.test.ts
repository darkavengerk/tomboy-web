import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import {
	readNotesCreds, getAccessToken, createFirestoreNotesStore, formatTomboyDate,
	__resetTokenCacheForTest
} from './notesStore.js';
import type { NotesCreds } from './notesStore.js';

const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' }
});

function makeCreds(): NotesCreds {
	return {
		uid: 'dbx-test_uid',
		notebook: '개발',
		serviceAccount: { project_id: 'tomboy-web', client_email: 'sa@test.iam', private_key: privateKey as unknown as string }
	};
}

function setEnv(p: string | undefined) {
	if (p === undefined) delete process.env.BRIDGE_NOTES_FILE;
	else process.env.BRIDGE_NOTES_FILE = p;
}

beforeEach(() => __resetTokenCacheForTest());

test('readNotesCreds: env 미설정 → null', () => {
	setEnv(undefined);
	assert.equal(readNotesCreds(), null);
});

test('readNotesCreds: 정상 파일 라운드트립 + notebook 기본값', () => {
	const dir = mkdtempSync(join(tmpdir(), 'notescreds-'));
	const p = join(dir, 'notes.json');
	writeFileSync(p, JSON.stringify({ uid: 'dbx-x', serviceAccount: { project_id: 'p', client_email: 'e', private_key: 'k' } }));
	setEnv(p);
	const c = readNotesCreds();
	assert.ok(c);
	assert.equal(c.uid, 'dbx-x');
	assert.equal(c.notebook, '개발');
});

test('readNotesCreds: 필드 결손 → null', () => {
	const dir = mkdtempSync(join(tmpdir(), 'notescreds-'));
	const p = join(dir, 'bad.json');
	writeFileSync(p, JSON.stringify({ uid: 'dbx-x' }));
	setEnv(p);
	assert.equal(readNotesCreds(), null);
});

test('readNotesCreds: 파일 없음 (ENOENT) → null, throw 없음', () => {
	const dir = mkdtempSync(join(tmpdir(), 'notescreds-'));
	const p = join(dir, 'missing.json');
	setEnv(p);
	assert.equal(readNotesCreds(), null);
});

test('readNotesCreds: JSON 파싱 실패 → null', () => {
	const dir = mkdtempSync(join(tmpdir(), 'notescreds-'));
	const p = join(dir, 'malformed.json');
	writeFileSync(p, '{ not json');
	setEnv(p);
	assert.equal(readNotesCreds(), null);
});

test('readNotesCreds: private_key 빈 문자열 → null', () => {
	const dir = mkdtempSync(join(tmpdir(), 'notescreds-'));
	const p = join(dir, 'empty-key.json');
	writeFileSync(p, JSON.stringify({ uid: 'dbx-x', serviceAccount: { project_id: 'p', client_email: 'e', private_key: '' } }));
	setEnv(p);
	assert.equal(readNotesCreds(), null);
});

test('getAccessToken: JWT 형태 + 캐시', async () => {
	let calls = 0;
	let capturedBody = '';
	const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
		calls++;
		capturedBody = String(init?.body ?? '');
		return new Response(JSON.stringify({ access_token: 'tok1', expires_in: 3600 }), { status: 200 });
	}) as typeof fetch;
	const creds = makeCreds();
	const t1 = await getAccessToken(creds, fakeFetch);
	const t2 = await getAccessToken(creds, fakeFetch);
	assert.equal(t1, 'tok1');
	assert.equal(t2, 'tok1');
	assert.equal(calls, 1); // 캐시 적중
	const assertion = /assertion=([^&]+)$/.exec(capturedBody)![1];
	const [h, c] = assertion.split('.');
	const header = JSON.parse(Buffer.from(h, 'base64url').toString());
	const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
	assert.equal(header.alg, 'RS256');
	assert.equal(claims.iss, 'sa@test.iam');
	assert.equal(claims.scope, 'https://www.googleapis.com/auth/datastore');
	assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
});

function tokenThenData(rows: unknown): { fetchFn: typeof fetch; captured: { url: string; body: unknown }[] } {
	const captured: { url: string; body: unknown }[] = [];
	const fetchFn = (async (url: unknown, init?: RequestInit) => {
		const u = String(url);
		if (u.includes('oauth2.googleapis.com')) {
			return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
		}
		captured.push({ url: u, body: JSON.parse(String(init?.body ?? 'null')) });
		return new Response(JSON.stringify(rows), { status: 200 });
	}) as typeof fetch;
	return { fetchFn, captured };
}

const DOC_FIELDS = {
	guid: { stringValue: 'g1' },
	uri: { stringValue: 'note://tomboy/g1' },
	title: { stringValue: '[p/b] 작업' },
	xmlContent: { stringValue: '<note-content version="0.1">[p/b] 작업\n\n</note-content>' },
	createDate: { stringValue: '2026-07-16T10:00:00.0000000+00:00' },
	changeDate: { stringValue: '2026-07-16T10:00:00.0000000+00:00' },
	metadataChangeDate: { stringValue: '2026-07-16T10:00:00.0000000+00:00' },
	tags: { arrayValue: { values: [{ stringValue: 'system:notebook:개발' }] } },
	deleted: { booleanValue: false },
	public: { booleanValue: false }
};

test('findByTitle: runQuery 요청 형태 + 매핑', async () => {
	const { fetchFn, captured } = tokenThenData([{ document: { name: 'x', fields: DOC_FIELDS } }]);
	const store = createFirestoreNotesStore(fetchFn);
	const doc = await store.findByTitle(makeCreds(), '[p/b] 작업');
	assert.ok(doc);
	assert.equal(doc.guid, 'g1');
	assert.deepEqual(doc.tags, ['system:notebook:개발']);
	assert.equal(doc.deleted, false);
	const q = captured[0];
	assert.ok(q.url.endsWith('/documents/users/dbx-test_uid:runQuery'));
	const sq = (q.body as { structuredQuery: { where: { fieldFilter: { field: { fieldPath: string }; op: string; value: { stringValue: string } } } } }).structuredQuery;
	assert.equal(sq.where.fieldFilter.field.fieldPath, 'title');
	assert.equal(sq.where.fieldFilter.op, 'EQUAL');
	assert.equal(sq.where.fieldFilter.value.stringValue, '[p/b] 작업');
});

test('findByTitle: 0건 → null (runQuery는 빈 row {readTime}만 반환하기도 함)', async () => {
	const { fetchFn } = tokenThenData([{ readTime: 'x' }]);
	const store = createFirestoreNotesStore(fetchFn);
	assert.equal(await store.findByTitle(makeCreds(), '[p/b] 없음'), null);
});

test('listByNotebook: ARRAY_CONTAINS 쿼리', async () => {
	const { fetchFn, captured } = tokenThenData([{ document: { name: 'x', fields: DOC_FIELDS } }]);
	const store = createFirestoreNotesStore(fetchFn);
	const docs = await store.listByNotebook(makeCreds());
	assert.equal(docs.length, 1);
	const sq = (captured[0].body as { structuredQuery: { where: { fieldFilter: { op: string; value: { stringValue: string } } } } }).structuredQuery;
	assert.equal(sq.where.fieldFilter.op, 'ARRAY_CONTAINS');
	assert.equal(sq.where.fieldFilter.value.stringValue, 'system:notebook:개발');
});

test('write: commit — 10필드 + serverUpdatedAt transform', async () => {
	const { fetchFn, captured } = tokenThenData({});
	const store = createFirestoreNotesStore(fetchFn);
	await store.write(makeCreds(), {
		guid: 'g2', uri: 'note://tomboy/g2', title: '[p/b] 작업',
		xmlContent: '<note-content version="0.1">[p/b] 작업\n\nx</note-content>',
		createDate: 'c', changeDate: 'd', metadataChangeDate: 'm',
		tags: ['system:notebook:개발'], deleted: false, public: false
	});
	const body = captured[0].body as {
		writes: Array<{
			update: { name: string; fields: Record<string, unknown> };
			updateTransforms: Array<{ fieldPath: string; setToServerValue: string }>;
		}>;
	};
	assert.ok(captured[0].url.endsWith('/documents:commit'));
	const w = body.writes[0];
	assert.ok(w.update.name.endsWith('/documents/users/dbx-test_uid/notes/g2'));
	assert.deepEqual(Object.keys(w.update.fields).sort(), [
		'changeDate', 'createDate', 'deleted', 'guid', 'metadataChangeDate', 'public', 'tags', 'title', 'uri', 'xmlContent'
	]);
	assert.deepEqual(w.updateTransforms, [{ fieldPath: 'serverUpdatedAt', setToServerValue: 'REQUEST_TIME' }]);
});

test('formatTomboyDate: 7자리 소수점 + 콜론 오프셋', () => {
	const s = formatTomboyDate(new Date('2026-07-16T12:34:56.789Z'));
	assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}[+-]\d{2}:\d{2}$/);
	assert.ok(s.includes('.7890000') || /\.\d{3}0000/.test(s));
});
