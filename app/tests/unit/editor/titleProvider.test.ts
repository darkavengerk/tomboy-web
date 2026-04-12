import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NoteData } from '$lib/core/note.js';

const listNotesMock = vi.fn<() => Promise<NoteData[]>>();

vi.mock('$lib/core/noteManager.js', () => ({
	listNotes: () => listNotesMock()
}));

// Use the real noteListCache — it is a simple in-memory module.
import {
	invalidateCache,
	_resetForTest
} from '$lib/stores/noteListCache.js';
import { createTitleProvider } from '$lib/editor/autoLink/titleProvider.js';

function makeNote(guid: string, title: string, changeDate = '2024-01-01T00:00:00Z'): NoteData {
	return {
		uri: `note://tomboy/${guid}`,
		guid,
		title,
		xmlContent: `<note-content version="0.1">${title}\n\n</note-content>`,
		createDate: changeDate,
		changeDate,
		metadataChangeDate: changeDate,
		cursorPosition: 0,
		selectionBoundPosition: 0,
		width: 0,
		height: 0,
		x: 0,
		y: 0,
		tags: [],
		openOnStartup: false,
		deleted: false,
		localDirty: false
	};
}

beforeEach(() => {
	_resetForTest();
	listNotesMock.mockReset();
});

describe('titleProvider', () => {
	it('refresh() populates entries with lower-cased titles', async () => {
		listNotesMock.mockResolvedValueOnce([
			makeNote('a', 'Foo Bar'),
			makeNote('b', 'Hello World')
		]);
		const p = createTitleProvider({});
		await p.refresh();

		const titles = p.getTitles();
		expect(titles).toHaveLength(2);
		const byGuid = Object.fromEntries(titles.map((t) => [t.guid, t]));
		expect(byGuid.a.original).toBe('Foo Bar');
		expect(byGuid.a.titleLower).toBe('foo bar');
		expect(byGuid.b.titleLower).toBe('hello world');
		p.dispose();
	});

	it('filters out blank / whitespace-only titles', async () => {
		listNotesMock.mockResolvedValueOnce([
			makeNote('a', 'Foo'),
			makeNote('b', ''),
			makeNote('c', '   ')
		]);
		const p = createTitleProvider({});
		await p.refresh();
		expect(p.getTitles().map((t) => t.guid)).toEqual(['a']);
		p.dispose();
	});

	it('excludes the configured guid', async () => {
		listNotesMock.mockResolvedValueOnce([
			makeNote('self', 'Self'),
			makeNote('other', 'Other')
		]);
		const p = createTitleProvider({ excludeGuid: 'self' });
		await p.refresh();
		expect(p.getTitles().map((t) => t.guid)).toEqual(['other']);
		p.dispose();
	});

	it('invalidateCache triggers a refresh and notifies onChange subscribers', async () => {
		listNotesMock
			.mockResolvedValueOnce([makeNote('a', 'Foo')])
			.mockResolvedValueOnce([makeNote('a', 'Foo'), makeNote('b', 'New')]);

		const p = createTitleProvider({});
		await p.refresh();
		expect(p.getTitles()).toHaveLength(1);

		const changed = vi.fn();
		p.onChange(changed);

		invalidateCache();
		// onChange fires after the internal refresh completes; wait a microtask.
		await new Promise((r) => setTimeout(r, 0));

		expect(changed).toHaveBeenCalled();
		expect(p.getTitles()).toHaveLength(2);
		p.dispose();
	});

	it('dispose() unsubscribes — further invalidations do not call listNotes again', async () => {
		listNotesMock.mockResolvedValue([makeNote('a', 'Foo')]);
		const p = createTitleProvider({});
		await p.refresh();
		expect(listNotesMock).toHaveBeenCalledTimes(1);

		p.dispose();
		invalidateCache();
		await new Promise((r) => setTimeout(r, 0));
		expect(listNotesMock).toHaveBeenCalledTimes(1);
	});

	it('onChange returns an unsubscribe function', async () => {
		listNotesMock.mockResolvedValue([makeNote('a', 'Foo')]);
		const p = createTitleProvider({});
		await p.refresh();

		const changed = vi.fn();
		const off = p.onChange(changed);
		off();

		invalidateCache();
		await new Promise((r) => setTimeout(r, 0));
		expect(changed).not.toHaveBeenCalled();
		p.dispose();
	});
});
