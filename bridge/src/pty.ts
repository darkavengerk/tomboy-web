import { spawn, type IPty } from 'node-pty';
import { hostname } from 'node:os';

export interface SshTarget {
	host: string;
	port?: number;
	user?: string;
}

const SSH_RE = /^ssh:\/\/(?:([^@\s/]+)@)?([^:\s/]+)(?::(\d{1,5}))?\/?\s*$/;

export function parseSshTarget(raw: string): SshTarget | null {
	const m = SSH_RE.exec(raw);
	if (!m) return null;
	const port = m[3] ? Number(m[3]) : undefined;
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
	return { user: m[1] || undefined, host: m[2], port };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * 타깃이 "로컬"인지 — user 없는 localhost/127.0.0.1/::1 또는 브릿지 호스트명.
 * 로컬이면 ssh 없이 브릿지의 로그인 셸을 띄운다.
 */
export function isLocalTarget(t: SshTarget): boolean {
	return (
		!t.user &&
		(LOCAL_HOSTS.has(t.host) || t.host.toLowerCase() === hostname().toLowerCase())
	);
}

/**
 * `ssh` 명령의 argv(ssh 자신 뒤의 인자들)를 구성한다. 순수 함수.
 *
 * `controlPath`가 주어지면 이 연결을 멀티플렉싱 "마스터"로 설정한다 — 같은
 * ControlPath를 가리키는 이후의 `ssh` 호출(imageTransfer.ts)이 이미 인증된 이
 * 연결을 재사용한다. 호스트 인자는 항상 마지막 — OpenSSH는 호스트 뒤의 토큰을
 * 원격 명령으로 취급하므로 옵션은 모두 호스트 앞에 와야 한다.
 */
export function buildSshArgs(t: SshTarget, controlPath?: string): string[] {
	const args: string[] = [];
	if (t.port) args.push('-p', String(t.port));
	args.push('-o', 'StrictHostKeyChecking=accept-new');
	if (controlPath) {
		args.push('-o', 'ControlMaster=auto');
		args.push('-o', `ControlPath=${controlPath}`);
	}
	args.push(t.user ? `${t.user}@${t.host}` : t.host);
	return args;
}

/**
 * 타깃용 PTY를 띄운다.
 *  - 로컬 타깃 → 브릿지 호스트의 로그인 셸.
 *  - 그 외 → `ssh ...`. 인증(키/비번)은 PTY를 통해 직접 흐른다 —
 *    자격증명을 중개하지 않는다.
 *  - `controlPath`가 주어지면 ControlMaster 마스터로 띄운다(이미지 전송용).
 */
export function spawnForTarget(
	t: SshTarget,
	cols: number,
	rows: number,
	controlPath?: string
): IPty {
	const env = sanitizedEnv();
	if (isLocalTarget(t)) {
		const shell = process.env.SHELL || '/bin/bash';
		return spawn(shell, ['-l'], {
			name: 'xterm-256color',
			cols,
			rows,
			cwd: process.env.HOME || '/',
			env
		});
	}
	return spawn('ssh', buildSshArgs(t, controlPath), {
		name: 'xterm-256color',
		cols,
		rows,
		cwd: process.env.HOME || '/',
		env
	});
}

function sanitizedEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === 'string') out[k] = v;
	}
	out.TERM = 'xterm-256color';
	return out;
}
