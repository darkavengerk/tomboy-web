import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { setImageStorageToken } from '$lib/storage/appSettings.js';

// Mock @vercel/blob/client.upload BEFORE importing the module under test.
const uploadMock = vi.fn();
vi.mock('@vercel/blob/client', () => ({
  upload: (...args: unknown[]) => uploadMock(...args)
}));

import {
  uploadTempImage,
  deleteTempImage,
  listTempImages
} from '$lib/sync/tempImageUpload.js';

const origFetch = globalThis.fetch;

describe('tempImageUpload', () => {
  beforeEach(async () => {
    uploadMock.mockReset();
    await setImageStorageToken('test-token');
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('throws when token unset', async () => {
    await setImageStorageToken('');
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    await expect(uploadTempImage(file)).rejects.toThrow(/토큰/);
  });

  it('calls @vercel/blob upload with temp-images prefix + Bearer in clientPayload', async () => {
    uploadMock.mockResolvedValue({ url: 'https://blob/temp-images/abc.png' });
    const file = new File(['x'], 'a.png', { type: 'image/png' });

    const url = await uploadTempImage(file);

    expect(url).toBe('https://blob/temp-images/abc.png');
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [pathname, body, opts] = uploadMock.mock.calls[0] as [string, File, Record<string, unknown>];
    expect(pathname).toMatch(/^temp-images\/[0-9a-f-]+\.png$/i);
    expect(body).toBe(file);
    expect(opts.access).toBe('public');
    expect(opts.handleUploadUrl).toBe('/api/temp-image');
    expect(opts.clientPayload).toContain('test-token');
  });

  it('preserves jpeg extension', async () => {
    uploadMock.mockResolvedValue({ url: 'x' });
    const file = new File(['x'], 'photo.JPEG', { type: 'image/jpeg' });
    await uploadTempImage(file);
    const [pathname] = uploadMock.mock.calls[0] as [string];
    expect(pathname).toMatch(/\.jpeg$/);
  });

  it('deleteTempImage hits DELETE with Bearer + url query', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;

    await deleteTempImage('https://blob/temp-images/abc.png');

    const [calledUrl, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toContain('/api/temp-image?url=https%3A%2F%2Fblob%2Ftemp-images%2Fabc.png');
    expect((init as RequestInit).method).toBe('DELETE');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-token' });
  });

  it('deleteTempImage throws on non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 502 })) as typeof fetch;
    await expect(deleteTempImage('https://blob/x.png')).rejects.toThrow(/502/);
  });

  it('listTempImages parses JSON response with Bearer auth', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              { url: 'u1', pathname: 'temp-images/a.png', size: 10, uploadedAt: '2026-05-27T00:00:00Z' }
            ],
            hasMore: false
          }),
          { status: 200 }
        )
    ) as typeof fetch;

    const result = await listTempImages();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].url).toBe('u1');
    expect(result.hasMore).toBe(false);

    const [calledUrl, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toContain('/api/temp-image/list');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-token' });
  });
});
