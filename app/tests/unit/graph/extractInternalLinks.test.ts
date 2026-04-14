import { describe, it, expect } from 'vitest';
import { extractInternalLinkTargets } from '$lib/graph/extractInternalLinks.js';

describe('extractInternalLinkTargets', () => {
	it('collects all tomboyInternalLink mark targets', () => {
		const doc = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: 'See ' },
						{
							type: 'text',
							text: 'Alpha',
							marks: [{ type: 'tomboyInternalLink', attrs: { target: 'Alpha' } }]
						},
						{ type: 'text', text: ' and ' },
						{
							type: 'text',
							text: 'Beta',
							marks: [{ type: 'tomboyInternalLink', attrs: { target: 'Beta' } }]
						}
					]
				}
			]
		};
		expect(extractInternalLinkTargets(doc)).toEqual(['Alpha', 'Beta']);
	});

	it('deduplicates identical targets', () => {
		const doc = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{
							type: 'text',
							text: 'x',
							marks: [{ type: 'tomboyInternalLink', attrs: { target: 'A' } }]
						},
						{
							type: 'text',
							text: 'y',
							marks: [{ type: 'tomboyInternalLink', attrs: { target: 'A' } }]
						}
					]
				}
			]
		};
		expect(extractInternalLinkTargets(doc)).toEqual(['A']);
	});

	it('excludes broken links', () => {
		const doc = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{
							type: 'text',
							text: 'Gone',
							marks: [{ type: 'tomboyInternalLink', attrs: { target: 'Gone', broken: true } }]
						},
						{
							type: 'text',
							text: 'Live',
							marks: [{ type: 'tomboyInternalLink', attrs: { target: 'Live' } }]
						}
					]
				}
			]
		};
		expect(extractInternalLinkTargets(doc)).toEqual(['Live']);
	});

	it('returns empty array for docs without internal links', () => {
		const doc = {
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }]
		};
		expect(extractInternalLinkTargets(doc)).toEqual([]);
	});
});
