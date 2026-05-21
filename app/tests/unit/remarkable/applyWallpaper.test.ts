import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	applyWallpaper,
	WallpaperApplyError
} from '$lib/remarkable/applyWallpaper.js';

function mockFetch(status: number, body: unknown) {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body
	} as Response);
}

const baseOpts = {
	bridgeUrl: 'wss://bridge.example.com',
	token: 'tok',
	host: 'rm2',
	screens: [{ slot: 'starting' as const, imageUrl: 'https://x/boot.png' }]
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('applyWallpaper', () => {
	it('returns results on 200', async () => {
		vi.stubGlobal('fetch', mockFetch(200, { results: [{ slot: 'starting', status: 'ok' }] }));
		const results = await applyWallpaper(baseOpts);
		expect(results).toEqual([{ slot: 'starting', status: 'ok' }]);
	});

	it('throws unauthorized on 401', async () => {
		vi.stubGlobal('fetch', mockFetch(401, { error: 'unauthorized' }));
		await expect(applyWallpaper(baseOpts)).rejects.toMatchObject({
			name: 'WallpaperApplyError',
			kind: 'unauthorized'
		});
	});

	it('throws not_configured on 503', async () => {
		vi.stubGlobal('fetch', mockFetch(503, { error: 'remarkable_not_configured' }));
		await expect(applyWallpaper(baseOpts)).rejects.toMatchObject({ kind: 'not_configured' });
	});

	it('throws unknown_host on 400 + unknown_host body', async () => {
		vi.stubGlobal('fetch', mockFetch(400, { error: 'unknown_host' }));
		await expect(applyWallpaper(baseOpts)).rejects.toMatchObject({ kind: 'unknown_host' });
	});

	it('throws bad_request on a 400 with a non-unknown_host body', async () => {
		vi.stubGlobal('fetch', mockFetch(400, { error: 'bad_request' }));
		await expect(applyWallpaper(baseOpts)).rejects.toMatchObject({ kind: 'bad_request' });
	});

	it('throws network when fetch rejects', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
		await expect(applyWallpaper(baseOpts)).rejects.toMatchObject({ kind: 'network' });
	});

	it('throws server_error on a 500 status', async () => {
		vi.stubGlobal('fetch', mockFetch(500, { error: 'oops' }));
		await expect(applyWallpaper(baseOpts)).rejects.toMatchObject({ kind: 'server_error' });
	});

	it('throws server_error on unexpected 200 shape', async () => {
		vi.stubGlobal('fetch', mockFetch(200, { nope: true }));
		await expect(applyWallpaper(baseOpts)).rejects.toMatchObject({ kind: 'server_error' });
	});

	it('WallpaperApplyError is an Error subclass', () => {
		expect(new WallpaperApplyError('network')).toBeInstanceOf(Error);
	});
});
