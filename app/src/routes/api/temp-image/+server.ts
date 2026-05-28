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
class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function POST({ request }: RequestEvent): Promise<Response> {
  const expected = env.IMAGE_STORAGE_TOKEN ?? '';
  if (!expected) {
    return new Response('IMAGE_STORAGE_TOKEN not configured (500)', { status: 500 });
  }

  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      // The SDK passes our `clientPayload` (from `client.upload()`) to this
      // callback as the second arg. Top-level `body.clientPayload` is empty
      // — the SDK nests it under `body.payload.clientPayload`. handleUpload
      // routes here only for `blob.generate-client-token`; the signed
      // `blob.upload-completed` callback path verifies via BLOB_READ_WRITE_TOKEN
      // inside the SDK and doesn't need our bearer.
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        let token = '';
        try {
          token = (JSON.parse(clientPayload ?? '') as { token?: string }).token ?? '';
        } catch {
          throw new AuthError('Malformed clientPayload');
        }
        if (token !== expected) {
          throw new AuthError('Unauthorized');
        }
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          addRandomSuffix: false,
          tokenPayload: JSON.stringify({ scope: TOKEN_SCOPE })
        };
      },
      onUploadCompleted: async () => {
        // No side-effect — note already holds the URL by the time upload completes.
      }
    });
    return new Response(JSON.stringify(jsonResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return new Response(`${err.message} (401)`, { status: 401 });
    }
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
