import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NoteData } from '$lib/core/note.js';

const store = new Map<string, NoteData>();

vi.mock('$lib/storage/noteStore.js', () => ({
	getNote: vi.fn(async (guid: string) => store.get(guid)),
	putNote: vi.fn(async (note: NoteData) => {
		store.set(note.guid, { ...note });
	}),
	getAllNotes: vi.fn(async () => Array.from(store.values())),
	getAllNotesIncludingTemplates: vi.fn(async () => Array.from(store.values())),
	putNoteSynced: vi.fn(),
	deleteNote: vi.fn(),
	findNoteByTitle: vi.fn(async (title: string) => {
		const needle = title.trim().toLowerCase();
		if (!needle) return undefined;
		return Array.from(store.values()).find(
			(n) => !n.deleted && n.title.trim().toLowerCase() === needle
		);
	})
}));

vi.mock('$lib/stores/noteListCache.js', () => ({
	invalidateCache: vi.fn()
}));

import { createNote } from '$lib/core/noteManager.js';

beforeEach(() => {
	store.clear();
});

describe('createNote — yyyy-mm-dd title seeds the year subtitle', () => {
	it('adds yyyy년 on the second line when title is yyyy-mm-dd', async () => {
		const note = await createNote('2026-04-17');
		expect(note.title).toBe('2026-04-17');
		expect(note.xmlContent).toBe(
			'<note-content version="0.1">2026-04-17\n2026년\n</note-content>'
		);
	});

	it('uses the matched year (not today) — 1999', async () => {
		const note = await createNote('1999-12-31');
		expect(note.xmlContent).toContain('\n1999년\n');
	});

	it('leaves the second line empty for non-date titles', async () => {
		const note = await createNote('Meeting notes');
		expect(note.xmlContent).toBe(
			'<note-content version="0.1">Meeting notes\n\n</note-content>'
		);
	});

	it('does not treat partial date-like titles as dates', async () => {
		const note = await createNote('2026-04');
		expect(note.xmlContent).not.toContain('년');
	});

	it('does not match when there is extra content after the date', async () => {
		const note = await createNote('2026-04-17 회의');
		expect(note.xmlContent).not.toContain('년\n');
	});
});

describe('createNote — default title is yyyy-mm-dd HH:mm', () => {
	it('uses yyyy-mm-dd HH:mm as the title when no initialTitle is given', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(2026, 3, 19, 7, 5));
			const note = await createNote();
			expect(note.title).toBe('2026-04-19 07:05');
		} finally {
			vi.useRealTimers();
		}
	});

	it('generated XML has the default two-blank-line body (no year subtitle)', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(2026, 3, 19, 7, 5));
			const note = await createNote();
			expect(note.xmlContent).toBe(
				'<note-content version="0.1">2026-04-19 07:05\n\n</note-content>'
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('falls back to a unique suffix when the same-minute title already exists', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(2026, 3, 19, 7, 5));
			const first = await createNote();
			const second = await createNote();
			const third = await createNote();
			expect(first.title).toBe('2026-04-19 07:05');
			expect(second.title).toBe('2026-04-19 07:05 (2)');
			expect(third.title).toBe('2026-04-19 07:05 (3)');
		} finally {
			vi.useRealTimers();
		}
	});
});
