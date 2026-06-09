import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBlobMock = vi.fn();
const lookupOrFetchMock = vi.fn();
const pushToastMock = vi.fn();

vi.mock('$lib/imageCache/imageCache.js', () => ({
	getBlob: (url: string) => getBlobMock(url),
	lookupOrFetch: (url: string) => lookupOrFetchMock(url)
}));
vi.mock('$lib/stores/toast.js', () => ({
	pushToast: (...args: unknown[]) => pushToastMock(...args)
}));

import {
	resolveImageBlob,
	copyImageToClipboard,
	copyImageUrlToClipboard
} from '$lib/editor/imageActions/copyImage.js';

const HREF = 'https://example.com/pic.png';

beforeEach(() => {
	getBlobMock.mockReset();
	lookupOrFetchMock.mockReset();
	pushToastMock.mockReset();
});

describe('resolveImageBlob', () => {
	it('returns the cached blob on a hit without fetching', async () => {
		const blob = new Blob(['x'], { type: 'image/png' });
		getBlobMock.mockResolvedValueOnce(blob);
		const out = await resolveImageBlob(HREF);
		expect(out).toBe(blob);
		expect(lookupOrFetchMock).not.toHaveBeenCalled();
	});

	it('fetches+caches on a miss, then re-reads the cached blob', async () => {
		const blob = new Blob(['x'], { type: 'image/png' });
		getBlobMock.mockResolvedValueOnce(null).mockResolvedValueOnce(blob);
		lookupOrFetchMock.mockResolvedValueOnce({ src: 'blob:x', fromCache: false });
		const out = await resolveImageBlob(HREF);
		expect(lookupOrFetchMock).toHaveBeenCalledWith(HREF);
		expect(out).toBe(blob);
	});

	it('returns null when bytes never become available', async () => {
		getBlobMock.mockResolvedValue(null);
		lookupOrFetchMock.mockResolvedValueOnce({ src: HREF, fromCache: false });
		const out = await resolveImageBlob(HREF);
		expect(out).toBeNull();
	});
});

describe('copyImageUrlToClipboard', () => {
	it('writes the href as text and toasts success', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText } });
		await copyImageUrlToClipboard(HREF);
		expect(writeText).toHaveBeenCalledWith(HREF);
		expect(pushToastMock).toHaveBeenCalledWith('이미지 주소 복사됨');
		vi.unstubAllGlobals();
	});

	it('toasts an error when writeText rejects', async () => {
		const writeText = vi.fn().mockRejectedValue(new Error('denied'));
		vi.stubGlobal('navigator', { clipboard: { writeText } });
		await copyImageUrlToClipboard(HREF);
		expect(pushToastMock).toHaveBeenCalledWith('복사 실패', { kind: 'error' });
		vi.unstubAllGlobals();
	});
});

describe('copyImageToClipboard', () => {
	it('writes a PNG ClipboardItem and toasts success (png source skips conversion)', async () => {
		const blob = new Blob(['x'], { type: 'image/png' });
		getBlobMock.mockResolvedValueOnce(blob);

		// Mimic the browser: write() awaits each ClipboardItem value promise.
		const write = vi.fn().mockImplementation(async (arr: { data: Record<string, unknown> }[]) => {
			for (const it of arr) for (const v of Object.values(it.data)) await v;
		});
		const items: unknown[] = [];
		class FakeClipboardItem {
			constructor(public data: Record<string, unknown>) {
				items.push(data);
			}
		}
		vi.stubGlobal('ClipboardItem', FakeClipboardItem);
		vi.stubGlobal('navigator', { clipboard: { write } });

		await copyImageToClipboard(HREF);

		expect(write).toHaveBeenCalledTimes(1);
		expect(items[0]).toHaveProperty('image/png');
		// The PNG value is the resolved (unconverted) blob.
		const resolved = await (items[0] as Record<string, Promise<Blob>>)['image/png'];
		expect(resolved).toBe(blob);
		expect(pushToastMock).toHaveBeenCalledWith('이미지 복사됨');

		vi.unstubAllGlobals();
	});

	it('toasts error when bytes are unavailable', async () => {
		getBlobMock.mockResolvedValue(null);
		lookupOrFetchMock.mockResolvedValueOnce({ src: HREF, fromCache: false });

		const write = vi.fn().mockImplementation(async (arr: { data: Record<string, unknown> }[]) => {
			for (const it of arr) for (const v of Object.values(it.data)) await v;
		});
		class FakeClipboardItem {
			constructor(public data: Record<string, unknown>) {}
		}
		vi.stubGlobal('ClipboardItem', FakeClipboardItem);
		vi.stubGlobal('navigator', { clipboard: { write } });

		await copyImageToClipboard(HREF);

		expect(pushToastMock).toHaveBeenCalledWith('이미지 복사 실패', { kind: 'error' });
		vi.unstubAllGlobals();
	});

	it('toasts unsupported-browser error when ClipboardItem is missing', async () => {
		vi.stubGlobal('ClipboardItem', undefined);
		vi.stubGlobal('navigator', { clipboard: { write: vi.fn() } });
		await copyImageToClipboard(HREF);
		expect(pushToastMock).toHaveBeenCalledWith('이미지 복사 실패 — 브라우저가 허용하지 않음', {
			kind: 'error'
		});
		vi.unstubAllGlobals();
	});
});
