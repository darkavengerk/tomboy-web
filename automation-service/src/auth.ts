export function extractBearer(authHeader?: string): string {
  if (!authHeader) return '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1].trim() : '';
}

export function verifyToken(secret: string, token: string): boolean {
  if (!secret || !token) return false;
  if (secret.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
