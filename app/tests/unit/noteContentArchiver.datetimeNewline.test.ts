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

	it('keeps adjacent <datetime>...</datetime><datetime>...</datetime> as SEPARATE elements', () => {
		// Gtk TextBuffer stores tag toggles per-offset — adjacent ranges of the
		// same tag name are NOT coalesced into one range. Tomboy desktop
		// therefore preserves `<datetime>A</datetime><datetime>B</datetime>`
		// as two distinct anchors, and so must we. (Earlier we incorrectly
		// canonicalised these into a single `<datetime>A…B</datetime>`.)
		const xml =
			`<note-content version="0.1">T\n` +
			`<list><list-item dir="ltr">` +
			`<datetime><link:internal>2021-07-27</link:internal></datetime>` +
			`<datetime>\n<link:internal>2021-09-13</link:internal></datetime>` +
			`<datetime>\n<link:internal>2021-10-17</link:internal></datetime>` +
			` tail` +
			`</list-item></list>` +
			`</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		expect(out).toBe(xml);
	});

	it('canonical output for chained <datetime>link</datetime><datetime>\\nlink</datetime> is idempotent', () => {
		// Source has multiple adjacent <datetime> elements — Tomboy desktop
		// would itself coalesce these into one continuous datetime range
		// (same tag singleton applied to contiguous chars). Our serializer
		// normalises to the canonical one-span form. Critical property:
		// the normalised form must be byte-stable on every subsequent
		// round-trip, so a single save fully stabilises the file.
		const sourceNonCanonical =
			`<note-content version="0.1">T\n` +
			`<list><list-item dir="ltr">` +
			`<datetime><link:internal>2021-07-27</link:internal></datetime>` +
			`<datetime>\n<link:internal>2021-09-13</link:internal></datetime>` +
			`<datetime>\n<link:internal>2021-10-17</link:internal></datetime>` +
			` tail` +
			`</list-item></list>` +
			`</note-content>`;
		const canonical = serializeContent(deserializeContent(sourceNonCanonical));
		// Re-parsing the canonical form and serialising again must produce the
		// exact same bytes — otherwise every open would re-save forever.
		const twice = serializeContent(deserializeContent(canonical));
		expect(twice).toBe(canonical);
	});

	it('preserves absence of trailing \\n on a nested list\'s last item', () => {
		// Tomboy's output rule is "nested last item keeps \n" in many cases,
		// but a note whose content ends at the deepest list item may have
		// no trailing \n at all. Our serializer must remember what the source
		// had instead of always normalizing.
		const xml =
			`<note-content version="0.1">T\n` +
			`<list><list-item dir="ltr">outer\n` +
			`<list><list-item dir="ltr">leaf</list-item></list>` +
			`</list-item></list>` +
			`</note-content>`;
		const doc = deserializeContent(xml);
		const out = serializeContent(doc);
		expect(out).toBe(xml);
	});

	it('preserves <datetime>text\\n</datetime> as a single continuous range', () => {
		// Tomboy can apply the datetime tag to a range that includes trailing
		// '\n' (e.g. the date header line). Must round-trip as ONE element,
		// not split into <datetime>text</datetime><datetime>\n</datetime>.
		const xml =
			`<note-content version="0.1">T\n` +
			`<datetime>2020-06-15\n</datetime>` +
			`<link:internal>선악에 대하여</link:internal> 뒷말.` +
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
