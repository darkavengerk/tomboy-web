import { getSetting, setSetting } from '$lib/storage/appSettings.js';

const URL_KEY = 'defaultTerminalBridge';
const TOKEN_KEY = 'terminalBridgeToken';

export async function getDefaultTerminalBridge(): Promise<string | undefined> {
	const v = await getSetting<string>(URL_KEY);
	return v && typeof v === 'string' ? v : undefined;
}

export async function setDefaultTerminalBridge(value: string | undefined): Promise<void> {
	await setSetting(URL_KEY, value ?? '');
}

export async function getTerminalBridgeToken(): Promise<string | undefined> {
	const v = await getSetting<string>(TOKEN_KEY);
	return v && typeof v === 'string' ? v : undefined;
}

export async function setTerminalBridgeToken(token: string | undefined): Promise<void> {
	await setSetting(TOKEN_KEY, token ?? '');
}

/**
 * Convert any of {wss://host[/path], https://host[/path], host[/path],
 * ws://, http://} into the corresponding HTTP base for /login + /health.
 * The wsClient handles the inverse for the WebSocket URL.
 */
export function bridgeToHttpBase(bridge: string): string {
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
	u.pathname = '';
	u.search = '';
	u.hash = '';
	return u.toString().replace(/\/$/, '');
}

interface LoginResponse {
	token: string;
}

/**
 * POST /login. On success, persists the token to appSettings AND returns
 * it. On failure, leaves any previously-stored token intact.
 */
export async function loginBridge(bridge: string, password: string): Promise<boolean> {
	const base = bridgeToHttpBase(bridge);
	const res = await fetch(base + '/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password })
	});
	if (!res.ok) return false;
	const body = (await res.json().catch(() => null)) as LoginResponse | null;
	if (!body || typeof body.token !== 'string' || !body.token) return false;
	await setTerminalBridgeToken(body.token);
	return true;
}

export async function logoutBridge(): Promise<void> {
	// Bearer tokens are stateless — "logout" just drops the local copy.
	await setTerminalBridgeToken(undefined);
}

/**
 * Probe the bridge with the stored token. Returns true if the server
 * accepts it. Network errors return false silently.
 */
export async function checkBridgeAuth(bridge: string): Promise<boolean> {
	const base = bridgeToHttpBase(bridge);
	const token = await getTerminalBridgeToken();
	if (!token) return false;
	try {
		const res = await fetch(base + '/health', {
			headers: { Authorization: `Bearer ${token}` }
		});
		if (!res.ok) return false;
		const data = (await res.json()) as { authed?: boolean };
		return !!data.authed;
	} catch {
		return false;
	}
}
