import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseNote, serializeNote, extractTitleFromContent, parseNoteFromFile, guidFromFilename, filenameFromGuid } from '$lib/core/noteArchiver.js';
import { formatTomboyDate, parseTomboyDate, escapeXml } from '$lib/core/note.js';

const fixturesDir = join(__dirname, '..', 'fixtures');

function readFixture(name: string): string {
	return readFileSync(join(fixturesDir, name), 'utf-8');
}

describe('noteArchiver - parseNote', () => {
	it('parses title from <title> element', () => {
		const xml = readFixture('simple.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		expect(note.title).toBe('Simple Test Note');
	});

	it('parses createDate, changeDate, metadataChangeDate', () => {
		const xml = readFixture('simple.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		expect(note.createDate).toBe('2024-03-10T09:00:00.0000000+09:00');
		expect(note.changeDate).toBe('2024-03-15T10:30:45.1234567+09:00');
		expect(note.metadataChangeDate).toBe('2024-03-15T10:30:45.1234567+09:00');
	});

	it('extracts xmlContent verbatim from <text> wrapper', () => {
		const xml = readFixture('simple.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		expect(note.xmlContent).toContain('<note-content version="0.1">');
		expect(note.xmlContent).toContain('Simple Test Note');
		expect(note.xmlContent).toContain('</note-content>');
		expect(note.xmlContent).not.toContain('<text');
	});

	it('parses cursor-position and selection-bound-position', () => {
		const xml = readFixture('simple.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		expect(note.cursorPosition).toBe(42);
		expect(note.selectionBoundPosition).toBe(-1);
	});

	it('parses width, height, x, y', () => {
		const xml = readFixture('simple.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		expect(note.width).toBe(450);
		expect(note.height).toBe(360);
		expect(note.x).toBe(100);
		expect(note.y).toBe(50);
	});

	it('parses tags including system:notebook: prefix', () => {
		const xml = readFixture('rich-formatting.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		expect(note.tags).toContain('system:notebook:Work');
		expect(note.tags).toContain('system:pinned');
		expect(note.tags).toHaveLength(2);
	});

	it('handles notes with no tags element', () => {
		const xml = readFixture('simple.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		expect(note.tags).toEqual([]);
	});

	it('handles open-on-startup True/False (capital T/F from C#)', () => {
		const xmlTrue = readFixture('rich-formatting.note');
		const noteTrue = parseNote(xmlTrue, 'note://tomboy/test-guid');
		expect(noteTrue.openOnStartup).toBe(true);

		const xmlFalse = readFixture('simple.note');
		const noteFalse = parseNote(xmlFalse, 'note://tomboy/test-guid');
		expect(noteFalse.openOnStartup).toBe(false);
	});

	it('extracts GUID from URI', () => {
		const xml = readFixture('simple.note');
		const note = parseNote(xml, 'note://tomboy/abc-123-def');
		expect(note.guid).toBe('abc-123-def');
		expect(note.uri).toBe('note://tomboy/abc-123-def');
	});

	it('preserves rich formatting in xmlContent', () => {
		const xml = readFixture('rich-formatting.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		expect(note.xmlContent).toContain('<bold>bold text</bold>');
		expect(note.xmlContent).toContain('<italic>italic text</italic>');
		expect(note.xmlContent).toContain('<strikethrough>strikethrough</strikethrough>');
		expect(note.xmlContent).toContain('<highlight>highlighted</highlight>');
		expect(note.xmlContent).toContain('<monospace>monospace code</monospace>');
		expect(note.xmlContent).toContain('<size:huge>huge</size:huge>');
		expect(note.xmlContent).toContain('<size:large>large</size:large>');
		expect(note.xmlContent).toContain('<size:small>small</size:small>');
		expect(note.xmlContent).toContain('<link:internal>Another Note</link:internal>');
		expect(note.xmlContent).toContain('<link:url>https://example.com</link:url>');
	});

	it('preserves list structure in xmlContent', () => {
		const xml = readFixture('with-lists.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		expect(note.xmlContent).toContain('<list>');
		expect(note.xmlContent).toContain('<list-item dir="ltr">');
		expect(note.xmlContent).toContain('Nested item A');
	});
});

describe('noteArchiver - serializeNote', () => {
	it('serializes NoteData to valid XML', () => {
		const xml = readFixture('simple.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		const serialized = serializeNote(note);

		expect(serialized).toContain('<?xml version="1.0" encoding="utf-8"?>');
		expect(serialized).toContain('<note version="0.3"');
		expect(serialized).toContain('xmlns="http://beatniksoftware.com/tomboy"');
		expect(serialized).toContain('xmlns:link="http://beatniksoftware.com/tomboy/link"');
		expect(serialized).toContain('xmlns:size="http://beatniksoftware.com/tomboy/size"');
		expect(serialized).toContain('<title>Simple Test Note</title>');
		expect(serialized).toContain('</note>');
	});

	it('serializes tags correctly', () => {
		const xml = readFixture('rich-formatting.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		const serialized = serializeNote(note);

		expect(serialized).toContain('<tags>');
		expect(serialized).toContain('<tag>system:notebook:Work</tag>');
		expect(serialized).toContain('<tag>system:pinned</tag>');
		expect(serialized).toContain('</tags>');
	});

	it('omits tags element when no tags', () => {
		const xml = readFixture('simple.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		const serialized = serializeNote(note);
		expect(serialized).not.toContain('<tags>');
	});

	it('serializes open-on-startup with capital True/False', () => {
		const xml = readFixture('rich-formatting.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		const serialized = serializeNote(note);
		expect(serialized).toContain('<open-on-startup>True</open-on-startup>');
	});

	it('round-trip: parse then serialize preserves key data', () => {
		const xml = readFixture('rich-formatting.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		const serialized = serializeNote(note);
		const reparsed = parseNote(serialized, 'note://tomboy/test-guid');

		expect(reparsed.title).toBe(note.title);
		expect(reparsed.xmlContent).toBe(note.xmlContent);
		expect(reparsed.changeDate).toBe(note.changeDate);
		expect(reparsed.createDate).toBe(note.createDate);
		expect(reparsed.tags).toEqual(note.tags);
		expect(reparsed.cursorPosition).toBe(note.cursorPosition);
		expect(reparsed.openOnStartup).toBe(note.openOnStartup);
	});

	it('round-trip with lists', () => {
		const xml = readFixture('with-lists.note');
		const note = parseNote(xml, 'note://tomboy/test-guid');
		const serialized = serializeNote(note);
		const reparsed = parseNote(serialized, 'note://tomboy/test-guid');

		expect(reparsed.xmlContent).toBe(note.xmlContent);
		expect(reparsed.tags).toEqual(note.tags);
	});
});

describe('extractTitleFromContent', () => {
	it('extracts title from first line of note-content', () => {
		const xmlContent = '<note-content version="0.1">My Title\nSome body text.</note-content>';
		expect(extractTitleFromContent(xmlContent)).toBe('My Title');
	});

	it('strips XML tags from title line', () => {
		const xmlContent = '<note-content version="0.1"><size:huge>My Title</size:huge>\nBody.</note-content>';
		expect(extractTitleFromContent(xmlContent)).toBe('My Title');
	});

	it('returns empty string for empty content', () => {
		expect(extractTitleFromContent('')).toBe('');
	});
});

describe('parseNoteFromFile', () => {
	it('derives GUID from filename', () => {
		const xml = readFixture('simple.note');
		const note = parseNoteFromFile(xml, 'abc-123-def.note');
		expect(note.guid).toBe('abc-123-def');
		expect(note.uri).toBe('note://tomboy/abc-123-def');
	});
});

describe('guidFromFilename / filenameFromGuid', () => {
	it('extracts GUID from filename', () => {
		expect(guidFromFilename('12345678-abcd-ef01.note')).toBe('12345678-abcd-ef01');
	});

	it('builds filename from GUID', () => {
		expect(filenameFromGuid('12345678-abcd-ef01')).toBe('12345678-abcd-ef01.note');
	});
});

describe('Tomboy date utilities', () => {
	it('formatTomboyDate produces correct format', () => {
		const date = new Date('2024-03-15T10:30:45.123Z');
		const formatted = formatTomboyDate(date);
		// Should match: yyyy-MM-ddTHH:mm:ss.fffffffzzz
		expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}[+-]\d{2}:\d{2}$/);
	});

	it('parseTomboyDate handles 7-digit fractional seconds', () => {
		const dateStr = '2024-03-15T10:30:45.1234567+09:00';
		const date = parseTomboyDate(dateStr);
		expect(date.getFullYear()).toBe(2024);
		expect(date.getMonth()).toBe(2); // March = 2
		expect(date.getDate()).toBe(15);
	});

	it('round-trip: format then parse preserves date (to millisecond precision)', () => {
		const original = new Date('2024-06-20T14:15:30.567Z');
		const formatted = formatTomboyDate(original);
		const parsed = parseTomboyDate(formatted);
		expect(Math.abs(parsed.getTime() - original.getTime())).toBeLessThan(1000);
	});
});

describe('escapeXml', () => {
	it('escapes ampersand', () => {
		expect(escapeXml('A & B')).toBe('A &amp; B');
	});

	it('escapes angle brackets', () => {
		expect(escapeXml('<tag>')).toBe('&lt;tag&gt;');
	});

	it('escapes quotes', () => {
		expect(escapeXml('"hello"')).toBe('&quot;hello&quot;');
	});

	it('handles empty string', () => {
		expect(escapeXml('')).toBe('');
	});
});
