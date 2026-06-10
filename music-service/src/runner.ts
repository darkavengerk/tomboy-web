import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSource } from './validate.js';
import { mintBridgeToken } from './bridgeToken.js';

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
		// NOTE: NO `--embed-thumbnail`. yt-dlp embeds the cover as an APIC frame at
		// the FRONT of the ID3v2 tag, pushing the first MPEG sync frame deep into
		// the file. WebKit (Safari / all iOS browsers) sniffs only the leading bytes
		// of an <audio> source; if it hits the big cover blob before the sync frame
		// it gives up with MEDIA_ERR_SRC_NOT_SUPPORTED — while Chrome/Firefox buffer
		// past it. Result: bridge songs "just skip" on the phone. `--embed-metadata`
		// (small ID3 text frames) is fine and kept.
		'-x', '--audio-format', 'mp3', '--embed-metadata',
		'--no-playlist', '--no-exec', '--socket-timeout', '30',
		'--max-filesize', maxFilesize,
		...(deps.ffmpegPath ? ['--ffmpeg-location', deps.ffmpegPath] : []),
		'-o', '%(title)s.%(ext)s', '--paths', dir, arg
	];
	return new Promise((resolve, reject) => {
		// stdout 도 캡처: yt-dlp 는 --max-filesize 초과 시 "larger than max-filesize ...
		// Aborting." 을 stdout 에 찍고 종료코드 0 으로 끝낸다(파일 미생성). 이를 잡아
		// no_output(일반 502) 이 아니라 too_large(413)로 분류하기 위함.
		const opts: SpawnOptions = { cwd: process.env.HOME, stdio: ['ignore', 'pipe', 'pipe'] };
		const child = spawn(bin, args, opts);
		let errOut = '';
		let tooLarge = false;
		let settled = false;
		const scan = (s: string) => { if (s.includes('larger than max-filesize')) tooLarge = true; };
		const fail = (msg: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { child.kill('SIGTERM'); } catch { /* gone */ }
			reject(new Error(msg));
		};
		const timer = setTimeout(() => fail('타임아웃'), timeoutMs);
		child.stdout?.on('data', (d: Buffer) => scan(d.toString('utf8')));
		child.stderr?.on('data', (d: Buffer) => { const s = d.toString('utf8'); scan(s); if (errOut.length < 8192) errOut += s; });
		child.on('error', (e: Error) => fail(e.message));
		child.on('close', (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (tooLarge) return reject(new Error('too_large'));
			if (code === 0) resolve();
			else reject(new Error(errOut.trim().slice(0, 200) || `종료 코드 ${code}`));
		});
	});
}

export interface PlaylistEntry { url: string; title: string; }
export interface EnumerateOk { label: string; entries: PlaylistEntry[]; total: number; truncated: boolean; }
export interface EnumerateDeps {
	spawn?: typeof nodeSpawn;
	ytdlpPath?: string;
	timeoutMs?: number;
	maxPlaylist?: number;
}

interface RawEntry { id?: unknown; url?: unknown; title?: unknown; }
interface PlaylistJson { title?: unknown; entries?: unknown; }

function entryToTrack(e: unknown): PlaylistEntry | null {
	if (!e || typeof e !== 'object') return null;
	const r = e as RawEntry;
	const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : '';
	const id = typeof r.id === 'string' && r.id ? r.id : '';
	if (id) return { url: `https://www.youtube.com/watch?v=${id}`, title: title || id };
	if (typeof r.url === 'string' && r.url) {
		const full = /^https?:\/\//i.test(r.url) ? r.url : `https://www.youtube.com/watch?v=${r.url}`;
		// title 폴백: watch?v= 파라미터 추출, 없으면 원 url 그대로.
		let fallback = r.url;
		try { fallback = new URL(full).searchParams.get('v') ?? r.url; } catch { /* non-parseable */ }
		return { url: full, title: title || fallback };
	}
	return null;
}

export async function enumerate(source: string, deps: EnumerateDeps): Promise<EnumerateOk> {
	const resolved = resolveSource(source);
	if (resolved.kind === 'reject') throw new Error(`bad_source:${resolved.reason}`);
	// 열거는 재생목록 URL 전용 — 검색어(ytsearch1:)는 단일 검색이라 의미 없음.
	if (resolved.kind === 'search') throw new Error('bad_source:not_a_url');
	const max = deps.maxPlaylist ?? 50;
	const json = await runYtdlpJson(resolved.value, deps);
	let parsed: PlaylistJson;
	try {
		parsed = JSON.parse(json) as PlaylistJson;
	} catch {
		throw new Error('bad_source:enumerate_parse');
	}
	const label = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : '재생목록';
	const raw = Array.isArray(parsed.entries) ? parsed.entries : [];
	const all = raw.map(entryToTrack).filter((e): e is PlaylistEntry => e !== null);
	// 0개 = 파싱 가능한 엔트리 없음(빈 재생목록) 또는 yt-dlp 가 단일 영상 JSON(entries 없음)을 반환한 경우.
	if (all.length === 0) throw new Error('bad_source:empty_playlist');
	const total = all.length;
	const entries = all.slice(0, max);
	return { label, entries, total, truncated: total > max };
}

function runYtdlpJson(arg: string, deps: EnumerateDeps): Promise<string> {
	const spawn = deps.spawn ?? nodeSpawn;
	const bin = deps.ytdlpPath ?? 'yt-dlp';
	const timeoutMs = deps.timeoutMs ?? 60_000;
	const args = ['-J', '--flat-playlist', '--yes-playlist', '--no-warnings', '--socket-timeout', '30', arg];
	return new Promise((resolve, reject) => {
		const opts: SpawnOptions = { cwd: process.env.HOME, stdio: ['ignore', 'pipe', 'pipe'] };
		const child = spawn(bin, args, opts);
		let out = '';
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
		// stdout 은 반드시 끝까지 소비(flat-playlist JSON; 50곡이면 수십 KB 수준).
		child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
		child.stderr?.on('data', (d: Buffer) => { if (errOut.length < 8192) errOut += d.toString('utf8'); });
		child.on('error', (e: Error) => fail(e.message));
		child.on('close', (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else reject(new Error(errOut.trim().slice(0, 200) || `종료 코드 ${code}`));
		});
	});
}

async function uploadToBridge(mp3: Buffer, filename: string, base: string, token: string): Promise<string> {
	const res = await fetch(`${base.replace(/\/$/, '')}/files`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${mintBridgeToken(token)}`,
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
