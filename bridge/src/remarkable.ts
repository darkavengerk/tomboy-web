import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import sharp from 'sharp';
import { extractBearer, verifyToken } from './auth.js';
import {
	lookupRemarkableHost,
	remarkableHostsConfigured,
	type RemarkableHost
} from './remarkableHosts.js';

export type { RemarkableHost };

export interface RmSlotFile {
	file: string;
	restart: boolean;
}

/**
 * 슬롯 id → /usr/share/remarkable/ 아래 기기 파일 + xochitl 재시작 필요 여부.
 * id 문자열은 app/src/lib/remarkable/slots.ts 의 RM_SLOT_LABELS 와 동기화 필수.
 */
export const RM_SLOT_FILES: Record<string, RmSlotFile> = {
	suspended: { file: 'suspended.png', restart: true },
	starting: { file: 'starting.png', restart: false },
	poweroff: { file: 'poweroff.png', restart: false },
	rebooting: { file: 'rebooting.png', restart: false },
	batteryempty: { file: 'batteryempty.png', restart: false }
};

export interface WallpaperScreen {
	slot: string;
	imageUrl: string;
}

export interface WallpaperDeps {
	hostsConfigured(): boolean;
	resolveHost(alias: string): RemarkableHost | null;
	fetchImage(url: string): Promise<Buffer>;
	convertImage(input: Buffer): Promise<Buffer>;
	pushFile(host: RemarkableHost, deviceFile: string, data: Buffer): Promise<void>;
	restartXochitl(host: RemarkableHost): Promise<void>;
}

export interface SlotResult {
	slot: string;
	status: 'ok' | 'error';
	message?: string;
}

export interface WallpaperOutcome {
	status: number;
	body: { results?: SlotResult[]; error?: string };
}

/**
 * 슬롯별로 페치→변환→전송. 한 슬롯의 실패는 격리되어 나머지를 막지 않는다.
 * 재시작 필요 슬롯이 하나라도 성공하면 마지막에 1회 restartXochitl.
 */
export async function applyWallpapers(
	deps: WallpaperDeps,
	alias: string,
	screens: WallpaperScreen[]
): Promise<WallpaperOutcome> {
	const host = deps.resolveHost(alias);
	if (!host) {
		return { status: 400, body: { error: 'unknown_host' } };
	}
	const results: SlotResult[] = [];
	let needRestart = false;
	for (const screen of screens) {
		// screen.slot 은 와이어에서 온 임의 문자열 — 미정의 슬롯 방어.
		const def = RM_SLOT_FILES[screen.slot];
		if (!def) {
			results.push({ slot: screen.slot, status: 'error', message: 'unknown_slot' });
			continue;
		}
		try {
			const raw = await deps.fetchImage(screen.imageUrl);
			const png = await deps.convertImage(raw);
			await deps.pushFile(host, def.file, png);
			results.push({ slot: screen.slot, status: 'ok' });
			if (def.restart) needRestart = true;
		} catch (err) {
			results.push({
				slot: screen.slot,
				status: 'error',
				message: (err as { message?: string }).message || 'failed'
			});
		}
	}
	if (needRestart) {
		try {
			await deps.restartXochitl(host);
		} catch (err) {
			console.error(
				'[term-bridge rm] xochitl restart failed:',
				(err as { message?: string }).message
			);
		}
	}
	return { status: 200, body: { results } };
}

export interface WallpaperRequestInput {
	token: string | undefined;
	secret: string;
	body: unknown;
	deps: WallpaperDeps;
}

/** 인증 → 구성 확인 → 본문 검증 → applyWallpapers. */
export async function processWallpaperRequest(
	input: WallpaperRequestInput
): Promise<WallpaperOutcome> {
	if (!verifyToken(input.secret, input.token)) {
		return { status: 401, body: { error: 'unauthorized' } };
	}
	if (!input.deps.hostsConfigured()) {
		return { status: 503, body: { error: 'remarkable_not_configured' } };
	}
	const parsed = parseBody(input.body);
	if (!parsed) {
		return { status: 400, body: { error: 'bad_request' } };
	}
	return applyWallpapers(input.deps, parsed.host, parsed.screens);
}

function parseBody(body: unknown): { host: string; screens: WallpaperScreen[] } | null {
	if (!body || typeof body !== 'object') return null;
	const b = body as Record<string, unknown>;
	if (typeof b.host !== 'string' || !b.host.trim()) return null;
	// 정의된 슬롯은 5개 — 봉투 단계에서는 8개까지 여유분으로 허용(향후 슬롯 대비).
	if (!Array.isArray(b.screens) || b.screens.length === 0 || b.screens.length > 8) return null;
	const screens: WallpaperScreen[] = [];
	for (const s of b.screens) {
		if (!s || typeof s !== 'object') return null;
		const slot = (s as Record<string, unknown>).slot;
		const imageUrl = (s as Record<string, unknown>).imageUrl;
		if (typeof slot !== 'string' || typeof imageUrl !== 'string') return null;
		if (!/^https?:\/\//i.test(imageUrl)) return null;
		screens.push({ slot, imageUrl });
	}
	return { host: b.host.trim(), screens };
}

// ─── 실 의존성 (fetch + sharp + ssh) ──────────────────────────────────────

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const RM_PORTRAIT = { width: 1404, height: 1872 };

/** Dropbox 공유 URL을 직접 다운로드 URL로 정규화. 그 외 URL은 그대로. */
function normalizeImageUrl(url: string): string {
	try {
		const u = new URL(url);
		if (u.hostname === 'www.dropbox.com' || u.hostname === 'dropbox.com') {
			u.searchParams.set('dl', '1');
		}
		return u.toString();
	} catch {
		return url;
	}
}

async function realFetchImage(url: string): Promise<Buffer> {
	const resp = await fetch(normalizeImageUrl(url), { redirect: 'follow' });
	if (!resp.ok) throw new Error(`image fetch ${resp.status}`);
	// Content-Length 선검사 + 청크 누적 — 적대적/오설정 서버가 거대한 응답으로
	// 메모리를 한 번에 점유하지 못하도록, 전체 버퍼링 전에 상한을 적용한다.
	const declared = Number(resp.headers.get('content-length') ?? NaN);
	if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
		throw new Error('image too large');
	}
	const reader = resp.body?.getReader();
	if (!reader) throw new Error('image body unreadable');
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > MAX_IMAGE_BYTES) {
			await reader.cancel();
			throw new Error('image too large');
		}
		chunks.push(value);
	}
	if (total === 0) throw new Error('image empty');
	return Buffer.concat(chunks);
}

async function realConvertImage(input: Buffer): Promise<Buffer> {
	return sharp(input)
		.rotate() // EXIF 방향 자동 보정
		.resize(RM_PORTRAIT.width, RM_PORTRAIT.height, { fit: 'cover' })
		.grayscale()
		.png()
		.toBuffer();
}

function runSsh(host: RemarkableHost, remoteCmd: string, stdin: Buffer | null): Promise<void> {
	return new Promise((resolve, reject) => {
		// StrictHostKeyChecking=accept-new — 최초 접속은 TOFU 로 신뢰하고
		// 키를 ~/.ssh/known_hosts 에 고정. 이후 키가 바뀌면 거부한다.
		// 컨테이너의 ~/.ssh 가 읽기전용이면 known_hosts 를 미리 채워 둘 것
		// (배포 문서 참조).
		const args = [
			'-o', 'BatchMode=yes',
			'-o', 'StrictHostKeyChecking=accept-new',
			'-o', 'ConnectTimeout=8'
		];
		if (host.keyPath) args.push('-i', host.keyPath);
		if (host.port) args.push('-p', String(host.port));
		args.push(`${host.user}@${host.host}`, remoteCmd);
		const child = spawn('ssh', args, { stdio: ['pipe', 'ignore', 'pipe'] });
		let stderr = '';
		child.stderr.on('data', (d) => {
			stderr += d.toString();
		});
		child.on('error', (err) => reject(err));
		child.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`ssh exit ${code}: ${stderr.trim().slice(0, 200)}`));
		});
		// spawn 실패 시 stdin write 가 EPIPE 를 던질 수 있다 — 'close' 가
		// 비정상 종료로 처리하므로 여기선 흡수만 한다.
		child.stdin.on('error', () => {});
		if (stdin) child.stdin.end(stdin);
		else child.stdin.end();
	});
}

function realPushFile(host: RemarkableHost, deviceFile: string, data: Buffer): Promise<void> {
	// `/usr`가 읽기전용이면 remount 선행. 파일명은 RM_SLOT_FILES 고정값이라 셸 주입 위험 없음.
	const target = `/usr/share/remarkable/${deviceFile}`;
	const remoteCmd = `mount -o remount,rw / 2>/dev/null; cat > '${target}'`;
	return runSsh(host, remoteCmd, data);
}

function realRestartXochitl(host: RemarkableHost): Promise<void> {
	return runSsh(host, 'systemctl restart xochitl', null);
}

export function realWallpaperDeps(): WallpaperDeps {
	return {
		hostsConfigured: remarkableHostsConfigured,
		resolveHost: lookupRemarkableHost,
		fetchImage: realFetchImage,
		convertImage: realConvertImage,
		pushFile: realPushFile,
		restartXochitl: realRestartXochitl
	};
}

// ─── HTTP 핸들러 ──────────────────────────────────────────────────────────

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	const MAX = 64 * 1024;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		total += buf.length;
		if (total > MAX) throw new Error('body too large');
		chunks.push(buf);
	}
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw) return {};
	return JSON.parse(raw);
}

/** POST /remarkable/wallpaper — Bearer 인증, 동기 응답. */
export async function handleRemarkableWallpaper(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	let body: unknown;
	try {
		body = await readJson(req);
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}
	const outcome = await processWallpaperRequest({
		token,
		secret,
		body,
		deps: realWallpaperDeps()
	});
	console.log(
		`[term-bridge rm] wallpaper status=${outcome.status} ` +
			`results=${outcome.body.results?.map((r) => `${r.slot}:${r.status}`).join(',') ?? '-'}`
	);
	res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(outcome.body));
}
