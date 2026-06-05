import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSource } from './validate.js';

export interface ExtractOk { url: string; title: string; }
export interface RunnerDeps {
	spawn?: typeof nodeSpawn;
	bridgeFilesUrl: string;
	sharedToken: string;
	ytdlpPath?: string;
	ffmpegPath?: string;
	timeoutMs?: number;
	maxFilesize?: string;
	uploadFn?: (mp3: Buffer, filename: string) => Promise<string>;
}

export async function extract(source: string, deps: RunnerDeps): Promise<ExtractOk> {
	const resolved = resolveSource(source);
	if (resolved.kind === 'reject') throw new Error(`bad_source:${resolved.reason}`);

	const dir = await mkdtemp(join(tmpdir(), 'music-'));
	try {
		await runYtdlp(resolved.value, dir, deps);
		const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.mp3'));
		if (files.length === 0) throw new Error('no_output');
		const filename = files.sort()[0];
		const mp3 = await readFile(join(dir, filename));
		const title = filename.replace(/\.mp3$/i, '');
		const upload = deps.uploadFn ?? ((b, fn) => uploadToBridge(b, fn, deps.bridgeFilesUrl, deps.sharedToken));
		const url = await upload(mp3, filename);
		return { url, title };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function runYtdlp(arg: string, dir: string, deps: RunnerDeps): Promise<void> {
	const spawn = deps.spawn ?? nodeSpawn;
	const bin = deps.ytdlpPath ?? 'yt-dlp';
	const timeoutMs = deps.timeoutMs ?? 180_000;
	const maxFilesize = deps.maxFilesize ?? '40M';
	const args = [
		'-x', '--audio-format', 'mp3', '--embed-metadata', '--embed-thumbnail',
		'--no-playlist', '--no-exec', '--socket-timeout', '30',
		'--max-filesize', maxFilesize,
		...(deps.ffmpegPath ? ['--ffmpeg-location', deps.ffmpegPath] : []),
		'-o', '%(title)s.%(ext)s', '--paths', dir, arg
	];
	return new Promise((resolve, reject) => {
		const opts: SpawnOptions = { cwd: process.env.HOME, stdio: ['ignore', 'ignore', 'pipe'] };
		const child = spawn(bin, args, opts);
		let errOut = '';
		let settled = false;
		const fail = (msg: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { child.kill('SIGTERM'); } catch { /* gone */ }
			reject(new Error(msg));
		};
		const timer = setTimeout(() => fail('타임아웃'), timeoutMs);
		child.stderr?.on('data', (d: Buffer) => { if (errOut.length < 8192) errOut += d.toString('utf8'); });
		child.on('error', (e: Error) => fail(e.message));
		child.on('close', (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(errOut.trim().slice(0, 200) || `종료 코드 ${code}`));
		});
	});
}

async function uploadToBridge(mp3: Buffer, filename: string, base: string, token: string): Promise<string> {
	const res = await fetch(`${base.replace(/\/$/, '')}/files`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'audio/mpeg',
			'X-Filename': encodeURIComponent(filename)
		},
		body: mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength) as ArrayBuffer
	});
	if (!res.ok) throw new Error(`upload_failed:${res.status}`);
	const j = (await res.json()) as { url?: string };
	if (!j.url) throw new Error('upload_no_url');
	return j.url;
}
