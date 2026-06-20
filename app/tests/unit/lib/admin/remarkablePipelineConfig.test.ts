import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPipelineConfig, savePipelineConfig } from '$lib/admin/remarkablePipeline';

afterEach(() => vi.restoreAllMocks());

describe('fetchPipelineConfig', () => {
	it('parses 200 body into config', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(
			JSON.stringify({ ok: true, defaultPrompt: 'd', folders: [{ name: 'Diary' }] }),
			{ status: 200 }
		)));
		const r = await fetchPipelineConfig('http://x', 't');
		expect(r.ok).toBe(true);
		expect(r.config?.defaultPrompt).toBe('d');
		expect(r.config?.folders[0].name).toBe('Diary');
	});

	it('reports auth failure on 401', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
		const r = await fetchPipelineConfig('http://x', 't');
		expect(r.ok).toBe(false);
	});

	it('returns not-configured without url/token', async () => {
		const r = await fetchPipelineConfig('', '');
		expect(r.ok).toBe(false);
	});
});

describe('savePipelineConfig', () => {
	it('PUTs JSON body and succeeds on 200', async () => {
		const spy = vi.fn<typeof fetch>(
			async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
		);
		vi.stubGlobal('fetch', spy);
		const r = await savePipelineConfig('http://x/', 't', { defaultPrompt: 'p', folders: [] });
		expect(r.ok).toBe(true);
		const [url, init] = spy.mock.calls[0];
		expect(url).toBe('http://x/config');
		expect((init as RequestInit).method).toBe('PUT');
		expect(JSON.parse((init as RequestInit).body as string).defaultPrompt).toBe('p');
	});

	it('surfaces 400 validation error message', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(
			JSON.stringify({ ok: false, error: 'X.titleFormat: unknown placeholder' }), { status: 400 }
		)));
		const r = await savePipelineConfig('http://x', 't', { defaultPrompt: '', folders: [] });
		expect(r.ok).toBe(false);
		expect(r.error).toContain('unknown placeholder');
	});
});
