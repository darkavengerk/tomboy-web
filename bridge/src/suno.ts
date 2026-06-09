export interface SunoTrack { url: string; title: string; }
export interface SunoResult { label: string; tracks: SunoTrack[]; total: number; truncated: boolean; }
export interface SunoDeps { fetch?: typeof fetch; maxPlaylist?: number; userAgent?: string; pageCap?: number; }

const API_BASE = 'https://studio-api.prod.suno.com';
const DEFAULT_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HTTP_RE = /^https?:\/\//i;

/** suno.com/playlist/<id> 또는 app.suno.ai/playlist/<id> 에서 id 추출. */
export function extractPlaylistId(playlistUrl: string): string | null {
	let u: URL;
	try { u = new URL(playlistUrl); } catch { return null; }
	if (!/(^|\.)suno\.(com|ai)$/i.test(u.hostname)) return null;
	const m = u.pathname.match(/\/playlist\/([A-Za-z0-9-]{6,})/);
	return m ? m[1] : null;
}

function clipToTrack(raw: unknown): SunoTrack | null {
	if (!raw || typeof raw !== 'object') return null;
	const clip = (raw as { clip?: unknown }).clip ?? raw;
	if (!clip || typeof clip !== 'object') return null;
	const c = clip as { audio_url?: unknown; title?: unknown };
	const url = typeof c.audio_url === 'string' ? c.audio_url : '';
	if (!HTTP_RE.test(url)) return null;
	const title = typeof c.title === 'string' && c.title.trim() ? c.title.trim() : url;
	return { url, title };
}

async function fetchViaJson(
	id: string,
	doFetch: typeof fetch,
	ua: string,
	pageCap: number
): Promise<{ label: string; tracks: SunoTrack[]; total: number } | null> {
	const tracks: SunoTrack[] = [];
	const seen = new Set<string>();
	let label = '재생목록';
	let total = 0;
	for (let page = 1; page <= pageCap; page++) {
		let res: Response;
		try {
			res = await doFetch(`${API_BASE}/api/playlist/${id}/?page=${page}`, {
				headers: { 'User-Agent': ua, Accept: 'application/json' }
			});
		} catch { return tracks.length ? { label, tracks, total: total || tracks.length } : null; }
		if (!res.ok) return tracks.length ? { label, tracks, total: total || tracks.length } : null;
		let json: { name?: unknown; num_total_results?: unknown; playlist_clips?: unknown };
		try { json = (await res.json()) as typeof json; } catch { break; }
		if (page === 1) {
			if (typeof json.name === 'string' && json.name.trim()) label = json.name.trim();
			if (typeof json.num_total_results === 'number') total = json.num_total_results;
		}
		const clips = Array.isArray(json.playlist_clips) ? json.playlist_clips : [];
		if (clips.length === 0) break;
		for (const pc of clips) {
			const t = clipToTrack(pc);
			if (t && !seen.has(t.url)) { seen.add(t.url); tracks.push(t); }
		}
	}
	return tracks.length ? { label, tracks, total: total || tracks.length } : null;
}

/** RSC/__NEXT_DATA__ HTML 에서 audio_url+title 쌍 추출. 이스케이프된 따옴표(\")를 먼저 펴서 평탄화. */
export function parseClipsFromHtml(html: string): SunoTrack[] {
	const flat = html.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/\\"/g, '"');
	const tracks: SunoTrack[] = [];
	const seen = new Set<string>();
	const re = /"audio_url"\s*:\s*"(https?:\/\/[^"]+?\.mp3[^"]*)"/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(flat)) !== null) {
		const url = m[1];
		if (seen.has(url)) continue;
		seen.add(url);
		// 같은 클립 객체 안의 title — audio_url 앞쪽 가까운 범위에서 마지막 title 채택.
		const windowStr = flat.slice(Math.max(0, m.index - 600), m.index);
		const tm = /"title"\s*:\s*"([^"]*)"/g;
		let title = '';
		let t: RegExpExecArray | null;
		while ((t = tm.exec(windowStr)) !== null) title = t[1];
		tracks.push({ url, title: title.trim() || url });
	}
	return tracks;
}

async function fetchViaHtml(
	id: string,
	doFetch: typeof fetch,
	ua: string
): Promise<{ label: string; tracks: SunoTrack[]; total: number } | null> {
	let res: Response;
	try { res = await doFetch(`https://suno.com/playlist/${id}`, { headers: { 'User-Agent': ua } }); }
	catch { return null; }
	if (!res.ok) return null;
	const html = await res.text();
	const tracks = parseClipsFromHtml(html);
	if (tracks.length === 0) return null;
	const nameMatch =
		html.replace(/\\"/g, '"').match(/"playlist"[^{]*\{[^}]*"name"\s*:\s*"([^"]+)"/) ??
		html.match(/<title>([^<]+)<\/title>/i);
	const label = nameMatch?.[1]?.trim() || '재생목록';
	return { label, tracks, total: tracks.length };
}

export async function fetchSunoPlaylist(playlistUrl: string, deps: SunoDeps = {}): Promise<SunoResult> {
	const id = extractPlaylistId(playlistUrl);
	if (!id) throw new Error('bad_request:no_playlist_id');
	const doFetch = deps.fetch ?? globalThis.fetch;
	const ua = deps.userAgent ?? DEFAULT_UA;
	const max = deps.maxPlaylist ?? 100;
	const pageCap = deps.pageCap ?? 20;

	let got = await fetchViaJson(id, doFetch, ua, pageCap);
	if (!got) got = await fetchViaHtml(id, doFetch, ua);
	if (!got) return { label: '재생목록', tracks: [], total: 0, truncated: false };

	const total = Math.max(got.total, got.tracks.length);
	const tracks = got.tracks.slice(0, max);
	return { label: got.label, tracks, total, truncated: total > tracks.length };
}
