/**
 * Convert `image/url` content blocks into `image/base64` blocks by fetching
 * the URL server-side. Anthropic's url-source image fetcher honors the
 * target host's robots.txt, which blocks common image hosts (Dropbox
 * `/scl/...`). Base64-source bypasses that entirely.
 *
 * Token cost is unchanged — Anthropic prices images by dimensions, not by
 * the size of the source payload. The trade-off is HTTP body size on the
 * wire between us and Anthropic.
 */

import type { AnthropicMessage } from './runner.js';

export type FetchFn = typeof fetch;

const DEFAULT_MAX_PER_IMAGE = 8 * 1024 * 1024; // 8 MiB raw bytes

export interface InlineOpts {
  fetchFn?: FetchFn;
  maxBytesPerImage?: number;
}

export class ImageFetchError extends Error {
  constructor(public url: string, public detail: string) {
    super(`image fetch failed (${url.slice(0, 80)}): ${detail}`);
  }
}

export async function inlineImageUrls(
  messages: AnthropicMessage[],
  opts: InlineOpts = {},
): Promise<AnthropicMessage[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxBytes = opts.maxBytesPerImage ?? DEFAULT_MAX_PER_IMAGE;

  return Promise.all(
    messages.map(async (m) => ({
      ...m,
      content: await Promise.all(
        m.content.map(async (c) => {
          if (c.type !== 'image' || c.source.type !== 'url') return c;
          const url = c.source.url;
          let res: Response;
          try {
            res = await fetchFn(url, { redirect: 'follow' });
          } catch (err) {
            throw new ImageFetchError(url, (err as Error).message);
          }
          if (!res.ok) {
            throw new ImageFetchError(url, `HTTP ${res.status}`);
          }
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > maxBytes) {
            throw new ImageFetchError(
              url,
              `image too large: ${buf.length} bytes > ${maxBytes}`,
            );
          }
          const ct = (res.headers.get('content-type') ?? 'image/png')
            .split(';')[0]
            .trim();
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: ct,
              data: buf.toString('base64'),
            },
          };
        }),
      ),
    })),
  );
}
