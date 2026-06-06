import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractOne, enumeratePlaylist, ExtractError } from '$lib/musicExtract/extractClient.js';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
	getDefaultTerminalBridge: vi.fn(async () => 'https://bridge.example'),
	getTerminalBridgeToken: vi.fn(async () => 'tok'),
	bridgeToHttpBase: (b: string) => b.replace(/\/$/, '')
}));
import * as bs from '$lib/editor/terminal/bridgeSettings.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
beforeEach(() => {
	(bs.getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue('https://bridge.example');
	(bs.getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue('tok');
});

it('미설정이면 not_configured throw + fetch 미호출', async () => {
	(bs.getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	const spy = vi.fn();
	globalThis.fetch = spy as unknown as typeof fetch;
	await expect(extractOne({ source: 'x' })).rejects.toMatchObject({ kind: 'not_configured' });
	expect(spy).not.toHaveBeenCalled();
});

it('성공 응답을 파싱한다 + Bearer/본문 전송', async () => {
	let calledUrl = '', auth = '', body = '';
	globalThis.fetch = (async (u: string, init: RequestInit) => {
		calledUrl = String(u); auth = (init.headers as Record<string, string>).Authorization; body = String(init.body);
		return new Response(JSON.stringify({ url: 'https://bridge.example/files/x/y.mp3', title: 'Y' }), { status: 200 });
	}) as unknown as typeof fetch;
	const out = await extractOne({ source: 'https://yt/abc' });
	expect(out).toEqual({ url: 'https://bridge.example/files/x/y.mp3', title: 'Y' });
	expect(calledUrl).toBe('https://bridge.example/music/extract');
	expect(auth).toBe('Bearer tok');
	expect(JSON.parse(body)).toEqual({ source: 'https://yt/abc' });
});

it.each([[401, 'unauthorized'], [503, 'service_unavailable'], [500, 'upstream_error'], [400, 'bad_request']])(
	'상태 %i → %s', async (status, kind) => {
		globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'e' }), { status })) as unknown as typeof fetch;
		await expect(extractOne({ source: 'x' })).rejects.toMatchObject({ kind });
	}
);

it('네트워크 오류 → network', async () => {
	globalThis.fetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
	await expect(extractOne({ source: 'x' })).rejects.toMatchObject({ kind: 'network' });
});

it('signal을 fetch에 전달한다', async () => {
	let capturedSignal: AbortSignal | undefined;
	globalThis.fetch = (async (_u: string, init: RequestInit) => {
		capturedSignal = init.signal as AbortSignal | undefined;
		return new Response(JSON.stringify({ url: 'u', title: 't' }), { status: 200 });
	}) as unknown as typeof fetch;
	const ctrl = new AbortController();
	await extractOne({ source: 'x', signal: ctrl.signal });
	expect(capturedSignal).toBe(ctrl.signal);
});

it('enumeratePlaylist: 미설정이면 not_configured + fetch 미호출', async () => {
	(bs.getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	const spy = vi.fn();
	globalThis.fetch = spy as unknown as typeof fetch;
	await expect(enumeratePlaylist({ source: 'x' })).rejects.toMatchObject({ kind: 'not_configured' });
	expect(spy).not.toHaveBeenCalled();
});

it('enumeratePlaylist: 성공 응답 파싱 + Bearer/본문/URL/signal', async () => {
	let url = '', auth = '', body = '';
	let sig: AbortSignal | undefined;
	globalThis.fetch = (async (u: string, init: RequestInit) => {
		url = String(u); auth = (init.headers as Record<string, string>).Authorization; body = String(init.body); sig = init.signal as AbortSignal | undefined;
		return new Response(JSON.stringify({ label: '가수A', entries: [{ url: 'https://yt/1', title: 'a' }, { url: 'https://yt/2', title: 'b' }], total: 2, truncated: false }), { status: 200 });
	}) as unknown as typeof fetch;
	const ctrl = new AbortController();
	const out = await enumeratePlaylist({ source: 'https://yt/p?list=PL', signal: ctrl.signal });
	expect(out.label).toBe('가수A');
	expect(out.entries).toHaveLength(2);
	expect(out.total).toBe(2);
	expect(url).toBe('https://bridge.example/music/enumerate');
	expect(auth).toBe('Bearer tok');
	expect(JSON.parse(body)).toEqual({ source: 'https://yt/p?list=PL' });
	expect(sig).toBe(ctrl.signal);
});

it.each([[401, 'unauthorized'], [503, 'service_unavailable'], [500, 'upstream_error'], [400, 'bad_request']])(
	'enumeratePlaylist 상태 %i → %s', async (status, kind) => {
		globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'e' }), { status })) as unknown as typeof fetch;
		await expect(enumeratePlaylist({ source: 'x' })).rejects.toMatchObject({ kind });
	}
);

it('enumeratePlaylist: 빈 entries → upstream_error', async () => {
	globalThis.fetch = (async () => new Response(JSON.stringify({ label: 'L', entries: [], total: 0, truncated: false }), { status: 200 })) as unknown as typeof fetch;
	await expect(enumeratePlaylist({ source: 'x' })).rejects.toMatchObject({ kind: 'upstream_error', detail: 'empty_playlist' });
});

it('enumeratePlaylist: 네트워크 오류 → network', async () => {
	globalThis.fetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
	await expect(enumeratePlaylist({ source: 'x' })).rejects.toMatchObject({ kind: 'network' });
});

it('enumeratePlaylist: label 없으면 재생목록 폴백', async () => {
	globalThis.fetch = (async () => new Response(JSON.stringify({ entries: [{ url: 'https://yt/1', title: 'a' }], total: 1, truncated: false }), { status: 200 })) as unknown as typeof fetch;
	const out = await enumeratePlaylist({ source: 'x' });
	expect(out.label).toBe('재생목록');
});
