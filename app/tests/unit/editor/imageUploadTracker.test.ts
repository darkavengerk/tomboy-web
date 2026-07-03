import { describe, it, expect } from 'vitest';
import {
	beginImageUpload,
	endImageUpload,
	pendingImageUploads
} from '$lib/editor/imageUploadTracker.svelte.js';
import type { Editor } from '@tiptap/core';

function fakeEditor(): Editor {
	return {} as Editor;
}

describe('imageUploadTracker', () => {
	it('begin/end로 카운트 증감', () => {
		const ed = fakeEditor();
		expect(pendingImageUploads(ed)).toBe(0);
		beginImageUpload(ed);
		expect(pendingImageUploads(ed)).toBe(1);
		beginImageUpload(ed);
		expect(pendingImageUploads(ed)).toBe(2);
		endImageUpload(ed);
		expect(pendingImageUploads(ed)).toBe(1);
		endImageUpload(ed);
		expect(pendingImageUploads(ed)).toBe(0);
	});

	it('에디터 인스턴스별 독립 카운트', () => {
		const a = fakeEditor();
		const b = fakeEditor();
		beginImageUpload(a);
		expect(pendingImageUploads(a)).toBe(1);
		expect(pendingImageUploads(b)).toBe(0);
		endImageUpload(a);
	});

	it('0 밑으로 안 내려감 (end 과잉 호출 무해)', () => {
		const ed = fakeEditor();
		endImageUpload(ed);
		expect(pendingImageUploads(ed)).toBe(0);
	});
});
