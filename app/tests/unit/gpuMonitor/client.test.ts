import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchGpuStatus, unloadModel, GpuMonitorError } from '$lib/gpuMonitor/client.js';

describe('fetchGpuStatus', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('returns parsed body on 200', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					vram: { total_mb: 10240, used_mb: 0, free_mb: 10240 },
					models: [],
					processes: [],
					ollama_available: true,
					ocr_available: true,
					gpu_available: true,
					fetched_at: '2026-05-15T00:00:00Z'
				}),
				{ status: 200 }
			)
		);
		const out = await fetchGpuStatus('https://bridge', 't');
		expect(out.vram?.total_mb).toBe(10240);
		expect(out.ollama_available).toBe(true);
	});

	it('throws GpuMonitorError on non-200', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
		await expect(fetchGpuStatus('https://bridge', 't')).rejects.toBeInstanceOf(
			GpuMonitorError
		);
	});

	it('strips ws:// scheme and trailing paths from bridgeUrl', async () => {
		const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					vram: null,
					models: [],
					processes: [],
					ollama_available: false,
					ocr_available: false,
					gpu_available: false,
					fetched_at: 'now'
				}),
				{ status: 200 }
			)
		);
		await fetchGpuStatus('wss://bridge.example.com/ws', 't');
		expect((spy.mock.calls[0] as [string])[0]).toBe('https://bridge.example.com/gpu/status');
	});
});

describe('unloadModel', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('posts JSON body with backend + name', async () => {
		const spy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}', { status: 200 }));
		await unloadModel('https://bridge', 't', {
			backend: 'ollama',
			name: 'exaone3.5:2.4b'
		});
		const init = (spy.mock.calls[0] as [string, RequestInit])[1];
		expect(JSON.parse(init.body as string)).toEqual({
			backend: 'ollama',
			name: 'exaone3.5:2.4b'
		});
	});

	it('returns {ok:false, status:423} on in-flight', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ error: 'in_flight' }), { status: 423 })
		);
		const r = await unloadModel('https://bridge', 't', { backend: 'ocr' });
		expect(r.ok).toBe(false);
		expect(r.status).toBe(423);
		expect(r.message).toBe('in_flight');
	});
});
