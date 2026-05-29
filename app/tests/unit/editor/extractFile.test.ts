import { describe, it, expect } from 'vitest';
import { extractAnyFile } from '$lib/editor/extractFile.js';

function fakeDt(
	items: Array<{ kind: string; type: string; file?: File }>
): DataTransfer {
	const files: File[] = items.filter((i) => i.file).map((i) => i.file!);
	const itemsList = items.map((i) => ({
		kind: i.kind,
		type: i.type,
		getAsFile: () => i.file ?? null
	}));
	return {
		items: Object.assign(itemsList, { length: itemsList.length }),
		files: Object.assign(files, { length: files.length })
	} as unknown as DataTransfer;
}

describe('extractAnyFile', () => {
	it('returns null when dataTransfer is null', () => {
		expect(extractAnyFile(null)).toBeNull();
	});

	it('returns null when there are no items or files', () => {
		expect(extractAnyFile(fakeDt([]))).toBeNull();
	});

	it('picks the image when image only', () => {
		const f = new File(['x'], 'a.png', { type: 'image/png' });
		const r = extractAnyFile(fakeDt([{ kind: 'file', type: 'image/png', file: f }]));
		expect(r).not.toBeNull();
		expect(r!.isImage).toBe(true);
		expect(r!.file).toBe(f);
	});

	it('picks the file when non-image only', () => {
		const f = new File(['x'], 'a.pdf', { type: 'application/pdf' });
		const r = extractAnyFile(
			fakeDt([{ kind: 'file', type: 'application/pdf', file: f }])
		);
		expect(r).not.toBeNull();
		expect(r!.isImage).toBe(false);
		expect(r!.file).toBe(f);
	});

	it('prefers the image when image + non-image are both present', () => {
		const img = new File(['x'], 'a.png', { type: 'image/png' });
		const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
		const r = extractAnyFile(
			fakeDt([
				{ kind: 'file', type: 'application/pdf', file: pdf },
				{ kind: 'file', type: 'image/png', file: img }
			])
		);
		expect(r).not.toBeNull();
		expect(r!.isImage).toBe(true);
		expect(r!.file).toBe(img);
	});

	it('ignores string items', () => {
		const f = new File(['x'], 'a.pdf', { type: 'application/pdf' });
		const r = extractAnyFile(
			fakeDt([
				{ kind: 'string', type: 'text/plain' },
				{ kind: 'file', type: 'application/pdf', file: f }
			])
		);
		expect(r).not.toBeNull();
		expect(r!.isImage).toBe(false);
		expect(r!.file).toBe(f);
	});

	it('falls back to files list when items API is empty (drag-drop browser case)', () => {
		const f = new File(['x'], 'a.zip', { type: 'application/zip' });
		const dt = {
			items: Object.assign([], { length: 0 }),
			files: Object.assign([f], { length: 1 })
		} as unknown as DataTransfer;
		const r = extractAnyFile(dt);
		expect(r).not.toBeNull();
		expect(r!.isImage).toBe(false);
		expect(r!.file).toBe(f);
	});

	it('falls back to files list and still prefers an image', () => {
		const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
		const img = new File(['x'], 'a.png', { type: 'image/png' });
		const dt = {
			items: Object.assign([], { length: 0 }),
			files: Object.assign([pdf, img], { length: 2 })
		} as unknown as DataTransfer;
		const r = extractAnyFile(dt);
		expect(r).not.toBeNull();
		expect(r!.isImage).toBe(true);
		expect(r!.file).toBe(img);
	});
});
