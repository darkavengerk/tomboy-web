const SCHEME_RE = /^https?:\/\//i;

export type Resolved =
	| { kind: 'url'; value: string }
	| { kind: 'search'; value: string }
	| { kind: 'reject'; reason: string };

/**
 * source 검증. shell 미경유로 spawn 하므로 셸 인젝션은 무관 — 핵심 위협은
 * (1) yt-dlp 옵션 주입(선두 '-'), (2) 비-http 스킴(file: 등). 둘을 차단하고
 * 검색어는 ytsearch1: 접두로 강제해 옵션으로 해석될 여지를 없앤다.
 */
export function resolveSource(raw: string): Resolved {
	const s = (raw ?? '').trim();
	if (!s) return { kind: 'reject', reason: 'empty' };
	if (s.startsWith('-')) return { kind: 'reject', reason: 'leading_dash' };
	if (SCHEME_RE.test(s)) return { kind: 'url', value: s };
	if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return { kind: 'reject', reason: 'bad_scheme' }; // file:, data: 등
	return { kind: 'search', value: `ytsearch1:${s}` };
}
