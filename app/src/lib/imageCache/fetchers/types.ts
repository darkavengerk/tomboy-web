/**
 * ImageFetcher — pluggable source-specific blob fetcher.
 *
 * Why this exists: `lookupOrFetch` cache misses can't always use plain
 * `fetch(url)` because some hosts (notably www.dropbox.com) don't send
 * CORS headers. Those hosts have alternate routes (SDK calls through
 * api.dropboxapi.com) that DO work cross-origin. The registry lets each
 * source register its own fetch strategy keyed by URL.
 *
 * `imageCache.ts` resolves a URL through the registry first; only if no
 * fetcher matches does it fall back to plain `fetch()`.
 */
export interface ImageFetcher {
	/** Stable identifier for logging + unregistration. */
	name: string;
	/** True if this fetcher knows how to retrieve the given URL. */
	matches(url: string): boolean;
	/** Retrieve the blob bytes. Throw on failure — registry doesn't retry. */
	fetch(url: string): Promise<Blob>;
}
