import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { del } from '@vercel/blob';
import { env } from '$env/dynamic/private';
import type { RequestEvent } from './$types.js';
import { requireBearerOrResponse } from './_lib/auth.js';

export const prerender = false;

const ALLOWED_CONTENT_TYPES = ['image/*'];
const TOKEN_SCOPE = 'temp-image';

/**
 * Mint a single-use client upload token. The browser calls this with our
 * token in `clientPayload` (not Authorization header — the
 * `@vercel/blob/client.upload()` helper doesn't let callers customise
 * headers), gets back a Vercel Blob client token, and then PUTs the file
 * directly to Vercel storage — bytes never transit through this function.
 *
 * DELETE continues to use the standard Authorization: Bearer header path.
 */
export async function POST({ request }: RequestEvent): Promise<Response> {
  const body = (await request.json()) as HandleUploadBody & { clientPayload?: string };

  // The @vercel/blob/client.upload() helper can't customise the
  // Authorization header, so the token travels in body.clientPayload
  // instead. DELETE/list (header-based) still use requireBearerOrResponse.
  const expected = env.IMAGE_STORAGE_TOKEN ?? '';
  if (!expected) {
    return new Response('IMAGE_STORAGE_TOKEN not configured (500)', { status: 500 });
  }
  const cp = body.clientPayload;
  if (!cp) {
    return new Response('Missing clientPayload (401)', { status: 401 });
  }
  let token: string;
  try {
    token = (JSON.parse(cp) as { token?: string }).token ?? '';
  } catch {
    return new Response('Malformed clientPayload (401)', { status: 401 });
  }
  if (token !== expected) {
    return new Response('Unauthorized (401)', { status: 401 });
  }

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
