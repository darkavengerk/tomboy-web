/**
 * OCR-only HTTP helper. Posts a base64 image to the bridge's /ocr
 * endpoint and returns the extracted text.
 *
 * Non-streaming for now — ocr-service returns a single JSON body. SSE
 * may come later; today the call is one round-trip.
 */
export type OcrSendErrorKind =
	| 'unauthorized'
	| 'ocr_service_unavailable'
	| 'bad_request'
	| 'network';

export class OcrSendError extends Error {
	kind: OcrSendErrorKind;
	status?: number;
	constructor(kind: OcrSendErrorKind, opts: { status?: number; message?: string } = {}) {
		super(opts.message ?? kind);
		this.name = 'OcrSendError';
		this.kind = kind;
		this.status = opts.status;
	}
}

export interface SendOcrOptions {
	url: string;
	token: string;
	imageB64: string;
	signal?: AbortSignal;
}

export async function sendOcr(opts: SendOcrOptions): Promise<{ text: string }> {
	let resp: Response;
	try {
		resp = await fetch(opts.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${opts.token}`
			},
			body: JSON.stringify({ image_b64: opts.imageB64 }),
			signal: opts.signal
		});
	} catch (err) {
		throw new OcrSendError('network', { message: (err as Error).message });
	}

	if (resp.status === 401) throw new OcrSendError('unauthorized', { status: 401 });
	if (resp.status === 503) throw new OcrSendError('ocr_service_unavailable', { status: 503 });
	if (resp.status === 400) {
		const body = await resp.json().catch(() => ({}));
		throw new OcrSendError('bad_request', {
			status: 400,
			message: (body as { detail?: string }).detail ?? 'bad_request'
		});
	}
	if (!resp.ok) {
		throw new OcrSendError('network', {
			status: resp.status,
			message: `upstream ${resp.status}`
		});
	}

	const body = (await resp.json()) as { text?: string };
	return { text: body.text ?? '' };
}
