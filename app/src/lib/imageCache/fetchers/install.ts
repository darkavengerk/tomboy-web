/**
 * One-shot installer for built-in image fetchers.
 *
 * Call from the root layout's onMount. Idempotent — re-registering the
 * same fetcher name replaces the entry in the registry, so multiple calls
 * are harmless but the `installed` guard avoids the work.
 *
 * Add new fetchers (e.g. Vercel Blob) by registering them here.
 */
import { registerFetcher } from './registry.js';
import { dropboxFetcher } from './dropboxFetcher.js';

let installed = false;

export function installImageFetchers(): void {
	if (installed) return;
	installed = true;
	registerFetcher(dropboxFetcher);
}
