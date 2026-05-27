import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { del } from '@vercel/blob';
import { env } from '$env/dynamic/private';
import type { RequestEvent } from './$types.js';
import { requireBearer, BearerError } from './_lib/auth.js';

export const prerender = false;

const ALLOWED_CONTENT_TYPES = ['image/*'];
const TOKEN_SCOPE = 'temp-image';

/**
 * Run the standard `Authorization: Bearer ...` check. Returns a Response
 * to send back if auth fails, or `null` if the request is authorised.
 * Non-BearerError surprises (e.g. env var unset) propagate to SvelteKit's
 * error handler.
 */
function requireBearerOrResponse(request: Request): Response | null {
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

/**
 * Mint a single-use client upload token. The browser calls this with our
 * Bearer token, gets back a Vercel Blob client token, and then PUTs the
 * file directly to Vercel storage — bytes never transit through this
 * function.
 *
 * Note: Task 5 will revise this handler to verify the token from
 * `clientPayload` (since `@vercel/blob/client.upload()` doesn't let the
 * caller customise the Authorization header). For now this uses the
 * header — DELETE will continue to use the header path.
 */
export async function POST({ request }: RequestEvent): Promise<Response> {
  const authError = requireBearerOrResponse(request);
  if (authError) return authError;

  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        addRandomSuffix: false,
        tokenPayload: JSON.stringify({ scope: TOKEN_SCOPE })
      }),
      onUploadCompleted: async () => {
        // No side-effect — note already holds the URL by the time upload completes.
      }
    });
    return new Response(JSON.stringify(jsonResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Blob token mint failed: ${msg}`, { status: 502 });
  }
}

/**
 * Delete a blob by URL. 204 on success, 400 on missing query, 502 on
 * SDK error.
 */
export async function DELETE({ request, url }: RequestEvent): Promise<Response> {
  const authError = requireBearerOrResponse(request);
  if (authError) return authError;

  const target = url.searchParams.get('url');
  if (!target) {
    return new Response('Missing ?url= query parameter', { status: 400 });
  }

  try {
    await del(target);
    return new Response(null, { status: 204 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Blob delete failed: ${msg}`, { status: 502 });
  }
}
