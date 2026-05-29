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

	it('click opens the URL via window.open and suppresses default', () => {
		const a = createFileBadgeElement('https://b.test/files/u/doc.pdf');
		const calls: Array<[string, string, string]> = [];
		const originalOpen = window.open;
		// @ts-expect-error — stub for spy
		window.open = (url: string, target: string, features: string) => {
			calls.push([url, target, features]);
			return null;
		};
		try {
			const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
			const dispatched = a.dispatchEvent(evt);
			expect(dispatched).toBe(false); // preventDefault was called
			expect(calls).toEqual([
				['https://b.test/files/u/doc.pdf', '_blank', 'noopener,noreferrer']
			]);
		} finally {
			window.open = originalOpen;
		}
	});
});
