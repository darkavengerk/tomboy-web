import { describe, it, expect } from 'vitest';
import { inlineImageUrls, ImageFetchError } from '../src/imageInline.js';
import type { AnthropicMessage } from '../src/runner.js';

function fakeFetch(map: Record<string, { status: number; body?: Uint8Array; contentType?: string }>): typeof fetch {
  return async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = map[url];
    if (!r) throw new Error(`no fake for ${url}`);
    return new Response(r.body ?? new Uint8Array(0), {
      status: r.status,
      headers: { 'content-type': r.contentType ?? 'application/octet-stream' },
    });
  };
}

describe('inlineImageUrls', () => {
  it('passes through text blocks unchanged', async () => {
    const msgs: AnthropicMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    const out = await inlineImageUrls(msgs, { fetchFn: fakeFetch({}) });
    expect(out).toEqual(msgs);
  });

  it('passes through image/base64 blocks unchanged', async () => {
    const msgs: AnthropicMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAA=' },
          },
        ],
      },
    ];
    const out = await inlineImageUrls(msgs, { fetchFn: fakeFetch({}) });
    expect(out).toEqual(msgs);
  });

  it('fetches image/url and converts to base64', async () => {
    const url = 'https://example.test/x.png';
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const out = await inlineImageUrls(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image', source: { type: 'url', url } },
          ],
        },
      ],
      {
        fetchFn: fakeFetch({
          [url]: { status: 200, body: bytes, contentType: 'image/png' },
        }),
      },
    );
    expect(out[0].content[0]).toEqual({ type: 'text', text: 'see' });
    const img = out[0].content[1];
    expect(img.type).toBe('image');
    if (img.type !== 'image' || img.source.type !== 'base64') {
      throw new Error('expected base64 source');
    }
    expect(img.source.media_type).toBe('image/png');
    expect(img.source.data).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('strips charset suffix from content-type', async () => {
    const url = 'https://example.test/y.jpg';
    const out = await inlineImageUrls(
      [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url } }],
        },
      ],
      {
        fetchFn: fakeFetch({
          [url]: { status: 200, contentType: 'image/jpeg; charset=binary' },
        }),
      },
    );
    const img = out[0].content[0];
    if (img.type !== 'image' || img.source.type !== 'base64') {
      throw new Error('expected base64 source');
    }
    expect(img.source.media_type).toBe('image/jpeg');
  });

  it('throws ImageFetchError on non-200 response', async () => {
    const url = 'https://example.test/missing.png';
    await expect(
      inlineImageUrls(
        [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url } }],
          },
        ],
        { fetchFn: fakeFetch({ [url]: { status: 404 } }) },
      ),
    ).rejects.toBeInstanceOf(ImageFetchError);
  });

  it('throws ImageFetchError on fetch network failure', async () => {
    await expect(
      inlineImageUrls(
        [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'https://nope/' } },
            ],
          },
        ],
        {
          fetchFn: async () => {
            throw new Error('ENOTFOUND');
          },
        },
      ),
    ).rejects.toBeInstanceOf(ImageFetchError);
  });

  it('enforces maxBytesPerImage', async () => {
    const url = 'https://example.test/big.png';
    await expect(
      inlineImageUrls(
        [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url } }],
          },
        ],
        {
          fetchFn: fakeFetch({
            [url]: { status: 200, body: new Uint8Array(2000), contentType: 'image/png' },
          }),
          maxBytesPerImage: 1000,
        },
      ),
    ).rejects.toBeInstanceOf(ImageFetchError);
  });
});
