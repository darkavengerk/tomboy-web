import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import {
	tiptapToPdfmake,
	type InternalLinkResolver
} from '$lib/remarkable/pdf/tiptapToPdfmake.js';

const noResolve: InternalLinkResolver = { resolveInternalTarget: () => null };

function doc(...content: JSONContent[]): JSONContent {
	return { type: 'doc', content };
}
function p(...content: JSONContent[]): JSONContent {
	return { type: 'paragraph', content };
}
function t(text: string, marks?: JSONContent['marks']): JSONContent {
	const out: JSONContent = { type: 'text', text };
	if (marks) out.marks = marks;
	return out;
}

describe('tiptapToPdfmake', () => {
	it('renders a simple paragraph as {text: [inline]}', () => {
		const out = tiptapToPdfmake(doc(p(t('hello'))), noResolve);
		expect(out).toEqual([{ text: [{ text: 'hello' }] }]);
	});

	it('skips empty text runs but keeps surrounding inlines', () => {
		const out = tiptapToPdfmake(doc(p(t('a'), t(''), t('b'))), noResolve);
		expect(out).toEqual([{ text: [{ text: 'a' }, { text: 'b' }] }]);
	});

	it('applies bold + italic marks', () => {
		const out = tiptapToPdfmake(
			doc(p(t('hi', [{ type: 'bold' }, { type: 'italic' }]))),
			noResolve
		);
		expect(out[0]).toEqual({ text: [{ text: 'hi', bold: true, italics: true }] });
	});

	it('strike + underline accumulate as decoration array', () => {
		const out = tiptapToPdfmake(
			doc(p(t('x', [{ type: 'strike' }, { type: 'underline' }]))),
			noResolve
		);
		expect(out[0]).toEqual({
			text: [{ text: 'x', decoration: ['lineThrough', 'underline'] }]
		});
	});

	it('highlight → yellow background', () => {
		const out = tiptapToPdfmake(
			doc(p(t('warn', [{ type: 'highlight' }]))),
			noResolve
		);
		expect(out[0]).toEqual({ text: [{ text: 'warn', background: 'yellow' }] });
	});

	it('tomboyMonospace → style: mono', () => {
		const out = tiptapToPdfmake(
			doc(p(t('code', [{ type: 'tomboyMonospace' }]))),
			noResolve
		);
		expect(out[0]).toEqual({ text: [{ text: 'code', style: 'mono' }] });
	});

	it('tomboyUrlLink → link prop with trimmed href', () => {
		const out = tiptapToPdfmake(
			doc(
				p(
					t('click', [{ type: 'tomboyUrlLink', attrs: { href: '  https://x  ' } }])
				)
			),
			noResolve
		);
		expect(out[0]).toEqual({ text: [{ text: 'click', link: 'https://x' }] });
	});

	it('tomboyUrlLink with empty href is ignored', () => {
		const out = tiptapToPdfmake(
			doc(p(t('plain', [{ type: 'tomboyUrlLink', attrs: { href: '   ' } }]))),
			noResolve
		);
		expect(out[0]).toEqual({ text: [{ text: 'plain' }] });
	});

	it('tomboyInternalLink → linkToDestination only when target resolves', () => {
		const resolver: InternalLinkResolver = {
			resolveInternalTarget: (target) => (target === '메모' ? 'guid-2' : null)
		};
		const out = tiptapToPdfmake(
			doc(
				p(
					t('see ', undefined),
					t('here', [{ type: 'tomboyInternalLink', attrs: { target: '메모' } }]),
					t(' and ', undefined),
					t('gone', [{ type: 'tomboyInternalLink', attrs: { target: '없는노트' } }])
				)
			),
			resolver
		);
		expect(out[0]).toEqual({
			text: [
				{ text: 'see ' },
				{ text: 'here', linkToDestination: 'note-guid-2' },
				{ text: ' and ' },
				{ text: 'gone' }
			]
		});
	});

	it('bullet list with nested list emits stack', () => {
		const out = tiptapToPdfmake(
			doc({
				type: 'bulletList',
				content: [
					{
						type: 'listItem',
						content: [
							p(t('a')),
							{
								type: 'bulletList',
								content: [
									{
										type: 'listItem',
										content: [p(t('a.1'))]
									}
								]
							}
						]
					},
					{ type: 'listItem', content: [p(t('b'))] }
				]
			}),
			noResolve
		);
		expect(out).toEqual([
			{
				ul: [
					{
						stack: [
							{ text: [{ text: 'a' }] },
							{ ul: [{ text: [{ text: 'a.1' }] }] }
						]
					},
					{ text: [{ text: 'b' }] }
				]
			}
		]);
	});

	it('ordered list renders as ol', () => {
		const out = tiptapToPdfmake(
			doc({
				type: 'orderedList',
				content: [
					{ type: 'listItem', content: [p(t('one'))] },
					{ type: 'listItem', content: [p(t('two'))] }
				]
			}),
			noResolve
		);
		expect(out).toEqual([
			{
				ol: [{ text: [{ text: 'one' }] }, { text: [{ text: 'two' }] }]
			}
		]);
	});

	it('hardBreak becomes literal \\n inside text', () => {
		const out = tiptapToPdfmake(
			doc(p(t('line1'), { type: 'hardBreak' }, t('line2'))),
			noResolve
		);
		expect(out[0]).toEqual({
			text: [{ text: 'line1' }, '\n', { text: 'line2' }]
		});
	});

	it('inlineCheckbox renders [x] / [ ] literal', () => {
		const out = tiptapToPdfmake(
			doc(
				p(
					{ type: 'inlineCheckbox', attrs: { checked: true } },
					t(' done')
				),
				p(
					{ type: 'inlineCheckbox', attrs: { checked: false } },
					t(' todo')
				)
			),
			noResolve
		);
		expect(out).toEqual([
			{ text: ['[x]', { text: ' done' }] },
			{ text: ['[ ]', { text: ' todo' }] }
		]);
	});

	it('footnoteMarker renders [^label]', () => {
		const out = tiptapToPdfmake(
			doc(p(t('see'), { type: 'footnoteMarker', attrs: { label: '1' } })),
			noResolve
		);
		expect(out[0]).toEqual({
			text: [{ text: 'see' }, { text: '[^1]' }]
		});
	});

	it('unknown block nodes are skipped (forward-compat)', () => {
		const out = tiptapToPdfmake(
			doc(p(t('keep')), { type: 'someFutureBlock', content: [t('drop')] }),
			noResolve
		);
		expect(out).toEqual([{ text: [{ text: 'keep' }] }]);
	});

	it('returns [] for an empty doc', () => {
		expect(tiptapToPdfmake({ type: 'doc', content: [] }, noResolve)).toEqual([]);
	});
});
