import { describe, it, expect } from 'vitest';
import { extractNoteGuidFromText } from '$lib/desktop/openByClipboard.js';

const GUID = '1c97d161-1489-4c32-93d9-d8c383330b9c';

describe('extractNoteGuidFromText', () => {
	it('returns null for empty / whitespace input', () => {
		expect(extractNoteGuidFromText('')).toBeNull();
		expect(extractNoteGuidFromText('   \n\t  ')).toBeNull();
	});

	it('extracts a bare UUID (case-insensitive, lowercased)', () => {
		expect(extractNoteGuidFromText(GUID)).toBe(GUID);
		expect(extractNoteGuidFromText(GUID.toUpperCase())).toBe(GUID);
		expect(extractNoteGuidFromText(`  ${GUID}  `)).toBe(GUID);
	});

	it('extracts from a Tomboy URI', () => {
		expect(extractNoteGuidFromText(`note://tomboy/${GUID}`)).toBe(GUID);
		expect(extractNoteGuidFromText(`note://tomboy/${GUID}/`)).toBe(GUID);
		expect(extractNoteGuidFromText(`  note://tomboy/${GUID}\n`)).toBe(GUID);
	});

	it('extracts from the app /note/<uuid> URL', () => {
		expect(extractNoteGuidFromText(`https://example.com/note/${GUID}`)).toBe(GUID);
		expect(extractNoteGuidFromText(`http://localhost:5173/note/${GUID}`)).toBe(GUID);
		expect(extractNoteGuidFromText(`https://example.com/note/${GUID}?from=home`)).toBe(GUID);
		expect(extractNoteGuidFromText(`https://example.com/note/${GUID}#anchor`)).toBe(GUID);
	});

	it('rejects malformed UUIDs', () => {
		expect(extractNoteGuidFromText('not-a-uuid')).toBeNull();
		expect(extractNoteGuidFromText('1c97d161-1489-4c32-93d9-d8c383330b9')).toBeNull();
		expect(extractNoteGuidFromText('1c97d161-1489-4c32-93d9-d8c383330b9cz')).toBeNull();
	});

	it('rejects arbitrary prose that contains a UUID', () => {
		expect(extractNoteGuidFromText(`see ${GUID} for context`)).toBeNull();
		expect(extractNoteGuidFromText(`# header\n\nbody ${GUID}`)).toBeNull();
	});

	it('rejects unrelated URLs even when they contain a UUID', () => {
		expect(
			extractNoteGuidFromText(`https://example.com/admin/notes/${GUID}`)
		).toBeNull();
		expect(extractNoteGuidFromText(`note://other/${GUID}`)).toBeNull();
	});
});
