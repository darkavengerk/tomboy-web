import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';
import {
	lookupRemarkableHost,
	remarkableHostsConfigured,
	type RemarkableHost
} from './remarkableHosts.js';

/**
 * 노트 → 리마커블 PDF 송출용 폴더 트리 조회.
 *
 * SSH 한 번으로 `/home/root/.local/share/remarkable/xochitl/*.metadata` 를 묶어
 * cat 하고, CollectionType (= 폴더) 만 추출해 경로(`/Foo/Bar`) 와 함께 돌려준다.
 * 별칭별로 짧게 메모리 캐시 — 폴더 작업이 잦지 않다는 가정. `refresh=1` 로 무효화.
 */

export interface RemarkableFolder {
	uuid: string;
	visibleName: string;
	parent: string;
	/** 최상위부터 내려오는 표시 경로, 예: "/Tomboy/Notes". 루트 폴더는 "/Tomboy". */
	path: string;
}

export interface FoldersDeps {
	hostsConfigured(): boolean;
	resolveHost(alias: string): RemarkableHost | null;
	fetchRawMetadata(host: RemarkableHost): Promise<string>;
}

export interface FoldersOutcome {
	status: number;
	body: { folders?: RemarkableFolder[]; error?: string };
}

const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
	folders: RemarkableFolder[];
	cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** 테스트 사이 격리용 — 캐시 전체 비우기. */
export function _resetRemarkableFoldersCache(): void {
	cache.clear();
}

export interface FoldersRequestInput {
	token: string | undefined;
	secret: string;
	alias: string | null;
	refresh: boolean;
	deps: FoldersDeps;
	now?: number;
}

export async function processFoldersRequest(
	input: FoldersRequestInput
): Promise<FoldersOutcome> {
	if (!verifyToken(input.secret, input.token)) {
		return { status: 401, body: { error: 'unauthorized' } };
	}
	if (!input.deps.hostsConfigured()) {
		return { status: 503, body: { error: 'remarkable_not_configured' } };
	}
	const alias = (input.alias ?? '').trim();
	if (!alias) return { status: 400, body: { error: 'missing_alias' } };
	const host = input.deps.resolveHost(alias);
	if (!host) return { status: 400, body: { error: 'unknown_alias' } };

	const now = input.now ?? Date.now();
	if (!input.refresh) {
		const hit = cache.get(alias);
		if (hit && now - hit.cachedAt < CACHE_TTL_MS) {
			return { status: 200, body: { folders: hit.folders } };
		}
	}
	let raw: string;
	try {
		raw = await input.deps.fetchRawMetadata(host);
	} catch (err) {
		return {
			status: 502,
			body: { error: `remote_failure: ${(err as Error).message.slice(0, 200)}` }
		};
	}
	const folders = parseFoldersFromRawMetadata(raw);
	cache.set(alias, { folders, cachedAt: now });
	return { status: 200, body: { folders } };
}

/**
 * fetchRawMetadata 의 결과(`###<uuid>.metadata\n<json>\n###...`)를 파싱.
 * CollectionType 만 추리고 deleted 는 제외. 경로는 parent 체인을 따라 구성하며,
 * 사이클이 생기면 마지막으로 본 노드의 visibleName 만 잘라낸다(안전 가드).
 */
export function parseFoldersFromRawMetadata(raw: string): RemarkableFolder[] {
	const segments = raw.split(/\r?\n###/);
	// 첫 segment 가 빈 prefix 일 수도, 첫 ### 가 빠진 텍스트일 수도. 일관 처리 위해
	// 맨 앞에 '###' 가 있으면 제거.
	if (segments[0]?.startsWith('###')) segments[0] = segments[0].slice(3);

	type Parsed = { uuid: string; visibleName: string; parent: string };
	const collected: Parsed[] = [];
	for (const seg of segments) {
		const trimmed = seg.replace(/^###/, '');
		const nl = trimmed.indexOf('\n');
		if (nl === -1) continue;
		const head = trimmed.slice(0, nl).trim();
		const body = trimmed.slice(nl + 1);
		const m = head.match(/^([0-9a-fA-F-]{8,})\.metadata$/);
		if (!m) continue;
		const uuid = m[1];
		let parsed: {
			type?: string;
			visibleName?: string;
			parent?: string;
			deleted?: boolean;
		};
		try {
			parsed = JSON.parse(body);
		} catch {
			continue;
		}
		if (parsed.type !== 'CollectionType') continue;
		if (parsed.deleted) continue;
		collected.push({
			uuid,
			visibleName: parsed.visibleName ?? '(이름 없음)',
			parent: parsed.parent ?? ''
		});
	}

	const byUuid = new Map(collected.map((f) => [f.uuid, f]));
	function pathOf(f: Parsed, seen: Set<string>): string {
		if (seen.has(f.uuid)) return '';
		seen.add(f.uuid);
		// trash 는 .metadata 가 없는 가상의 부모 — 루트 취급. self-parent 도 root.
		if (!f.parent || f.parent === 'trash' || f.parent === f.uuid) {
			return `/${f.visibleName}`;
		}
		const parent = byUuid.get(f.parent);
		if (!parent) return `/${f.visibleName}`;
		return `${pathOf(parent, seen)}/${f.visibleName}`;
	}

	return collected
		.map((f) => ({
			uuid: f.uuid,
			visibleName: f.visibleName,
			parent: f.parent,
			path: pathOf(f, new Set())
		}))
		.sort((a, b) => a.path.localeCompare(b.path, 'ko'));
}

// ─── 실 SSH 의존성 ─────────────────────────────────────────────────────────

const XOCHITL_DIR = '/home/root/.local/share/remarkable/xochitl';

function runSshCapture(host: RemarkableHost, remoteCmd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = [
			'-o', 'BatchMode=yes',
			'-o', 'StrictHostKeyChecking=accept-new',
			'-o', 'ConnectTimeout=8'
		];
		if (host.keyPath) args.push('-i', host.keyPath);
		if (host.port) args.push('-p', String(host.port));
		args.push(`${host.user}@${host.host}`, remoteCmd);
		const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const chunks: Buffer[] = [];
		let stderr = '';
		child.stdout.on('data', (d) => chunks.push(d as Buffer));
		child.stderr.on('data', (d) => {
			stderr += d.toString();
		});
		child.on('error', (err) => reject(err));
		child.on('close', (code) => {
			if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
			else reject(new Error(`ssh exit ${code}: ${stderr.trim().slice(0, 200)}`));
		});
	});
}

export async function realFetchRawMetadata(host: RemarkableHost): Promise<string> {
	// 모든 .metadata 를 한 SSH 호출로 묶어 cat. XOCHITL_DIR 는 고정 — 셸 주입 위험 없음.
	const cmd =
		`cd '${XOCHITL_DIR}' && for f in *.metadata; do echo "###$f"; cat "$f"; echo; done`;
	return runSshCapture(host, cmd);
}

export function realFoldersDeps(): FoldersDeps {
	return {
		hostsConfigured: remarkableHostsConfigured,
		resolveHost: lookupRemarkableHost,
		fetchRawMetadata: realFetchRawMetadata
	};
}

// ─── HTTP 핸들러 ──────────────────────────────────────────────────────────

export async function handleRemarkableFolders(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	const u = new URL(req.url ?? '/', 'http://localhost/');
	const alias = u.searchParams.get('alias');
	const refresh =
		u.searchParams.get('refresh') === '1' || u.searchParams.get('refresh') === 'true';
	const outcome = await processFoldersRequest({
		token,
		secret,
		alias,
		refresh,
		deps: realFoldersDeps()
	});
	console.log(
		`[term-bridge rm] folders alias=${alias ?? '-'} refresh=${refresh} ` +
			`status=${outcome.status} count=${outcome.body.folders?.length ?? 0}`
	);
	res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(outcome.body));
}
