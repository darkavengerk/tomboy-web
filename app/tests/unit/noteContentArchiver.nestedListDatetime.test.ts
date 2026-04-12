import { describe, it, expect } from 'vitest';
import {
	serializeContent,
	deserializeContent
} from '$lib/core/noteContentArchiver.js';

/**
 * Additional round-trip regressions observed on real user notes:
 * 1. The LAST item of a NESTED list must keep its trailing '\n' before
 *    </list-item>, even though the last item of a TOP-LEVEL list does not.
 * 2. <datetime>…</datetime> is a Tomboy-specific inline tag that must be
 *    preserved through parse + serialize.
 */
describe('noteContentArchiver — nested-list last item trailing newline', () => {
	it('last item of a nested list preserves its trailing \\n (real-world shape)', () => {
		const xml =
			`<note-content version="0.1">` +
			`<list>` +
			`<list-item dir="ltr">과학\n` +
			`<list>` +
			`<list-item dir="ltr">인지심리\n</list-item>` +
			`<list-item dir="ltr">사람의 마음\n</list-item>` +
			// NOTE: this last inner item DOES end with \n before </list-item>
			`<list-item dir="ltr">사회현상\n</list-item>` +
			`</list>` +
			`</list-item>` +
			`<list-item dir="ltr">역사\n</list-item>` +
			`<list-item dir="ltr">철학</list-item>` +
			`</list>` +
			`</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		expect(out).toBe(xml);
	});

	it('last item of a nested list preserves \\n even when simple (two items)', () => {
		const xml =
			`<note-content version="0.1">` +
			`<list>` +
			`<list-item dir="ltr">outer\n` +
			`<list>` +
			`<list-item dir="ltr">inner1\n</list-item>` +
			`<list-item dir="ltr">inner2\n</list-item>` +
			`</list>` +
			`</list-item>` +
			`<list-item dir="ltr">next</list-item>` +
			`</list>` +
			`</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		expect(out).toBe(xml);
	});

	it('deeply nested (3 levels): only the top-level last item drops its trailing \\n', () => {
		const xml =
			`<note-content version="0.1">` +
			`<list>` +
			`<list-item dir="ltr">L1\n` +
			`<list>` +
			`<list-item dir="ltr">L2\n` +
			`<list>` +
			`<list-item dir="ltr">L3a\n</list-item>` +
			`<list-item dir="ltr">L3b\n</list-item>` +
			`</list>` +
			`</list-item>` +
			`</list>` +
			`</list-item>` +
			`</list>` +
			`</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		expect(out).toBe(xml);
	});
});

describe('noteContentArchiver — <datetime> tag preservation', () => {
	it('round-trips a single <datetime> element inline in a paragraph', () => {
		const xml =
			`<note-content version="0.1">` +
			`Seen on <datetime>2024-12-18</datetime> for launch` +
			`</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		expect(out).toBe(xml);
	});

	it('round-trips <datetime> at the start of content', () => {
		const xml =
			`<note-content version="0.1"><datetime>2024-12-18</datetime> 시작</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		expect(out).toBe(xml);
	});

	it('preserves <datetime> with ISO-style date-time text', () => {
		const xml =
			`<note-content version="0.1">at <datetime>2024-12-18T09:00</datetime>!</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		expect(out).toBe(xml);
	});
});
