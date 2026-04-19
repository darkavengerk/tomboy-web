import { describe, it, expect } from 'vitest';
import type { NoteData } from '$lib/core/note.js';
import { findDuplicateTitles } from '$lib/core/titleInvariantCheck.js';

function makeNote(overrides: Partial<NoteData> = {}): NoteData {
	return {
		uri: 'note://tomboy/test',
		guid: 'test',
		title: 'Test',
		xmlContent: '<note-content version="0.1">Test</note-content>',
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

describe('findDuplicateTitles', () => {
	it('returns [] for empty input', () => {
		expect(findDuplicateTitles([])).toEqual([]);
	});

	it('returns [] when all titles are unique', () => {
		const notes = [
			makeNote({ guid: '1', title: 'Alpha' }),
			makeNote({ guid: '2', title: 'Beta' })
		];
		expect(findDuplicateTitles(notes)).toEqual([]);
	});

	it('groups two notes with identical title, ordered by changeDate DESC', () => {
		const notes = [
			makeNote({ guid: '1', title: 'Foo', changeDate: '2024-01-01T00:00:00.0000000+00:00' }),
			makeNote({ guid: '2', title: 'Foo', changeDate: '2024-06-01T00:00:00.0000000+00:00' })
		];
		const groups = findDuplicateTitles(notes);
		expect(groups).toHaveLength(1);
		expect(groups[0].title).toBe('Foo');
		expect(groups[0].notes.map((n) => n.guid)).toEqual(['2', '1']);
	});

	it('returns only the duplicated group when one title is unique', () => {
		const notes = [
			makeNote({ guid: '1', title: 'Foo' }),
			makeNote({ guid: '2', title: 'Foo' }),
			makeNote({ guid: '3', title: 'Bar' })
		];
		const groups = findDuplicateTitles(notes);
		expect(groups).toHaveLength(1);
		expect(groups[0].title).toBe('Foo');
	});

	it('treats case-different titles as distinct (case-sensitive)', () => {
		const notes = [
			makeNote({ guid: '1', title: 'Foo' }),
			makeNote({ guid: '2', title: 'foo' })
		];
		expect(findDuplicateTitles(notes)).toEqual([]);
	});

	it('excludes deleted notes', () => {
		const notes = [
			makeNote({ guid: '1', title: 'Foo' }),
			makeNote({ guid: '2', title: 'Foo', deleted: true })
		];
		expect(findDuplicateTitles(notes)).toEqual([]);
	});

	it('excludes template notes', () => {
		const notes = [
			makeNote({ guid: '1', title: 'Foo' }),
			makeNote({ guid: '2', title: 'Foo', tags: ['system:template'] })
		];
		expect(findDuplicateTitles(notes)).toEqual([]);
	});

	it('excludes whitespace-only titles', () => {
		const notes = [
			makeNote({ guid: '1', title: '   ' }),
			makeNote({ guid: '2', title: '' })
		];
		expect(findDuplicateTitles(notes)).toEqual([]);
	});

	it('trims titles for grouping (Foo and Foo space group together)', () => {
		const notes = [
			makeNote({ guid: '1', title: 'Foo' }),
			makeNote({ guid: '2', title: 'Foo ' })
		];
		const groups = findDuplicateTitles(notes);
		expect(groups).toHaveLength(1);
		expect(groups[0].title).toBe('Foo');
		expect(groups[0].notes).toHaveLength(2);
	});

	it('sorts multiple groups by title ascending', () => {
		const notes = [
			makeNote({ guid: '1', title: 'Beta' }),
			makeNote({ guid: '2', title: 'Beta' }),
			makeNote({ guid: '3', title: 'Alpha' }),
			makeNote({ guid: '4', title: 'Alpha' })
		];
		const groups = findDuplicateTitles(notes);
		expect(groups.map((g) => g.title)).toEqual(['Alpha', 'Beta']);
	});

	it('sorts group members by changeDate DESC', () => {
		const notes = [
			makeNote({ guid: 'old', title: 'Foo', changeDate: '2024-01-01T00:00:00.0000000+00:00' }),
			makeNote({ guid: 'new', title: 'Foo', changeDate: '2024-12-01T00:00:00.0000000+00:00' }),
			makeNote({ guid: 'mid', title: 'Foo', changeDate: '2024-06-01T00:00:00.0000000+00:00' })
		];
		const groups = findDuplicateTitles(notes);
		expect(groups[0].notes.map((n) => n.guid)).toEqual(['new', 'mid', 'old']);
	});
});
