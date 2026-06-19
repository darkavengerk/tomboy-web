import { readFileSync } from 'node:fs';
import type { SshTarget } from './pty.js';

export interface SshHostAlias {
	/** 브릿지에서 닿는 호스트 (역터널이면 'localhost'). */
	host: string;
	/** SSH 사용자. 미지정 시 SSH 호출 측 기본값. */
	user?: string;
	/** SSH 포트. 역터널 바인드 포트(예: 18022). */
	port?: number;
}

let table = new Map<string, SshHostAlias>();

export function loadSshHosts(path: string | undefined): void {
	table = new Map();
	if (!path) return;
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			console.log(`[term-bridge] ssh-hosts file not found, aliases disabled: ${path}`);
		} else {
			console.error(`[term-bridge] failed to read ssh-hosts file ${path}:`, err);
		}
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		console.error('[term-bridge] ssh-hosts file is not valid JSON:', err);
		return;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		console.error('[term-bridge] ssh-hosts file must be an object {alias: entry}');
		return;
	}
	for (const [alias, value] of Object.entries(parsed as Record<string, unknown>)) {
		const entry = normalizeEntry(alias, value);
		// 별칭은 사용자 정의 키 — 소문자로 접지 않는다 (remarkableHosts 와 동일).
		if (entry) table.set(alias, entry);
	}
	console.log(`[term-bridge] loaded ${table.size} ssh alias(es) from ${path}`);
}

function normalizeEntry(alias: string, value: unknown): SshHostAlias | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		console.warn(`[term-bridge] ssh-hosts[${alias}] must be an object, skipped`);
		return null;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.host !== 'string' || !v.host.trim()) {
		console.warn(`[term-bridge] ssh-hosts[${alias}].host required, skipped`);
		return null;
	}
	const out: SshHostAlias = { host: v.host.trim() };
	if (typeof v.user === 'string' && v.user.trim()) out.user = v.user.trim();
	if (typeof v.port === 'number' && v.port >= 1 && v.port <= 65535) out.port = Math.floor(v.port);
	return out;
}

export function lookupSshHost(alias: string): SshHostAlias | null {
	return table.get(alias) ?? null;
}

/** 대시보드(`/status`)용 — 등록된 SSH 별칭 수. */
export function sshHostCount(): number {
	return table.size;
}

/**
 * 타깃 host가 등록된 별칭이면 alias 엔트리로 치환한다. 노트가 명시한
 * user/port는 별칭값보다 우선 보존한다(ssh://me@phone:9999 → me/9999 유지).
 * 별칭이 아니면 원본을 그대로 반환하고 alias=null.
 */
export function applySshAlias(target: SshTarget): { target: SshTarget; alias: string | null } {
	const entry = lookupSshHost(target.host);
	if (!entry) return { target, alias: null };
	return {
		target: {
			host: entry.host,
			port: target.port ?? entry.port,
			user: target.user ?? entry.user
		},
		alias: target.host
	};
}
