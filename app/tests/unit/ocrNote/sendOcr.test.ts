import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendOcr, OcrSendError } from '$lib/ocrNote/sendOcr.js';

describe('sendOcr', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('returns text on 200', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ text: 'hello' }), { status: 200 })
		);
		const out = await sendOcr({ url: '/ocr', token: 't', imageB64: 'aa' });
		expect(out.text).toBe('hello');
	});

	it('throws unauthorized on 401', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
		await expect(
			sendOcr({ url: '/ocr', token: 't', imageB64: 'aa' })
		).rejects.toMatchObject({ kind: 'unauthorized' });
	});

	it('throws ocr_service_unavailable on 503', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
		await expect(
			sendOcr({ url: '/ocr', token: 't', imageB64: 'aa' })
		).rejects.toMatchObject({ kind: 'ocr_service_unavailable' });
	});

	it('throws bad_request on 400 with detail', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ detail: 'missing_image_b64' }), { status: 400 })
		);
		await expect(
			sendOcr({ url: '/ocr', token: 't', imageB64: '' })
		).rejects.toMatchObject({ kind: 'bad_request' });
	});

	it('throws network on fetch failure', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
		await expect(
			sendOcr({ url: '/ocr', token: 't', imageB64: 'aa' })
		).rejects.toBeInstanceOf(OcrSendError);
	});
});
