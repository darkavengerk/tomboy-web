import { describe, it, expect } from 'vitest';
import { isImageUrl } from '$lib/editor/imagePreview/isImageUrl.js';

describe('isImageUrl — extension-based detection', () => {
	it('accepts .png / .jpg / .jpeg / .gif / .webp / .svg / .avif / .bmp', () => {
		expect(isImageUrl('https://example.com/cat.png')).toBe(true);
		expect(isImageUrl('https://example.com/cat.jpg')).toBe(true);
		expect(isImageUrl('https://example.com/cat.jpeg')).toBe(true);
		expect(isImageUrl('https://example.com/cat.gif')).toBe(true);
		expect(isImageUrl('https://example.com/cat.webp')).toBe(true);
		expect(isImageUrl('https://example.com/cat.svg')).toBe(true);
		expect(isImageUrl('https://example.com/cat.avif')).toBe(true);
		expect(isImageUrl('https://example.com/cat.bmp')).toBe(true);
	});

	it('is case-insensitive for the extension', () => {
		expect(isImageUrl('https://example.com/cat.PNG')).toBe(true);
		expect(isImageUrl('https://example.com/cat.Jpg')).toBe(true);
		expect(isImageUrl('https://example.com/cat.JPEG')).toBe(true);
	});

	it('ignores query strings and fragments when checking the extension', () => {
		expect(isImageUrl('https://example.com/cat.png?v=2')).toBe(true);
		expect(isImageUrl('https://example.com/cat.jpg#section')).toBe(true);
		expect(isImageUrl('https://example.com/cat.webp?size=large&v=1#anchor')).toBe(true);
	});

	it('accepts http:// and https:// only', () => {
		expect(isImageUrl('http://example.com/cat.png')).toBe(true);
		expect(isImageUrl('https://example.com/cat.png')).toBe(true);
	});

	it('rejects non-image extensions', () => {
		expect(isImageUrl('https://example.com/doc.pdf')).toBe(false);
		expect(isImageUrl('https://example.com/page.html')).toBe(false);
		expect(isImageUrl('https://example.com/script.js')).toBe(false);
		expect(isImageUrl('https://example.com/')).toBe(false);
		expect(isImageUrl('https://example.com/nofile')).toBe(false);
	});

	it('rejects non-http(s) schemes (local / file / data / blob)', () => {
		expect(isImageUrl('file:///home/user/cat.png')).toBe(false);
		expect(isImageUrl('data:image/png;base64,iVBORw0KGgo')).toBe(false);
		expect(isImageUrl('blob:https://example.com/abc-123')).toBe(false);
		expect(isImageUrl('ftp://example.com/cat.png')).toBe(false);
	});

	it('rejects invalid / empty strings', () => {
		expect(isImageUrl('')).toBe(false);
		expect(isImageUrl('   ')).toBe(false);
		expect(isImageUrl('not a url')).toBe(false);
		expect(isImageUrl('example.com/cat.png')).toBe(false); // no scheme
	});

	it('does not match extension inside the query string', () => {
		// "foo.png" appearing in the query must not flip a non-image path
		// to look like an image.
		expect(isImageUrl('https://example.com/page?file=foo.png')).toBe(false);
	});
});

describe('isImageUrl — Dropbox-style direct links', () => {
	it('accepts ?raw=1 shared links even when dl=0 is also present', () => {
		expect(
			isImageUrl('https://www.dropbox.com/s/abc/cat.png?dl=0&raw=1')
		).toBe(true);
	});

	it('accepts dl.dropboxusercontent.com direct URLs', () => {
		expect(
			isImageUrl('https://dl.dropboxusercontent.com/s/abc/cat.jpg')
		).toBe(true);
	});
});
