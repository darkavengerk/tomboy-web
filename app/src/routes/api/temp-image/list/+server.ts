import { list } from '@vercel/blob';
import type { RequestEvent } from './$types.js';
import { requireBearerOrResponse } from '../_lib/auth.js';

export const prerender = false;

// Must match the pathname prefix used by lib/sync/tempImageUpload.ts.
const PREFIX = 'temp-images/';
const LIMIT = 1000;

/**
 * List blobs under the `temp-images/` prefix. Used by the admin inventory
 * page to detect orphaned temporary images (uploaded but never promoted to
 * a permanent URL by the note-save flow).
 *
 * Response: `{ items: [{ url, pathname, size, uploadedAt }], hasMore }`
 */
export async function GET({ request }: RequestEvent): Promise<Response> {
  const authError = requireBearerOrResponse(request);
  if (authError) return authError;

  try {
    const result = await list({ prefix: PREFIX, limit: LIMIT });
    const items = result.blobs.map((b) => ({
      url: b.url,
      pathname: b.pathname,
      size: b.size,
      uploadedAt:
        b.uploadedAt instanceof Date ? b.uploadedAt.toISOString() : String(b.uploadedAt)
    }));
    return new Response(JSON.stringify({ items, hasMore: Boolean(result.hasMore) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Blob list failed: ${msg}`, { status: 502 });
  }
}
