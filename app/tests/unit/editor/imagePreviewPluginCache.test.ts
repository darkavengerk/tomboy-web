/**
 * Tests for imagePreviewPlugin's image-cache integration:
 *   - sync pool hit → img.src is ObjectURL immediately (no flicker)
 *   - pool miss → img.src is original href, replaced after lookupOrFetch resolves
 *   - lookupOrFetch returns {src: href, fromCache: false} → img.src stays as original href
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderImagePreview } from '../../../src/lib/editor/imagePreview/imagePreviewPlugin.js';
import * as cache from '../../../src/lib/imageCache/imageCache.js';
import * as pool from '../../../src/lib/imageCache/objectUrlPool.js';

describe('imagePreviewPlugin cache integration', () => {
	beforeEach(() => {
		pool.__resetForTest();
		cache.__resetForTest();
		vi.spyOn(URL, 'createObjectURL').mockImplementation(
			() => 'blob:fake-object-url'
		);
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('sync pool hit → img.src is ObjectURL immediately', () => {
		// Pre-register the URL in the pool so peek() returns the ObjectURL.
		pool.getOrCreate('https://a/x.png', new Blob(['x']));

		const img = renderImagePreview('https://a/x.png');

		// Synchronous assertion — no await needed, pool.peek() is sync.
		expect(img.src).toBe('blob:fake-object-url');
	});

	it('pool miss → img.src is original href, then replaced after lookup resolves', async () => {
		const lookupSpy = vi.spyOn(cache, 'lookupOrFetch').mockResolvedValue({
			src: 'blob:resolved-object-url',
			fromCache: true
		});

		const img = renderImagePreview('https://a/y.png');

		// Immediately after creation: fallback URL
		expect(img.src).toBe('https://a/y.png');

		// Allow the microtask queue to drain.
		await Promise.resolve();
		await Promise.resolve();

		expect(lookupSpy).toHaveBeenCalledWith('https://a/y.png');
		// src replaced with the resolved ObjectURL
		expect(img.src).toBe('blob:resolved-object-url');
	});

	it('lookup returns {src: href, fromCache: false} → img.src stays as original href', async () => {
		// This simulates cache miss + failed network fetch — no ObjectURL.
		vi.spyOn(cache, 'lookupOrFetch').mockResolvedValue({
			src: 'https://a/z.png',
			fromCache: false
		});

		const img = renderImagePreview('https://a/z.png');

		// Allow the promise to resolve.
		await new Promise((r) => setTimeout(r, 0));

		// src === href (both sides of the comparison are identical → no assignment)
		expect(img.src).toBe('https://a/z.png');
	});

	it('lookup rejects → img.src stays as original href', async () => {
		vi.spyOn(cache, 'lookupOrFetch').mockRejectedValue(new Error('network error'));

		const img = renderImagePreview('https://a/w.png');

		await new Promise((r) => setTimeout(r, 0));

		expect(img.src).toBe('https://a/w.png');
	});
});
