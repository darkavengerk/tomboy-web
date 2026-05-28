/**
 * One-shot installer for built-in image fetchers.
 *
 * Call from the root layout's onMount. Idempotent — re-registering the
 * same fetcher name replaces the entry in the registry, so multiple calls
 * are harmless but the `installed` guard avoids the work.
 *
 * Add new fetchers here when a host needs a special fetch strategy.
 * Vercel Blob (used by the temp image storage) is intentionally not a
 * fetcher: it serves CORS-open responses so `lookupOrFetch`'s plain
 * `fetch()` fallback already handles it.
 */
import { registerFetcher } from './registry.js';
import { dropboxFetcher } from './dropboxFetcher.js';

let installed = false;

export function installImageFetchers(): void {
	if (installed) return;
	installed = true;
	registerFetcher(dropboxFetcher);
}
