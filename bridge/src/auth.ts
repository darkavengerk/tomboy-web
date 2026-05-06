import { createHmac, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'term_auth';
export const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

/**
 * Cookie token format: `<issuedAtMs>.<hex hmac>`. The HMAC binds the
 * issuance time so we can both verify integrity and enforce expiration
 * server-side without keeping any session state.
 */
export function mintToken(secret: string, now = Date.now()): string {
	const issuedAt = String(now);
	const sig = sign(secret, issuedAt);
	return `${issuedAt}.${sig}`;
}

export function verifyToken(secret: string, token: string | undefined, now = Date.now()): boolean {
	if (!token) return false;
	const dot = token.indexOf('.');
	if (dot <= 0) return false;
	const issuedAt = token.slice(0, dot);
	const sig = token.slice(dot + 1);

	const expected = sign(secret, issuedAt);
	if (!constantTimeEqualHex(sig, expected)) return false;

	const issued = Number(issuedAt);
	if (!Number.isFinite(issued) || issued <= 0) return false;
	if (now - issued > COOKIE_MAX_AGE_SEC * 1000) return false;
	return true;
}

function sign(secret: string, payload: string): string {
	return createHmac('sha256', secret).update(payload).digest('hex');
}

function constantTimeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	const ab = Buffer.from(a, 'hex');
	const bb = Buffer.from(b, 'hex');
	if (ab.length !== bb.length || ab.length === 0) return false;
	return timingSafeEqual(ab, bb);
}

/** Parse a Cookie header into a flat lookup. Tolerates RFC-ish quoting. */
export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		const k = part.slice(0, eq).trim();
		let v = part.slice(eq + 1).trim();
		if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		if (k) out[k] = decodeURIComponent(v);
	}
	return out;
}

/** Constant-time password compare (UTF-8). */
export function passwordMatches(provided: string, expected: string): boolean {
	const a = Buffer.from(provided, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
