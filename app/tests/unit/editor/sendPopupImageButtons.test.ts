import { describe, it, expect, vi } from 'vitest';
import { extractImageFromClipboardItems } from '../../../src/lib/editor/terminal/clipboardImage';

describe('extractImageFromClipboardItems', () => {
	it('이미지 타입 ClipboardItem이 있으면 첫 번째를 File로 반환', async () => {
		const blob = new Blob(['fake-png-bytes'], { type: 'image/png' });
		const item = {
			types: ['text/plain', 'image/png'],
			getType: vi.fn(async (t: string) => {
				if (t === 'image/png') return blob;
				throw new Error('not found');
			})
		} as unknown as ClipboardItem;
		const result = await extractImageFromClipboardItems([item]);
		expect(result).not.toBeNull();
		expect(result?.type).toBe('image/png');
		expect(result?.name).toBe('pasted');
	});

	it('이미지 타입이 없으면 null', async () => {
		const item = {
			types: ['text/plain'],
			getType: vi.fn()
		} as unknown as ClipboardItem;
		const result = await extractImageFromClipboardItems([item]);
		expect(result).toBeNull();
	});

	it('빈 리스트면 null', async () => {
		const result = await extractImageFromClipboardItems([]);
		expect(result).toBeNull();
	});

	it('여러 이미지 항목 중 첫 번째를 반환', async () => {
		const pngBlob = new Blob(['png-bytes'], { type: 'image/png' });
		const jpgBlob = new Blob(['jpg-bytes'], { type: 'image/jpeg' });
		const item1 = {
			types: ['image/png'],
			getType: vi.fn(async () => pngBlob)
		} as unknown as ClipboardItem;
		const item2 = {
			types: ['image/jpeg'],
			getType: vi.fn(async () => jpgBlob)
		} as unknown as ClipboardItem;
		const result = await extractImageFromClipboardItems([item1, item2]);
		expect(result?.type).toBe('image/png');
	});
});
