import { createHmac } from 'node:crypto';

/**
 * 브릿지 /files 업로드용 토큰 발급. 브릿지의 verifyToken 은 HMAC(`<issuedAtMs>.<hmacHex>`)을
 * 요구하므로 raw secret 으로는 인증 실패한다. BRIDGE_SHARED_TOKEN === BRIDGE_SECRET 이라
 * 이 비밀로 HMAC 서명하면 브릿지가 검증한다. 형식은 bridge/src/auth.ts 와 동일.
 */
export function mintBridgeToken(secret: string, now = Date.now()): string {
	const issuedAt = String(now);
	const sig = createHmac('sha256', secret).update(issuedAt).digest('hex');
	return `${issuedAt}.${sig}`;
}
