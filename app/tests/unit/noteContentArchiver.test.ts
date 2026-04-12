import { describe, it, expect } from 'vitest';
import {
	deserializeContent,
	serializeContent,
	extractTitleFromDoc
} from '$lib/core/noteContentArchiver.js';
import type { JSONContent } from '@tiptap/core';

// Helper to deserialize then get content nodes
function deser(xml: string): JSONContent {
	return deserializeContent(xml);
}

// Helper: deserialize → serialize round-trip
function roundTrip(xml: string): string {
	const doc = deserializeContent(xml);
	return serializeContent(doc);
}

describe('noteContentArchiver - deserialize', () => {
	it('deserializes plain text to paragraphs', () => {
		const xml = '<note-content version="0.1">Title\nBody text here.</note-content>';
		const doc = deser(xml);

		expect(doc.type).toBe('doc');
		expect(doc.content).toHaveLength(2);
		expect(doc.content![0].type).toBe('paragraph');
		expect(doc.content![0].content![0].text).toBe('Title');
		expect(doc.content![1].content![0].text).toBe('Body text here.');
	});

	it('deserializes <bold> to bold mark', () => {
		const xml = '<note-content version="0.1">Title\nSome <bold>bold text</bold> here.</note-content>';
		const doc = deser(xml);

		const body = doc.content![1];
		const boldNode = body.content!.find((n) => n.marks?.some((m) => m.type === 'bold'));
		expect(boldNode).toBeDefined();
		expect(boldNode!.text).toBe('bold text');
	});

	it('deserializes <italic> to italic mark', () => {
		const xml = '<note-content version="0.1">Title\n<italic>italic</italic></note-content>';
		const doc = deser(xml);
		const body = doc.content![1];
		const node = body.content!.find((n) => n.marks?.some((m) => m.type === 'italic'));
		expect(node).toBeDefined();
		expect(node!.text).toBe('italic');
	});

	it('deserializes <strikethrough> to strike mark', () => {
		const xml =
			'<note-content version="0.1">Title\n<strikethrough>struck</strikethrough></note-content>';
		const doc = deser(xml);
		const body = doc.content![1];
		const node = body.content!.find((n) => n.marks?.some((m) => m.type === 'strike'));
		expect(node).toBeDefined();
		expect(node!.text).toBe('struck');
	});

	it('deserializes <underline> to underline mark', () => {
		const xml = '<note-content version="0.1">Title\n<underline>under</underline></note-content>';
		const doc = deser(xml);
		const body = doc.content![1];
		const node = body.content!.find((n) => n.marks?.some((m) => m.type === 'underline'));
		expect(node).toBeDefined();
	});

	it('deserializes <highlight> to highlight mark', () => {
		const xml = '<note-content version="0.1">Title\n<highlight>hi</highlight></note-content>';
		const doc = deser(xml);
		const body = doc.content![1];
		const node = body.content!.find((n) => n.marks?.some((m) => m.type === 'highlight'));
		expect(node).toBeDefined();
	});

	it('deserializes <monospace> to tomboyMonospace mark', () => {
		const xml = '<note-content version="0.1">Title\n<monospace>code</monospace></note-content>';
		const doc = deser(xml);
		const body = doc.content![1];
		const node = body.content!.find((n) => n.marks?.some((m) => m.type === 'tomboyMonospace'));
		expect(node).toBeDefined();
		expect(node!.text).toBe('code');
	});

	it('deserializes <size:huge> to tomboySize mark with level=huge', () => {
		const xml = '<note-content version="0.1">Title\n<size:huge>big</size:huge></note-content>';
		const doc = deser(xml);
		const body = doc.content![1];
		const node = body.content!.find((n) =>
			n.marks?.some((m) => m.type === 'tomboySize' && m.attrs?.level === 'huge')
		);
		expect(node).toBeDefined();
		expect(node!.text).toBe('big');
	});

	it('deserializes <size:large> to tomboySize mark with level=large', () => {
		const xml = '<note-content version="0.1">Title\n<size:large>med</size:large></note-content>';
		const doc = deser(xml);
		const body = doc.content![1];
		const node = body.content!.find((n) =>
			n.marks?.some((m) => m.type === 'tomboySize' && m.attrs?.level === 'large')
		);
		expect(node).toBeDefined();
	});

	it('deserializes <size:small> to tomboySize mark with level=small', () => {
		const xml = '<note-content version="0.1">Title\n<size:small>tiny</size:small></note-content>';
		const doc = deser(xml);
		const body = doc.content![1];
		const node = body.content!.find((n) =>
			n.marks?.some((m) => m.type === 'tomboySize' && m.attrs?.level === 'small')
		);
		expect(node).toBeDefined();
	});

	it('deserializes <link:internal> to tomboyInternalLink mark', () => {
		const xml =
			'<note-content version="0.1">Title\n<link:internal>Other Note</link:internal></note-content>';
		const doc = deser(xml);
		const body = doc.content![1];
		const node = body.content!.find((n) =>
			n.marks?.some((m) => m.type === 'tomboyInternalLink')
		);
		expect(node).toBeDefined();
		expect(node!.text).toBe('Other Note');
		const mark = node!.marks!.find((m) => m.type === 'tomboyInternalLink');
		expect(mark!.attrs!.target).toBe('Other Note');
	});

	it('deserializes <link:url> to tomboyUrlLink mark', () => {
		const xml =
			'<note-content version="0.1">Title\n<link:url>https://example.com</link:url></note-content>';
		const doc = deser(xml);
		const body = doc.content![1];
		const node = body.content!.find((n) => n.marks?.some((m) => m.type === 'tomboyUrlLink'));
		expect(node).toBeDefined();
		expect(node!.text).toBe('https://example.com');
		const mark = node!.marks!.find((m) => m.type === 'tomboyUrlLink');
		expect(mark!.attrs!.href).toBe('https://example.com');
	});

	it('deserializes <list>/<list-item> to bulletList/listItem', () => {
		const xml =
			'<note-content version="0.1">Title\n<list><list-item dir="ltr">Item 1</list-item><list-item dir="ltr">Item 2</list-item></list></note-content>';
		const doc = deser(xml);
		const list = doc.content!.find((n) => n.type === 'bulletList');
		expect(list).toBeDefined();
		expect(list!.content).toHaveLength(2);
		expect(list!.content![0].type).toBe('listItem');
	});

	it('deserializes nested lists', () => {
		const xml =
			'<note-content version="0.1">Title\n<list><list-item dir="ltr">Parent<list><list-item dir="ltr">Child</list-item></list></list-item></list></note-content>';
		const doc = deser(xml);
		const list = doc.content!.find((n) => n.type === 'bulletList');
		expect(list).toBeDefined();
		const parentItem = list!.content![0];
		expect(parentItem.type).toBe('listItem');
		// Should have a paragraph and a nested bulletList
		const nestedList = parentItem.content!.find((n) => n.type === 'bulletList');
		expect(nestedList).toBeDefined();
		expect(nestedList!.content![0].type).toBe('listItem');
	});

	it('handles nested/overlapping marks', () => {
		const xml =
			'<note-content version="0.1">Title\n<bold><italic>both</italic></bold></note-content>';
		const doc = deser(xml);
		const body = doc.content![1];
		const node = body.content![0];
		expect(node.text).toBe('both');
		const markTypes = node.marks!.map((m) => m.type).sort();
		expect(markTypes).toContain('bold');
		expect(markTypes).toContain('italic');
	});

	it('returns empty doc for empty content', () => {
		const doc = deser('');
		expect(doc.type).toBe('doc');
		expect(doc.content!.length).toBeGreaterThanOrEqual(1);
	});
});

describe('noteContentArchiver - serialize', () => {
	it('serializes plain paragraphs to text with newlines', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toBe('<note-content version="0.1">Title\nBody</note-content>');
	});

	it('serializes bold mark to <bold> tag', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: 'normal ' },
						{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }
					]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('normal <bold>bold</bold>');
	});

	it('serializes italic mark to <italic> tag', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [{ type: 'text', text: 'italic', marks: [{ type: 'italic' }] }]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('<italic>italic</italic>');
	});

	it('serializes strike mark to <strikethrough> tag', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [{ type: 'text', text: 'struck', marks: [{ type: 'strike' }] }]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('<strikethrough>struck</strikethrough>');
	});

	it('serializes tomboySize mark to <size:level> tag', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{
							type: 'text',
							text: 'huge',
							marks: [{ type: 'tomboySize', attrs: { level: 'huge' } }]
						}
					]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('<size:huge>huge</size:huge>');
	});

	it('serializes tomboyInternalLink mark to <link:internal> tag', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{
							type: 'text',
							text: 'Other Note',
							marks: [{ type: 'tomboyInternalLink', attrs: { target: 'Other Note' } }]
						}
					]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('<link:internal>Other Note</link:internal>');
	});

	it('serializes tomboyUrlLink mark to <link:url> tag', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{
							type: 'text',
							text: 'https://example.com',
							marks: [{ type: 'tomboyUrlLink', attrs: { href: 'https://example.com' } }]
						}
					]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('<link:url>https://example.com</link:url>');
	});

	it('serializes bulletList to <list>/<list-item> tags', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							content: [
								{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }
							]
						},
						{
							type: 'listItem',
							content: [
								{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }
							]
						}
					]
				}
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('<list>');
		expect(xml).toContain('<list-item dir="ltr">Item 1</list-item>');
		expect(xml).toContain('<list-item dir="ltr">Item 2</list-item>');
		expect(xml).toContain('</list>');
	});

	it('escapes XML special characters in text', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'A < B & C > D' }] }
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('A &lt; B &amp; C &gt; D');
	});
});

describe('noteContentArchiver - round-trip', () => {
	it('round-trips plain text', () => {
		const original = '<note-content version="0.1">My Title\nSome body text.</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips bold formatting', () => {
		const original = '<note-content version="0.1">Title\nSome <bold>bold</bold> text.</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips multiple formatting tags', () => {
		const original =
			'<note-content version="0.1">Title\n<bold>bold</bold> and <italic>italic</italic></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips size tags', () => {
		const original =
			'<note-content version="0.1">Title\n<size:huge>huge</size:huge> and <size:small>small</size:small></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips link tags', () => {
		const original =
			'<note-content version="0.1">Title\n<link:internal>Other</link:internal> and <link:url>https://x.com</link:url></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips list structure', () => {
		const original =
			'<note-content version="0.1">Title\n<list><list-item dir="ltr">A</list-item><list-item dir="ltr">B</list-item></list></note-content>';
		expect(roundTrip(original)).toBe(original);
	});
});

describe('extractTitleFromDoc', () => {
	it('extracts title from first paragraph', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'My Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }
			]
		};
		expect(extractTitleFromDoc(doc)).toBe('My Title');
	});

	it('returns empty string for empty doc', () => {
		const doc: JSONContent = { type: 'doc', content: [] };
		expect(extractTitleFromDoc(doc)).toBe('');
	});

	it('concatenates text nodes in first paragraph', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: 'Hello ' },
						{ type: 'text', text: 'World', marks: [{ type: 'bold' }] }
					]
				}
			]
		};
		expect(extractTitleFromDoc(doc)).toBe('Hello World');
	});
});
