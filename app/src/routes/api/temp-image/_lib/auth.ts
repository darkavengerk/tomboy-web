import { env } from '$env/dynamic/private';

/**
 * Verify `Authorization: Bearer <token>` matches the expected token.
 *
 * Throws a `BearerError` (subclass of Error) whose `.status` and `.message`
 * carry the HTTP status code. Endpoint handlers catch this and re-throw as
 * a proper `Response` so SvelteKit uses it as the HTTP response.
 *
 * The message always contains the numeric status code (e.g. "(401)") so that
 * `expect(fn).toThrow(/401/)` assertions work in unit tests.
 */
export class BearerError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`${detail} (${status})`);
    this.status = status;
  }
}

export function requireBearer(request: Request, expected: string): void {
  if (!expected) {
    throw new BearerError(500, 'IMAGE_STORAGE_TOKEN not configured');
  }
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    throw new BearerError(401, 'Unauthorized');
  }
  const token = header.slice('Bearer '.length).trim();
  if (token !== expected) {
    throw new BearerError(401, 'Unauthorized');
  }
}

/**
 * Run the standard `Authorization: Bearer ...` check using
 * `IMAGE_STORAGE_TOKEN` as the expected value. Returns a Response to send
 * back if auth fails, or `null` if the request is authorised.
 * Non-BearerError surprises (e.g. env var unset) propagate to SvelteKit's
 * error handler.
 */
export function requireBearerOrResponse(request: Request): Response | null {
  try {
    requireBearer(request, env.IMAGE_STORAGE_TOKEN ?? '');
    return null;
  } catch (err) {
    if (err instanceof BearerError) {
      return new Response(err.message, { status: err.status });
    }
    throw err;
  }
}
