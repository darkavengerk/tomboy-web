import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetDBForTest } from '$lib/storage/db.js';
import {
	getImageRecord,
	putImageRecord,
	deleteImageRecord,
	evictLRU,
	cursorSumSize,
	countRecords,
	getAllImageRecords,
	type ImageCacheRecord
} from '$lib/imageCache/imageCacheStore.js';

function makeRecord(url: string, size: number, lastAccess: number): ImageCacheRecord {
	return {
		url,
		blob: new Blob([new Uint8Array(size)], { type: 'image/png' }),
		contentType: 'image/png',
		size,
		lastAccess,
		insertedAt: lastAccess
	};
}

beforeEach(() => {
	// Fresh in-memory IDB for each test (keeps globals, resets data)
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('imageCacheStore', () => {
	it('put → get round-trip', async () => {
		const rec = makeRecord('https://a/x.png', 100, 1000);
		await putImageRecord(rec);
		const got = await getImageRecord('https://a/x.png');
		expect(got?.url).toBe(rec.url);
		// size is stored as an explicit numeric field (not derived from blob.size)
		expect(got?.size).toBe(100);
		// blob object is preserved (jsdom structuredClone does not preserve Blob.size getter)
		expect(got?.blob).toBeDefined();
		expect(got?.contentType).toBe('image/png');
		expect(got?.lastAccess).toBe(1000);
		expect(got?.insertedAt).toBe(1000);
	});

	it('get for missing url → undefined', async () => {
		const got = await getImageRecord('https://nope/x.png');
		expect(got).toBeUndefined();
	});

	it('delete removes record', async () => {
		await putImageRecord(makeRecord('https://a/x.png', 100, 1000));
		await deleteImageRecord('https://a/x.png');
		expect(await getImageRecord('https://a/x.png')).toBeUndefined();
	});

	it('put overwrites existing url', async () => {
		await putImageRecord(makeRecord('https://a/x.png', 100, 1000));
		await putImageRecord(makeRecord('https://a/x.png', 200, 2000));
		const got = await getImageRecord('https://a/x.png');
		expect(got?.size).toBe(200);
		expect(got?.lastAccess).toBe(2000);
	});

	it('evictLRU removes oldest-lastAccess first until target freed', async () => {
		await putImageRecord(makeRecord('https://a/1.png', 100, 100));
		await putImageRecord(makeRecord('https://a/2.png', 200, 200));
		await putImageRecord(makeRecord('https://a/3.png', 300, 300));

		const { evictedUrls, freedBytes } = await evictLRU(250);

		// 100 (lastAccess=100) + 200 (lastAccess=200) = 300 freed >= 250
		expect(freedBytes).toBeGreaterThanOrEqual(250);
		expect(evictedUrls).toContain('https://a/1.png');
		expect(evictedUrls).toContain('https://a/2.png');
		expect(evictedUrls).not.toContain('https://a/3.png');

		expect(await getImageRecord('https://a/3.png')).toBeDefined();
		expect(await getImageRecord('https://a/1.png')).toBeUndefined();
	});

	it('evictLRU on empty store returns 0', async () => {
		const { evictedUrls, freedBytes } = await evictLRU(1000);
		expect(evictedUrls).toEqual([]);
		expect(freedBytes).toBe(0);
	});

	it('cursorSumSize returns sum of all record sizes', async () => {
		await putImageRecord(makeRecord('https://a/1.png', 100, 100));
		await putImageRecord(makeRecord('https://a/2.png', 250, 200));
		expect(await cursorSumSize()).toBe(350);
	});

	it('cursorSumSize returns 0 for empty store', async () => {
		expect(await cursorSumSize()).toBe(0);
	});

	it('countRecords returns number of stored records', async () => {
		expect(await countRecords()).toBe(0);
		await putImageRecord(makeRecord('https://a/1.png', 100, 100));
		await putImageRecord(makeRecord('https://a/2.png', 200, 200));
		expect(await countRecords()).toBe(2);
	});

	it('evictLRU with targetBytesToFree=0 returns empty result', async () => {
		await putImageRecord(makeRecord('https://a/1.png', 100, 100));
		const { evictedUrls, freedBytes } = await evictLRU(0);
		expect(evictedUrls).toEqual([]);
		expect(freedBytes).toBe(0);
		// record should still be there
		expect(await getImageRecord('https://a/1.png')).toBeDefined();
	});

	it('evictLRU frees exactly enough when single record covers target', async () => {
		await putImageRecord(makeRecord('https://a/big.png', 500, 100));
		const { evictedUrls, freedBytes } = await evictLRU(100);
		expect(evictedUrls).toEqual(['https://a/big.png']);
		expect(freedBytes).toBe(500);
	});

	it('getAllImageRecords returns lightweight metadata for every record (no blob)', async () => {
		await putImageRecord(makeRecord('https://a/1.png', 100, 100));
		await putImageRecord(makeRecord('https://a/2.png', 200, 200));

		const all = await getAllImageRecords();

		expect(all).toHaveLength(2);
		expect(all.map((r) => r.url).sort()).toEqual(['https://a/1.png', 'https://a/2.png']);
		const two = all.find((r) => r.url === 'https://a/2.png')!;
		expect(two.size).toBe(200);
		expect(two.contentType).toBe('image/png');
		expect(two.lastAccess).toBe(200);
		// the blob is intentionally NOT carried in the lightweight metadata
		expect((two as unknown as Record<string, unknown>).blob).toBeUndefined();
	});

	it('getAllImageRecords returns empty array for empty store', async () => {
		expect(await getAllImageRecords()).toEqual([]);
	});
});
