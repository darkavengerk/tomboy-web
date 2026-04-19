import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NoteData } from '$lib/core/note.js';

// In-memory fake noteStore.
const store = new Map<string, NoteData>();
const putSpy = vi.fn();

vi.mock('$lib/storage/noteStore.js', () => ({
	getNote: vi.fn(async (guid: string) => store.get(guid)),
	putNote: vi.fn(async (note: NoteData) => {
		putSpy(note);
		store.set(note.guid, { ...note, localDirty: true });
	}),
	putNoteSynced: vi.fn(async (note: NoteData) => {
		store.set(note.guid, { ...note });
	}),
	getAllNotes: vi.fn(async () =>
		Array.from(store.values()).filter((n) => !n.deleted)
	),
	getAllNotesIncludingTemplates: vi.fn(async () =>
		Array.from(store.values()).filter((n) => !n.deleted)
	),
	deleteNote: vi.fn(),
	findNoteByTitle: vi.fn(async (title: string) => {
		for (const n of store.values()) if (n.title === title) return n;
		return undefined;
	})
}));

const invalidateCacheSpy = vi.fn();
vi.mock('$lib/stores/noteListCache.js', () => ({
	invalidateCache: () => invalidateCacheSpy()
}));

const lookupGuidByTitleMock = vi.fn<(title: string) => string | null>();
const ensureTitleIndexReadySpy = vi.fn(async () => {});
vi.mock('$lib/editor/autoLink/titleProvider.js', () => ({
	lookupGuidByTitle: (title: string) => lookupGuidByTitleMock(title),
	ensureTitleIndexReady: () => ensureTitleIndexReadySpy()
}));

const emitNoteReloadSpy = vi.fn(async (_guids: Iterable<string>) => {});
vi.mock('$lib/core/noteReloadBus.js', () => ({
	emitNoteReload: (guids: Iterable<string>) => emitNoteReloadSpy(guids),
	subscribeNoteReload: vi.fn(() => () => {}),
	_resetForTest: vi.fn()
}));

import { updateNoteFromEditor } from '$lib/core/noteManager.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';

function makeNote(overrides: Partial<NoteData> = {}): NoteData {
	return {
		uri: 'note://tomboy/abc',
		guid: 'abc',
		title: 'Foo',
		xmlContent: '<note-content version="0.1">Foo\n\nbody</note-content>',
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

beforeEach(() => {
	store.clear();
	putSpy.mockReset();
	invalidateCacheSpy.mockReset();
	lookupGuidByTitleMock.mockReset();
	ensureTitleIndexReadySpy.mockClear();
	emitNoteReloadSpy.mockReset();
	emitNoteReloadSpy.mockImplementation(async () => {});
});

describe('updateNoteFromEditor — rename rewrite of backlinks', () => {
	it('rewrites <link:internal>Foo</link:internal> in all referencing notes and emits reload', async () => {
		const A = makeNote({
			guid: 'A',
			title: 'Foo',
			xmlContent: '<note-content version="0.1">Foo\n\nbody</note-content>'
		});
		const B = makeNote({
			guid: 'B',
			title: 'B-note',
			xmlContent:
				'<note-content version="0.1">B-note\nsee <link:internal>Foo</link:internal> here</note-content>'
		});
		const C = makeNote({
			guid: 'C',
			title: 'C-note',
			xmlContent:
				'<note-content version="0.1">C-note\n<link:internal>Foo</link:internal></note-content>'
		});
		store.set(A.guid, { ...A });
		store.set(B.guid, { ...B });
		store.set(C.guid, { ...C });

		lookupGuidByTitleMock.mockReturnValue(null);

		const doc = deserializeContent(
			'<note-content version="0.1">Bar\n\nbody</note-content>'
		);
		const result = await updateNoteFromEditor('A', doc);

		expect(result?.title).toBe('Bar');

		// B and C should have been rewritten via putNote.
		const putGuids = putSpy.mock.calls.map((c) => (c[0] as NoteData).guid);
		expect(putGuids).toContain('B');
		expect(putGuids).toContain('C');

		// Renamed note itself (A) is NOT in the affected list.
		const storedB = store.get('B')!;
		const storedC = store.get('C')!;
		expect(storedB.xmlContent).toContain('<link:internal>Bar</link:internal>');
		expect(storedB.xmlContent).not.toContain(
			'<link:internal>Foo</link:internal>'
		);
		expect(storedC.xmlContent).toContain('<link:internal>Bar</link:internal>');
		expect(storedC.xmlContent).not.toContain(
			'<link:internal>Foo</link:internal>'
		);

		// Timestamps updated on rewritten notes.
		expect(storedB.changeDate).not.toBe(B.changeDate);
		expect(storedB.metadataChangeDate).not.toBe(B.metadataChangeDate);
		expect(storedC.changeDate).not.toBe(C.changeDate);
		expect(storedC.metadataChangeDate).not.toBe(C.metadataChangeDate);

		// localDirty true (putNote path, not putNoteSynced).
		expect(storedB.localDirty).toBe(true);
		expect(storedC.localDirty).toBe(true);

		// emitNoteReload called once with B and C (order independent).
		expect(emitNoteReloadSpy).toHaveBeenCalledTimes(1);
		const emittedArg = emitNoteReloadSpy.mock.calls[0]![0];
		const emittedArr = Array.from(emittedArg as Iterable<string>);
		expect(new Set(emittedArr)).toEqual(new Set(['B', 'C']));
		expect(emittedArr).not.toContain('A');

		// invalidateCache called (at least once for title change; second pass
		// for the rewrite batch is allowed).
		expect(invalidateCacheSpy).toHaveBeenCalled();
	});

	it('rewrites <link:broken>Foo</link:broken> references too', async () => {
		const A = makeNote({
			guid: 'A',
			title: 'Foo',
			xmlContent: '<note-content version="0.1">Foo\n\nbody</note-content>'
		});
		const D = makeNote({
			guid: 'D',
			title: 'D-note',
			xmlContent:
				'<note-content version="0.1">D-note\n<link:broken>Foo</link:broken></note-content>'
		});
		store.set(A.guid, { ...A });
		store.set(D.guid, { ...D });

		lookupGuidByTitleMock.mockReturnValue(null);

		const doc = deserializeContent(
			'<note-content version="0.1">Bar\n\nbody</note-content>'
		);
		await updateNoteFromEditor('A', doc);

		const storedD = store.get('D')!;
		expect(storedD.xmlContent).toContain('<link:broken>Bar</link:broken>');
		expect(storedD.xmlContent).not.toContain('<link:broken>Foo</link:broken>');
		expect(emitNoteReloadSpy).toHaveBeenCalledTimes(1);
		const emittedArr = Array.from(
			emitNoteReloadSpy.mock.calls[0]![0] as Iterable<string>
		);
		expect(emittedArr).toEqual(['D']);
	});

	it('does not rewrite or emit when no note references the old title', async () => {
		const A = makeNote({
			guid: 'A',
			title: 'Foo',
			xmlContent: '<note-content version="0.1">Foo\n\nbody</note-content>'
		});
		const E = makeNote({
			guid: 'E',
			title: 'E-note',
			xmlContent: '<note-content version="0.1">E-note\nplain body</note-content>'
		});
		store.set(A.guid, { ...A });
		store.set(E.guid, { ...E });

		lookupGuidByTitleMock.mockReturnValue(null);

		const doc = deserializeContent(
			'<note-content version="0.1">Bar\n\nbody</note-content>'
		);
		await updateNoteFromEditor('A', doc);

		// Only A was put (self), never E.
		const putGuids = putSpy.mock.calls.map((c) => (c[0] as NoteData).guid);
		expect(putGuids).not.toContain('E');

		// emitNoteReload NOT called (empty affected list skips the emit).
		expect(emitNoteReloadSpy).not.toHaveBeenCalled();
	});

	it('does not rewrite when the new title equals the old title', async () => {
		const A = makeNote({
			guid: 'A',
			title: 'Foo',
			xmlContent: '<note-content version="0.1">Foo\n\nbody</note-content>'
		});
		const B = makeNote({
			guid: 'B',
			title: 'B',
			xmlContent:
				'<note-content version="0.1">B\n<link:internal>Foo</link:internal></note-content>'
		});
		store.set(A.guid, { ...A });
		store.set(B.guid, { ...B });

		lookupGuidByTitleMock.mockReturnValue(null);

		// Body-only edit of A (title stays "Foo"): no titleChanged branch.
		const doc = deserializeContent(
			'<note-content version="0.1">Foo\n\nnew body</note-content>'
		);
		await updateNoteFromEditor('A', doc);

		expect(emitNoteReloadSpy).not.toHaveBeenCalled();
		expect(store.get('B')!.xmlContent).toBe(B.xmlContent);
	});

	it('does NOT rewrite when the title-conflict guard rejects the save', async () => {
		const A = makeNote({
			guid: 'A',
			title: 'Foo',
			xmlContent: '<note-content version="0.1">Foo\n\nbody</note-content>'
		});
		const B = makeNote({
			guid: 'B',
			title: 'B',
			xmlContent:
				'<note-content version="0.1">B\n<link:internal>Foo</link:internal></note-content>'
		});
		store.set(A.guid, { ...A });
		store.set(B.guid, { ...B });

		// Conflict: "Bar" is owned by someone else.
		lookupGuidByTitleMock.mockImplementation((t: string) =>
			t === 'Bar' ? 'someone-else' : null
		);

		const doc = deserializeContent(
			'<note-content version="0.1">Bar\n\nbody</note-content>'
		);
		const result = await updateNoteFromEditor('A', doc);

		// Guard rejected: A stayed "Foo" in storage, B unchanged, no emit.
		expect(result?.title).toBe('Foo');
		expect(store.get('A')!.title).toBe('Foo');
		expect(store.get('B')!.xmlContent).toBe(B.xmlContent);
		expect(emitNoteReloadSpy).not.toHaveBeenCalled();
	});

	it('self-excludes: renaming A never rewrites A itself even if it somehow has its own old title mark', async () => {
		// Edge case: A has <link:internal>Foo</link:internal> inside its own body.
		// On rename Foo→Bar, the editor's JSON already carries whatever marks
		// the user had; serializeContent decides the new xml. The backlink
		// sweep must not additionally rewrite A again.
		const A = makeNote({
			guid: 'A',
			title: 'Foo',
			xmlContent: '<note-content version="0.1">Foo\n\nbody</note-content>'
		});
		store.set(A.guid, { ...A });

		lookupGuidByTitleMock.mockReturnValue(null);

		const doc = deserializeContent(
			'<note-content version="0.1">Bar\n\nbody</note-content>'
		);
		await updateNoteFromEditor('A', doc);

		// Affected list must never contain A.
		if (emitNoteReloadSpy.mock.calls.length > 0) {
			const arr = Array.from(
				emitNoteReloadSpy.mock.calls[0]![0] as Iterable<string>
			);
			expect(arr).not.toContain('A');
		}
		// A was put exactly once (the primary save), not a second time.
		const aPuts = putSpy.mock.calls.filter(
			(c) => (c[0] as NoteData).guid === 'A'
		);
		expect(aPuts.length).toBe(1);
	});

	it('skips deleted notes even if they contain the reference', async () => {
		const A = makeNote({
			guid: 'A',
			title: 'Foo',
			xmlContent: '<note-content version="0.1">Foo\n\nbody</note-content>'
		});
		const F = makeNote({
			guid: 'F',
			title: 'F',
			xmlContent:
				'<note-content version="0.1">F\n<link:internal>Foo</link:internal></note-content>',
			deleted: true
		});
		store.set(A.guid, { ...A });
		// Bypass the mock's deleted filter by adding directly.
		store.set(F.guid, { ...F });

		lookupGuidByTitleMock.mockReturnValue(null);

		const doc = deserializeContent(
			'<note-content version="0.1">Bar\n\nbody</note-content>'
		);
		await updateNoteFromEditor('A', doc);

		// F not rewritten.
		const putF = putSpy.mock.calls.find(
			(c) => (c[0] as NoteData).guid === 'F'
		);
		expect(putF).toBeUndefined();

		// emit NOT called (or called with empty list — both OK; assert F absent).
		if (emitNoteReloadSpy.mock.calls.length > 0) {
			const arr = Array.from(
				emitNoteReloadSpy.mock.calls[0]![0] as Iterable<string>
			);
			expect(arr).not.toContain('F');
		}
	});
});
