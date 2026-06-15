import { describe, it, expect } from 'vitest';
import { parseNoteRevFromPath, collectNoteRevisions } from '$lib/sync/dropboxClient.js';
import type { files } from 'dropbox';

function fileMatch(path: string, server_modified: string): files.SearchMatchV2 {
	return {
		metadata: {
			'.tag': 'metadata',
			metadata: { '.tag': 'file', name: path.split('/').pop()!, path_display: path, server_modified } as unknown as files.FileMetadataReference
		}
	} as unknown as files.SearchMatchV2;
}

describe('parseNoteRevFromPath', () => {
	const G = '1c97d161-1489-4c32-93d9-d8c383330b9c';
	it('parses rev from a note path', () => {
		expect(parseNoteRevFromPath(`/Notes/3/345/${G}.note`, G)).toBe(345);
		expect(parseNoteRevFromPath(`/0/7/${G}.note`, G)).toBe(7);
	});
	it('rejects wrong basename', () => {
		expect(parseNoteRevFromPath(`/3/345/other.note`, G)).toBeNull();
	});
	it('rejects non-numeric rev', () => {
		expect(parseNoteRevFromPath(`/3/xx/${G}.note`, G)).toBeNull();
	});
});

describe('collectNoteRevisions', () => {
	const G = 'aaa';
	it('filters, dedupes, sorts desc', () => {
		const matches = [
			fileMatch(`/0/5/${G}.note`, '2026-01-05T00:00:00Z'),
			fileMatch(`/0/9/${G}.note`, '2026-01-09T00:00:00Z'),
			fileMatch(`/0/5/${G}.note`, '2026-01-05T00:00:00Z'),
			fileMatch(`/0/9/other.note`, '2026-01-09T00:00:00Z')
		];
		const refs = collectNoteRevisions(matches, G);
		expect(refs.map((r) => r.rev)).toEqual([9, 5]);
		expect(refs[0].date).toBe('2026-01-09T00:00:00Z');
	});
	it('skips non-file / non-metadata matches', () => {
		const folderMatch = { metadata: { '.tag': 'metadata', metadata: { '.tag': 'folder', name: 'x', path_display: '/0/9' } } } as unknown as files.SearchMatchV2;
		const otherMatch = { metadata: { '.tag': 'other' } } as unknown as files.SearchMatchV2;
		expect(collectNoteRevisions([folderMatch, otherMatch], G)).toEqual([]);
	});
});
