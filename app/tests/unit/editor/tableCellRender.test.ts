import { describe, it, expect } from 'vitest';
import { renderInlinesToDom } from '$lib/editor/tableBlock/renderInlines.js';
import type { JSONContent } from '@tiptap/core';

function render(inlines: JSONContent[]): HTMLElement {
	const wrap = document.createElement('div');
	wrap.appendChild(renderInlinesToDom(inlines));
	return wrap;
}

describe('renderInlinesToDom — bare text', () => {
	it('renders a plain text node', () => {
		const dom = render([{ type: 'text', text: 'hello' }]);
		expect(dom.textContent).toBe('hello');
		expect(dom.children.length).toBe(0); // pure text node, no element wrapper
	});

	it('renders an empty cell as an empty fragment', () => {
		const dom = render([]);
		expect(dom.textContent).toBe('');
	});
});

describe('renderInlinesToDom — basic marks', () => {
	it('wraps bold in <strong>', () => {
		const dom = render([
			{ type: 'text', text: 'B', marks: [{ type: 'bold' }] }
		]);
		expect(dom.querySelector('strong')?.textContent).toBe('B');
	});

	it('wraps italic in <em>', () => {
		const dom = render([
			{ type: 'text', text: 'I', marks: [{ type: 'italic' }] }
		]);
		expect(dom.querySelector('em')?.textContent).toBe('I');
	});

	it('wraps strike in <s>', () => {
		const dom = render([
			{ type: 'text', text: 'S', marks: [{ type: 'strike' }] }
		]);
		expect(dom.querySelector('s')?.textContent).toBe('S');
	});

	it('wraps underline in <u>', () => {
		const dom = render([
			{ type: 'text', text: 'U', marks: [{ type: 'underline' }] }
		]);
		expect(dom.querySelector('u')?.textContent).toBe('U');
	});

	it('wraps highlight in <mark>', () => {
		const dom = render([
			{ type: 'text', text: 'H', marks: [{ type: 'highlight' }] }
		]);
		expect(dom.querySelector('mark')?.textContent).toBe('H');
	});

	it('wraps tomboyMonospace in span.tomboy-monospace', () => {
		const dom = render([
			{ type: 'text', text: 'M', marks: [{ type: 'tomboyMonospace' }] }
		]);
		const el = dom.querySelector('span.tomboy-monospace');
		expect(el?.textContent).toBe('M');
	});

	it('wraps tomboySize in a level-classed span', () => {
		const dom = render([
			{
				type: 'text',
				text: 'L',
				marks: [{ type: 'tomboySize', attrs: { level: 'large' } }]
			}
		]);
		const el = dom.querySelector('span.tomboy-size-large');
		expect(el?.textContent).toBe('L');
	});
});

describe('renderInlinesToDom — links', () => {
	it('renders an internal link with data-link-target', () => {
		const dom = render([
			{
				type: 'text',
				text: 'See',
				marks: [
					{ type: 'tomboyInternalLink', attrs: { target: 'Other Note' } }
				]
			}
		]);
		const a = dom.querySelector('a.tomboy-link-internal') as HTMLAnchorElement | null;
		expect(a).not.toBeNull();
		expect(a!.textContent).toBe('See');
		expect(a!.getAttribute('data-link-target')).toBe('Other Note');
	});

	it('marks a broken internal link with .tomboy-link-broken', () => {
		const dom = render([
			{
				type: 'text',
				text: 'Gone',
				marks: [
					{
						type: 'tomboyInternalLink',
						attrs: { target: 'Missing', broken: true }
					}
				]
			}
		]);
		const a = dom.querySelector('a.tomboy-link-broken');
		expect(a?.textContent).toBe('Gone');
	});

	it('renders a URL link with href and external-safe attrs', () => {
		const dom = render([
			{
				type: 'text',
				text: 'site',
				marks: [
					{
						type: 'tomboyUrlLink',
						attrs: { href: 'https://example.com' }
					}
				]
			}
		]);
		const a = dom.querySelector('a.tomboy-link-url') as HTMLAnchorElement | null;
		expect(a).not.toBeNull();
		expect(a!.getAttribute('href')).toBe('https://example.com');
		expect(a!.getAttribute('target')).toBe('_blank');
		// rel must include noopener (per OWASP / standard practice for _blank).
		expect(a!.getAttribute('rel') ?? '').toMatch(/noopener/);
	});
});

describe('renderInlinesToDom — nested marks', () => {
	it('nests multiple marks innermost-out (bold + italic)', () => {
		// PM stores marks outer→inner. So [bold, italic] should produce
		// <strong><em>x</em></strong> when bold is the outer mark.
		const dom = render([
			{
				type: 'text',
				text: 'x',
				marks: [{ type: 'bold' }, { type: 'italic' }]
			}
		]);
		const strong = dom.querySelector('strong');
		const em = strong?.querySelector('em');
		expect(em?.textContent).toBe('x');
	});

	it('keeps a link wrapping bold text', () => {
		const dom = render([
			{
				type: 'text',
				text: 'click',
				marks: [
					{ type: 'tomboyInternalLink', attrs: { target: 'X' } },
					{ type: 'bold' }
				]
			}
		]);
		const a = dom.querySelector('a.tomboy-link-internal');
		const strong = a?.querySelector('strong');
		expect(strong?.textContent).toBe('click');
	});
});

describe('renderInlinesToDom — multiple text nodes', () => {
	it('joins multiple inline pieces into a flat fragment', () => {
		const dom = render([
			{ type: 'text', text: 'a' },
			{ type: 'text', text: 'B', marks: [{ type: 'bold' }] },
			{ type: 'text', text: 'c' }
		]);
		expect(dom.textContent).toBe('aBc');
		expect(dom.querySelector('strong')?.textContent).toBe('B');
	});
});
