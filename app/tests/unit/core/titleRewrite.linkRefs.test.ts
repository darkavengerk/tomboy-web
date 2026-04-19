import { describe, it, expect } from 'vitest';
import { rewriteInternalLinkRefsInXml } from '$lib/core/titleRewrite.js';

describe('rewriteInternalLinkRefsInXml', () => {
	it('returns changed=false when no reference matches', () => {
		const xml =
			'<note-content version="0.1">Title\nhello world</note-content>';
		const res = rewriteInternalLinkRefsInXml(xml, 'Foo', 'Bar');
		expect(res.changed).toBe(false);
		expect(res.xml).toBe(xml);
	});

	it('rewrites a single <link:internal>Old</link:internal>', () => {
		const xml =
			'<note-content version="0.1">X\nsee <link:internal>Foo</link:internal> here</note-content>';
		const res = rewriteInternalLinkRefsInXml(xml, 'Foo', 'Bar');
		expect(res.changed).toBe(true);
		expect(res.xml).toBe(
			'<note-content version="0.1">X\nsee <link:internal>Bar</link:internal> here</note-content>'
		);
	});

	it('rewrites a single <link:broken>Old</link:broken>', () => {
		const xml =
			'<note-content version="0.1">X\nsee <link:broken>Foo</link:broken> here</note-content>';
		const res = rewriteInternalLinkRefsInXml(xml, 'Foo', 'Bar');
		expect(res.changed).toBe(true);
		expect(res.xml).toBe(
			'<note-content version="0.1">X\nsee <link:broken>Bar</link:broken> here</note-content>'
		);
	});

	it('rewrites both internal and broken forms in the same xml', () => {
		const xml =
			'<note-content version="0.1">X\n<link:internal>Foo</link:internal> / <link:broken>Foo</link:broken></note-content>';
		const res = rewriteInternalLinkRefsInXml(xml, 'Foo', 'Bar');
		expect(res.changed).toBe(true);
		expect(res.xml).toBe(
			'<note-content version="0.1">X\n<link:internal>Bar</link:internal> / <link:broken>Bar</link:broken></note-content>'
		);
	});

	it('rewrites every repeated occurrence', () => {
		const xml =
			'<note-content version="0.1">X\n<link:internal>Foo</link:internal> and <link:internal>Foo</link:internal> and <link:internal>Foo</link:internal></note-content>';
		const res = rewriteInternalLinkRefsInXml(xml, 'Foo', 'Bar');
		expect(res.changed).toBe(true);
		expect(res.xml).toBe(
			'<note-content version="0.1">X\n<link:internal>Bar</link:internal> and <link:internal>Bar</link:internal> and <link:internal>Bar</link:internal></note-content>'
		);
	});

	it('matches only the escaped form of titles with XML special chars', () => {
		// Title with & → must match <link:internal>A &amp; B</link:internal>
		// The RAW string `A & B` should NOT appear inside the link tag (invalid XML),
		// but the helper should still match the correctly-escaped form.
		const xml =
			'<note-content version="0.1">X\n<link:internal>A &amp; B</link:internal></note-content>';
		const res = rewriteInternalLinkRefsInXml(xml, 'A & B', 'C');
		expect(res.changed).toBe(true);
		expect(res.xml).toBe(
			'<note-content version="0.1">X\n<link:internal>C</link:internal></note-content>'
		);
	});

	it('XML-escapes the replacement title', () => {
		const xml =
			'<note-content version="0.1">X\n<link:internal>Old</link:internal></note-content>';
		const res = rewriteInternalLinkRefsInXml(xml, 'Old', 'A & B');
		expect(res.changed).toBe(true);
		expect(res.xml).toBe(
			'<note-content version="0.1">X\n<link:internal>A &amp; B</link:internal></note-content>'
		);
	});

	it('does NOT match partial-text substrings (closing tag must be exact)', () => {
		// Title "Old" should not rewrite "<link:internal>OldVersion</link:internal>".
		const xml =
			'<note-content version="0.1">X\n<link:internal>OldVersion</link:internal></note-content>';
		const res = rewriteInternalLinkRefsInXml(xml, 'Old', 'Bar');
		expect(res.changed).toBe(false);
		expect(res.xml).toBe(xml);
	});

	it('treats regex metacharacters in the title literally', () => {
		const xml =
			'<note-content version="0.1">X\n<link:internal>.*</link:internal></note-content>';
		const res = rewriteInternalLinkRefsInXml(xml, '.*', 'plain');
		expect(res.changed).toBe(true);
		expect(res.xml).toBe(
			'<note-content version="0.1">X\n<link:internal>plain</link:internal></note-content>'
		);
	});

	it('does not match a title substring that happens to look like regex anchoring', () => {
		// Title "Foo" plain — but xml has "FooBar" inside the tag. No match.
		const xml =
			'<note-content version="0.1">X\n<link:internal>FooBar</link:internal></note-content>';
		const res = rewriteInternalLinkRefsInXml(xml, 'Foo', 'Bar');
		expect(res.changed).toBe(false);
		expect(res.xml).toBe(xml);
	});

	it('permits an empty new title (helper does not special-case)', () => {
		const xml =
			'<note-content version="0.1">X\n<link:internal>Old</link:internal></note-content>';
		const res = rewriteInternalLinkRefsInXml(xml, 'Old', '');
		expect(res.changed).toBe(true);
		expect(res.xml).toBe(
			'<note-content version="0.1">X\n<link:internal></link:internal></note-content>'
		);
	});

	it('returns changed=false when old and new titles are identical', () => {
		const xml =
			'<note-content version="0.1">X\n<link:internal>Same</link:internal></note-content>';
		const res = rewriteInternalLinkRefsInXml(xml, 'Same', 'Same');
		expect(res.changed).toBe(false);
		expect(res.xml).toBe(xml);
	});

	it('handles old title with < and > escape', () => {
		const xml =
			'<note-content version="0.1">X\n<link:internal>a &lt; b &gt; c</link:internal></note-content>';
		const res = rewriteInternalLinkRefsInXml(xml, 'a < b > c', 'ok');
		expect(res.changed).toBe(true);
		expect(res.xml).toBe(
			'<note-content version="0.1">X\n<link:internal>ok</link:internal></note-content>'
		);
	});
});
