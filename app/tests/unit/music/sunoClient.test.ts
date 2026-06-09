import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as bridgeSettings from '$lib/editor/terminal/bridgeSettings.js';
import { fetchSunoPlaylist, SunoError } from '$lib/music/sunoClient.js';

const A1 = 'https://cdn1.suno.ai/c1.mp3';

beforeEach(() => {
	vi.spyOn(bridgeSettings, 'getDefaultTerminalBridge').mockResolvedValue('wss://bridge.example/ws');
	vi.spyOn(bridgeSettings, 'getTerminalBridgeToken').mockResolvedValue('tok');
	vi.spyOn(bridgeSettings, 'bridgeToHttpBase').mockReturnValue('https://bridge.example');
});
afterEach(() => vi.restoreAllMocks());

describe('fetchSunoPlaylist (client)', () => {
	it('정상 응답 매핑', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({ label: 'M', tracks: [{ url: A1, title: 'A' }], total: 1, truncated: false }),
				{ status: 200 }
			)
		);
		const r = await fetchSunoPlaylist({ url: 'https://suno.com/playlist/x' });
		expect(r.label).toBe('M');
		expect(r.tracks).toEqual([{ url: A1, title: 'A' }]);
	});

	it('빈 tracks → empty', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ label: 'M', tracks: [] }), { status: 200 })
		);
		await expect(fetchSunoPlaylist({ url: 'x' })).rejects.toMatchObject({ kind: 'empty' });
	});

	it('401 → unauthorized', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response('{"error":"unauthorized"}', { status: 401 })
		);
		await expect(fetchSunoPlaylist({ url: 'x' })).rejects.toMatchObject({ kind: 'unauthorized' });
	});

	it('브릿지 미설정 → not_configured', async () => {
		vi.spyOn(bridgeSettings, 'getDefaultTerminalBridge').mockResolvedValue('');
		await expect(fetchSunoPlaylist({ url: 'x' })).rejects.toMatchObject({ kind: 'not_configured' });
	});
});
