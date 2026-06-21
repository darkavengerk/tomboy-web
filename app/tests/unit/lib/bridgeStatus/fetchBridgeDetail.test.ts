import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
	getDefaultTerminalBridge: vi.fn(async () => 'wss://bridge.test/ws'),
	getTerminalBridgeToken: vi.fn(async () => 'tok'),
	bridgeToHttpBase: (b: string) => b.replace(/^wss:/, 'https:').replace(/\/ws$/, '')
}));

import { fetchBridgeDetail, BridgeStatusError } from '$lib/bridgeStatus/statusClient.js';
import { getDefaultTerminalBridge } from '$lib/editor/terminal/bridgeSettings.js';

const sample = {
	fetched_at: '2026-06-21T04:45:00Z',
	inbox: { count: 2, newest_mtime: '2026-06-21T04:44:00Z', stale_minutes: 1, per_folder: [] },
	ocr: { status: 'unconfigured' }
};

beforeEach(() => {
	vi.restoreAllMocks();
	(getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue('wss://bridge.test/ws');
});

describe('fetchBridgeDetail', () => {
	it('GETs /status/diary with Bearer and returns parsed detail', async () => {
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(sample), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchMock);
		const r = await fetchBridgeDetail('diary');
		expect(r.inbox.count).toBe(2);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://bridge.test/status/diary');
		expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
	});

	it('maps 401 → unauthorized', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
		await expect(fetchBridgeDetail('diary')).rejects.toMatchObject({ kind: 'unauthorized' });
	});

	it('not_configured when bridge unset', async () => {
		(getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue('');
		await expect(fetchBridgeDetail('diary')).rejects.toBeInstanceOf(BridgeStatusError);
	});

	it('network error when fetch throws', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
		await expect(fetchBridgeDetail('diary')).rejects.toMatchObject({ kind: 'network' });
	});
});
