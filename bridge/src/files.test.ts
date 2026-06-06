import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';
import {
	sanitizeFilename,
	handleFileUpload,
	handleFileDownload,
	handleFileList,
	handleFileDelete,
	parseSingleByteRange
} from './files.js';
import { mintToken } from './auth.js';

const SECRET = 'a'.repeat(64);

function mockReq(opts: {
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: Buffer | string;
}): IncomingMessage {
	const raw = opts.body
		? typeof opts.body === 'string'
			? Buffer.from(opts.body)
			: opts.body
		: Buffer.alloc(0);
	const r = Readable.from([raw]) as unknown as IncomingMessage;
	r.method = opts.method ?? 'GET';
	r.url = opts.url ?? '/';
	r.headers = opts.headers ?? {};
	return r;
}

function mockRes(): {
	res: ServerResponse;
	get: () => { status: number; headers: Record<string, string>; body: Buffer };
} {
	let status = 0;
	let headers: Record<string, string> = {};
	const chunks: Buffer[] = [];
	// stream/promises#pipeline(readable, dest) requires `dest` to be a real
	// Writable. Subclassing Writable lets handleFileDownload's
	// `pipeline(createReadStream, res)` drive our mock the same way it
	// drives a real ServerResponse.
	const sink = new Writable({
		write(chunk: Buffer | string, _enc: string, cb: (e?: Error | null) => void) {
			chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
			cb();
		}
	});
	const sinkMut = sink as unknown as {
		writeHead: unknown;
		setHeader: unknown;
	};
	sinkMut.writeHead = (s: number, h?: Record<string, string>) => {
		status = s;
		if (h) headers = { ...headers, ...h };
		return sink;
	};
	sinkMut.setHeader = (k: string, v: string) => {
		headers[k] = v;
	};
	const res = sink as unknown as ServerResponse;
	return { res, get: () => ({ status, headers, body: Buffer.concat(chunks) }) };
}

test('sanitizeFilename: basename strips path', () => {
	assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
});

test('sanitizeFilename: NFC normalizes Korean', () => {
	const decomposed = '각'; // ㄱㅏㄱ
	const composed = sanitizeFilename(decomposed);
	assert.equal(composed.normalize('NFC'), composed);
});

test('sanitizeFilename: strips control chars and slashes', () => {
	// basename() splits on POSIX '/' first → 'c\\d', then regex strips '\\' → 'cd'.
	assert.equal(sanitizeFilename('a b/c\\d'), 'cd');
	// No-path variant: control chars + backslash stripped, regular chars (incl. space) kept.
	assert.equal(sanitizeFilename('a\\b\tc'), 'abc');
});

test('sanitizeFilename: 255 byte cap preserves extension', () => {
	const longBase = 'a'.repeat(300);
	const r = sanitizeFilename(`${longBase}.pdf`);
	assert.ok(Buffer.byteLength(r, 'utf8') <= 255);
	assert.ok(r.endsWith('.pdf'));
});

test('sanitizeFilename: empty result → untitled', () => {
	assert.equal(sanitizeFilename(''), 'untitled');
	assert.equal(sanitizeFilename('   '), 'untitled');
	assert.equal(sanitizeFilename('/'), 'untitled');
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('upload: 401 without bearer', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const { res, get } = mockRes();
		const req = mockReq({ method: 'POST', headers: { 'content-length': '5' } });
		await handleFileUpload(req, res, SECRET, dir, 'https://b.test');
		assert.equal(get().status, 401);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('upload: 413 when content-length exceeds 50 MiB', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const token = mintToken(SECRET);
		const { res, get } = mockRes();
		const req = mockReq({
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-length': String(60 * 1024 * 1024),
				'x-filename': encodeURIComponent('big.bin')
			}
		});
		await handleFileUpload(req, res, SECRET, dir, 'https://b.test');
		assert.equal(get().status, 413);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('upload: 200 + writes file + returns metadata', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const token = mintToken(SECRET);
		const { res, get } = mockRes();
		const body = Buffer.from('hello pdf');
		const req = mockReq({
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-length': String(body.length),
				'content-type': 'application/pdf',
				'x-filename': encodeURIComponent('doc.pdf')
			},
			body
		});
		await handleFileUpload(req, res, SECRET, dir, 'https://b.test');
		const r = get();
		assert.equal(r.status, 200);
		const json = JSON.parse(r.body.toString('utf8')) as {
			uuid: string;
			filename: string;
			size: number;
			url: string;
		};
		assert.ok(UUID_RE.test(json.uuid));
		assert.equal(json.filename, 'doc.pdf');
		assert.equal(json.size, body.length);
		assert.equal(json.url, `https://b.test/files/${json.uuid}/${encodeURIComponent('doc.pdf')}`);
		assert.ok(existsSync(join(dir, json.uuid, 'doc.pdf')));
		assert.deepEqual(readFileSync(join(dir, json.uuid, 'doc.pdf')), body);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('upload: empty X-Filename → untitled', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const token = mintToken(SECRET);
		const { res, get } = mockRes();
		const body = Buffer.from('x');
		const req = mockReq({
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-length': String(body.length)
			},
			body
		});
		await handleFileUpload(req, res, SECRET, dir, 'https://b.test');
		const json = JSON.parse(get().body.toString('utf8')) as { filename: string };
		assert.equal(json.filename, 'untitled');
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('download: 200 + Content-Disposition + body', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const uuid = '11111111-2222-3333-4444-555555555555';
		const fname = 'doc.pdf';
		mkdirSync(join(dir, uuid), { recursive: true });
		writeFileSync(join(dir, uuid, fname), 'hello');
		const { res, get } = mockRes();
		const req = mockReq({
			method: 'GET',
			url: `/files/${uuid}/${fname}`
		});
		await handleFileDownload(req, res, dir);
		const r = get();
		assert.equal(r.status, 200);
		assert.match(r.headers['Content-Disposition'] ?? '', /attachment; filename\*=UTF-8''/);
		assert.equal(r.headers['Cache-Control'], 'public, max-age=31536000, immutable');
		assert.equal(r.headers['ETag'], `"${uuid}"`);
		assert.equal(r.body.toString('utf8'), 'hello');
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('download: filename mismatch falls back to single file in UUID dir', async () => {
	// iOS Safari may NFD-normalize percent-encoded paths before sending,
	// so the URL filename can disagree with the on-disk (NFC) name. UUID
	// is the security boundary; serve the dir's sole file regardless.
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const uuid = '11111111-2222-3333-4444-555555555555';
		mkdirSync(join(dir, uuid), { recursive: true });
		// NFC composed Hangul on disk.
		const onDisk = '달콤한.mp3'.normalize('NFC');
		writeFileSync(join(dir, uuid, onDisk), 'audio-bytes');
		// URL sends NFD decomposed form.
		const nfdName = '달콤한.mp3'.normalize('NFD');
		const { res, get } = mockRes();
		const req = mockReq({
			method: 'GET',
			url: `/files/${uuid}/${encodeURIComponent(nfdName)}`
		});
		await handleFileDownload(req, res, dir);
		const r = get();
		assert.equal(r.status, 200);
		assert.equal(r.body.toString('utf8'), 'audio-bytes');
		// mp3 is media → inline (iOS <audio> refuses attachment); name = on-disk NFC.
		assert.equal(
			r.headers['Content-Disposition'],
			`inline; filename*=UTF-8''${encodeURIComponent(onDisk)}`
		);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('download: media → inline, documents → attachment', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const cases: Array<[string, string]> = [
			['song.mp3', 'inline'],
			['clip.mp4', 'inline'],
			['doc.pdf', 'attachment'],
			['data.zip', 'attachment'],
			['notes.txt', 'attachment']
		];
		for (const [fname, expected] of cases) {
			const uuid = '11111111-2222-3333-4444-555555555555';
			const udir = join(dir, uuid);
			rmSync(udir, { recursive: true, force: true });
			mkdirSync(udir, { recursive: true });
			writeFileSync(join(udir, fname), 'x');
			const { res, get } = mockRes();
			const req = mockReq({ method: 'GET', url: `/files/${uuid}/${fname}` });
			await handleFileDownload(req, res, dir);
			const disp = get().headers['Content-Disposition'] ?? '';
			assert.ok(
				disp.startsWith(`${expected}; `),
				`${fname} expected ${expected}, got "${disp}"`
			);
		}
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('parseSingleByteRange: open + bounded + suffix + invalid', () => {
	const size = 1000;
	assert.deepEqual(parseSingleByteRange('bytes=0-99', size), { start: 0, end: 99 });
	assert.deepEqual(parseSingleByteRange('bytes=200-', size), { start: 200, end: 999 });
	assert.deepEqual(parseSingleByteRange('bytes=-100', size), { start: 900, end: 999 });
	// End past EOF clamps to last byte.
	assert.deepEqual(parseSingleByteRange('bytes=0-9999', size), { start: 0, end: 999 });
	// Whitespace tolerance.
	assert.deepEqual(parseSingleByteRange(' bytes=0-9 ', size), { start: 0, end: 9 });
	// Malformed / unsupported.
	assert.equal(parseSingleByteRange(undefined, size), null);
	assert.equal(parseSingleByteRange('', size), null);
	assert.equal(parseSingleByteRange('bytes=-', size), null);
	assert.equal(parseSingleByteRange('bytes=abc-def', size), null);
	assert.equal(parseSingleByteRange('bytes=500-200', size), null); // reversed
	assert.equal(parseSingleByteRange('bytes=2000-3000', size), null); // start past EOF
	assert.equal(parseSingleByteRange('bytes=0-99,200-299', size), null); // multi-range
});

test('download: Range request → 206 + sliced body + Content-Range', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const uuid = '11111111-2222-3333-4444-555555555555';
		const fname = 'audio.mp3';
		mkdirSync(join(dir, uuid), { recursive: true });
		writeFileSync(join(dir, uuid, fname), 'abcdefghij'); // 10 bytes
		const { res, get } = mockRes();
		const req = mockReq({
			method: 'GET',
			url: `/files/${uuid}/${fname}`,
			headers: { range: 'bytes=2-5' }
		});
		await handleFileDownload(req, res, dir);
		const r = get();
		assert.equal(r.status, 206);
		assert.equal(r.body.toString('utf8'), 'cdef');
		assert.equal(r.headers['Content-Length'], '4');
		assert.equal(r.headers['Content-Range'], 'bytes 2-5/10');
		assert.equal(r.headers['Accept-Ranges'], 'bytes');
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('download: no Range header → 200 + Accept-Ranges advertised', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const uuid = '11111111-2222-3333-4444-555555555555';
		const fname = 'doc.pdf';
		mkdirSync(join(dir, uuid), { recursive: true });
		writeFileSync(join(dir, uuid, fname), 'fullbody');
		const { res, get } = mockRes();
		const req = mockReq({ method: 'GET', url: `/files/${uuid}/${fname}` });
		await handleFileDownload(req, res, dir);
		const r = get();
		assert.equal(r.status, 200);
		assert.equal(r.headers['Accept-Ranges'], 'bytes');
		assert.equal(r.body.toString('utf8'), 'fullbody');
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('download: 404 when UUID dir does not exist', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const uuid = '11111111-2222-3333-4444-555555555555';
		const { res, get } = mockRes();
		const req = mockReq({ method: 'GET', url: `/files/${uuid}/doc.pdf` });
		await handleFileDownload(req, res, dir);
		assert.equal(get().status, 404);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('download: 400 on bad uuid (traversal)', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const { res, get } = mockRes();
		const req = mockReq({ method: 'GET', url: '/files/..%2Fetc/passwd' });
		await handleFileDownload(req, res, dir);
		assert.equal(get().status, 400);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('list: 401 without bearer', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const { res, get } = mockRes();
		const req = mockReq({ method: 'GET', url: '/files' });
		await handleFileList(req, res, SECRET, dir);
		assert.equal(get().status, 401);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('list: 200 + empty', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const token = mintToken(SECRET);
		const { res, get } = mockRes();
		const req = mockReq({
			method: 'GET',
			url: '/files',
			headers: { authorization: `Bearer ${token}` }
		});
		await handleFileList(req, res, SECRET, dir);
		assert.equal(get().status, 200);
		assert.deepEqual(JSON.parse(get().body.toString('utf8')), []);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('list: 200 + meta array', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const uuid = '11111111-2222-3333-4444-555555555555';
		mkdirSync(join(dir, uuid), { recursive: true });
		writeFileSync(join(dir, uuid, 'a.pdf'), 'abc');
		const token = mintToken(SECRET);
		const { res, get } = mockRes();
		const req = mockReq({
			method: 'GET',
			url: '/files',
			headers: { authorization: `Bearer ${token}` }
		});
		await handleFileList(req, res, SECRET, dir);
		const arr = JSON.parse(get().body.toString('utf8')) as Array<{
			uuid: string;
			filename: string;
			size: number;
			mtime: string;
		}>;
		assert.equal(arr.length, 1);
		assert.equal(arr[0].uuid, uuid);
		assert.equal(arr[0].filename, 'a.pdf');
		assert.equal(arr[0].size, 3);
		assert.ok(arr[0].mtime);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('delete: 200 + removes dir', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const uuid = '11111111-2222-3333-4444-555555555555';
		mkdirSync(join(dir, uuid), { recursive: true });
		writeFileSync(join(dir, uuid, 'a.pdf'), 'x');
		const token = mintToken(SECRET);
		const { res, get } = mockRes();
		const req = mockReq({
			method: 'DELETE',
			url: `/files/${uuid}`,
			headers: { authorization: `Bearer ${token}` }
		});
		await handleFileDelete(req, res, SECRET, dir);
		assert.equal(get().status, 200);
		assert.ok(!existsSync(join(dir, uuid)));
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('delete: 400 on bad uuid', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const token = mintToken(SECRET);
		const { res, get } = mockRes();
		const req = mockReq({
			method: 'DELETE',
			url: '/files/..%2Fetc',
			headers: { authorization: `Bearer ${token}` }
		});
		await handleFileDelete(req, res, SECRET, dir);
		assert.equal(get().status, 400);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('delete: 404 on missing uuid', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const token = mintToken(SECRET);
		const { res, get } = mockRes();
		const req = mockReq({
			method: 'DELETE',
			url: '/files/11111111-2222-3333-4444-555555555555',
			headers: { authorization: `Bearer ${token}` }
		});
		await handleFileDelete(req, res, SECRET, dir);
		assert.equal(get().status, 404);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test('roundtrip: upload then download → byte-identical', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
	try {
		const token = mintToken(SECRET);
		const body = Buffer.from('roundtrip-content-here');

		// Upload
		const upRes = mockRes();
		const upReq = mockReq({
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-length': String(body.length),
				'content-type': 'application/octet-stream',
				'x-filename': encodeURIComponent('round.bin')
			},
			body
		});
		await handleFileUpload(upReq, upRes.res, SECRET, dir, 'https://b.test');
		const meta = JSON.parse(upRes.get().body.toString('utf8')) as {
			uuid: string;
			filename: string;
		};

		// Download
		const dlRes = mockRes();
		const dlReq = mockReq({
			method: 'GET',
			url: `/files/${meta.uuid}/${encodeURIComponent(meta.filename)}`
		});
		await handleFileDownload(dlReq, dlRes.res, dir);
		assert.equal(dlRes.get().status, 200);
		assert.deepEqual(dlRes.get().body, body);
	} finally {
		rmSync(dir, { recursive: true });
	}
});
