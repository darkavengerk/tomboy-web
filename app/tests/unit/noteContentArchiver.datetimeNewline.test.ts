import { describe, it, expect } from 'vitest';
import {
	serializeContent,
	deserializeContent
} from '$lib/core/noteContentArchiver.js';

/**
 * Tomboy desktop stores note content as a flat Gtk.TextBuffer with tags
 * applied to character ranges, including over '\n' characters. A
 * <datetime>\n</datetime> element in the XML — i.e. the datetime tag applied
 * to just a newline — is legal: Tomboy's Deserialize inserts the '\n' as
 * text and applies the datetime tag over it, and re-serialization walks the
 * same single char and emits <datetime>\n</datetime> again.
 *
 * Our web archiver historically dropped the datetime mark entirely when the
 * only marked content was whitespace/newlines, producing a diff on save
 * without any user edit.
 */
describe('noteContentArchiver — datetime mark on whitespace/newline', () => {
	it('preserves <datetime>\\n</datetime> between an inline run and a <list>', () => {
		const xml =
			`<note-content version="0.1">title\n` +
			`<link:internal>모닝 리추얼</link:internal><datetime>\n</datetime>` +
			`<list><list-item dir="ltr"><datetime><link:internal>2022-04-08</link:internal></datetime></list-item></list>` +
			`</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		expect(out).toBe(xml);
	});

	it('preserves <datetime>\\n</datetime> inside a list-item (before a nested list)', () => {
		const xml =
			`<note-content version="0.1">head\n` +
			`<list><list-item dir="ltr"><link:internal>모닝 리추얼</link:internal><datetime>\n</datetime>` +
			`<list><list-item dir="ltr"><datetime><link:internal>2021-12-01</link:internal></datetime>\n</list-item></list></list-item></list>` +
			`</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		expect(out).toBe(xml);
	});
});
