import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NoteData } from '$lib/core/note.js';

// In-memory fake IDB.
const store = new Map<string, NoteData>();
const putSpy = vi.fn();
const putSyncedSpy = vi.fn();

vi.mock('$lib/storage/noteStore.js', () => ({
	getNote: vi.fn(async (guid: string) => store.get(guid)),
	putNote: vi.fn(async (note: NoteData) => {
		putSpy(note);
		store.set(note.guid, { ...note, localDirty: true });
	}),
	putNoteSynced: vi.fn(async (note: NoteData) => {
		putSyncedSpy(note);
		store.set(note.guid, { ...note });
	}),
	getAllNotes: vi.fn(async () => Array.from(store.values())),
	getAllNotesIncludingDeleted: vi.fn(async () => Array.from(store.values())),
	findNoteByTitle: vi.fn(async (title: string) => {
		const needle = title.trim();
		if (!needle) return undefined;
		return Array.from(store.values()).find(
			(n) => !n.deleted && n.title.trim() === needle
		);
	})
}));

const pushToastMock = vi.fn();
vi.mock('$lib/stores/toast.js', () => ({
	pushToast: (...args: unknown[]) => pushToastMock(...args)
}));

vi.mock('$lib/stores/noteListCache.js', () => ({
	invalidateCache: vi.fn()
}));

vi.mock('$lib/core/notebooks.js', () => ({
	refreshNotebooksCache: vi.fn()
}));

// Stub the dropbox client so import of syncManager doesn't drag in network code.
vi.mock('$lib/sync/dropboxClient.js', () => ({
	downloadServerManifest: vi.fn(),
	downloadNoteAtRevision: vi.fn(),
	commitRevision: vi.fn(),
	initServerManifest: vi.fn(),
	isAuthenticated: vi.fn(() => true)
}));

vi.mock('$lib/sync/manifest.js', () => ({
	getManifest: vi.fn(async () => ({
		serverId: '',
		noteRevisions: {},
		lastSyncRev: 0,
		lastSyncDate: ''
	})),
	saveManifest: vi.fn(),
	clearManifest: vi.fn()
}));

import { _applyIncomingRemoteNoteForTest } from '$lib/sync/syncManager.js';

function makeIncoming(overrides: Partial<NoteData> & { guid: string; title: string }): NoteData {
	return {
		uri: `note://tomboy/${overrides.guid}`,
		xmlContent: `<note-content version="0.1">${overrides.title}\nbody</note-content>`,
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
		localDirty: true, // incoming, but applyIncoming should set to false on no-collision
		deleted: false,
		...overrides
	};
}

function seedLocal(guid: string, title: string): void {
	store.set(guid, {
		uri: `note://tomboy/${guid}`,
		guid,
		title,
		xmlContent: `<note-content version="0.1">${title}\nbody</note-content>`,
		createDate: '2024-01-01T00:00:00.0000000+00:00',
		changeDate: '2024-01-01T00:00:00.0000000+00:00',
		metadataChangeDate: '2024-01-01T00:00:00.0000000+00:00',
		cursorPosition: 0,
		selectionBoundPosition: -1,
		width: 450,
		height: 360,
		x: 0,
		y: 0,
		tags: [],
		openOnStartup: false,
		localDirty: false,
		deleted: false
	});
}

beforeEach(() => {
	store.clear();
	putSpy.mockReset();
	putSyncedSpy.mockReset();
	pushToastMock.mockReset();
});

describe('applyIncomingRemoteNote (sync-pull title-suffix helper)', () => {
	it('no collision → putNoteSynced, localDirty=false, no toast', async () => {
		const incoming = makeIncoming({ guid: 'g1', title: 'Unique Title' });
		await _applyIncomingRemoteNoteForTest(incoming);

		expect(putSyncedSpy).toHaveBeenCalledTimes(1);
		expect(putSpy).not.toHaveBeenCalled();
		expect(pushToastMock).not.toHaveBeenCalled();

		const stored = store.get('g1');
		expect(stored?.title).toBe('Unique Title');
		expect(stored?.localDirty).toBe(false);
		expect(stored?.deleted).toBe(false);
	});

	it('collision with different local guid → putNote (dirty), toast emitted, xmlContent rewritten', async () => {
		seedLocal('local-owner', 'Collision');
		const incoming = makeIncoming({ guid: 'remote-guid', title: 'Collision' });

		await _applyIncomingRemoteNoteForTest(incoming);

		expect(putSpy).toHaveBeenCalledTimes(1);
		expect(putSyncedSpy).not.toHaveBeenCalled();

		expect(pushToastMock).toHaveBeenCalledTimes(1);
		expect(pushToastMock).toHaveBeenCalledWith(
			"제목 중복 — 'Collision' → 'Collision (2)' 로 이름 변경됨",
			{ kind: 'info' }
		);

		const stored = store.get('remote-guid');
		expect(stored?.title).toBe('Collision (2)');
		expect(stored?.xmlContent).toBe(
			'<note-content version="0.1">Collision (2)\nbody</note-content>'
		);
		expect(stored?.localDirty).toBe(true);
	});

	it('self-match (same guid already has same title locally) → putNoteSynced, no toast', async () => {
		seedLocal('same-guid', 'SameTitle');
		const incoming = makeIncoming({ guid: 'same-guid', title: 'SameTitle' });

		await _applyIncomingRemoteNoteForTest(incoming);

		expect(putSyncedSpy).toHaveBeenCalledTimes(1);
		expect(putSpy).not.toHaveBeenCalled();
		expect(pushToastMock).not.toHaveBeenCalled();
	});

	it('updates metadataChangeDate on rename', async () => {
		seedLocal('local-owner', 'T');
		const incoming = makeIncoming({
			guid: 'remote-guid',
			title: 'T',
			metadataChangeDate: '2024-06-01T10:20:30.1234567+00:00'
		});

		await _applyIncomingRemoteNoteForTest(incoming);

		const stored = store.get('remote-guid');
		expect(stored?.metadataChangeDate).not.toBe(
			'2024-06-01T10:20:30.1234567+00:00'
		);
		// format guard — non-empty and Tomboy-shaped
		expect(stored?.metadataChangeDate).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}[+-]\d{2}:\d{2}$/
		);
	});
});
