import { describe, it, expect } from 'vitest';
import {
	serializeContent,
	deserializeContent
} from '$lib/core/noteContentArchiver.js';

/**
 * These round-trip tests guard against silent mutation of the XML when a
 * note is loaded and re-serialized without any user edit. A bug here causes
 * unmodified notes to appear on the sync upload list forever.
 */
describe('noteContentArchiver — round-trip idempotency', () => {
	it('list items preserve their trailing newline before </list-item>', () => {
		// Tomboy desktop emits "<list-item>text\n</list-item>" for every list
		// item except the last one inside a list.
		const xml =
			`<note-content version="0.1">head\n` +
			`<list>` +
			`<list-item dir="ltr">a\n</list-item>` +
			`<list-item dir="ltr">b\n</list-item>` +
			`<list-item dir="ltr">c</list-item>` +
			`</list>` +
			`</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		expect(out).toBe(xml);
	});

	it('nested list preserves the outer item\'s trailing newline before the inner list', () => {
		// Nested list's last item (inner) DOES keep its trailing \n because
		// it's nested; only a TOP-LEVEL list's last item drops it.
		const xml =
			`<note-content version="0.1">` +
			`<list>` +
			`<list-item dir="ltr">outer\n` +
			`<list><list-item dir="ltr">inner\n</list-item></list>` +
			`</list-item>` +
			`<list-item dir="ltr">next</list-item>` +
			`</list>` +
			`</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		expect(out).toBe(xml);
	});

	it('preserves an internal link followed by two newlines and plain text', () => {
		const xml =
			`<note-content version="0.1">` +
			`before <link:internal>Foo</link:internal>\n\nafter` +
			`</note-content>`;
		const doc = deserializeContent(xml);
		expect(serializeContent(doc)).toBe(xml);
	});

	it('preserves a title-line note with only one link', () => {
		const xml =
			`<note-content version="0.1"><link:internal>Foo</link:internal>\n\nbody</note-content>`;
		const doc = deserializeContent(xml);
		expect(serializeContent(doc)).toBe(xml);
	});
});
