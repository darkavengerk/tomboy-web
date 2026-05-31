/**
 * Client-side wrapper around `/api/temp-image/*` endpoints.
 *
 * Flow:
 *   uploadTempImage(file)
 *     1. read Bearer token from appSettings
 *     2. call @vercel/blob/client.upload() with our handleUploadUrl
 *        and the token in clientPayload — the server endpoint extracts
 *        the token from the request, validates it, and only then mints
 *        the single-use Vercel client token
 *     3. browser PUTs the bytes directly to Vercel Blob
 *     4. return the resulting URL
 *
 * Storage layout: `temp-images/{uuid}.{ext}` — extension preserved so
 * the blob serves the right Content-Type when used as <img src>.
 */

import { upload } from '@vercel/blob/client';
import { getImageStorageToken } from '$lib/storage/appSettings.js';
import { fileExtension } from '$lib/utils/fileExtension.js';
import { prime as cachePrime } from '$lib/imageCache/imageCache.js';

export interface TempImageListItem {
  url: string;
  pathname: string;
  size: number;
  uploadedAt: string;
}

export interface TempImageListResult {
  items: TempImageListItem[];
  hasMore: boolean;
}

function buildPathname(file: File): string {
  // The `temp-images/` prefix MUST match `PREFIX` in
  // app/src/routes/api/temp-image/list/+server.ts. If one drifts, the
  // list endpoint silently returns nothing for blobs uploaded here.
  return `temp-images/${crypto.randomUUID()}.${fileExtension(file)}`;
}

async function requireToken(): Promise<string> {
  const t = await getImageStorageToken();
  if (!t) {
    throw new Error(
      '이미지 서버 토큰이 설정되지 않았습니다. 설정 페이지에서 토큰을 입력하세요.'
    );
  }
  return t;
}

/**
 * Upload a file to Vercel Blob's temp-images namespace and return the
 * resulting public URL.
 */
export async function uploadTempImage(file: File): Promise<string> {
  const token = await requireToken();
  const pathname = buildPathname(file);

  const result = await upload(pathname, file, {
    access: 'public',
    handleUploadUrl: '/api/temp-image',
    // The server-side handleUpload sees clientPayload as the JSON string we
    // pass here. The @vercel/blob/client.upload() helper doesn't expose a
    // way to customise the Authorization header (it uses fetch internally),
    // so we route the token through the body instead.
    clientPayload: JSON.stringify({ token })
  });

  cachePrime(result.url, file, file.type).catch((e) => {
    console.warn('[imageCache] uploadTempImage prime 실패:', e);
  });

  return result.url;
}

/**
 * Delete a temp blob by URL.
 */
export async function deleteTempImage(url: string): Promise<void> {
  const token = await requireToken();
  const target = `/api/temp-image?url=${encodeURIComponent(url)}`;
  const res = await fetch(target, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`Blob 삭제 실패 (${res.status})`);
  }
}

/**
 * List every blob under `temp-images/`.
 */
export async function listTempImages(): Promise<TempImageListResult> {
  const token = await requireToken();
  const res = await fetch('/api/temp-image/list', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`Blob list 실패 (${res.status})`);
  }
  return (await res.json()) as TempImageListResult;
}
