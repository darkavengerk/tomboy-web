import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractOne, ExtractError } from '$lib/musicExtract/extractClient.js';

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
	await expect(extractOne({ source: 'x' })).rejects.toBeInstanceOf(ExtractError);
	await expect(extractOne({ source: 'x' })).rejects.toMatchObject({ kind: 'network' });
});
