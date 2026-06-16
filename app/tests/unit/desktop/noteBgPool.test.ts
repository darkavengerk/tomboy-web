import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The pool only consumes these two loaders from the (runes) session module.
// Mock them with a plain backing store so the test is deterministic and avoids
// pulling the whole desktop session + idb stack.
const store = new Map<string, { blob: Blob | null; mode: string }>();
vi.mock('$lib/desktop/session.svelte.js', () => ({
	loadNoteBg: vi.fn(async (guid: string) => store.get(guid)?.blob ?? null),
	loadNoteBgMode: vi.fn(async (guid: string) => store.get(guid)?.mode ?? 'cover')
}));

import { createNoteBgPool } from '$lib/desktop/noteBgPool.js';

function blob(n: number): Blob {
	return new Blob([new Uint8Array(n)], { type: 'image/png' });
}

let created: string[];
let revoked: string[];

beforeEach(() => {
	store.clear();
	created = [];
	revoked = [];
	let seq = 0;
	vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
		const u = `blob:${++seq}`;
		created.push(u);
		return u;
	});
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => {
		revoked.push(u as string);
	});
});

afterEach(() => vi.restoreAllMocks());

describe('createNoteBgPool', () => {
	it('load() with a stored bg → get() returns {url, mode}', async () => {
		store.set('g1', { blob: blob(10), mode: 'contain' });
		const pool = createNoteBgPool();
		await pool.load('g1');
		expect(pool.get('g1')).toEqual({ url: 'blob:1', mode: 'contain' });
		expect(created).toEqual(['blob:1']);
	});

	it('load() with no stored bg → get() undefined, no ObjectURL created', async () => {
		const pool = createNoteBgPool();
		await pool.load('g1');
		expect(pool.get('g1')).toBeUndefined();
		expect(created).toEqual([]);
	});

	it('release() revokes the url and drops the entry', async () => {
		store.set('g1', { blob: blob(10), mode: 'cover' });
		const pool = createNoteBgPool();
		await pool.load('g1');
		pool.release('g1');
		expect(pool.get('g1')).toBeUndefined();
		expect(revoked).toEqual(['blob:1']);
	});

	it('releaseAll() revokes every url and empties the pool', async () => {
		store.set('a', { blob: blob(1), mode: 'cover' });
		store.set('b', { blob: blob(1), mode: 'tile' });
		const pool = createNoteBgPool();
		await pool.load('a');
		await pool.load('b');
		pool.releaseAll();
		expect(pool.get('a')).toBeUndefined();
		expect(pool.get('b')).toBeUndefined();
		expect([...revoked].sort()).toEqual(['blob:1', 'blob:2']);
	});

	it('reload (load same guid twice) revokes the old url and stores the new one', async () => {
		store.set('g1', { blob: blob(1), mode: 'cover' });
		const pool = createNoteBgPool();
		await pool.load('g1'); // blob:1
		store.set('g1', { blob: blob(1), mode: 'fill' });
		await pool.load('g1'); // blob:2, old revoked
		expect(pool.get('g1')).toEqual({ url: 'blob:2', mode: 'fill' });
		expect(revoked).toEqual(['blob:1']);
	});

	it('reload to no-bg revokes the old url and clears the entry', async () => {
		store.set('g1', { blob: blob(1), mode: 'cover' });
		const pool = createNoteBgPool();
		await pool.load('g1');
		store.set('g1', { blob: null, mode: 'cover' });
		await pool.load('g1');
		expect(pool.get('g1')).toBeUndefined();
		expect(revoked).toEqual(['blob:1']);
	});

	it('concurrent loads for the same guid keep only the latest result (no leak)', async () => {
		const mod = await import('$lib/desktop/session.svelte.js');
		const deferreds: Array<(b: Blob) => void> = [];
		(mod.loadNoteBg as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise<Blob>((res) => deferreds.push(res))
		);
		(mod.loadNoteBgMode as ReturnType<typeof vi.fn>).mockResolvedValue('cover');

		const pool = createNoteBgPool();
		const p1 = pool.load('g1'); // token 1 → deferreds[0]
		const p2 = pool.load('g1'); // token 2 (latest) → deferreds[1]
		deferreds[1](blob(1)); // latest resolves first → wins
		deferreds[0](blob(1)); // stale resolves → must be discarded before any URL is made
		await Promise.all([p1, p2]);

		expect(pool.get('g1')).toBeDefined();
		// stale call never reaches createObjectURL → exactly one url made, none revoked
		expect(created.length).toBe(1);
		expect(revoked.length).toBe(0);
	});
});
