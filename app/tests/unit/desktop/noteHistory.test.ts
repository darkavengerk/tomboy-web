import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NoteData } from '$lib/core/note.js';

const search = vi.fn();
const dlManifest = vi.fn();
const dlServerManifest = vi.fn();
const fetchRev = vi.fn();

vi.mock('$lib/sync/dropboxClient.js', () => ({
	searchNoteRevisions: (...a: unknown[]) => search(...a),
	downloadServerManifest: (...a: unknown[]) => dlServerManifest(...a),
	downloadRevisionManifest: (...a: unknown[]) => dlManifest(...a)
}));
vi.mock('$lib/sync/adminClient.js', () => ({
	fetchNoteAtRevision: (...a: unknown[]) => fetchRev(...a)
}));

import { createNoteHistory, formatVersionLabel, noteToPlainText } from '$lib/desktop/noteHistory.svelte.js';

const G = 'g1';
function note(partial: Partial<NoteData> = {}): NoteData {
	return {
		uri: `note://tomboy/${G}`,
		guid: G,
		title: 'T',
		xmlContent: '<note-content version="0.1">hi</note-content>',
		createDate: '',
		changeDate: '',
		metadataChangeDate: '',
		cursorPosition: 0,
		selectionBoundPosition: -1,
		width: 450,
		height: 360,
		x: 0,
		y: 0,
		tags: [],
		openOnStartup: false,
		deleted: false,
		localDirty: false,
		...partial
	} as NoteData;
}

beforeEach(() => {
	search.mockReset(); dlManifest.mockReset(); dlServerManifest.mockReset(); fetchRev.mockReset();
	dlServerManifest.mockResolvedValue({ revision: 9, serverId: 's', notes: [{ guid: G, rev: 9 }] });
});

describe('createNoteHistory.load (search path)', () => {
	it('builds desc versions and injects missing current rev', async () => {
		search.mockResolvedValue([{ rev: 5, date: 'd5' }, { rev: 3, date: 'd3' }]);
		const h = createNoteHistory(G);
		await h.load();
		expect(h.versions.map((v) => v.rev)).toEqual([9, 5, 3]);
		expect(h.usedFallback).toBe(false);
	});
});

describe('createNoteHistory.load (fallback)', () => {
	it('scans manifests when search empty', async () => {
		search.mockResolvedValue([]);
		dlManifest.mockImplementation(async (rev: number) =>
			rev === 9 ? { revision: 9, serverId: 's', notes: [{ guid: G, rev: 9 }] }
			: rev === 8 ? { revision: 8, serverId: 's', notes: [{ guid: G, rev: 6 }] }
			: { revision: rev, serverId: 's', notes: [] }
		);
		const h = createNoteHistory(G);
		await h.load();
		expect(h.usedFallback).toBe(true);
		expect(h.versions.map((v) => v.rev)).toContain(9);
		expect(h.versions.map((v) => v.rev)).toContain(6);
	});
});

describe('fetchBody caches', () => {
	it('hits network once per rev', async () => {
		search.mockResolvedValue([{ rev: 9, date: 'd9' }]);
		fetchRev.mockResolvedValue(note());
		const h = createNoteHistory(G);
		await h.load();
		await h.fetchBody(9);
		await h.fetchBody(9);
		expect(fetchRev).toHaveBeenCalledTimes(1);
	});
});

describe('pure helpers', () => {
	it('noteToPlainText returns text', () => {
		expect(noteToPlainText(note())).toContain('hi');
	});
	it('formatVersionLabel', () => {
		expect(formatVersionLabel({ rev: 9, date: '' })).toBe('rev 9');
		expect(formatVersionLabel({ rev: 9, date: '2026-01-09T00:00:00Z' })).toMatch(/^rev 9 · /);
	});
});
