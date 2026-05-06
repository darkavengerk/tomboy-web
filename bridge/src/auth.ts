import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOKEN_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

/**
 * Token format: `<issuedAtMs>.<hex hmac>`. The HMAC binds the issuance time
 * so we can verify integrity and enforce expiration server-side without
 * keeping any session state. Identical scheme to the previous cookie
 * implementation — only the transport changed (Bearer header / WS message
 * instead of Set-Cookie).
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
	if (now - issued > TOKEN_MAX_AGE_SEC * 1000) return false;
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

/** Constant-time password compare (UTF-8). */
export function passwordMatches(provided: string, expected: string): boolean {
	const a = Buffer.from(provided, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Extract a Bearer token from an `Authorization: Bearer <token>` header.
 * Returns undefined if the header is absent or malformed.
 */
export function extractBearer(authorization: string | undefined): string | undefined {
	if (!authorization) return undefined;
	const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
	return m ? m[1] : undefined;
}
