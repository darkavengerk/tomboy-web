import { describe, it, expect } from 'vitest';
import {
	validateImageFile,
	imageFilesFromList,
	fileToImagePayload,
	MAX_IMAGE_BYTES
} from '$lib/editor/terminal/imagePasteClient.js';

function makeFile(bytes: number, type: string, name = 'x'): File {
	return new File([new Uint8Array(bytes)], name, { type });
}

describe('validateImageFile', () => {
	it('accepts a small png', () => {
		expect(validateImageFile(makeFile(10, 'image/png'))).toEqual({ ok: true });
	});
	it('rejects a non-image file', () => {
		const r = validateImageFile(makeFile(10, 'text/plain'));
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/이미지 파일/);
	});
	it('rejects an oversized image', () => {
		const r = validateImageFile(makeFile(MAX_IMAGE_BYTES + 1, 'image/png'));
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/너무 큽/);
	});
});

describe('imageFilesFromList', () => {
	it('keeps only image files', () => {
		const files = [
			makeFile(1, 'image/png', 'a'),
			makeFile(1, 'text/plain', 'b'),
			makeFile(1, 'image/jpeg', 'c')
		];
		expect(imageFilesFromList(files).map((f) => f.name)).toEqual(['a', 'c']);
	});
});

describe('fileToImagePayload', () => {
	it('reads a file into mime + base64 (no data: prefix)', async () => {
		const file = new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' });
		const payload = await fileToImagePayload(file);
		expect(payload.mime).toBe('image/png');
		// base64 of bytes [1,2,3] is "AQID"
		expect(payload.data).toBe('AQID');
	});
});
