import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import {
	extractImageUrlsFromDoc,
	splitTextOnImageUrls
} from '$lib/remarkable/pdf/extractImageUrls.js';

function doc(...content: JSONContent[]): JSONContent {
	return { type: 'doc', content };
}
function p(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}

describe('extractImageUrlsFromDoc', () => {
	it('returns empty for plain text', () => {
		const out = extractImageUrlsFromDoc(doc(p('no images here')));
		expect(out).toEqual([]);
	});

	it('finds a single image url', () => {
		const out = extractImageUrlsFromDoc(doc(p('hello https://x.com/cat.png world')));
		expect(out).toEqual(['https://x.com/cat.png']);
	});

	it('ignores non-image http urls', () => {
		const out = extractImageUrlsFromDoc(doc(p('see https://example.com/page')));
		expect(out).toEqual([]);
	});

	it('trims trailing punctuation', () => {
		const out = extractImageUrlsFromDoc(doc(p('check https://x.com/cat.png.')));
		expect(out).toEqual(['https://x.com/cat.png']);
	});

	it('walks nested content', () => {
		const out = extractImageUrlsFromDoc(
			doc({
				type: 'bulletList',
				content: [
					{
						type: 'listItem',
						content: [p('nested https://x.com/dog.jpg in list')]
					}
				]
			})
		);
		expect(out).toEqual(['https://x.com/dog.jpg']);
	});
});

describe('splitTextOnImageUrls', () => {
	it('returns one text segment when no urls', () => {
		expect(splitTextOnImageUrls('plain text')).toEqual([{ kind: 'text', value: 'plain text' }]);
	});

	it('splits around a single url in the middle', () => {
		expect(splitTextOnImageUrls('before https://x.com/cat.png after')).toEqual([
			{ kind: 'text', value: 'before ' },
			{ kind: 'image', value: 'https://x.com/cat.png' },
			{ kind: 'text', value: ' after' }
		]);
	});

	it('drops the url cleanly when at start', () => {
		expect(splitTextOnImageUrls('https://x.com/cat.png trailing')).toEqual([
			{ kind: 'image', value: 'https://x.com/cat.png' },
			{ kind: 'text', value: ' trailing' }
		]);
	});

	it('handles two urls in sequence', () => {
		expect(splitTextOnImageUrls('a https://x.com/1.png b https://x.com/2.png c')).toEqual([
			{ kind: 'text', value: 'a ' },
			{ kind: 'image', value: 'https://x.com/1.png' },
			{ kind: 'text', value: ' b ' },
			{ kind: 'image', value: 'https://x.com/2.png' },
			{ kind: 'text', value: ' c' }
		]);
	});

	it('keeps trailing punctuation as text', () => {
		expect(splitTextOnImageUrls('see https://x.com/cat.png.')).toEqual([
			{ kind: 'text', value: 'see ' },
			{ kind: 'image', value: 'https://x.com/cat.png' },
			{ kind: 'text', value: '.' }
		]);
	});

	it('passes non-image http urls through as text', () => {
		expect(splitTextOnImageUrls('go https://example.com home')).toEqual([
			{ kind: 'text', value: 'go https://example.com home' }
		]);
	});
});
