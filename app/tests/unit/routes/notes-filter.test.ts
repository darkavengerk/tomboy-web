import { describe, it, expect } from 'vitest';
import { filterByNotebook } from '$lib/core/notebooks';
import type { NoteData } from '$lib/core/note';

function makeNote(guid: string, notebookTag: string | null): NoteData {
	return {
		uri: `note://tomboy/${guid}`,
		guid,
		title: guid,
		xmlContent: '',
		tags: notebookTag ? [`system:notebook:${notebookTag}`] : [],
		createDate: '',
		changeDate: '',
		metadataChangeDate: '',
		cursorPosition: 0,
		selectionBoundPosition: -1,
		width: 450,
		height: 360,
		x: 0,
		y: 0,
		openOnStartup: false,
		localDirty: false,
		deleted: false
	};
}

describe('filterByNotebook', () => {
	const notes = [
		makeNote('a', '업무'),
		makeNote('b', '업무'),
		makeNote('c', '개인'),
		makeNote('d', null)
	];

	it('null을 전달하면 전체 노트를 반환한다', () => {
		expect(filterByNotebook(notes, null)).toHaveLength(4);
	});

	it('노트북 이름으로 필터링한다', () => {
		const result = filterByNotebook(notes, '업무');
		expect(result).toHaveLength(2);
		expect(result.every((n) => n.tags.includes('system:notebook:업무'))).toBe(true);
	});

	it('존재하지 않는 노트북이면 빈 배열을 반환한다', () => {
		expect(filterByNotebook(notes, '없는노트북')).toHaveLength(0);
	});

	it('노트북 없는 노트만 반환하려면 빈 문자열을 전달한다', () => {
		const result = filterByNotebook(notes, '');
		expect(result).toHaveLength(1);
		expect(result[0].guid).toBe('d');
	});
});
