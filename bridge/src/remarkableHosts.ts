import { readFileSync } from 'node:fs';

export interface RemarkableHost {
	/** 브릿지에서 닿는 IP 또는 DNS 이름. */
	host: string;
	/** SSH 사용자 (reMarkable은 'root'). */
	user: string;
	/** SSH 포트. 미지정 시 SSH 호출 측에서 22를 기본값으로 사용. */
	port?: number;
	/** 명시적 개인키 경로. 미지정 시 브릿지의 ~/.ssh 기본 키를 사용. */
	keyPath?: string;
}

let table = new Map<string, RemarkableHost>();

export function loadRemarkableHosts(path: string | undefined): void {
	table = new Map();
	if (!path) return;
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			console.log(`[term-bridge] reMarkable hosts file not found, wallpaper disabled: ${path}`);
		} else {
			console.error(`[term-bridge] failed to read reMarkable hosts file ${path}:`, err);
		}
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		console.error('[term-bridge] reMarkable hosts file is not valid JSON:', err);
		return;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		console.error('[term-bridge] reMarkable hosts file must be an object {alias: entry}');
		return;
	}
	for (const [alias, value] of Object.entries(parsed as Record<string, unknown>)) {
		const entry = normalizeEntry(alias, value);
		// 별칭은 그대로 저장 — reMarkable 별칭은 사용자 정의 키이지 DNS
		// 호스트명이 아니므로, hosts.ts 와 달리 소문자로 접지 않는다.
		if (entry) table.set(alias, entry);
	}
	console.log(`[term-bridge] loaded ${table.size} reMarkable host(s) from ${path}`);
}

function normalizeEntry(alias: string, value: unknown): RemarkableHost | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		console.warn(`[term-bridge] reMarkable hosts[${alias}] must be an object, skipped`);
		return null;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.host !== 'string' || !v.host.trim()) {
		console.warn(`[term-bridge] reMarkable hosts[${alias}].host required, skipped`);
		return null;
	}
	const user = typeof v.user === 'string' && v.user.trim() ? v.user.trim() : 'root';
	const out: RemarkableHost = { host: v.host.trim(), user };
	if (typeof v.port === 'number' && v.port >= 1 && v.port <= 65535) {
		out.port = Math.floor(v.port);
	}
	if (typeof v.keyPath === 'string' && v.keyPath.trim()) {
		out.keyPath = v.keyPath.trim();
	}
	return out;
}

export function lookupRemarkableHost(alias: string): RemarkableHost | null {
	return table.get(alias) ?? null;
}

export function remarkableHostsConfigured(): boolean {
	return table.size > 0;
}

/** 대시보드(`/status`)용 — 등록된 reMarkable 호스트 수. */
export function remarkableHostCount(): number {
	return table.size;
}
