import { describe, it, expect } from 'vitest';
import { createFileBadgeElement, filenameFromUrl } from '$lib/editor/filePreview/fileBadge.js';

describe('filenameFromUrl', () => {
	it('extracts last path segment and decodes', () => {
		expect(
			filenameFromUrl('https://b.test/files/u/' + encodeURIComponent('문서.pdf'))
		).toBe('문서.pdf');
	});

	it('handles plain ASCII', () => {
		expect(filenameFromUrl('https://b.test/files/u/doc.pdf')).toBe('doc.pdf');
	});

	it('returns 파일 for empty filename', () => {
		expect(filenameFromUrl('https://b.test/files/u/')).toBe('파일');
	});

	it('returns 파일 on decode failure', () => {
		expect(filenameFromUrl('https://b.test/files/u/%E0%A4%A')).toBe('파일');
	});
});

describe('createFileBadgeElement', () => {
	it('returns <a> with href, target _blank, and filename text', () => {
		const a = createFileBadgeElement('https://b.test/files/u/doc.pdf');
		expect(a.tagName).toBe('A');
		expect(a.getAttribute('href')).toBe('https://b.test/files/u/doc.pdf');
		expect(a.getAttribute('target')).toBe('_blank');
		expect(a.getAttribute('rel')).toContain('noopener');
		expect(a.textContent).toContain('doc.pdf');
		expect(a.textContent).toContain('📎');
	});
});
