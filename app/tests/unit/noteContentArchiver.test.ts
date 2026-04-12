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
		// Tomboy desktop inserts '\n' before </list-item> for every item except
		// the last one in a list.
		expect(xml).toContain('<list-item dir="ltr">Item 1\n</list-item>');
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
			'<note-content version="0.1">Title\n<list><list-item dir="ltr">A\n</list-item><list-item dir="ltr">B</list-item></list></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('preserves blank lines between paragraphs', () => {
		const original = '<note-content version="0.1">Title\nA\n\nB</note-content>';
		const doc = deser(original);
		expect(doc.content).toHaveLength(4);
		expect(doc.content![2].type).toBe('paragraph');
		expect(doc.content![2].content).toBeUndefined();
		expect(roundTrip(original)).toBe(original);
	});

	it('preserves multiple consecutive blank lines', () => {
		const original = '<note-content version="0.1">Title\nA\n\n\nB</note-content>';
		expect(roundTrip(original)).toBe(original);
	});
});

// Ground-truth cases derived from reading ref/Tomboy/NoteBuffer.cs — the original
// Tomboy desktop serializer/deserializer. These are shapes the desktop app actually
// produces and consumes, so round-tripping them verbatim is the correctness bar.
describe('noteContentArchiver - ref-grounded round-trip', () => {
	it('round-trips trailing blank line after content', () => {
		const original = '<note-content version="0.1">Title\nBody\n</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips leading blank line after title', () => {
		const original = '<note-content version="0.1">Title\n\nBody</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips whitespace inside bold mark', () => {
		const original =
			'<note-content version="0.1">Title\nA <bold>  padded  </bold> B</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips adjacent marks without space', () => {
		const original =
			'<note-content version="0.1">Title\n<bold>bold</bold><italic>italic</italic></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips XML special characters', () => {
		const original =
			'<note-content version="0.1">Title\nif (a &lt; b &amp;&amp; c &gt; d) return;</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips special characters inside marks', () => {
		const original =
			'<note-content version="0.1">Title\n<monospace>x &lt; y</monospace></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips URL with query string', () => {
		const original =
			'<note-content version="0.1">Title\nsee <link:url>https://example.com/path?q=1&amp;r=2</link:url> here</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips nested bold inside italic', () => {
		const original =
			'<note-content version="0.1">Title\n<italic>a <bold>b</bold> c</italic></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips all three size levels mixed', () => {
		const original =
			'<note-content version="0.1">Title\n<size:huge>H</size:huge> <size:large>L</size:large> <size:small>S</size:small></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips size mark combined with bold', () => {
		const original =
			'<note-content version="0.1">Title\n<size:large><bold>Big Bold</bold></size:large></note-content>';
		const doc = deser(original);
		const para = doc.content![1];
		const node = para.content![0];
		const markTypes = (node.marks ?? []).map((m) => m.type).sort();
		expect(markTypes).toContain('bold');
		expect(markTypes).toContain('tomboySize');
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips paragraph after a list', () => {
		const original =
			'<note-content version="0.1">Title\n<list><list-item dir="ltr">item</list-item></list>\nAfter list</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips nested lists two levels deep', () => {
		const original =
			'<note-content version="0.1">Title\n<list><list-item dir="ltr">A\n<list><list-item dir="ltr">A.1\n</list-item><list-item dir="ltr">A.2</list-item></list></list-item><list-item dir="ltr">B</list-item></list></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips list item with inline formatting', () => {
		const original =
			'<note-content version="0.1">Title\n<list><list-item dir="ltr"><bold>bold item</bold>\n</list-item><list-item dir="ltr">plain</list-item></list></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips broken internal link', () => {
		const original =
			'<note-content version="0.1">Title\n<link:broken>Missing</link:broken></note-content>';
		const doc = deser(original);
		const node = doc.content![1].content![0];
		const mark = node.marks!.find((m) => m.type === 'tomboyInternalLink');
		expect(mark!.attrs!.broken).toBe(true);
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips all mark types in a single paragraph', () => {
		const original =
			'<note-content version="0.1">Title\n<bold>b</bold> <italic>i</italic> <strikethrough>s</strikethrough> <underline>u</underline> <highlight>h</highlight> <monospace>m</monospace></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips a mixed realistic note', () => {
		const original =
			'<note-content version="0.1">My Note\n\nIntro with <bold>emphasis</bold>.\n\n<list><list-item dir="ltr">first\n</list-item><list-item dir="ltr"><italic>second</italic></list-item></list>\nA link: <link:url>https://example.com</link:url> and <link:internal>Another Note</link:internal>.</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	// --- Unicode ---

	it('round-trips Korean text', () => {
		const original = '<note-content version="0.1">제목\n한글 본문입니다.</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips emoji', () => {
		const original = '<note-content version="0.1">Title\n안녕 🌙 👋 hello</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips mixed CJK and marks', () => {
		const original =
			'<note-content version="0.1">제목\n<bold>굵게</bold>와 <italic>기울임</italic> 混合</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips Korean inside internal link target', () => {
		const original =
			'<note-content version="0.1">제목\n<link:internal>다른 노트</link:internal></note-content>';
		const doc = deser(original);
		const node = doc.content![1].content![0];
		const mark = node.marks!.find((m) => m.type === 'tomboyInternalLink');
		expect(mark!.attrs!.target).toBe('다른 노트');
		expect(roundTrip(original)).toBe(original);
	});

	// --- Mark crossing newline (Tomboy desktop produces this on multi-line bold) ---

	it('splits a mark that spans a newline into multiple paragraphs', () => {
		const original = '<note-content version="0.1">Title\n<bold>line1\nline2</bold></note-content>';
		const doc = deser(original);
		// Two paragraphs after the title, each bolded.
		expect(doc.content).toHaveLength(3);
		const p1 = doc.content![1];
		const p2 = doc.content![2];
		expect(p1.content![0].text).toBe('line1');
		expect(p1.content![0].marks?.[0].type).toBe('bold');
		expect(p2.content![0].text).toBe('line2');
		expect(p2.content![0].marks?.[0].type).toBe('bold');
	});

	it('round-trips a bold mark spanning a newline', () => {
		const original = '<note-content version="0.1">Title\n<bold>line1\nline2</bold></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips italic over three lines', () => {
		const original =
			'<note-content version="0.1">T\n<italic>a\nb\nc</italic></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips mark spanning a blank line', () => {
		const original =
			'<note-content version="0.1">T\n<bold>a\n\nb</bold></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	// --- Multi-mark combinations ---

	it('round-trips three overlapping marks', () => {
		const original =
			'<note-content version="0.1">T\n<bold><italic><underline>triple</underline></italic></bold></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips size mark wrapping a url link', () => {
		const original =
			'<note-content version="0.1">T\n<size:large><link:url>https://example.com</link:url></size:large></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips alternating bold/italic runs', () => {
		const original =
			'<note-content version="0.1">T\n<bold>a</bold><italic>b</italic><bold>c</bold><italic>d</italic></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips mark at the very start of a paragraph', () => {
		const original = '<note-content version="0.1">T\n<bold>leading</bold> rest</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips mark at the very end of a paragraph', () => {
		const original = '<note-content version="0.1">T\nrest <bold>trailing</bold></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	// --- Adjacent links with different attrs must not merge ---

	it('keeps two different url links adjacent without merging', () => {
		const original =
			'<note-content version="0.1">T\n<link:url>https://a.com</link:url><link:url>https://b.com</link:url></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('keeps two different internal links adjacent without merging', () => {
		const original =
			'<note-content version="0.1">T\n<link:internal>NoteA</link:internal><link:internal>NoteB</link:internal></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	// --- List edge cases ---

	it('round-trips three-level nested list', () => {
		const original =
			'<note-content version="0.1">T\n<list><list-item dir="ltr">L1\n<list><list-item dir="ltr">L2\n<list><list-item dir="ltr">L3</list-item></list></list-item></list></list-item></list></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips list item containing only formatted text', () => {
		const original =
			'<note-content version="0.1">T\n<list><list-item dir="ltr"><bold>only bold</bold></list-item></list></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips list item with multiple marks', () => {
		const original =
			'<note-content version="0.1">T\n<list><list-item dir="ltr">a <bold>b</bold> <italic>c</italic> d</list-item></list></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips blank line between two lists', () => {
		const original =
			'<note-content version="0.1">T\n<list><list-item dir="ltr">A</list-item></list>\n\n<list><list-item dir="ltr">B</list-item></list></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips list followed immediately by paragraph (no blank)', () => {
		const original =
			'<note-content version="0.1">T\n<list><list-item dir="ltr">item</list-item></list>\nnext para</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	// --- Whitespace-sensitive ---

	it('round-trips whitespace-only text between marks', () => {
		const original =
			'<note-content version="0.1">T\n<bold>a</bold>   <italic>b</italic></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips tab characters', () => {
		const original = '<note-content version="0.1">T\nindented\twith\ttabs</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('preserves multiple spaces inside text', () => {
		const original = '<note-content version="0.1">T\nthree   spaces</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	// --- Extreme content ---

	it('round-trips a large realistic note', () => {
		const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
		const original = `<note-content version="0.1">Title\n${body}</note-content>`;
		expect(roundTrip(original)).toBe(original);
	});

	it('handles deeply nested mark combos at scale', () => {
		const original =
			'<note-content version="0.1">T\n' +
			'<bold>A</bold> <italic>B</italic> <bold><italic>AB</italic></bold> ' +
			'<underline>U</underline> <highlight>H</highlight> <monospace>M</monospace> ' +
			'<size:huge>huge</size:huge> <size:small>tiny</size:small>' +
			'</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	// --- Title extraction variants ---

	it('extractTitleFromDoc strips marks from title', () => {
		const doc = deser(
			'<note-content version="0.1"><bold>Bold Title</bold>\nBody</note-content>'
		);
		expect(extractTitleFromDoc(doc)).toBe('Bold Title');
	});

	it('extractTitleFromDoc returns empty for empty first paragraph', () => {
		const doc = deser('<note-content version="0.1">\nBody</note-content>');
		expect(extractTitleFromDoc(doc)).toBe('');
	});

	// --- Pathological inputs (must not throw) ---

	it('handles note-content with only newlines', () => {
		expect(() => deser('<note-content version="0.1">\n\n\n</note-content>')).not.toThrow();
	});

	it('handles empty note-content element', () => {
		const doc = deser('<note-content version="0.1"></note-content>');
		expect(doc.type).toBe('doc');
		expect(doc.content!.length).toBeGreaterThanOrEqual(1);
	});

	it('handles missing note-content wrapper gracefully', () => {
		const doc = deser('no wrapper here');
		expect(doc.type).toBe('doc');
	});

	// --- Adjacent marks with different attrs must not merge ---

	it('keeps two different size levels adjacent', () => {
		const original =
			'<note-content version="0.1">T\n<size:huge>H</size:huge><size:large>L</size:large></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('keeps broken link and internal link distinct when adjacent', () => {
		const original =
			'<note-content version="0.1">T\n<link:broken>X</link:broken><link:internal>Y</link:internal></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	// --- First block is a list (no title paragraph) ---

	it('handles a document whose first block is a list', () => {
		const original =
			'<note-content version="0.1"><list><list-item dir="ltr">A</list-item></list></note-content>';
		const doc = deser(original);
		// Tomboy notes conventionally have a title; this is a pathological input
		// but must not throw. Just verify it round-trips or at least parses.
		expect(doc.type).toBe('doc');
		expect(doc.content!.length).toBeGreaterThanOrEqual(1);
	});

	// --- Deeply stacked marks ---

	it('round-trips four stacked marks', () => {
		const original =
			'<note-content version="0.1">T\n<bold><italic><underline><highlight>quad</highlight></underline></italic></bold></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	// --- Partial overlap of marks ---

	it('round-trips partially overlapping marks (bold over half of italic)', () => {
		// italic spans "abcd"; bold spans "cd"
		const original =
			'<note-content version="0.1">T\n<italic>ab<bold>cd</bold></italic></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips bold run split by an italic run with different marks', () => {
		const original =
			'<note-content version="0.1">T\n<bold>A</bold><italic>B</italic><bold>C</bold></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	// --- Mark continuing across paragraphs with surrounding unmarked text ---

	it('round-trips text-bold-newline-bold-text', () => {
		const original =
			'<note-content version="0.1">T\npre <bold>in1\nin2</bold> post</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips blank-line inside a multiline bold span', () => {
		const original = '<note-content version="0.1">T\n<bold>x\n\n\ny</bold></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	// --- Numbers, symbols, punctuation ---

	it('round-trips code-like content with special punctuation', () => {
		const original =
			'<note-content version="0.1">T\n<monospace>arr[i] = (a &lt; b) ? x : y;</monospace></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	it('round-trips text with consecutive special chars', () => {
		const original = '<note-content version="0.1">T\n&amp;&amp;&lt;&lt;&gt;&gt;</note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	// --- List with blank line preceding ---

	it('round-trips blank line before a list', () => {
		const original =
			'<note-content version="0.1">T\n\n<list><list-item dir="ltr">A</list-item></list></note-content>';
		expect(roundTrip(original)).toBe(original);
	});

	// --- Deserialize stability: repeated deser/ser preserves identity ---

	it('is idempotent under multiple round-trips', () => {
		const original =
			'<note-content version="0.1">T\n<bold>a\nb</bold>\n<list><list-item dir="ltr">x</list-item></list>\nafter</note-content>';
		const once = roundTrip(original);
		const twice = roundTrip(once);
		const thrice = roundTrip(twice);
		expect(once).toBe(original);
		expect(twice).toBe(original);
		expect(thrice).toBe(original);
	});

	// --- Schema-validity: no text node with embedded newline after parsing ---

	it('never produces a text node containing a literal newline', () => {
		const inputs = [
			'<note-content version="0.1">T\n<bold>a\nb</bold></note-content>',
			'<note-content version="0.1">T\n<italic>x\ny\nz</italic></note-content>',
			'<note-content version="0.1">T\npre <bold>a\nb</bold> post</note-content>',
			'<note-content version="0.1">T\n<bold>a\n\nb</bold></note-content>'
		];
		for (const xml of inputs) {
			const doc = deser(xml);
			const walk = (n: JSONContent) => {
				if (n.type === 'text' && typeof n.text === 'string') {
					expect(n.text).not.toContain('\n');
				}
				for (const c of n.content ?? []) walk(c);
			};
			walk(doc);
		}
	});

	it('preserves empty paragraph at end of document', () => {
		// "Body\n\n" → two trailing newlines → two empty lines after Body.
		// Tomboy buffer model: each '\n' starts a new line.
		const original = '<note-content version="0.1">Title\nBody\n\n</note-content>';
		const doc = deser(original);
		expect(doc.content!.length).toBe(4);
		expect(doc.content![2].type).toBe('paragraph');
		expect(doc.content![2].content).toBeUndefined();
		expect(doc.content![3].type).toBe('paragraph');
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
