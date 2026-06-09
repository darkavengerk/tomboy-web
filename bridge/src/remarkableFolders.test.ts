import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintToken } from './auth.js';
import {
	parseFoldersFromRawMetadata,
	processFoldersRequest,
	_resetRemarkableFoldersCache,
	type FoldersDeps,
	type RemarkableFolder
} from './remarkableFolders.js';
import type { RemarkableHost } from './remarkableHosts.js';

const SECRET = 'folders-test-secret';
const HOST: RemarkableHost = { host: '10.0.0.42', user: 'root' };

function makeFake(
	rawMetadata: string | (() => string | Promise<string>),
	over: Partial<FoldersDeps> = {}
) {
	const calls = { fetches: 0 };
	const deps: FoldersDeps = {
		hostsConfigured: () => true,
		resolveHost: () => HOST,
		fetchRawMetadata: async () => {
			calls.fetches += 1;
			return typeof rawMetadata === 'function' ? rawMetadata() : rawMetadata;
		},
		...over
	};
	return { deps, calls };
}

function meta(uuid: string, body: object): string {
	return `###${uuid}.metadata\n${JSON.stringify(body)}\n`;
}

test('parseFoldersFromRawMetadata: empty input → []', () => {
	assert.deepEqual(parseFoldersFromRawMetadata(''), []);
});

test('parseFoldersFromRawMetadata: keeps CollectionType, drops DocumentType + deleted', () => {
	const raw =
		meta('aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa', {
			type: 'CollectionType',
			visibleName: '루트폴더',
			parent: ''
		}) +
		meta('bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb', {
			type: 'DocumentType',
			visibleName: '문서',
			parent: ''
		}) +
		meta('cccccccc-1111-2222-3333-cccccccccccc', {
			type: 'CollectionType',
			visibleName: '삭제됨',
			parent: '',
			deleted: true
		});
	const folders = parseFoldersFromRawMetadata(raw);
	assert.equal(folders.length, 1);
	assert.equal(folders[0].uuid, 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa');
	assert.equal(folders[0].visibleName, '루트폴더');
	assert.equal(folders[0].path, '/루트폴더');
});

test('parseFoldersFromRawMetadata: nested folders get full path', () => {
	const raw =
		meta('11111111-aaaa-bbbb-cccc-111111111111', { type: 'CollectionType', visibleName: 'Tomboy', parent: '' }) +
		meta('22222222-aaaa-bbbb-cccc-222222222222', { type: 'CollectionType', visibleName: 'Notes', parent: '11111111-aaaa-bbbb-cccc-111111111111' }) +
		meta('33333333-aaaa-bbbb-cccc-333333333333', { type: 'CollectionType', visibleName: 'Daily', parent: '22222222-aaaa-bbbb-cccc-222222222222' });
	const folders = parseFoldersFromRawMetadata(raw);
	const byUuid = new Map(folders.map((f) => [f.uuid, f]));
	assert.equal(byUuid.get('11111111-aaaa-bbbb-cccc-111111111111')?.path, '/Tomboy');
	assert.equal(byUuid.get('22222222-aaaa-bbbb-cccc-222222222222')?.path, '/Tomboy/Notes');
	assert.equal(byUuid.get('33333333-aaaa-bbbb-cccc-333333333333')?.path, '/Tomboy/Notes/Daily');
});

test('parseFoldersFromRawMetadata: trash parent treated as root', () => {
	const raw = meta('01010101-aaaa-bbbb-cccc-010101010101', {
		type: 'CollectionType',
		visibleName: '버린것',
		parent: 'trash'
	});
	const folders = parseFoldersFromRawMetadata(raw);
	assert.equal(folders[0].path, '/버린것');
});

test('parseFoldersFromRawMetadata: parent cycle does not infinite-loop', () => {
	// 비현실적이지만 방어. 자기 참조 cycle.
	const cycleUuid = 'cccccccc-aaaa-bbbb-cccc-cccccccccccc';
	const raw = meta(cycleUuid, {
		type: 'CollectionType',
		visibleName: '순환',
		parent: cycleUuid
	});
	const folders = parseFoldersFromRawMetadata(raw);
	assert.equal(folders.length, 1);
	assert.equal(folders[0].path, '/순환');
});

test('parseFoldersFromRawMetadata: malformed JSON entry is skipped', () => {
	const raw =
		'###bad12345.metadata\n{not-json\n' +
		meta('09090909-aaaa-bbbb-cccc-090909090909', {
			type: 'CollectionType',
			visibleName: '정상',
			parent: ''
		});
	const folders = parseFoldersFromRawMetadata(raw);
	assert.equal(folders.length, 1);
	assert.equal(folders[0].visibleName, '정상');
});

test('processFoldersRequest: missing token → 401', async () => {
	_resetRemarkableFoldersCache();
	const { deps } = makeFake('');
	const out = await processFoldersRequest({
		token: undefined,
		secret: SECRET,
		alias: 'rm2',
		refresh: false,
		deps
	});
	assert.equal(out.status, 401);
});

test('processFoldersRequest: hosts not configured → 503', async () => {
	_resetRemarkableFoldersCache();
	const { deps } = makeFake('', { hostsConfigured: () => false });
	const out = await processFoldersRequest({
		token: mintToken(SECRET),
		secret: SECRET,
		alias: 'rm2',
		refresh: false,
		deps
	});
	assert.equal(out.status, 503);
});

test('processFoldersRequest: missing alias → 400 missing_alias', async () => {
	_resetRemarkableFoldersCache();
	const { deps } = makeFake('');
	const out = await processFoldersRequest({
		token: mintToken(SECRET),
		secret: SECRET,
		alias: null,
		refresh: false,
		deps
	});
	assert.equal(out.status, 400);
	assert.equal(out.body.error, 'missing_alias');
});

test('processFoldersRequest: unknown alias → 400 unknown_alias', async () => {
	_resetRemarkableFoldersCache();
	const { deps } = makeFake('', { resolveHost: () => null });
	const out = await processFoldersRequest({
		token: mintToken(SECRET),
		secret: SECRET,
		alias: 'nope',
		refresh: false,
		deps
	});
	assert.equal(out.status, 400);
	assert.equal(out.body.error, 'unknown_alias');
});

test('processFoldersRequest: ssh failure → 502', async () => {
	_resetRemarkableFoldersCache();
	const { deps } = makeFake(() => {
		throw new Error('ssh exit 255');
	});
	const out = await processFoldersRequest({
		token: mintToken(SECRET),
		secret: SECRET,
		alias: 'rm2',
		refresh: false,
		deps
	});
	assert.equal(out.status, 502);
	assert.match(out.body.error ?? '', /^remote_failure/);
});

test('processFoldersRequest: caches results within TTL, refresh=true bypasses', async () => {
	_resetRemarkableFoldersCache();
	const raw = meta('11111111-aaaa-bbbb-cccc-111111111111', { type: 'CollectionType', visibleName: 'A', parent: '' });
	const { deps, calls } = makeFake(raw);
	const baseNow = 1_000_000;
	const opts = {
		token: mintToken(SECRET),
		secret: SECRET,
		alias: 'rm2',
		refresh: false,
		deps
	};

	const a = await processFoldersRequest({ ...opts, now: baseNow });
	assert.equal(a.status, 200);
	assert.equal((a.body.folders as RemarkableFolder[]).length, 1);
	assert.equal(calls.fetches, 1);

	// TTL 안 — 캐시 hit, fetch 안 늘어남
	const b = await processFoldersRequest({ ...opts, now: baseNow + 60_000 });
	assert.equal(b.status, 200);
	assert.equal(calls.fetches, 1);

	// TTL 밖 — fetch 다시
	const c = await processFoldersRequest({ ...opts, now: baseNow + 6 * 60_000 });
	assert.equal(c.status, 200);
	assert.equal(calls.fetches, 2);

	// refresh=true → TTL 안에서도 강제 fetch
	const d = await processFoldersRequest({
		...opts,
		refresh: true,
		now: baseNow + 6 * 60_000 + 1000
	});
	assert.equal(d.status, 200);
	assert.equal(calls.fetches, 3);
});

test('processFoldersRequest: folders sorted by path', async () => {
	_resetRemarkableFoldersCache();
	const raw =
		meta('11111111-aaaa-bbbb-cccc-111111111111', { type: 'CollectionType', visibleName: 'Zeta', parent: '' }) +
		meta('22222222-aaaa-bbbb-cccc-222222222222', { type: 'CollectionType', visibleName: 'Alpha', parent: '' });
	const { deps } = makeFake(raw);
	const out = await processFoldersRequest({
		token: mintToken(SECRET),
		secret: SECRET,
		alias: 'rm2',
		refresh: false,
		deps
	});
	const folders = out.body.folders as RemarkableFolder[];
	assert.deepEqual(
		folders.map((f) => f.path),
		['/Alpha', '/Zeta']
	);
});
