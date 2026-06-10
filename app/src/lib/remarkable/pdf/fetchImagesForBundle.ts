import * as imageCache from '$lib/imageCache/imageCache.js';
import { toDirectImageUrl } from '$lib/sync/imageUpload.js';

/**
 * For each url, prime the image cache (if needed), then read the cached blob
 * and turn it into a `data:image/...;base64,...` URI. pdfmake's `image:` key
 * accepts data URIs directly; it does NOT accept ObjectURLs / blob: URLs.
 *
 * Failures are silently dropped — the URL just won't appear in the map and the
 * tiptap-to-pdfmake converter falls back to rendering the URL as plain text.
 * This keeps PDF generation robust against transient network errors.
 *
 * The map is keyed by the URL as it appears in the document text, NOT by the
 * post-`toDirectImageUrl` cache key. The renderer looks up the same string it
 * saw inline, so the consumer doesn't need to know about Dropbox quirks.
 */
export async function fetchImagesForBundle(urls: string[]): Promise<Map<string, string>> {
	const distinct = Array.from(new Set(urls));
	const map = new Map<string, string>();
	await Promise.all(
		distinct.map(async (originalUrl) => {
			try {
				const cacheKey = toDirectImageUrl(originalUrl);
				await imageCache.lookupOrFetch(cacheKey);
				const blob = await imageCache.getBlob(cacheKey);
				if (!blob) return;
				const dataUri = await blobToDataUri(blob);
				map.set(originalUrl, dataUri);
			} catch {
				// network / decoding failure → drop
			}
		})
	);
	return map;
}

function blobToDataUri(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result === 'string') resolve(result);
			else reject(new Error('FileReader returned non-string'));
		};
		reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
		reader.readAsDataURL(blob);
	});
}
