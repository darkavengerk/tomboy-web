import {
	getDefaultTerminalBridge,
	getTerminalBridgeToken,
	bridgeToHttpBase
} from '$lib/editor/terminal/bridgeSettings.js';

export type ExtractErrorKind =
	| 'not_configured'
	| 'unauthorized'
	| 'service_unavailable'
	| 'too_large'
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
	413: 'too_large',
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

export interface PlaylistEntry {
	url: string;
	title: string;
}
export interface EnumerateOk {
	label: string;
	entries: PlaylistEntry[];
	total: number;
	truncated: boolean;
}

export interface ChapterTrack {
	url: string;
	title: string;
}
export interface ChaptersOk {
	label: string;
	tracks: ChapterTrack[];
	total: number;
	truncated: boolean;
}

/** 챕터 분할 추출 — 영상 URL 을 데스크탑에서 챕터별 mp3 로 쪼개 업로드, 트랙 URL 목록 반환. */
export async function extractChapters(opts: { source: string; signal?: AbortSignal }): Promise<ChaptersOk> {
	const bridge = await getDefaultTerminalBridge();
	const token = await getTerminalBridgeToken();
	if (!bridge || !token) throw new ExtractError('not_configured', '브릿지 설정이 필요합니다');
	const url = `${bridgeToHttpBase(bridge)}/music/chapters`;

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

	const data = (await res.json()) as Partial<ChaptersOk>;
	const tracks = Array.isArray(data.tracks)
		? data.tracks.filter((t): t is ChapterTrack => !!t && typeof t.url === 'string' && t.url.length > 0)
		: [];
	if (tracks.length === 0) throw new ExtractError('upstream_error', 'no_chapters');
	return {
		label: typeof data.label === 'string' && data.label ? data.label : '챕터',
		tracks,
		total: typeof data.total === 'number' ? data.total : tracks.length,
		truncated: data.truncated === true
	};
}

export async function enumeratePlaylist(opts: { source: string; signal?: AbortSignal }): Promise<EnumerateOk> {
	const bridge = await getDefaultTerminalBridge();
	const token = await getTerminalBridgeToken();
	if (!bridge || !token) throw new ExtractError('not_configured', '브릿지 설정이 필요합니다');
	const url = `${bridgeToHttpBase(bridge)}/music/enumerate`;

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

	const data = (await res.json()) as Partial<EnumerateOk>;
	const entries = Array.isArray(data.entries)
		? data.entries.filter((e): e is PlaylistEntry => !!e && typeof e.url === 'string' && e.url.length > 0)
		: [];
	if (entries.length === 0) throw new ExtractError('upstream_error', 'empty_playlist');
	return {
		label: typeof data.label === 'string' && data.label ? data.label : '재생목록',
		entries,
		total: typeof data.total === 'number' ? data.total : entries.length,
		truncated: data.truncated === true
	};
}
