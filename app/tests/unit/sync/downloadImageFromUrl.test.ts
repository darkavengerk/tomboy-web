import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sharingGetSharedLinkFileMock = vi.fn();
vi.mock('$lib/sync/dropboxClient.js', () => ({
	getClient: () => ({
		sharingGetSharedLinkFile: (...args: unknown[]) => sharingGetSharedLinkFileMock(...args)
	}),
	getImagesPath: () => ''
}));

import { downloadImageFromUrl } from '$lib/sync/imageUpload.js';

const origFetch = globalThis.fetch;

describe('downloadImageFromUrl', () => {
	beforeEach(() => {
		sharingGetSharedLinkFileMock.mockReset();
	});
	afterEach(() => {
		globalThis.fetch = origFetch;
	});

	it('routes www.dropbox.com via Dropbox SDK (sharingGetSharedLinkFile)', async () => {
		sharingGetSharedLinkFileMock.mockResolvedValue({
			result: { fileBlob: new Blob(['drop']) }
		});
		const blob = await downloadImageFromUrl('https://www.dropbox.com/scl/abc?raw=1');
		expect(sharingGetSharedLinkFileMock).toHaveBeenCalledOnce();
		expect(await blob.text()).toBe('drop');
	});

	it('routes dropboxusercontent.com via Dropbox SDK', async () => {
		sharingGetSharedLinkFileMock.mockResolvedValue({
			result: { fileBlob: new Blob(['drop2']) }
		});
		await downloadImageFromUrl('https://dl.dropboxusercontent.com/x');
		expect(sharingGetSharedLinkFileMock).toHaveBeenCalledOnce();
	});

	it('routes other hosts (Vercel Blob) to plain fetch', async () => {
		globalThis.fetch = vi.fn(
			async () => new Response('vercel-bytes', { status: 200 })
		) as typeof fetch;

		const blob = await downloadImageFromUrl(
			'https://x.public.blob.vercel-storage.com/temp-images/a.png'
		);

		expect(sharingGetSharedLinkFileMock).not.toHaveBeenCalled();
		expect(await blob.text()).toBe('vercel-bytes');
	});

	it('throws on non-2xx for non-Dropbox', async () => {
		globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as typeof fetch;
		await expect(downloadImageFromUrl('https://example.com/a.png')).rejects.toThrow();
	});
});
