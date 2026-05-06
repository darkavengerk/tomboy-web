import { getSetting, setSetting } from '$lib/storage/appSettings.js';

const KEY = 'defaultTerminalBridge';

export async function getDefaultTerminalBridge(): Promise<string | undefined> {
	const v = await getSetting<string>(KEY);
	return v && typeof v === 'string' ? v : undefined;
}

export async function setDefaultTerminalBridge(value: string | undefined): Promise<void> {
	await setSetting(KEY, value ?? '');
}

/**
 * Convert any of {wss://host[/path], https://host[/path], host[/path]} into
 * the HTTPS origin we POST to for /login. The wsClient does a similar
 * conversion in the other direction.
 */
export function bridgeToHttpsBase(bridge: string): string {
	const trimmed = bridge.trim();
	let u: URL;
	if (/^https?:\/\//i.test(trimmed)) {
		u = new URL(trimmed);
	} else if (/^wss:\/\//i.test(trimmed)) {
		u = new URL('https://' + trimmed.slice('wss://'.length));
	} else if (/^ws:\/\//i.test(trimmed)) {
		u = new URL('http://' + trimmed.slice('ws://'.length));
	} else {
		u = new URL('https://' + trimmed);
	}
	// Strip any trailing path; /login is appended by the caller.
	u.pathname = '';
	u.search = '';
	u.hash = '';
	return u.toString().replace(/\/$/, '');
}

export async function loginBridge(bridge: string, password: string): Promise<boolean> {
	const base = bridgeToHttpsBase(bridge);
	const res = await fetch(base + '/login', {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password })
	});
	return res.ok;
}

export async function logoutBridge(bridge: string): Promise<void> {
	const base = bridgeToHttpsBase(bridge);
	await fetch(base + '/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
}

export async function checkBridgeAuth(bridge: string): Promise<boolean> {
	const base = bridgeToHttpsBase(bridge);
	try {
		const res = await fetch(base + '/health', { credentials: 'include' });
		if (!res.ok) return false;
		const data = (await res.json()) as { authed?: boolean };
		return !!data.authed;
	} catch {
		return false;
	}
}
