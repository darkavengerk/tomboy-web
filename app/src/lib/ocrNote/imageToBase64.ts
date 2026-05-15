/**
 * Downscale an image (File / Blob / URL) and return JPEG base64 (no data: prefix).
 *
 * Why downscale: the bridge's `/llm/chat` body cap is 1 MiB. With JSON +
 * base64 overhead (~1.37x), an unscaled 4 MiB phone photo would blow past the
 * cap. 1280px on the long edge is a sweet spot for vision models — Qwen2.5-VL
 * and LLaVA both handle that resolution well, and the resulting JPEG sits
 * comfortably under ~300 KB for typical photos.
 *
 * Why JPEG: PNG re-encodes of photos balloon in size. JPEG q0.85 is a tighter
 * fit while preserving glyph edges well enough for OCR.
 *
 * Why prefer Blob over URL: Dropbox shared links (`www.dropbox.com/scl/...`)
 * respond with a 302 redirect but no permissive CORS headers, so `fetch()`
 * is blocked by the browser. `<img src>` works (cross-origin image loads
 * don't need CORS), but `fetch().then(blob)` doesn't. Image paste/drop
 * gives us the File object directly — we use that instead of round-tripping
 * through the network.
 */
const MAX_LONG_EDGE = 1280;
const JPEG_QUALITY = 0.85;

/**
 * The fast path: caller already has the File / Blob in hand (e.g. from a
 * paste or drop event). No network involved.
 */
export async function imageBlobToBase64(blob: Blob): Promise<string> {
	const bitmap = await blobToBitmap(blob);
	try {
		const { canvas, ctx } = drawScaled(bitmap, MAX_LONG_EDGE);
		const out = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
		void ctx;
		return blobToBase64(out);
	} finally {
		bitmap.close?.();
	}
}

/**
 * Fallback path for URLs without an accompanying File. Subject to CORS —
 * Dropbox `www.dropbox.com/scl/...` links will fail here. Used only when
 * no File is available (e.g. future "OCR existing image" flows).
 */
export async function imageUrlToBase64(url: string): Promise<string> {
	const blob = await fetchAsBlob(url);
	return imageBlobToBase64(blob);
}


async function fetchAsBlob(url: string): Promise<Blob> {
	const resp = await fetch(url, { mode: 'cors', credentials: 'omit' });
	if (!resp.ok) {
		throw new Error(`이미지 다운로드 실패 (HTTP ${resp.status})`);
	}
	return resp.blob();
}

async function blobToBitmap(blob: Blob): Promise<ImageBitmap> {
	if (typeof createImageBitmap === 'function') {
		return createImageBitmap(blob);
	}
	throw new Error('이 브라우저에서는 이미지 처리가 지원되지 않습니다');
}

function drawScaled(
	bitmap: ImageBitmap,
	maxLongEdge: number
): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
	const { width: w0, height: h0 } = bitmap;
	const longEdge = Math.max(w0, h0);
	const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
	const w = Math.max(1, Math.round(w0 * scale));
	const h = Math.max(1, Math.round(h0 * scale));

	if (typeof OffscreenCanvas !== 'undefined') {
		const off = new OffscreenCanvas(w, h);
		const ctx = off.getContext('2d');
		if (!ctx) throw new Error('OffscreenCanvas 2D context를 얻지 못했습니다');
		ctx.drawImage(bitmap, 0, 0, w, h);
		return { canvas: off, ctx };
	}

	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('canvas 2D context를 얻지 못했습니다');
	ctx.drawImage(bitmap, 0, 0, w, h);
	return { canvas, ctx };
}

async function canvasToBlob(
	canvas: HTMLCanvasElement | OffscreenCanvas,
	type: string,
	quality: number
): Promise<Blob> {
	if ('convertToBlob' in canvas) {
		return canvas.convertToBlob({ type, quality });
	}
	return new Promise((resolve, reject) => {
		(canvas as HTMLCanvasElement).toBlob(
			(b) => (b ? resolve(b) : reject(new Error('canvas → blob 변환 실패'))),
			type,
			quality
		);
	});
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error('blob → base64 변환 실패'));
		reader.onload = () => {
			const dataUrl = reader.result as string;
			const comma = dataUrl.indexOf(',');
			resolve(comma === -1 ? dataUrl : dataUrl.slice(comma + 1));
		};
		reader.readAsDataURL(blob);
	});
}
