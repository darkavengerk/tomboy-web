import { describe, it, expect } from 'vitest';
import {
	serializeContent,
	deserializeContent
} from '$lib/core/noteContentArchiver.js';
import type { JSONContent } from '@tiptap/core';

function para(content: JSONContent[]): JSONContent {
	return { type: 'paragraph', content };
}
function txt(text: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>): JSONContent {
	const n: JSONContent = { type: 'text', text };
	if (marks) n.marks = marks;
	return n;
}
function link(target: string) {
	return { type: 'tomboyInternalLink', attrs: { target } };
}
function urlLink(href: string) {
	return { type: 'tomboyUrlLink', attrs: { href } };
}

/**
 * Tomboy desktop emits link marks as self-contained per-span tags; a link
 * never crosses a paragraph boundary. Regression against the serializer
 * merging three adjacent same-target links into one <link:internal> wrapping
 * both paragraph separators.
 */
describe('serializeContent — link marks must close at paragraph boundaries', () => {
	it('three paragraphs with identical internal-link marks serialize as three separate tags', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				para([txt('처음 먹는 마음의 중요성', [link('처음 먹는 마음의 중요성')])]),
				para([txt('처음 먹는 마음의 중요성', [link('처음 먹는 마음의 중요성')])]),
				para([txt('처음 먹는 마음의 중요성', [link('처음 먹는 마음의 중요성')])])
			]
		};
		const xml = serializeContent(doc);
		// Each paragraph's link should have its own <link:internal>…</link:internal>.
		const matches = xml.match(/<link:internal>/g) ?? [];
		expect(matches.length).toBe(3);
		// And the '\n' separators must sit OUTSIDE the link tags.
		expect(xml).not.toMatch(/<link:internal>[^<]*\n[^<]*<\/link:internal>/);
	});

	it('two adjacent paragraphs with the same internal link emit two tags', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				para([txt('Foo', [link('Foo')])]),
				para([txt('Foo', [link('Foo')])])
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toBe(
			`<note-content version="0.1"><link:internal>Foo</link:internal>\n<link:internal>Foo</link:internal></note-content>`
		);
	});

	it('URL link marks also close at paragraph boundaries', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				para([txt('https://x', [urlLink('https://x')])]),
				para([txt('https://x', [urlLink('https://x')])])
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toBe(
			`<note-content version="0.1"><link:url>https://x</link:url>\n<link:url>https://x</link:url></note-content>`
		);
	});

	it('bold marks STILL span paragraph boundaries (Tomboy-compatible)', () => {
		// This is the legitimate case the original spanning logic was written
		// for: the same bold mark across two paragraphs is one open tag in
		// Tomboy's XML.
		const doc: JSONContent = {
			type: 'doc',
			content: [
				para([txt('line1', [{ type: 'bold' }])]),
				para([txt('line2', [{ type: 'bold' }])])
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('<bold>line1\nline2</bold>');
	});

	it('round-trips a three-line identical-link note', () => {
		const xml =
			`<note-content version="0.1">` +
			`<link:internal>Foo</link:internal>\n` +
			`<link:internal>Foo</link:internal>\n` +
			`<link:internal>Foo</link:internal>` +
			`</note-content>`;
		const doc = deserializeContent(xml);
		expect(serializeContent(doc)).toBe(xml);
	});
});
