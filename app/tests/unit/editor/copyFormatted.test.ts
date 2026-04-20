import { describe, it, expect } from 'vitest';
import {
	tiptapToPlainText,
	tiptapToStructuredText,
	tiptapToHtml,
	tiptapToMarkdown
} from '$lib/editor/copyFormatted.js';
import type { JSONContent } from '@tiptap/core';

function p(text: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text, marks }] };
}
function doc(...children: JSONContent[]): JSONContent {
	return { type: 'doc', content: children };
}

describe('tiptapToPlainText', () => {
	it('returns the text content, one paragraph per line', () => {
		const json = doc(p('Title'), p('Body line 1'), p('Body line 2'));
		expect(tiptapToPlainText(json)).toBe('Title\nBody line 1\nBody line 2');
	});

	it('strips marks — returns naked text only', () => {
		const json = doc(p('hello', [{ type: 'bold' }]));
		expect(tiptapToPlainText(json)).toBe('hello');
	});

	it('handles hardBreak as a newline within a paragraph', () => {
		const json = doc({
			type: 'paragraph',
			content: [
				{ type: 'text', text: 'a' },
				{ type: 'hardBreak' },
				{ type: 'text', text: 'b' }
			]
		});
		expect(tiptapToPlainText(json)).toBe('a\nb');
	});

	it('emits list item text without "- " markers (so it pastes cleanly into another list)', () => {
		const json = doc({
			type: 'bulletList',
			content: [
				{
					type: 'listItem',
					content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }]
				},
				{
					type: 'listItem',
					content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }]
				}
			]
		});
		expect(tiptapToPlainText(json)).toBe('one\ntwo');
	});

	it('flattens nested list items — no indentation added for nesting', () => {
		const json = doc({
			type: 'bulletList',
			content: [
				{
					type: 'listItem',
					content: [
						{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
						{
							type: 'bulletList',
							content: [
								{
									type: 'listItem',
									content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }]
								}
							]
						}
					]
				}
			]
		});
		expect(tiptapToPlainText(json)).toBe('A\nB');
	});

	it('returns empty string for an empty doc', () => {
		expect(tiptapToPlainText(doc())).toBe('');
	});

	it('accepts a partial JSON fragment (no type:doc wrapper)', () => {
		expect(tiptapToPlainText(p('hi'))).toBe('hi');
	});
});

describe('tiptapToStructuredText', () => {
	it('keeps paragraph text as-is (one line per paragraph)', () => {
		expect(tiptapToStructuredText(doc(p('one'), p('two')))).toBe('one\ntwo');
	});

	it('renders top-level bullet list with the • disc glyph', () => {
		const json = doc({
			type: 'bulletList',
			content: [
				{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
				{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }
			]
		});
		expect(tiptapToStructuredText(json)).toBe('• one\n• two');
	});

	it('cycles bullet glyphs by depth to mirror browser default list-style', () => {
		// Three levels deep: • → ○ → ■
		const json = doc({
			type: 'bulletList',
			content: [
				{
					type: 'listItem',
					content: [
						{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
						{
							type: 'bulletList',
							content: [
								{
									type: 'listItem',
									content: [
										{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
										{
											type: 'bulletList',
											content: [
												{
													type: 'listItem',
													content: [
														{ type: 'paragraph', content: [{ type: 'text', text: 'C' }] }
													]
												}
											]
										}
									]
								}
							]
						}
					]
				}
			]
		});
		expect(tiptapToStructuredText(json)).toBe('• A\n  ○ B\n    ■ C');
	});

	it('numbers ordered list items as "1. 2. 3."', () => {
		const json = doc({
			type: 'orderedList',
			content: [
				{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
				{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
				{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'third' }] }] }
			]
		});
		expect(tiptapToStructuredText(json)).toBe('1. first\n2. second\n3. third');
	});

	it('strips marks — no bold/italic/etc markup appears', () => {
		const json = doc(p('hi', [{ type: 'bold' }, { type: 'italic' }]));
		expect(tiptapToStructuredText(json)).toBe('hi');
	});

	it('does not escape markdown meta chars', () => {
		expect(tiptapToStructuredText(doc(p('5 * 3 = 15')))).toBe('5 * 3 = 15');
	});
});

describe('tiptapToHtml', () => {
	it('wraps paragraphs in <p>', () => {
		expect(tiptapToHtml(doc(p('a'), p('b')))).toBe('<p>a</p><p>b</p>');
	});

	it('renders bold marks as <strong>', () => {
		expect(tiptapToHtml(doc(p('bold', [{ type: 'bold' }])))).toMatch(/<strong>bold<\/strong>/);
	});

	it('renders italic marks as <em>', () => {
		expect(tiptapToHtml(doc(p('it', [{ type: 'italic' }])))).toMatch(/<em>it<\/em>/);
	});

	it('renders strike marks as <s>', () => {
		expect(tiptapToHtml(doc(p('x', [{ type: 'strike' }])))).toMatch(/<s>x<\/s>/);
	});

	it('renders bullet list as <ul><li>...</li></ul>', () => {
		const json = doc({
			type: 'bulletList',
			content: [
				{
					type: 'listItem',
					content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }]
				}
			]
		});
		const html = tiptapToHtml(json);
		expect(html).toMatch(/<ul>/);
		expect(html).toMatch(/<li>/);
		expect(html).toMatch(/one/);
	});

	it('escapes HTML special chars in text', () => {
		expect(tiptapToHtml(doc(p('<script>alert(1)</script>')))).not.toMatch(/<script>/);
		expect(tiptapToHtml(doc(p('<script>alert(1)</script>')))).toMatch(/&lt;script&gt;/);
	});
});

describe('tiptapToMarkdown', () => {
	it('renders bold as **text**', () => {
		expect(tiptapToMarkdown(doc(p('x', [{ type: 'bold' }])))).toContain('**x**');
	});

	it('renders italic as *text*', () => {
		expect(tiptapToMarkdown(doc(p('y', [{ type: 'italic' }])))).toContain('*y*');
	});

	it('renders strike as ~~text~~', () => {
		expect(tiptapToMarkdown(doc(p('z', [{ type: 'strike' }])))).toContain('~~z~~');
	});

	it('renders monospace (code) as `text`', () => {
		expect(
			tiptapToMarkdown(doc(p('k', [{ type: 'tomboyMonospace' }])))
		).toContain('`k`');
	});

	it('renders a URL link as [text](href)', () => {
		const json = doc(
			p('site', [{ type: 'tomboyUrlLink', attrs: { href: 'https://example.com' } }])
		);
		expect(tiptapToMarkdown(json)).toContain('[site](https://example.com)');
	});

	it('renders bullet lists as "- " lines, respecting indent for nesting', () => {
		const json = doc({
			type: 'bulletList',
			content: [
				{
					type: 'listItem',
					content: [
						{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
						{
							type: 'bulletList',
							content: [
								{
									type: 'listItem',
									content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }]
								}
							]
						}
					]
				},
				{
					type: 'listItem',
					content: [{ type: 'paragraph', content: [{ type: 'text', text: 'C' }] }]
				}
			]
		});
		expect(tiptapToMarkdown(json)).toBe('- A\n  - B\n- C');
	});

	it('joins top-level blocks with a single newline (no extra blank line)', () => {
		expect(tiptapToMarkdown(doc(p('first'), p('second')))).toBe('first\nsecond');
	});

	it('combines marks sensibly: bold+italic → ***x***', () => {
		const json = doc(p('x', [{ type: 'bold' }, { type: 'italic' }]));
		const md = tiptapToMarkdown(json);
		expect(md).toMatch(/\*{3}x\*{3}|\*\*\*x\*\*\*/);
	});

	it('escapes markdown meta chars in plain text runs', () => {
		// A literal asterisk should not become markdown emphasis.
		expect(tiptapToMarkdown(doc(p('5 * 3 = 15')))).toContain('5 \\* 3 = 15');
	});
});
