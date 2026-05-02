import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadCodegraphData } from '$lib/codegraph/loadCodegraphData.js';

interface FakeFetchResult {
	ok: boolean;
	status?: number;
	json?: () => Promise<unknown>;
	throws?: unknown;
}

/**
 * Build a `fetch` stub that returns the given fake responses in URL-keyed order.
 * Any URL not present yields a 404. Pass `{ throws }` to make a fetch reject.
 */
function stubFetch(map: Record<string, FakeFetchResult>): void {
	const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString();
		const entry = map[url];
		if (!entry) {
			return { ok: false, status: 404, json: async () => ({}) } as Response;
		}
		if (entry.throws) {
			throw entry.throws;
		}
		return {
			ok: entry.ok,
			status: entry.status ?? (entry.ok ? 200 : 404),
			json: entry.json ?? (async () => ({}))
		} as Response;
	});
	vi.stubGlobal('fetch', fakeFetch);
}

const META_OK = {
	repoUrl: 'https://github.com/me/repo',
	branch: 'main',
	syncedAt: '2026-05-02T00:00:00Z',
	nodeCount: 3,
	linkCount: 2
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('loadCodegraphData', () => {
	it('happy path: transforms nodes/links and computes degree+size', async () => {
		stubFetch({
			'/codegraph.json': {
				ok: true,
				json: async () => ({
					nodes: [
						{
							id: 'a',
							label: 'A',
							community: 1,
							file_type: 'code',
							source_file: 'a.ts',
							source_location: 'L1'
						},
						{
							id: 'b',
							label: 'B',
							community: 2,
							file_type: 'document',
							source_file: 'b.md',
							source_location: null
						},
						{
							id: 'c',
							label: 'C',
							community: 1,
							file_type: 'code',
							source_file: 'c.ts',
							source_location: 'L42'
						}
					],
					links: [
						{
							source: 'a',
							target: 'b',
							relation: 'calls',
							confidence: 'EXTRACTED',
							confidence_score: 1.0,
							_src: 'a',
							_tgt: 'b',
							weight: 1.0,
							source_file: 'a.ts',
							source_location: 'L5'
						},
						{
							source: 'a',
							target: 'c',
							relation: 'references',
							confidence: 'INFERRED',
							confidence_score: 0.7
						}
					]
				})
			},
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': {
				ok: true,
				json: async () => ({ '1': 'core', '2': 'docs' })
			}
		});

		const result = await loadCodegraphData();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { data } = result;

		expect(data.meta).toEqual(META_OK);
		expect(data.communityLabels).toEqual({ '1': 'core', '2': 'docs' });

		expect(data.nodes).toHaveLength(3);
		const byId = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
		expect(byId.a.title).toBe('A');
		expect(byId.a.degree).toBe(2);
		expect(byId.b.degree).toBe(1);
		expect(byId.c.degree).toBe(1);
		expect(byId.a.fileType).toBe('code');
		expect(byId.b.fileType).toBe('document');
		expect(byId.a.sourceFile).toBe('a.ts');
		expect(byId.a.sourceLocation).toBe('L1');
		expect(byId.b.sourceLocation).toBeNull();

		// size formula: 1 + log1p(deg) / log1p(maxDeg). maxDeg=2 → log1p(2)=ln3.
		const logMax = Math.log1p(2);
		expect(byId.a.size).toBeCloseTo(1 + Math.log1p(2) / logMax, 9); // = 2
		expect(byId.b.size).toBeCloseTo(1 + Math.log1p(1) / logMax, 9);
		expect(byId.a.size).toBeLessThanOrEqual(2);

		expect(data.links).toHaveLength(2);
		const link0 = data.links[0];
		expect(link0).toEqual({
			source: 'a',
			target: 'b',
			relation: 'calls',
			confidence: 'EXTRACTED',
			confidenceScore: 1.0
		});
		// Verify graphify-internal fields stripped.
		expect(link0).not.toHaveProperty('_src');
		expect(link0).not.toHaveProperty('_tgt');
		expect(link0).not.toHaveProperty('weight');
		expect(link0).not.toHaveProperty('source_file');
		expect(link0).not.toHaveProperty('source_location');
	});

	it('maxDegree=0 fallback: sizes are all 1.0', async () => {
		stubFetch({
			'/codegraph.json': {
				ok: true,
				json: async () => ({
					nodes: [
						{ id: 'x', label: 'X', community: 0, file_type: 'code', source_file: 'x.ts' },
						{ id: 'y', label: 'Y', community: 0, file_type: 'code', source_file: 'y.ts' }
					],
					links: []
				})
			},
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': { ok: true, json: async () => ({}) }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.nodes.every((n) => n.size === 1.0)).toBe(true);
		expect(result.data.nodes.every((n) => n.degree === 0)).toBe(true);
	});

	it('empty nodes/links → ok with empty arrays', async () => {
		stubFetch({
			'/codegraph.json': { ok: true, json: async () => ({ nodes: [], links: [] }) },
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.nodes).toEqual([]);
		expect(result.data.links).toEqual([]);
		expect(result.data.communityLabels).toEqual({});
	});

	it("codegraph.json 404 → reason: 'missing'", async () => {
		stubFetch({
			'/codegraph.json': { ok: false, status: 404 },
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('missing');
	});

	it("codegraph-meta.json 404 → reason: 'missing'", async () => {
		stubFetch({
			'/codegraph.json': { ok: true, json: async () => ({ nodes: [], links: [] }) },
			'/codegraph-meta.json': { ok: false, status: 404 },
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('missing');
	});

	it('codegraph-communities.json 404 (optional) → ok with empty communityLabels', async () => {
		stubFetch({
			'/codegraph.json': {
				ok: true,
				json: async () => ({
					nodes: [{ id: 'a', label: 'A' }],
					links: []
				})
			},
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.communityLabels).toEqual({});
	});

	it("malformed JSON in codegraph.json → reason: 'malformed'", async () => {
		stubFetch({
			'/codegraph.json': {
				ok: true,
				json: async () => {
					throw new SyntaxError('Unexpected token < in JSON');
				}
			},
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('malformed');
		expect(result.detail).toMatch(/Unexpected/);
	});

	it("non-array nodes → reason: 'malformed'", async () => {
		stubFetch({
			'/codegraph.json': { ok: true, json: async () => ({ nodes: 'oops', links: [] }) },
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('malformed');
	});

	it('link missing source/target → skipped, load succeeds', async () => {
		stubFetch({
			'/codegraph.json': {
				ok: true,
				json: async () => ({
					nodes: [
						{ id: 'a', label: 'A' },
						{ id: 'b', label: 'B' }
					],
					links: [
						{ source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED' },
						{ source: '', target: 'b', relation: 'calls' }, // skipped
						{ target: 'b', relation: 'calls' }, // skipped (no source)
						{ source: 'a', relation: 'calls' } // skipped (no target)
					]
				})
			},
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.links).toHaveLength(1);
		expect(result.data.links[0].source).toBe('a');
		expect(result.data.links[0].target).toBe('b');
	});

	it("unknown confidence value → coerced to 'INFERRED'", async () => {
		stubFetch({
			'/codegraph.json': {
				ok: true,
				json: async () => ({
					nodes: [
						{ id: 'a', label: 'A' },
						{ id: 'b', label: 'B' }
					],
					links: [
						{
							source: 'a',
							target: 'b',
							relation: 'calls',
							confidence: 'WHATEVER',
							confidence_score: 0.4
						}
					]
				})
			},
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.links[0].confidence).toBe('INFERRED');
		expect(result.data.links[0].confidenceScore).toBe(0.4);
	});

	it('hyperedges in input are dropped (not present in output)', async () => {
		stubFetch({
			'/codegraph.json': {
				ok: true,
				json: async () => ({
					nodes: [{ id: 'a', label: 'A' }],
					links: [],
					hyperedges: [
						{ id: 'h1', label: 'something', nodes: ['a'], relation: 'implement' }
					]
				})
			},
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).not.toHaveProperty('hyperedges');
	});

	it("network error (fetch throws) → reason: 'network'", async () => {
		stubFetch({
			'/codegraph.json': { ok: true, throws: new TypeError('Failed to fetch') },
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('network');
		expect(result.detail).toMatch(/Failed to fetch/);
	});

	it('communities sidecar parse error → falls back to empty map and warns', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		stubFetch({
			'/codegraph.json': {
				ok: true,
				json: async () => ({ nodes: [{ id: 'a', label: 'A' }], links: [] })
			},
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': {
				ok: true,
				json: async () => {
					throw new SyntaxError('bad communities json');
				}
			}
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.communityLabels).toEqual({});
		expect(warnSpy).toHaveBeenCalled();
	});

	it('node missing id → malformed', async () => {
		stubFetch({
			'/codegraph.json': {
				ok: true,
				json: async () => ({
					nodes: [{ label: 'no-id' }],
					links: []
				})
			},
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('malformed');
	});

	it('meta missing required field → malformed', async () => {
		stubFetch({
			'/codegraph.json': { ok: true, json: async () => ({ nodes: [], links: [] }) },
			'/codegraph-meta.json': {
				ok: true,
				json: async () => ({ repoUrl: 'x', branch: 'main', syncedAt: 't' }) // missing counts
			},
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('malformed');
	});

	it('node with missing optional fields → defaults applied', async () => {
		stubFetch({
			'/codegraph.json': {
				ok: true,
				json: async () => ({
					nodes: [{ id: 'a' }], // no label/community/file_type/source_file/source_location
					links: []
				})
			},
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const n = result.data.nodes[0];
		expect(n.title).toBe('a'); // falls back to id
		expect(n.community).toBe(0);
		expect(n.fileType).toBe('code');
		expect(n.sourceFile).toBe('');
		expect(n.sourceLocation).toBeNull();
	});

	it('link missing confidence_score → defaults to 0.5', async () => {
		stubFetch({
			'/codegraph.json': {
				ok: true,
				json: async () => ({
					nodes: [
						{ id: 'a', label: 'A' },
						{ id: 'b', label: 'B' }
					],
					links: [{ source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED' }]
				})
			},
			'/codegraph-meta.json': { ok: true, json: async () => META_OK },
			'/codegraph-communities.json': { ok: false, status: 404 }
		});
		const result = await loadCodegraphData();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.links[0].confidenceScore).toBe(0.5);
	});
});
