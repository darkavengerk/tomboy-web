/**
 * Clipboard actions for note images.
 *
 * `copyImageToClipboard` puts the actual image *bytes* on the clipboard so a
 * paste into other apps/web/PC behaves like a normally-copied image.
 * `copyImageUrlToClipboard` copies the image URL text.
 *
 * Byte resolution reuses the in-note image cache (`lib/imageCache`), which
 * routes `www.dropbox.com` through the Dropbox SDK fetcher (plain `fetch()` is
 * CORS-blocked there). Because the resolved bytes are a local `Blob`, drawing
 * them to a canvas does NOT taint it, so PNG conversion always succeeds.
 */

import { getBlob, lookupOrFetch } from '$lib/imageCache/imageCache.js';
import { pushToast } from '$lib/stores/toast.js';

/**
 * Resolve the raw image bytes for `href`: cache hit first, otherwise fetch
 * (and prime the cache) via `lookupOrFetch`, then read the now-cached blob.
 * Returns null if the bytes can't be obtained.
 */
export async function resolveImageBlob(href: string): Promise<Blob | null> {
	let blob = await getBlob(href);
	if (blob) return blob;
	await lookupOrFetch(href).catch(() => {});
	blob = await getBlob(href);
	return blob;
}

/**
 * Convert an arbitrary image blob to a PNG blob via canvas. PNG is the one
 * image type browsers reliably accept for clipboard `write()`.
 */
export async function toPngBlob(blob: Blob): Promise<Blob> {
	const bitmap = await createImageBitmap(blob);
	try {
		const canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('no 2d context');
		ctx.drawImage(bitmap, 0, 0);
		return await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
		});
	} finally {
		bitmap.close();
	}
}

/**
 * Copy the image at `href` to the clipboard as PNG bytes.
 *
 * The whole resolve→convert pipeline is wrapped in a Promise handed to
 * `ClipboardItem`, so `navigator.clipboard.write()` is called synchronously
 * inside the user gesture — Safari/iOS reject a `write()` issued after an
 * `await` that escaped the gesture.
 */
export async function copyImageToClipboard(href: string): Promise<void> {
	if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
		pushToast('이미지 복사 실패 — 브라우저가 허용하지 않음', { kind: 'error' });
		return;
	}
	try {
		const pngPromise = (async () => {
			const blob = await resolveImageBlob(href);
			if (!blob) throw new Error('image bytes unavailable');
			return blob.type === 'image/png' ? blob : await toPngBlob(blob);
		})();
		await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);
		pushToast('이미지 복사됨');
	} catch {
		pushToast('이미지 복사 실패', { kind: 'error' });
	}
}

/** Copy the image's URL text to the clipboard. */
export async function copyImageUrlToClipboard(href: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(href);
		pushToast('이미지 주소 복사됨');
	} catch {
		pushToast('복사 실패', { kind: 'error' });
	}
}
