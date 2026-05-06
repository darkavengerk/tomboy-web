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
 * Spawn a PTY for the given target.
 *  - Local target → just a login shell on the bridge host.
 *  - Remote target → `ssh user@host -p port`. Auth (key/password) flows
 *    through the PTY directly; we don't broker credentials.
 */
export function spawnForTarget(t: SshTarget, cols: number, rows: number): IPty {
	const isLocal =
		LOCAL_HOSTS.has(t.host) ||
		t.host.toLowerCase() === hostname().toLowerCase();

	const env = sanitizedEnv();
	if (isLocal) {
		const shell = process.env.SHELL || '/bin/bash';
		return spawn(shell, ['-l'], {
			name: 'xterm-256color',
			cols,
			rows,
			cwd: process.env.HOME || '/',
			env
		});
	}

	const args: string[] = [];
	if (t.port) args.push('-p', String(t.port));
	args.push('-o', 'StrictHostKeyChecking=accept-new');
	args.push(t.user ? `${t.user}@${t.host}` : t.host);
	return spawn('ssh', args, {
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
