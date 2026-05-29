import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';
import { basename, resolve as pathResolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
	mkdirSync,
	createReadStream,
	createWriteStream,
	existsSync,
	statSync,
	readdirSync
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MIME_BY_EXT: Record<string, string> = {
	pdf: 'application/pdf',
	zip: 'application/zip',
	txt: 'text/plain; charset=utf-8',
	json: 'application/json',
	mp4: 'video/mp4',
	mp3: 'audio/mpeg',
	csv: 'text/csv; charset=utf-8',
	md: 'text/markdown; charset=utf-8',
	html: 'text/html; charset=utf-8'
};

export function sanitizeFilename(raw: string): string {
	let s = basename(String(raw ?? ''));
	s = s.normalize('NFC');
	// Strip control + path separators (basename already removed dirs, but
	// belt-and-braces for embedded slashes and backslashes that survived
	// some path APIs on Windows-origin filenames).
	s = s.replace(/[\x00-\x1f\x7f/\\]/g, '');
	s = s.replace(/^[\s.]+|[\s.]+$/g, '');
	while (Buffer.byteLength(s, 'utf8') > 255) {
		// Preserve extension: drop one char from base.
		const dot = s.lastIndexOf('.');
		if (dot > 0 && dot < s.length - 1) {
			s = s.slice(0, dot - 1) + s.slice(dot);
		} else {
			s = s.slice(0, -1);
		}
		if (!s) break;
	}
	return s || 'untitled';
}

function isValidUuid(s: string): boolean {
	return UUID_RE.test(s);
}

function contentTypeFor(filename: string): string {
	const dot = filename.lastIndexOf('.');
	if (dot < 0) return 'application/octet-stream';
	const ext = filename.slice(dot + 1).toLowerCase();
	return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

export async function handleFileUpload(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	baseDir: string,
	publicBaseUrl: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	const declared = Number(req.headers['content-length'] ?? '0');
	if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
		res.writeHead(413, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'too_large' }));
		return;
	}

	const rawName = req.headers['x-filename'];
	const decoded = typeof rawName === 'string' ? safeDecode(rawName) : '';
	const filename = sanitizeFilename(decoded);

	const uuid = randomUUID();
	const dir = join(baseDir, uuid);
	const dest = join(dir, filename);

	// Belt-and-braces traversal guard — sanitize+UUID should make this
	// unreachable, but the guarantee is too cheap to skip.
	const resolved = pathResolve(dest);
	if (!resolved.startsWith(pathResolve(baseDir) + '/')) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_path' }));
		return;
	}

	mkdirSync(dir, { recursive: true });

	let written = 0;
	try {
		const ws = createWriteStream(dest);
		await pipeline(async function* () {
			for await (const chunk of req) {
				const buf = chunk as Buffer;
				written += buf.length;
				if (written > MAX_UPLOAD_BYTES) {
					throw new Error('too_large_stream');
				}
				yield buf;
			}
		}, ws);
	} catch (err) {
		await rm(dir, { recursive: true, force: true });
		if ((err as Error).message === 'too_large_stream') {
			res.writeHead(413, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'too_large' }));
			return;
		}
		console.warn(`[term-bridge files] upload failed: ${(err as Error).message}`);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'write_failed' }));
		return;
	}

	const url = `${publicBaseUrl.replace(/\/$/, '')}/files/${uuid}/${encodeURIComponent(filename)}`;
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(
		JSON.stringify({
			uuid,
			filename,
			size: written,
			url
		})
	);
}

export async function handleFileDownload(
	req: IncomingMessage,
	res: ServerResponse,
	baseDir: string
): Promise<void> {
	// req.url is `/files/<uuid>/<filename>` (Caddy passes path-as-is).
	const url = req.url ?? '';
	const m = /^\/files\/([^/]+)\/(.+)$/.exec(url);
	if (!m) {
		res.writeHead(404).end();
		return;
	}
	const uuid = m[1];
	if (!isValidUuid(uuid)) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_uuid' }));
		return;
	}
	const filename = safeDecode(m[2]);
	const sanitized = sanitizeFilename(filename);
	if (sanitized !== filename) {
		// URL filename doesn't survive sanitize → guaranteed miss.
		res.writeHead(404).end();
		return;
	}

	const dest = join(baseDir, uuid, sanitized);
	const resolved = pathResolve(dest);
	if (!resolved.startsWith(pathResolve(baseDir) + '/')) {
		res.writeHead(400).end();
		return;
	}
	if (!existsSync(dest)) {
		res.writeHead(404).end();
		return;
	}

	const stat = statSync(dest);
	res.writeHead(200, {
		'Content-Type': contentTypeFor(sanitized),
		'Content-Length': String(stat.size),
		'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(sanitized)}`,
		'Cache-Control': 'public, max-age=31536000, immutable',
		ETag: `"${uuid}"`
	});
	await pipeline(createReadStream(dest), res);
}

export async function handleFileList(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	baseDir: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	const out: Array<{ uuid: string; filename: string; size: number; mtime: string }> = [];
	let entries: string[];
	try {
		entries = readdirSync(baseDir);
	} catch {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end('[]');
		return;
	}

	for (const uuid of entries) {
		if (!isValidUuid(uuid)) continue;
		const dir = join(baseDir, uuid);
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		if (names.length === 0) continue;
		// Invariant: each UUID dir holds exactly one file (enforced at upload).
		// If a future change introduces sidecars (thumbnail, metadata), this
		// listing needs to be revisited — names[0] would silently drop them.
		const filename = names[0];
		try {
			const s = statSync(join(dir, filename));
			out.push({
				uuid,
				filename,
				size: s.size,
				mtime: s.mtime.toISOString()
			});
		} catch {
			continue;
		}
	}

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(out));
}

export async function handleFileDelete(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	baseDir: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}

	const url = req.url ?? '';
	const m = /^\/files\/([^/]+)$/.exec(url);
	if (!m) {
		res.writeHead(404).end();
		return;
	}
	const uuid = safeDecode(m[1]);
	if (!isValidUuid(uuid)) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_uuid' }));
		return;
	}
	const dir = join(baseDir, uuid);
	const resolved = pathResolve(dir);
	if (!resolved.startsWith(pathResolve(baseDir) + '/')) {
		res.writeHead(400).end();
		return;
	}
	if (!existsSync(dir)) {
		res.writeHead(404).end();
		return;
	}
	await rm(dir, { recursive: true, force: true });
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ ok: true }));
}
