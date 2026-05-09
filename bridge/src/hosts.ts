import { readFileSync } from 'node:fs';

export interface WolEntry {
	mac: string;
	broadcast?: string;
	wakeTimeoutSec?: number;
}

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

let table: Map<string, WolEntry> = new Map();

export function loadHostsFile(path: string | undefined): void {
	table = new Map();
	if (!path) return;
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			console.log(`[term-bridge] hosts file not found, WOL disabled: ${path}`);
			return;
		}
		console.error(`[term-bridge] failed to read hosts file ${path}:`, err);
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		console.error(`[term-bridge] hosts file is not valid JSON, WOL disabled:`, err);
		return;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		console.error('[term-bridge] hosts file must be an object {host: entry}');
		return;
	}
	for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
		const entry = normalizeEntry(host, value);
		if (entry) table.set(host.toLowerCase(), entry);
	}
	console.log(`[term-bridge] loaded ${table.size} WOL host(s) from ${path}`);
}

function normalizeEntry(host: string, value: unknown): WolEntry | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		console.warn(`[term-bridge] hosts[${host}] must be an object, skipped`);
		return null;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.mac !== 'string' || !MAC_RE.test(v.mac)) {
		console.warn(`[term-bridge] hosts[${host}].mac must be AA:BB:CC:DD:EE:FF, skipped`);
		return null;
	}
	const out: WolEntry = { mac: v.mac.toLowerCase() };
	if (typeof v.broadcast === 'string' && v.broadcast.trim()) {
		out.broadcast = v.broadcast.trim();
	}
	if (typeof v.wakeTimeoutSec === 'number' && v.wakeTimeoutSec > 0) {
		out.wakeTimeoutSec = Math.min(600, Math.floor(v.wakeTimeoutSec));
	}
	return out;
}

export function lookupWolTarget(host: string): WolEntry | null {
	return table.get(host.toLowerCase()) ?? null;
}
