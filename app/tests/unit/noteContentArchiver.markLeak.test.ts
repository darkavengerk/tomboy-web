import { describe, it, expect } from 'vitest';
import {
	serializeContent,
	deserializeContent
} from '$lib/core/noteContentArchiver.js';
import type { JSONContent } from '@tiptap/core';

function para(content?: JSONContent[]): JSONContent {
	return content ? { type: 'paragraph', content } : { type: 'paragraph' };
}
function txt(text: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>): JSONContent {
	const n: JSONContent = { type: 'text', text };
	if (marks) n.marks = marks;
	return n;
}
function link(target: string) {
	return { type: 'tomboyInternalLink', attrs: { target } };
}

describe('serializeContent — marks must not leak across empty paragraphs', () => {
	it('closes an internal-link mark before a trailing empty paragraph', () => {
		// Doc: [para: "Foo" with link] [empty para] [para: "bar"]
		const doc: JSONContent = {
			type: 'doc',
			content: [
				para([txt('Foo', [link('Foo')])]),
				para(),
				para([txt('bar')])
			]
		};
		const xml = serializeContent(doc);
		// The link must NOT swallow the \n\n before "bar".
		expect(xml).toContain('<link:internal>Foo</link:internal>');
		expect(xml).not.toMatch(/<link:internal>Foo\n\n?<\/link:internal>/);
		expect(xml).not.toMatch(/<link:internal>Foo\n\n<\/link:internal>bar/);
	});

	it('closes a mark at end of a paragraph when next paragraph has no such mark', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				para([txt('hello', [{ type: 'bold' }])]),
				para([txt('world')])
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain('<bold>hello</bold>\nworld');
	});

	it('keeps a mark open across a \\n when both adjacent paragraphs share it (legitimate spanning)', () => {
		// This is the Tomboy-compatible case: bold spans two paragraphs.
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

	it('does not leak a mark through an empty para before an unmarked para', () => {
		// Repro of the diff the user reported at end of the note:
		//   [para: ..., "주기적으로 업데이트 하기"(link)] [empty] [para: "2024-12-18 시작"]
		const doc: JSONContent = {
			type: 'doc',
			content: [
				para([
					txt('ref '),
					txt('주기적으로 업데이트 하기', [link('주기적으로 업데이트 하기')])
				]),
				para(),
				para([txt('2024-12-18 시작')])
			]
		};
		const xml = serializeContent(doc);
		expect(xml).toContain(
			'<link:internal>주기적으로 업데이트 하기</link:internal>'
		);
		// Must NOT be: <link:internal>주기적으로 업데이트 하기\n\n</link:internal>2024-12-18
		expect(xml).not.toMatch(
			/주기적으로 업데이트 하기\n\n<\/link:internal>2024-12-18/
		);
	});

	it('round-trips a note whose link ends at a paragraph boundary', () => {
		const xml = `<note-content version="0.1">before <link:internal>Foo</link:internal>\n\nafter</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		// Idempotency: serializing what we parsed should yield identical XML.
		expect(out).toBe(xml);
	});

	it('round-trips a standalone title-line link followed by empty paragraphs', () => {
		const xml = `<note-content version="0.1"><link:internal>Foo</link:internal>\n\nbody</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		expect(out).toBe(xml);
	});
});
