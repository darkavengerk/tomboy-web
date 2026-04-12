import { describe, it, expect } from 'vitest';
import { searchNotes } from '$lib/search/noteSearch.js';
import type { NoteData } from '$lib/core/note.js';

function makeNote(overrides: Partial<NoteData> = {}): NoteData {
	return {
		uri: 'note://tomboy/test',
		guid: 'test',
		title: 'Test Note',
		xmlContent: '<note-content version="0.1">Test Note\nBody text here.</note-content>',
		createDate: '2024-01-01T00:00:00.0000000+00:00',
		changeDate: '2024-06-01T00:00:00.0000000+00:00',
		metadataChangeDate: '2024-06-01T00:00:00.0000000+00:00',
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

describe('noteSearch', () => {
	const notes = [
		makeNote({ guid: '1', title: 'Shopping List', xmlContent: '<note-content version="0.1">Shopping List\nBuy milk and eggs.</note-content>' }),
		makeNote({ guid: '2', title: 'Meeting Notes', xmlContent: '<note-content version="0.1">Meeting Notes\nDiscuss <bold>project</bold> timeline.</note-content>' }),
		makeNote({ guid: '3', title: 'Recipe', xmlContent: '<note-content version="0.1">Recipe\nChocolate cake with eggs and flour.</note-content>' }),
		makeNote({ guid: '4', title: 'Deleted Note', deleted: true, xmlContent: '<note-content version="0.1">Deleted Note\nShould not appear.</note-content>' })
	];

	it('matches title substring case-insensitively', () => {
		const results = searchNotes(notes, 'shopping');
		expect(results).toHaveLength(1);
		expect(results[0].note.guid).toBe('1');
	});

	it('matches body content with XML tags stripped', () => {
		const results = searchNotes(notes, 'project');
		expect(results).toHaveLength(1);
		expect(results[0].note.guid).toBe('2');
	});

	it('returns empty array for no matches', () => {
		const results = searchNotes(notes, 'nonexistent');
		expect(results).toHaveLength(0);
	});

	it('limits results to specified count', () => {
		const results = searchNotes(notes, 'eggs', 1);
		expect(results).toHaveLength(1);
	});

	it('returns results matching across multiple notes', () => {
		const results = searchNotes(notes, 'eggs');
		expect(results).toHaveLength(2);
	});

	it('excludes deleted notes', () => {
		const results = searchNotes(notes, 'Deleted');
		expect(results).toHaveLength(0);
	});

	it('returns empty for blank query', () => {
		const results = searchNotes(notes, '   ');
		expect(results).toHaveLength(0);
	});

	it('provides match context for body matches', () => {
		const results = searchNotes(notes, 'timeline');
		expect(results).toHaveLength(1);
		expect(results[0].matchContext).toContain('timeline');
	});
});
