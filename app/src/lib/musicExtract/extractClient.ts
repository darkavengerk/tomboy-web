import {
	getDefaultTerminalBridge,
	getTerminalBridgeToken,
	bridgeToHttpBase
} from '$lib/editor/terminal/bridgeSettings.js';

export type ExtractErrorKind =
	| 'not_configured'
	| 'unauthorized'
	| 'service_unavailable'
	| 'bad_request'
	| 'upstream_error'
	| 'network';

export class ExtractError extends Error {
	constructor(public kind: ExtractErrorKind, public detail?: string) {
		super(`${kind}${detail ? `: ${detail}` : ''}`);
	}
}

export interface ExtractOk {
	url: string;
	title: string;
}

const STATUS_TO_KIND: Record<number, ExtractErrorKind> = {
	401: 'unauthorized',
	503: 'service_unavailable'
};

export async function extractOne(opts: { source: string; signal?: AbortSignal }): Promise<ExtractOk> {
	const bridge = await getDefaultTerminalBridge();
	const token = await getTerminalBridgeToken();
	if (!bridge || !token) throw new ExtractError('not_configured', '브릿지 설정이 필요합니다');
	const url = `${bridgeToHttpBase(bridge)}/music/extract`;

	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ source: opts.source }),
			signal: opts.signal
		});
	} catch (err) {
		throw new ExtractError('network', (err as Error).message);
	}

	if (!res.ok) {
		let bodyErr = '';
		try {
			const j = (await res.json()) as { error?: string };
			bodyErr = typeof j?.error === 'string' ? j.error : '';
		} catch {
			/* ignore */
		}
		const kind = STATUS_TO_KIND[res.status] ?? (res.status >= 500 ? 'upstream_error' : 'bad_request');
		throw new ExtractError(kind, bodyErr || undefined);
	}

	const data = (await res.json()) as Partial<ExtractOk>;
	if (!data.url) throw new ExtractError('upstream_error', 'no_url');
	return { url: data.url, title: data.title ?? '' };
}
