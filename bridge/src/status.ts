import type { IncomingMessage, ServerResponse } from 'node:http';
import { statfsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { extractBearer, verifyToken } from './auth.js';
import { SpectatorHubRegistry } from './spectatorHub.js';
import { wolHostCount } from './hosts.js';
import { sshHostCount } from './sshHosts.js';
import { remarkableHostCount } from './remarkableHosts.js';
import { remarkableFoldersCacheSize } from './remarkableFolders.js';

/**
 * GET /status — 브릿지 대시보드(`브릿지::` 노트) 집계 엔드포인트.
 *
 * 브릿지가 다루는 것들의 전반적 현황을 한 번에 모은다:
 *   - system: 가동시간/부하/메모리/CPU 온도(라즈베리파이)
 *   - disks:  업로드 저장소(/files 마운트) + 컨테이너 루트의 statfs
 *   - services: 다운스트림(ocr/ollama/music/automation/claude/rag) 도달성 프로브
 *   - files:  /files 업로드 개수·총용량·최근시각
 *   - connections: 스펙테이터 세션 수 + 등록 호스트/캐시
 *
 * 인증은 다른 엔드포인트와 동일한 Bearer(verifyToken). 프로브는 best-effort —
 * 어떤 HTTP 응답이든 돌아오면 'up'(도달 가능), 네트워크 오류/타임아웃이면 'down',
 * env URL 이 비었으면 'unconfigured'. 한 서비스가 죽어도 200 으로 전체를 돌려준다.
 *
 * 주의: 브릿지는 podman 컨테이너 안에서 돈다 → statfs/df 는 컨테이너 뷰다.
 * `/files` 마운트는 호스트 볼륨을 반영(업로드 누적분 = 가장 중요)하고, 루트는
 * 컨테이너 파일시스템이다. 호스트 전체 디스크는 컨테이너에서 보이지 않는다.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROBE_TIMEOUT_MS = 2500;

export interface ServiceSpec {
	/** 표시 이름(노트 표에 그대로). */
	name: string;
	/** 서비스 베이스 URL. 빈 문자열이면 'unconfigured'. */
	url: string;
	/** 프로브 시 베이스 뒤에 붙일 경로(예: '/status', '/api/version'). 기본 없음. */
	path?: string;
	/** true 면 브릿지 시크릿을 Bearer 로 재서명해 보낸다(ocr 등). */
	auth?: boolean;
}

export interface StatusConfig {
	secret: string;
	filesDir: string;
	publicBaseUrl: string;
	port: number;
	services: ServiceSpec[];
}

export interface ServiceProbe {
	name: string;
	status: 'up' | 'down' | 'unconfigured';
	latency_ms: number | null;
}

export type ProbeFn = (spec: ServiceSpec, secret: string) => Promise<ServiceProbe>;

export interface StatusDeps {
	probe?: ProbeFn;
	now?: number;
}

export interface DiskInfo {
	mount: string;
	size_bytes: number;
	used_bytes: number;
	avail_bytes: number;
	use_pct: number;
}

export interface BridgeStatus {
	fetched_at: string;
	system: {
		uptime_s: number;
		load: number[];
		cpu_count: number;
		cpu_temp_c: number | null;
		mem_total_bytes: number;
		mem_used_bytes: number;
	};
	disks: DiskInfo[];
	services: ServiceProbe[];
	files: { count: number; total_bytes: number; latest_mtime: string | null };
	connections: {
		spectator_sessions: number;
		folder_cache: number;
		hosts_ssh: number;
		hosts_remarkable: number;
		hosts_wol: number;
	};
	bridge: { port: number; uptime_s: number; node: string; public_host: string };
}

/** 단일 서비스 도달성 프로브 — HTTP 응답이 오면 up, 던지면 down. */
export async function defaultProbe(spec: ServiceSpec, secret: string): Promise<ServiceProbe> {
	if (!spec.url) return { name: spec.name, status: 'unconfigured', latency_ms: null };
	const target = spec.url.replace(/\/$/, '') + (spec.path ?? '');
	const headers: Record<string, string> = spec.auth ? { Authorization: `Bearer ${secret}` } : {};
	const started = Date.now();
	try {
		const res = await fetch(target, {
			method: 'GET',
			headers,
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
		});
		// 본문은 소켓 정리를 위해 비운다(상태/지연만 쓴다).
		void res.text().catch(() => {
			/* ignore */
		});
		return { name: spec.name, status: 'up', latency_ms: Date.now() - started };
	} catch {
		return { name: spec.name, status: 'down', latency_ms: null };
	}
}

function cpuTempC(): number | null {
	try {
		const raw = readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
		const milli = Number(raw);
		if (!Number.isFinite(milli)) return null;
		return Math.round(milli / 100) / 10; // 0.1°C 단위
	} catch {
		return null;
	}
}

function gatherDisk(mount: string, label: string): DiskInfo | null {
	try {
		const s = statfsSync(mount);
		const size = s.blocks * s.bsize;
		const avail = s.bavail * s.bsize;
		const free = s.bfree * s.bsize;
		const used = size - free;
		const denom = used + avail; // df 관례(예약 블록 제외)
		const usePct = denom > 0 ? Math.round((used / denom) * 1000) / 10 : 0;
		return { mount: label, size_bytes: size, used_bytes: used, avail_bytes: avail, use_pct: usePct };
	} catch {
		return null;
	}
}

function gatherFiles(baseDir: string): BridgeStatus['files'] {
	let count = 0;
	let total = 0;
	let latest = 0;
	let entries: string[];
	try {
		entries = readdirSync(baseDir);
	} catch {
		return { count: 0, total_bytes: 0, latest_mtime: null };
	}
	for (const uuid of entries) {
		if (!UUID_RE.test(uuid)) continue;
		let names: string[];
		try {
			names = readdirSync(join(baseDir, uuid));
		} catch {
			continue;
		}
		if (names.length === 0) continue;
		try {
			const st = statSync(join(baseDir, uuid, names[0]));
			count++;
			total += st.size;
			if (st.mtimeMs > latest) latest = st.mtimeMs;
		} catch {
			continue;
		}
	}
	return { count, total_bytes: total, latest_mtime: latest ? new Date(latest).toISOString() : null };
}

function gatherSystem(): BridgeStatus['system'] {
	const memTotal = os.totalmem();
	const memFree = os.freemem();
	return {
		uptime_s: Math.round(os.uptime()),
		load: os.loadavg().map((n) => Math.round(n * 100) / 100),
		cpu_count: os.cpus().length,
		cpu_temp_c: cpuTempC(),
		mem_total_bytes: memTotal,
		mem_used_bytes: memTotal - memFree
	};
}

function hostOf(u: string): string {
	try {
		return new URL(u).host;
	} catch {
		return u;
	}
}

/** 전체 현황을 모은다(프로브/시각은 deps 로 주입 가능 — 테스트용). */
export async function buildStatus(config: StatusConfig, deps: StatusDeps = {}): Promise<BridgeStatus> {
	const probe = deps.probe ?? defaultProbe;
	const now = deps.now ?? Date.now();
	const services = await Promise.all(config.services.map((s) => probe(s, config.secret)));
	const disks = [gatherDisk(config.filesDir, '/files'), gatherDisk('/', '/(루트)')].filter(
		(d): d is DiskInfo => d !== null
	);
	return {
		fetched_at: new Date(now).toISOString(),
		system: gatherSystem(),
		disks,
		services,
		files: gatherFiles(config.filesDir),
		connections: {
			spectator_sessions: SpectatorHubRegistry.size(),
			folder_cache: remarkableFoldersCacheSize(),
			hosts_ssh: sshHostCount(),
			hosts_remarkable: remarkableHostCount(),
			hosts_wol: wolHostCount()
		},
		bridge: {
			port: config.port,
			uptime_s: Math.round(process.uptime()),
			node: process.version,
			public_host: hostOf(config.publicBaseUrl)
		}
	};
}

export async function handleStatus(
	req: IncomingMessage,
	res: ServerResponse,
	config: StatusConfig,
	deps?: StatusDeps
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(config.secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}
	const status = await buildStatus(config, deps);
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(status));
}
