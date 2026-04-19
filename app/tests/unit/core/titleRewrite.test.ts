import { describe, it, expect } from 'vitest';
import type { NoteData } from '$lib/core/note.js';
import {
	xmlEscapeTitle,
	rewriteTitleInNoteContentXml,
	prepareIncomingNoteForLocal
} from '$lib/core/titleRewrite.js';

describe('xmlEscapeTitle', () => {
	it('escapes ampersand', () => {
		expect(xmlEscapeTitle('A & B')).toBe('A &amp; B');
	});

	it('escapes angle brackets', () => {
		expect(xmlEscapeTitle('1 < 2 > 0')).toBe('1 &lt; 2 &gt; 0');
	});

	it('leaves plain text unchanged', () => {
		expect(xmlEscapeTitle('plain')).toBe('plain');
	});

	it('does not escape quotes (titles are XML text, not attributes)', () => {
		expect(xmlEscapeTitle(`"quoted"`)).toBe(`"quoted"`);
		expect(xmlEscapeTitle(`'apostrophe'`)).toBe(`'apostrophe'`);
	});
});

describe('rewriteTitleInNoteContentXml', () => {
	it('replaces the first line with the new title, preserving body after \\n', () => {
		const xml =
			'<note-content version="0.1">OldTitle\nbody\nmore</note-content>';
		expect(rewriteTitleInNoteContentXml(xml, 'NewTitle')).toBe(
			'<note-content version="0.1">NewTitle\nbody\nmore</note-content>'
		);
	});

	it('replaces a title that contains XML entities', () => {
		const xml =
			'<note-content version="0.1">Foo &amp; Bar\nbody</note-content>';
		expect(rewriteTitleInNoteContentXml(xml, 'Clean')).toBe(
			'<note-content version="0.1">Clean\nbody</note-content>'
		);
	});

	it('escapes the replacement title', () => {
		const xml = '<note-content version="0.1">Old\nbody</note-content>';
		expect(rewriteTitleInNoteContentXml(xml, 'A & B')).toBe(
			'<note-content version="0.1">A &amp; B\nbody</note-content>'
		);
	});

	it('works when note has ONE line only (no newline — title at the very end)', () => {
		const xml = '<note-content version="0.1">OnlyTitle</note-content>';
		expect(rewriteTitleInNoteContentXml(xml, 'NewTitle')).toBe(
			'<note-content version="0.1">NewTitle</note-content>'
		);
	});

	it('returns input unchanged when <note-content> tag is missing', () => {
		const xml = 'not a note';
		expect(rewriteTitleInNoteContentXml(xml, 'X')).toBe('not a note');
	});

	it('preserves embedded <list> and other markup byte-for-byte after rewrite', () => {
		const xml =
			'<note-content version="0.1">OldTitle\nbefore\n<list><list-item dir="ltr">item 1</list-item><list-item dir="ltr">item 2</list-item></list>after</note-content>';
		expect(rewriteTitleInNoteContentXml(xml, 'Shiny')).toBe(
			'<note-content version="0.1">Shiny\nbefore\n<list><list-item dir="ltr">item 1</list-item><list-item dir="ltr">item 2</list-item></list>after</note-content>'
		);
	});

	it('handles <note-content> with different attributes / whitespace', () => {
		const xml =
			'<note-content  version="0.1"  xmlns="x">OldTitle\nbody</note-content>';
		expect(rewriteTitleInNoteContentXml(xml, 'NewTitle')).toBe(
			'<note-content  version="0.1"  xmlns="x">NewTitle\nbody</note-content>'
		);
	});
});

// ── prepareIncomingNoteForLocal ────────────────────────────────────────────

function makeIncoming(overrides: Partial<NoteData> = {}): NoteData {
	return {
		uri: 'note://tomboy/incoming-guid',
		guid: 'incoming-guid',
		title: 'Hello',
		xmlContent: '<note-content version="0.1">Hello\nbody</note-content>',
		createDate: '2024-01-01T00:00:00.0000000+00:00',
		changeDate: '2024-06-01T10:20:30.1234567+00:00',
		metadataChangeDate: '2024-06-01T10:20:30.1234567+00:00',
		cursorPosition: 0,
		selectionBoundPosition: -1,
		width: 450,
		height: 360,
		x: 0,
		y: 0,
		tags: [],
		openOnStartup: false,
		localDirty: false,
		deleted: false,
		...overrides
	};
}

describe('prepareIncomingNoteForLocal', () => {
	it('returns renamed=false when no local collision exists', async () => {
		const incoming = makeIncoming({ title: 'Unique Title' });
		const result = await prepareIncomingNoteForLocal(incoming, {
			findByTitle: async () => undefined,
			now: () => '2026-04-19T00:00:00.0000000+00:00'
		});
		expect(result.renamed).toBe(false);
		expect(result.from).toBe('Unique Title');
		expect(result.to).toBe('Unique Title');
		expect(result.note.title).toBe('Unique Title');
		expect(result.note.localDirty).toBe(false);
		expect(result.note.xmlContent).toBe(incoming.xmlContent);
	});

	it('suffixes the title when a DIFFERENT guid has the same title', async () => {
		const incoming = makeIncoming({
			guid: 'incoming-guid',
			title: 'Dupe',
			xmlContent: '<note-content version="0.1">Dupe\nbody</note-content>'
		});
		const result = await prepareIncomingNoteForLocal(incoming, {
			findByTitle: async (title: string) =>
				title === 'Dupe' ? { guid: 'other-guid' } : undefined,
			now: () => '2026-04-19T00:00:00.0000000+00:00'
		});
		expect(result.renamed).toBe(true);
		expect(result.from).toBe('Dupe');
		expect(result.to).toBe('Dupe (2)');
		expect(result.note.title).toBe('Dupe (2)');
		expect(result.note.xmlContent).toBe(
			'<note-content version="0.1">Dupe (2)\nbody</note-content>'
		);
		expect(result.note.localDirty).toBe(true);
		expect(result.note.metadataChangeDate).toBe(
			'2026-04-19T00:00:00.0000000+00:00'
		);
	});

	it('does NOT rename when the same-guid note matches (self-match)', async () => {
		const incoming = makeIncoming({ guid: 'incoming-guid', title: 'SameGuid' });
		const result = await prepareIncomingNoteForLocal(incoming, {
			findByTitle: async () => ({ guid: 'incoming-guid' }),
			now: () => '2026-04-19T00:00:00.0000000+00:00'
		});
		expect(result.renamed).toBe(false);
		expect(result.note.title).toBe('SameGuid');
		expect(result.note.localDirty).toBe(false);
	});

	it('chains collisions: T and T (2) exist → incoming T becomes T (3)', async () => {
		const incoming = makeIncoming({
			guid: 'fresh-guid',
			title: 'T',
			xmlContent: '<note-content version="0.1">T\nbody</note-content>'
		});
		const taken = new Map<string, string>([
			['T', 'a-guid'],
			['T (2)', 'b-guid']
		]);
		const result = await prepareIncomingNoteForLocal(incoming, {
			findByTitle: async (title: string) => {
				const g = taken.get(title);
				return g ? { guid: g } : undefined;
			},
			now: () => '2026-04-19T00:00:00.0000000+00:00'
		});
		expect(result.renamed).toBe(true);
		expect(result.to).toBe('T (3)');
		expect(result.note.title).toBe('T (3)');
		expect(result.note.xmlContent).toBe(
			'<note-content version="0.1">T (3)\nbody</note-content>'
		);
	});

	it('does not suffix when title is empty / whitespace', async () => {
		const incoming = makeIncoming({
			title: '   ',
			xmlContent: '<note-content version="0.1">   \nbody</note-content>'
		});
		const result = await prepareIncomingNoteForLocal(incoming, {
			findByTitle: async () => ({ guid: 'other' }),
			now: () => '2026-04-19T00:00:00.0000000+00:00'
		});
		expect(result.renamed).toBe(false);
		expect(result.note.title).toBe('   ');
		expect(result.note.localDirty).toBe(false);
	});

	it('trims title whitespace when searching, but keeps the original title unchanged on no-collision', async () => {
		// If trimmed title is unique, we don't rewrite — preserves byte-for-byte.
		const incoming = makeIncoming({ title: '  Hello  ' });
		const result = await prepareIncomingNoteForLocal(incoming, {
			findByTitle: async () => undefined,
			now: () => '2026-04-19T00:00:00.0000000+00:00'
		});
		expect(result.renamed).toBe(false);
		expect(result.note.title).toBe('  Hello  ');
	});

	it('does not mutate the input NoteData object on rename', async () => {
		const incoming = makeIncoming({
			guid: 'incoming-guid',
			title: 'Dupe',
			xmlContent: '<note-content version="0.1">Dupe\nbody</note-content>'
		});
		const originalTitle = incoming.title;
		const originalXml = incoming.xmlContent;
		const originalMeta = incoming.metadataChangeDate;
		const result = await prepareIncomingNoteForLocal(incoming, {
			findByTitle: async (title: string) =>
				title === 'Dupe' ? { guid: 'other-guid' } : undefined,
			now: () => '2026-04-19T00:00:00.0000000+00:00'
		});
		expect(incoming.title).toBe(originalTitle);
		expect(incoming.xmlContent).toBe(originalXml);
		expect(incoming.metadataChangeDate).toBe(originalMeta);
		expect(incoming.localDirty).toBe(false);
		// But the returned note is the mutated copy.
		expect(result.note).not.toBe(incoming);
		expect(result.note.title).toBe('Dupe (2)');
	});
});
