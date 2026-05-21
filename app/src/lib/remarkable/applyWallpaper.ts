import { bridgeToHttpBase } from '$lib/editor/terminal/bridgeSettings.js';
import type { RmSlotId } from './slots.js';

export interface WallpaperApplyScreen {
	slot: RmSlotId;
	imageUrl: string;
}

export interface WallpaperSlotResult {
	slot: string;
	status: 'ok' | 'error';
	message?: string;
}

export type WallpaperApplyErrorKind =
	| 'unauthorized'
	| 'not_configured'
	| 'unknown_host'
	| 'bad_request'
	| 'network'
	| 'server_error';

export class WallpaperApplyError extends Error {
	kind: WallpaperApplyErrorKind;
	constructor(kind: WallpaperApplyErrorKind, message?: string) {
		super(message ?? kind);
		this.name = 'WallpaperApplyError';
		this.kind = kind;
	}
}

export interface ApplyWallpaperOptions {
	bridgeUrl: string;
	token: string;
	host: string;
	screens: WallpaperApplyScreen[];
}

/**
 * 브릿지로 배경화면 배치를 POST. 200이면 슬롯별 결과를 resolve,
 * 실패면 `WallpaperApplyError`를 throw — `kind`는
 * `unauthorized`(401) · `not_configured`(503) · `unknown_host`/`bad_request`(400)
 * · `network`(fetch 거부) · `server_error`(그 외 비정상 응답) 중 하나.
 */
export async function applyWallpaper(
	opts: ApplyWallpaperOptions
): Promise<WallpaperSlotResult[]> {
	const base = bridgeToHttpBase(opts.bridgeUrl);
	let resp: Response;
	try {
		resp = await fetch(base + '/remarkable/wallpaper', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${opts.token}`
			},
			body: JSON.stringify({ host: opts.host, screens: opts.screens })
		});
	} catch {
		throw new WallpaperApplyError('network', '브릿지에 연결할 수 없습니다');
	}

	if (resp.status === 401) {
		throw new WallpaperApplyError('unauthorized', '브릿지 인증에 실패했습니다');
	}
	if (resp.status === 503) {
		throw new WallpaperApplyError('not_configured', '브릿지에 리마커블 설정이 없습니다');
	}
	if (resp.status === 400) {
		const body = (await resp.json().catch(() => null)) as { error?: string } | null;
		if (body?.error === 'unknown_host') {
			throw new WallpaperApplyError('unknown_host', '알 수 없는 호스트 별칭입니다');
		}
		throw new WallpaperApplyError('bad_request', '잘못된 요청입니다');
	}
	if (!resp.ok) {
		throw new WallpaperApplyError('server_error', `브릿지 오류 (${resp.status})`);
	}

	const body = (await resp.json().catch(() => null)) as
		| { results?: WallpaperSlotResult[] }
		| null;
	if (!body || !Array.isArray(body.results)) {
		throw new WallpaperApplyError('server_error', '예상치 못한 응답 형식입니다');
	}
	return body.results;
}
