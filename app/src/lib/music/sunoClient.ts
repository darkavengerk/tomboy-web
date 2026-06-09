import {
	getDefaultTerminalBridge,
	getTerminalBridgeToken,
	bridgeToHttpBase
} from '$lib/editor/terminal/bridgeSettings.js';

export type SunoErrorKind =
	| 'not_configured'
	| 'unauthorized'
	| 'service_unavailable'
	| 'bad_request'
	| 'upstream_error'
	| 'network'
	| 'empty';

export class SunoError extends Error {
	constructor(public kind: SunoErrorKind, public detail?: string) {
		super(`${kind}${detail ? `: ${detail}` : ''}`);
	}
}

export interface SunoTrack {
	url: string;
	title: string;
}

export interface SunoPlaylist {
	label: string;
	tracks: SunoTrack[];
	total: number;
	truncated: boolean;
}

const STATUS_TO_KIND: Record<number, SunoErrorKind> = {
	401: 'unauthorized',
	503: 'service_unavailable'
};

export async function fetchSunoPlaylist(opts: {
	url: string;
	signal?: AbortSignal;
}): Promise<SunoPlaylist> {
	const bridge = await getDefaultTerminalBridge();
	const token = await getTerminalBridgeToken();
	if (!bridge || !token) throw new SunoError('not_configured', '브릿지 설정이 필요합니다');
	const endpoint = `${bridgeToHttpBase(bridge)}/music/suno`;

	let res: Response;
	try {
		res = await fetch(endpoint, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: opts.url }),
			signal: opts.signal
		});
	} catch (err) {
		throw new SunoError('network', (err as Error).message);
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
		throw new SunoError(kind, bodyErr || undefined);
	}

	const data = (await res.json()) as Partial<SunoPlaylist>;
	const tracks = Array.isArray(data.tracks)
		? data.tracks.filter(
				(t): t is SunoTrack =>
					!!t &&
					typeof t.url === 'string' &&
					t.url.length > 0 &&
					typeof t.title === 'string'
			)
		: [];
	if (tracks.length === 0) throw new SunoError('empty', 'empty_playlist');
	return {
		label: typeof data.label === 'string' && data.label ? data.label : '재생목록',
		tracks,
		total: typeof data.total === 'number' ? data.total : tracks.length,
		truncated: data.truncated === true
	};
}
