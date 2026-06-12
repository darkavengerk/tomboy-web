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

describe('copyFormatted — footnoteMarker', () => {
	const docWithFn: JSONContent = doc(
		p('제목'),
		{
			type: 'paragraph',
			content: [
				{ type: 'text', text: '본문 ' },
				{ type: 'footnoteMarker', attrs: { label: '1' } },
				{ type: 'text', text: ' 끝' }
			]
		}
	);

	it('plain → [^N]', () => {
		expect(tiptapToPlainText(docWithFn)).toContain('본문 [^1] 끝');
	});

	it('structured → [^N]', () => {
		expect(tiptapToStructuredText(docWithFn)).toContain('본문 [^1] 끝');
	});

	it('html → <sup>N</sup>', () => {
		expect(tiptapToHtml(docWithFn)).toContain('<sup>1</sup>');
	});

	it('markdown → [^N]', () => {
		expect(tiptapToMarkdown(docWithFn)).toContain('본문 [^1] 끝');
	});
});

describe('inlineCheckbox serializers', () => {
	const docOf = (checked: boolean) => ({
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
			{
				type: 'paragraph',
				content: [
					{ type: 'text', text: '할 일 ' },
					{ type: 'inlineCheckbox', attrs: { checked } },
					{ type: 'text', text: ' 우유' }
				]
			}
		]
	});

	it('plain text emits [ ] for unchecked', () => {
		expect(tiptapToPlainText(docOf(false))).toContain('[ ]');
	});

	it('plain text emits [x] for checked', () => {
		expect(tiptapToPlainText(docOf(true))).toContain('[x]');
	});

	it('structured text emits [ ] / [x]', () => {
		expect(tiptapToStructuredText(docOf(false))).toContain('[ ]');
		expect(tiptapToStructuredText(docOf(true))).toContain('[x]');
	});

	it('markdown emits [ ] / [x] (GFM task list)', () => {
		expect(tiptapToMarkdown(docOf(false))).toContain('[ ]');
		expect(tiptapToMarkdown(docOf(true))).toContain('[x]');
	});

	it('html emits <input type="checkbox" disabled> for unchecked', () => {
		const html = tiptapToHtml(docOf(false));
		expect(html).toContain('<input type="checkbox" disabled>');
		expect(html).not.toContain('checked');
	});

	it('html emits <input type="checkbox" disabled checked> for checked', () => {
		const html = tiptapToHtml(docOf(true));
		expect(html).toContain('<input type="checkbox" disabled checked>');
	});
});

describe('boxKind 항목 단위 체크박스/라디오', () => {
	const boxDoc: JSONContent = {
		type: 'doc',
		content: [
			{
				type: 'bulletList',
				content: [
					{
						type: 'listItem',
						attrs: { boxKind: 'checkbox', checked: true },
						content: [
							{ type: 'paragraph', content: [{ type: 'text', text: '우유' }] }
						]
					},
					{
						type: 'listItem',
						attrs: { boxKind: 'radio', checked: false },
						content: [
							{ type: 'paragraph', content: [{ type: 'text', text: '밥' }] }
						]
					},
					{
						type: 'listItem',
						content: [
							{ type: 'paragraph', content: [{ type: 'text', text: '빵' }] }
						]
					}
				]
			}
		]
	};

	it('markdown: 태스크 문법 + 라디오 리터럴', () => {
		expect(tiptapToMarkdown(boxDoc)).toBe('- [x] 우유\n- ( ) 밥\n- 빵');
	});

	it('plain: 접두 마커', () => {
		expect(tiptapToPlainText(boxDoc)).toBe('[x] 우유\n( ) 밥\n빵');
	});

	it('structured: 불릿 글리프 대신 마커', () => {
		expect(tiptapToStructuredText(boxDoc)).toBe('[x] 우유\n( ) 밥\n• 빵');
	});

	it('html: input 요소', () => {
		const html = tiptapToHtml(boxDoc);
		expect(html).toContain(
			'<li><input type="checkbox" disabled checked> <p>우유</p></li>'
		);
		expect(html).toContain('<li><input type="radio" disabled> <p>밥</p></li>');
		expect(html).toContain('<li><p>빵</p></li>');
	});
});
