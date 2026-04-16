import { describe, it, expect } from 'vitest';
import { extractImageFile } from '$lib/editor/imagePreview/extractImageFile.js';

function fakeItems(
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

describe('extractImageFile', () => {
	it('returns null when dataTransfer is null', () => {
		expect(extractImageFile(null)).toBeNull();
	});

	it('returns null when there are no items or files', () => {
		const dt = fakeItems([]);
		expect(extractImageFile(dt)).toBeNull();
	});

	it('extracts an image/png file from items', () => {
		const f = new File(['x'], 'a.png', { type: 'image/png' });
		const dt = fakeItems([{ kind: 'file', type: 'image/png', file: f }]);
		expect(extractImageFile(dt)).toBe(f);
	});

	it('skips non-file items (e.g. string clipboard data)', () => {
		const f = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
		const dt = fakeItems([
			{ kind: 'string', type: 'text/plain' },
			{ kind: 'file', type: 'image/jpeg', file: f }
		]);
		expect(extractImageFile(dt)).toBe(f);
	});

	it('skips file items whose MIME is not image/*', () => {
		const f = new File(['x'], 'a.pdf', { type: 'application/pdf' });
		const dt = fakeItems([{ kind: 'file', type: 'application/pdf', file: f }]);
		expect(extractImageFile(dt)).toBeNull();
	});

	it('falls back to files list when items API is empty', () => {
		const f = new File(['x'], 'a.gif', { type: 'image/gif' });
		const dt = {
			items: Object.assign([], { length: 0 }),
			files: Object.assign([f], { length: 1 })
		} as unknown as DataTransfer;
		expect(extractImageFile(dt)).toBe(f);
	});

	it('returns the first image when multiple are present', () => {
		const a = new File(['a'], 'a.png', { type: 'image/png' });
		const b = new File(['b'], 'b.jpg', { type: 'image/jpeg' });
		const dt = fakeItems([
			{ kind: 'file', type: 'image/png', file: a },
			{ kind: 'file', type: 'image/jpeg', file: b }
		]);
		expect(extractImageFile(dt)).toBe(a);
	});
});
