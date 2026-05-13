import { describe, test, expect, vi } from 'vitest';
import { searchRag, RagSearchError } from '$lib/llmNote/searchRag.js';

function mockFetch(status: number, body: unknown): typeof globalThis.fetch {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body)
	}) as unknown as typeof globalThis.fetch;
}

describe('searchRag', () => {
	test('200 → returns hits', async () => {
		const hits = [
			{ guid: 'g1', title: 't1', body: 'b1', score: 0.9 },
			{ guid: 'g2', title: 't2', body: 'b2', score: 0.8 }
		];
		globalThis.fetch = mockFetch(200, hits);
		const result = await searchRag({
			url: 'http://x/rag/search',
			token: 'tok',
			query: 'q',
			k: 5
		});
		expect(result).toEqual(hits);
	});

	test('401 → RagSearchError unauthorized', async () => {
		globalThis.fetch = mockFetch(401, { error: 'unauthorized' });
		await expect(
			searchRag({ url: 'http://x/rag/search', token: '', query: 'q', k: 5 })
		).rejects.toMatchObject({ kind: 'unauthorized' });
	});

	test('503 → RagSearchError rag_unavailable', async () => {
		globalThis.fetch = mockFetch(503, { error: 'rag_unavailable' });
		await expect(
			searchRag({ url: 'http://x/rag/search', token: 't', query: 'q', k: 5 })
		).rejects.toMatchObject({ kind: 'rag_unavailable' });
	});

	test('400 → RagSearchError bad_request', async () => {
		globalThis.fetch = mockFetch(400, { error: 'bad_query' });
		await expect(
			searchRag({ url: 'http://x/rag/search', token: 't', query: '', k: 5 })
		).rejects.toMatchObject({ kind: 'bad_request' });
	});

	test('500 → RagSearchError upstream_error', async () => {
		globalThis.fetch = mockFetch(500, {});
		await expect(
			searchRag({ url: 'http://x/rag/search', token: 't', query: 'q', k: 5 })
		).rejects.toMatchObject({ kind: 'upstream_error' });
	});

	test('network fail → RagSearchError network', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		await expect(
			searchRag({ url: 'http://x/rag/search', token: 't', query: 'q', k: 5 })
		).rejects.toMatchObject({ kind: 'network' });
	});

	test('posts JSON body with bearer', async () => {
		const spy = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve([])
		});
		globalThis.fetch = spy as unknown as typeof globalThis.fetch;
		await searchRag({
			url: 'http://x/rag/search',
			token: 'tok',
			query: 'hello',
			k: 3
		});
		expect(spy).toHaveBeenCalledWith(
			'http://x/rag/search',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: 'Bearer tok',
					'Content-Type': 'application/json'
				}),
				body: JSON.stringify({ query: 'hello', k: 3 })
			})
		);
	});
});
