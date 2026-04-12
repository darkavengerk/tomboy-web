import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/sync/dropboxClient.js', () => ({
	isAuthenticated: vi.fn(() => true),
	downloadServerManifest: vi.fn(async () => null),
	downloadNoteAtRevision: vi.fn(async () => '<note>test</note>'),
	commitRevision: vi.fn(async () => undefined),
	initServerManifest: vi.fn(async () => ({ revision: 1, serverId: 'new-server', notes: [] }))
}));

vi.mock('$lib/storage/noteStore.js', () => ({
	getAllNotesIncludingDeleted: vi.fn(async () => []),
	putNoteSynced: vi.fn(async () => undefined),
	purgeNote: vi.fn(async () => undefined)
}));

vi.mock('$lib/sync/manifest.js', () => ({
	getManifest: vi.fn(async () => ({
		id: 'manifest',
		lastSyncDate: '',
		lastSyncRev: -1,
		serverId: '',
		noteRevisions: {}
	})),
	saveManifest: vi.fn(async () => undefined),
	clearManifest: vi.fn(async () => undefined)
}));

vi.mock('$lib/core/noteArchiver.js', () => ({
	parseNoteFromFile: vi.fn((content: string, filename: string) => {
		const guid = filename.replace(/\.note$/, '');
		return {
			uri: `note://tomboy/${guid}`,
			guid,
			title: 'Test Note',
			xmlContent: content,
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
			deleted: false
		};
	}),
	serializeNote: vi.fn(() => '<note>xml</note>')
}));

import { computePlan, applyPlan, _resetForTest } from '$lib/sync/syncManager.js';
import * as dropboxClient from '$lib/sync/dropboxClient.js';
import * as noteStore from '$lib/storage/noteStore.js';
import * as manifest from '$lib/sync/manifest.js';
import type { NoteData } from '$lib/core/note.js';
import type { TomboyServerManifest } from '$lib/sync/dropboxClient.js';

function makeNote(overrides: Partial<NoteData> = {}): NoteData {
	return {
		uri: 'note://tomboy/test-guid',
		guid: 'test-guid',
		title: 'Test Note',
		xmlContent: '<note-content>Test</note-content>',
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

function makeServerManifest(overrides: Partial<TomboyServerManifest> = {}): TomboyServerManifest {
	return {
		revision: 5,
		serverId: 'server-id-123',
		notes: [],
		...overrides
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetForTest();
	vi.mocked(dropboxClient.isAuthenticated).mockReturnValue(true);
	vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(makeServerManifest());
	vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([]);
	vi.mocked(manifest.getManifest).mockResolvedValue({
		id: 'manifest',
		lastSyncDate: '',
		lastSyncRev: 5,
		serverId: 'server-id-123',
		noteRevisions: {}
	});
});

describe('computePlan', () => {
	it('returns empty plan when local and server are identical', async () => {
		const note = makeNote({ guid: 'abc', localDirty: false });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([note]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ notes: [{ guid: 'abc', rev: 5 }] })
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 5, serverId: 'server-id-123',
			noteRevisions: { abc: 5 }
		});

		const plan = await computePlan();

		expect(plan.toDownload).toHaveLength(0);
		expect(plan.toUpload).toHaveLength(0);
		expect(plan.toDeleteRemote).toHaveLength(0);
		expect(plan.toDeleteLocal).toHaveLength(0);
		expect(plan.conflicts).toHaveLength(0);
	});

	it('lists notes newer on server under toDownload', async () => {
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ notes: [{ guid: 'new-server', rev: 5 }] })
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 4, serverId: 'server-id-123',
			noteRevisions: {}
		});

		const plan = await computePlan();

		expect(plan.toDownload).toHaveLength(1);
		expect(plan.toDownload[0].guid).toBe('new-server');
	});

	it('lists locally-dirty notes under toUpload', async () => {
		const dirty = makeNote({ guid: 'dirty', localDirty: true });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([dirty]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ notes: [] })
		);

		const plan = await computePlan();

		expect(plan.toUpload).toHaveLength(1);
		expect(plan.toUpload[0].guid).toBe('dirty');
	});

	it('lists local tombstones under toDeleteRemote', async () => {
		const deleted = makeNote({ guid: 'del', deleted: true });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([deleted]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ notes: [{ guid: 'del', rev: 3 }] })
		);

		const plan = await computePlan();

		expect(plan.toDeleteRemote).toHaveLength(1);
		expect(plan.toDeleteRemote[0].guid).toBe('del');
	});

	it('lists server-missing guids present in local manifest under toDeleteLocal', async () => {
		const local = makeNote({ guid: 'gone', localDirty: false });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([local]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ notes: [] }) // 'gone' not on server
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 5, serverId: 'server-id-123',
			noteRevisions: { gone: 5 }
		});

		const plan = await computePlan();

		expect(plan.toDeleteLocal).toHaveLength(1);
		expect(plan.toDeleteLocal[0].guid).toBe('gone');
	});

	it('marks conflicting notes (both dirty + server newer)', async () => {
		const local = makeNote({ guid: 'conflict', localDirty: true });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([local]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ notes: [{ guid: 'conflict', rev: 5 }] })
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 4, serverId: 'server-id-123',
			noteRevisions: { conflict: 4 }
		});

		const plan = await computePlan();

		expect(plan.conflicts).toHaveLength(1);
		expect(plan.conflicts[0].guid).toBe('conflict');
	});

	it('serverWasWiped true when serverId mismatch and local has a stored serverId', async () => {
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 5, serverId: 'old-server',
			noteRevisions: {}
		});
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ serverId: 'new-server' })
		);

		const plan = await computePlan();

		expect(plan.serverWasWiped).toBe(true);
	});

	it('computePlan does NOT call commitRevision or downloadNoteAtRevision', async () => {
		const dirty = makeNote({ guid: 'dirty', localDirty: true });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([dirty]);

		await computePlan();

		expect(dropboxClient.commitRevision).not.toHaveBeenCalled();
		expect(dropboxClient.downloadNoteAtRevision).not.toHaveBeenCalled();
	});

	it('computePlan does NOT mutate manifest in IDB', async () => {
		const saveSpy = vi.mocked(manifest.saveManifest);
		saveSpy.mockClear();

		await computePlan();

		expect(saveSpy).not.toHaveBeenCalled();
	});
});

describe('applyPlan', () => {
	it('applyPlan with empty upload selection does not call commitRevision', async () => {
		const serverManifest = makeServerManifest({ notes: [{ guid: 'srv', rev: 5 }] });
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(serverManifest);

		const plan = await computePlan();
		const sel = {
			download: new Set<string>(),
			upload: new Set<string>(),
			deleteRemote: new Set<string>(),
			deleteLocal: new Set<string>(),
			conflictChoice: new Map<string, 'local' | 'remote'>()
		};

		await applyPlan(plan, sel);

		expect(dropboxClient.commitRevision).not.toHaveBeenCalled();
	});

	it('applyPlan skips downloads not selected', async () => {
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ notes: [{ guid: 'skip-me', rev: 5 }] })
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 4, serverId: 'server-id-123',
			noteRevisions: {}
		});

		const plan = await computePlan();
		const sel = {
			download: new Set<string>(), // empty — skip all
			upload: new Set<string>(),
			deleteRemote: new Set<string>(),
			deleteLocal: new Set<string>(),
			conflictChoice: new Map<string, 'local' | 'remote'>()
		};

		const result = await applyPlan(plan, sel);

		expect(result.downloaded).toBe(0);
		expect(dropboxClient.downloadNoteAtRevision).not.toHaveBeenCalled();
	});
});
