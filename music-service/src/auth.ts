// keep in sync with automation-service/src/auth.ts (timing-safe bearer compare)

/**
 * For test use: returns the token that verifyToken(secret, token) accepts.
 * In this simple scheme the token IS the shared secret (personal-use service).
 */
export function mintToken(secret: string): string {
  return secret;
}

export function extractBearer(authHeader?: string): string {
  if (!authHeader) return '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1].trim() : '';
}

export function verifyToken(secret: string, token: string): boolean {
  if (!secret || !token) return false;
  // Constant-time compare: not strictly needed for personal-use service,
  // but cheap insurance.
  if (secret.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
