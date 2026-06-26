import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractBearer, verifyToken } from './auth.js';
import { isLocalTarget, buildSshExecArgs, type SshTarget } from './pty.js';

const execFileP = promisify(execFile);

export interface SessionInfo {
	name: string;
	windows: number;
	attached: boolean;
	activity: number;
	command: string;
}

// 7 탭 구분 필드. listSessions 의 원격 경로가 이 문자열을 작은따옴표로 감싸
// ssh 원격 셸에 한 토큰으로 넘긴다 — 절대 작은따옴표(')를 포함하지 말 것.
// 포함하면 셸 따옴표가 깨져 -F 인자가 조용히 잘린다. 리터럴 탭은 안전.
const PANE_FMT =
	'#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_activity}\t#{window_active}\t#{pane_active}\t#{pane_current_command}';

export function parseSessionList(stdout: string): SessionInfo[] {
	const bySession = new Map<string, SessionInfo>();
	const order: string[] = [];
	for (const rawLine of stdout.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (!line) continue;
		const parts = line.split('\t');
		if (parts.length < 7) continue;
		const [name, winsRaw, attachedRaw, activityRaw, winActive, paneActive, command] = parts;
		if (!name) continue;
		if (!bySession.has(name)) {
			bySession.set(name, {
				name,
				windows: Number(winsRaw) || 0,
				attached: attachedRaw === '1',
				activity: Number(activityRaw) || 0,
				command: ''
			});
			order.push(name);
		}
		if (winActive === '1' && paneActive === '1') {
			bySession.get(name)!.command = command ?? '';
		}
	}
	return order.map((n) => bySession.get(n)!);
}

const NAME_RE = /^[^-\s/@:][^\s/@:]*$/;

export function coerceTarget(raw: unknown): SshTarget | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	const host = typeof o.host === 'string' ? o.host : '';
	if (!NAME_RE.test(host)) return null;
	let user: string | undefined;
	if (o.user !== undefined && o.user !== null) {
		if (typeof o.user !== 'string' || !NAME_RE.test(o.user)) return null;
		user = o.user;
	}
	let port: number | undefined;
	if (o.port !== undefined && o.port !== null) {
		const p = Number(o.port);
		if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
		port = p;
	}
	return { host, user, port };
}

export async function listSessions(t: SshTarget): Promise<SessionInfo[]> {
	const opts = { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 } as const;
	try {
		let stdout: string;
		if (isLocalTarget(t)) {
			({ stdout } = await execFileP('tmux', ['list-panes', '-a', '-F', PANE_FMT], opts));
		} else {
			const args = buildSshExecArgs(t, undefined, `tmux list-panes -a -F '${PANE_FMT}'`);
			({ stdout } = await execFileP('ssh', args, opts));
		}
		return parseSessionList(stdout);
	} catch (err) {
		const stderr = String((err as { stderr?: unknown }).stderr ?? '');
		if (/no server running/i.test(stderr)) return [];
		throw err;
	}
}

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

export async function handleSessionList(req: IncomingMessage, res: ServerResponse, secret: string): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}
	let body: { target?: unknown };
	try {
		body = (await readJson(req)) as { target?: unknown };
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_json' }));
		return;
	}
	const target = coerceTarget(body.target);
	if (!target) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_request', detail: 'invalid_target' }));
		return;
	}
	try {
		const sessions = await listSessions(target);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ sessions }));
	} catch (err) {
		console.warn(`[term-bridge sessions] ${(err as Error).message}`);
		res.writeHead(502, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unreachable' }));
	}
}
