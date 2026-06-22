import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractBearer, verifyToken } from './auth.js';

/**
 * GET /status/diary — 일기 파이프라인 상세(브릿지 대시보드 드릴다운).
 *
 *  - inbox: 마운트된 diary inbox 를 직접 glob → push 신선도 + 폴더별 backlog.
 *           (index.json 은 0600 diary-sync 라 못 읽으므로 glob 으로 동일 정보 산출.)
 *  - ocr:   desktop trigger_server GET /status 를 프록시 → 마지막 OCR 실행/로그 꼬리.
 *
 * best-effort: 한쪽이 실패해도 200 + 부분 데이터. 인증 실패만 401.
 */

const PROBE_TIMEOUT_MS = 2500;
const LOG_TAIL_LINES = 12;

export interface DiaryStatusConfig {
	secret: string;
	inboxDir: string; // DIARY_INBOX_DIR (마운트 경로)
	triggerUrl: string; // DIARY_TRIGGER_URL ('' = unconfigured)
	triggerToken: string; // DIARY_TRIGGER_TOKEN
}

export interface DiaryFolderInfo {
	folder: string;
	count: number;
	newest_mtime: string | null;
}

export interface DiaryInbox {
	count: number;
	newest_mtime: string | null;
	stale_minutes: number | null;
	per_folder: DiaryFolderInfo[];
	error?: string;
}

export interface DiaryOcr {
	status: 'ok' | 'unconfigured' | 'unreachable';
	running?: boolean;
	last_run_at?: string | null;
	exit_code?: number | null;
	result?: 'success' | 'failed' | 'running' | 'unknown';
	summary?: string | null;
	log_tail?: string;
}

export interface DiaryDetail {
	fetched_at: string;
	inbox: DiaryInbox;
	ocr: DiaryOcr;
}

export interface DiaryStatusDeps {
	fetchTrigger?: (url: string, token: string) => Promise<unknown>;
	now?: number;
}

export function gatherDiaryInbox(inboxDir: string, now: number): DiaryInbox {
	let entries: string[];
	try {
		entries = readdirSync(inboxDir);
	} catch {
		return { count: 0, newest_mtime: null, stale_minutes: null, per_folder: [], error: 'inbox 미마운트/읽기 실패' };
	}
	const buckets = new Map<string, { count: number; newest: number }>();
	let count = 0;
	let newest = 0;
	for (const name of entries) {
		if (!name.endsWith('.rm')) continue;
		const uuid = name.slice(0, -3);
		let mtime = 0;
		try {
			mtime = statSync(join(inboxDir, name)).mtimeMs;
		} catch {
			continue;
		}
		count++;
		if (mtime > newest) newest = mtime;
		let folder = '기타';
		try {
			const meta = JSON.parse(readFileSync(join(inboxDir, `${uuid}.metadata`), 'utf8'));
			if (typeof meta.sourceFolder === 'string' && meta.sourceFolder) folder = meta.sourceFolder;
		} catch {
			/* sourceFolder 없으면 기타 */
		}
		const b = buckets.get(folder) ?? { count: 0, newest: 0 };
		b.count++;
		if (mtime > b.newest) b.newest = mtime;
		buckets.set(folder, b);
	}
	const per_folder: DiaryFolderInfo[] = [...buckets.entries()]
		.map(([folder, b]) => ({
			folder,
			count: b.count,
			newest_mtime: b.newest ? new Date(b.newest).toISOString() : null
		}))
		.sort((a, b) => b.count - a.count);
	return {
		count,
		newest_mtime: newest ? new Date(newest).toISOString() : null,
		stale_minutes: newest ? Math.round((now - newest) / 60000) : null,
		per_folder
	};
}

async function defaultFetchTrigger(url: string, token: string): Promise<unknown> {
	const res = await fetch(url.replace(/\/$/, '') + '/status', {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
	});
	// 비-2xx(토큰 오류=401, 서버 오류=5xx 등)는 본문이 JSON 이 아닐 수 있으니 res.json()
	// 시도 전에 던진다. phase 1 은 인증 실패와 도달 불가를 의도적으로 같은 'unreachable'
	// 로 합친다(세분화는 후속 — DiaryOcr.status 유니온이 앱 타입까지 번지므로).
	if (!res.ok) throw new Error(`trigger /status ${res.status}`);
	return res.json();
}

function summarizeStdout(tail: string): string | null {
	const lines = tail
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	const priority = /Push complete|page\(s\)|Wrote|OCR|Error|Traceback|skip/i;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (priority.test(lines[i])) return lines[i];
	}
	return lines.length ? lines[lines.length - 1] : null;
}

function tailLines(s: string, n: number): string {
	return s
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.slice(-n)
		.join('\n');
}

export async function gatherDiaryOcr(config: DiaryStatusConfig, deps: DiaryStatusDeps): Promise<DiaryOcr> {
	if (!config.triggerUrl) return { status: 'unconfigured' };
	const fetchTrigger = deps.fetchTrigger ?? defaultFetchTrigger;
	let raw: Record<string, unknown>;
	try {
		raw = (await fetchTrigger(config.triggerUrl, config.triggerToken)) as Record<string, unknown>;
	} catch {
		return { status: 'unreachable' };
	}
	if (!raw || typeof raw !== 'object') return { status: 'unreachable' };
	const running = !!raw.running;
	const stdout = typeof raw.stdoutTail === 'string' ? raw.stdoutTail : '';
	const stderr = typeof raw.stderrTail === 'string' ? raw.stderrTail : '';
	const exit = typeof raw.exitCode === 'number' ? raw.exitCode : null;
	let result: DiaryOcr['result'] = 'unknown';
	if (running) result = 'running';
	else if (exit === 0) result = 'success';
	else if (typeof exit === 'number') result = 'failed';
	const finishedAt = typeof raw.finishedAt === 'string' ? raw.finishedAt : null;
	const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : null;
	return {
		status: 'ok',
		running,
		last_run_at: finishedAt ?? startedAt,
		exit_code: exit,
		result,
		summary: summarizeStdout(stdout),
		log_tail: tailLines([stdout, stderr].filter(Boolean).join('\n'), LOG_TAIL_LINES)
	};
}

export async function buildDiaryStatus(config: DiaryStatusConfig, deps: DiaryStatusDeps = {}): Promise<DiaryDetail> {
	const now = deps.now ?? Date.now();
	const [inbox, ocr] = await Promise.all([
		Promise.resolve(gatherDiaryInbox(config.inboxDir, now)),
		gatherDiaryOcr(config, deps)
	]);
	return { fetched_at: new Date(now).toISOString(), inbox, ocr };
}

export async function handleDiaryStatus(
	req: IncomingMessage,
	res: ServerResponse,
	config: DiaryStatusConfig,
	deps?: DiaryStatusDeps
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(config.secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}
	const detail = await buildDiaryStatus(config, deps);
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(detail));
}
