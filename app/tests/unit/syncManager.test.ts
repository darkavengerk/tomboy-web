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
	putNote: vi.fn(async () => undefined),
	purgeNote: vi.fn(async () => undefined),
	findNoteByTitle: vi.fn(async () => undefined)
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
	serializeNote: vi.fn(() => '<note>xml</note>'),
	filenameFromGuid: vi.fn((guid: string) => `${guid}.note`),
	extractTitleFromContent: vi.fn((xml: string) => {
		const m = xml.match(/<note-content[^>]*>([^\n<]*)/);
		return m ? m[1].trim() : '';
	})
}));

import { sync, _resetForTest } from '$lib/sync/syncManager.js';
import * as dropboxClient from '$lib/sync/dropboxClient.js';
import * as noteStore from '$lib/storage/noteStore.js';
import * as manifest from '$lib/sync/manifest.js';
import {
	subscribeNoteReload,
	_resetForTest as _resetReloadBusForTest
} from '$lib/core/noteReloadBus.js';
import type { NoteData } from '$lib/core/note.js';
import type { TomboyServerManifest } from '$lib/sync/dropboxClient.js';

function makeNote(overrides: Partial<NoteData> = {}): NoteData {
	return {
		uri: 'note://tomboy/test-guid',
		guid: 'test-guid',
		title: 'Test Note',
		xmlContent: '<note-content version="0.1">Test Note\nBody</note-content>',
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
	_resetReloadBusForTest();
	Object.defineProperty(navigator, 'onLine', { value: true, writable: true });
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

describe('syncManager', () => {
	it('uploads local dirty note as new revision', async () => {
		const localNote = makeNote({ guid: 'new-local', localDirty: true });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ revision: 5, notes: [] })
		);

		const result = await sync();

		expect(result.uploaded).toBe(1);
		expect(dropboxClient.commitRevision).toHaveBeenCalledWith(
			6, // newRev = 5 + 1
			expect.arrayContaining([expect.objectContaining({ guid: 'new-local' })]),
			[],
			expect.anything(),
			expect.anything() // CommitCallbacks
		);
		expect(noteStore.putNoteSynced).toHaveBeenCalledWith(
			expect.objectContaining({ guid: 'new-local', localDirty: false })
		);
	});

	it('downloads new remote note not present locally', async () => {
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ notes: [{ guid: 'remote-guid', rev: 5 }] })
		);
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([]);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 4, serverId: 'server-id-123',
			noteRevisions: {}
		});

		const result = await sync();

		expect(result.downloaded).toBe(1);
		expect(dropboxClient.downloadNoteAtRevision).toHaveBeenCalledWith('remote-guid', 5, expect.anything());
		expect(noteStore.putNoteSynced).toHaveBeenCalled();
	});

	it('remote changeDate newer → download wins over local dirty', async () => {
		const localNote = makeNote({
			guid: 'shared-guid',
			changeDate: '2024-05-01T00:00:00.0000000+00:00',
			localDirty: true
		});
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ revision: 5, notes: [{ guid: 'shared-guid', rev: 5 }] })
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 4, serverId: 'server-id-123',
			noteRevisions: { 'shared-guid': 4 }
		});
		// Remote note has newer changeDate (2024-06-01 from parseNoteFromFile mock default)

		const result = await sync();

		expect(result.downloaded).toBe(1);
		expect(result.uploaded).toBe(0);
	});

	it('local changeDate newer → upload wins over remote', async () => {
		const localNote = makeNote({
			guid: 'shared-guid',
			changeDate: '2024-07-01T00:00:00.0000000+00:00', // newer than mock's 2024-06-01
			localDirty: true
		});
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ revision: 5, notes: [{ guid: 'shared-guid', rev: 5 }] })
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 4, serverId: 'server-id-123',
			noteRevisions: { 'shared-guid': 4 }
		});

		const result = await sync();

		expect(result.uploaded).toBe(1);
		expect(result.downloaded).toBe(0);
	});

	it('deleted local note is excluded from server manifest via commitRevision', async () => {
		const localNote = makeNote({ guid: 'del-guid', deleted: true, localDirty: true });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ notes: [{ guid: 'del-guid', rev: 5 }] })
		);

		const result = await sync();

		expect(result.deleted).toBe(1);
		expect(dropboxClient.commitRevision).toHaveBeenCalledWith(
			expect.any(Number),
			[],
			['del-guid'],
			expect.anything()
		);
		expect(noteStore.purgeNote).toHaveBeenCalledWith('del-guid');
	});

	it('note deleted remotely and not locally dirty → purge local', async () => {
		const localNote = makeNote({ guid: 'gone-guid', localDirty: false });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ notes: [] }) // 'gone-guid' no longer on server
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 5, serverId: 'server-id-123',
			noteRevisions: { 'gone-guid': 5 } // we knew about it
		});

		const result = await sync();

		expect(result.deleted).toBe(1);
		expect(noteStore.purgeNote).toHaveBeenCalledWith('gone-guid');
	});

	it('sets localDirty = false after successful upload', async () => {
		const localNote = makeNote({ guid: 'dirty-guid', localDirty: true });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);

		await sync();

		expect(noteStore.putNoteSynced).toHaveBeenCalledWith(
			expect.objectContaining({ guid: 'dirty-guid', localDirty: false })
		);
	});

	it('returns error when offline', async () => {
		Object.defineProperty(navigator, 'onLine', { value: false });

		const result = await sync();

		expect(result.status).toBe('error');
		expect(result.errors).toContain('Offline');
	});

	it('returns error when not authenticated', async () => {
		vi.mocked(dropboxClient.isAuthenticated).mockReturnValue(false);

		const result = await sync();

		expect(result.status).toBe('error');
		expect(result.errors).toContain('Not authenticated');
	});

	it('manifest is updated with new revision after upload', async () => {
		const localNote = makeNote({ guid: 'rev-guid', localDirty: true });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ revision: 10, notes: [] })
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 10, serverId: 'server-id-123',
			noteRevisions: {}
		});

		await sync();

		const savedManifest = vi.mocked(manifest.saveManifest).mock.calls[0][0];
		expect(savedManifest.noteRevisions['rev-guid']).toBe(11); // newRev = 10 + 1
		expect(savedManifest.lastSyncRev).toBe(11);
	});

	it('initializes fresh server when manifest.xml does not exist', async () => {
		const localNote = makeNote({ guid: 'first-note', localDirty: false });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(null); // no manifest yet
		vi.mocked(dropboxClient.initServerManifest).mockResolvedValue({
			revision: 1, serverId: 'new-server', notes: [{ guid: 'first-note', rev: 1 }]
		});

		const result = await sync();

		expect(result.uploaded).toBe(1);
		expect(dropboxClient.initServerManifest).toHaveBeenCalled();
	});

	it('auto-merges when local and remote edited different regions', async () => {
		const base = '<note-content version="0.1">Test Note\nalpha\nbeta\ngamma\n</note-content>';
		const localXml = '<note-content version="0.1">Test Note\nALPHA\nbeta\ngamma\n</note-content>';
		const remoteXml = '<note-content version="0.1">Test Note\nalpha\nbeta\nGAMMA\n</note-content>';

		const localNote = makeNote({
			guid: 'merge-guid',
			xmlContent: localXml,
			syncedXmlContent: base,
			changeDate: '2024-05-01T00:00:00.0000000+00:00',
			localDirty: true
		});
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ revision: 5, notes: [{ guid: 'merge-guid', rev: 5 }] })
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 4, serverId: 'server-id-123',
			noteRevisions: { 'merge-guid': 4 }
		});
		vi.mocked(dropboxClient.downloadNoteAtRevision).mockResolvedValue(remoteXml);

		const result = await sync();

		expect(result.merged).toBe(1);
		expect(result.uploaded).toBe(1);
		expect(result.downloaded).toBe(0);
		// The merged note was queued for upload via commitRevision
		expect(dropboxClient.commitRevision).toHaveBeenCalled();
		// putNote is called with the merged xmlContent (both edits applied)
		const putNoteCalls = vi.mocked(noteStore.putNote).mock.calls;
		const mergedCall = putNoteCalls.find(([n]) => n.guid === 'merge-guid');
		expect(mergedCall).toBeDefined();
		expect(mergedCall?.[0].xmlContent).toContain('ALPHA');
		expect(mergedCall?.[0].xmlContent).toContain('GAMMA');
	});

	it('falls back to newer-date when merge would conflict', async () => {
		const base = '<note-content version="0.1">Test Note\nalpha\n</note-content>';
		const localXml = '<note-content version="0.1">Test Note\nLOCAL-CHANGE\n</note-content>';
		const remoteXml = '<note-content version="0.1">Test Note\nREMOTE-CHANGE\n</note-content>';

		const localNote = makeNote({
			guid: 'conflict-guid',
			xmlContent: localXml,
			syncedXmlContent: base,
			changeDate: '2024-05-01T00:00:00.0000000+00:00', // older than 2024-06-01 remote default
			localDirty: true
		});
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ revision: 5, notes: [{ guid: 'conflict-guid', rev: 5 }] })
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 4, serverId: 'server-id-123',
			noteRevisions: { 'conflict-guid': 4 }
		});
		vi.mocked(dropboxClient.downloadNoteAtRevision).mockResolvedValue(remoteXml);

		const result = await sync();

		expect(result.merged).toBe(0);
		expect(result.downloaded).toBe(1); // remote is newer → remote wins
	});

	it('skips merge when no baseline is stored (pre-feature note)', async () => {
		const localXml = '<note-content version="0.1">Test Note\nedited locally\n</note-content>';
		const remoteXml = '<note-content version="0.1">Test Note\nedited remotely\n</note-content>';

		const localNote = makeNote({
			guid: 'nobase-guid',
			xmlContent: localXml,
			// No syncedXmlContent — baseline missing
			changeDate: '2024-07-01T00:00:00.0000000+00:00', // newer than remote default
			localDirty: true
		});
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ revision: 5, notes: [{ guid: 'nobase-guid', rev: 5 }] })
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 4, serverId: 'server-id-123',
			noteRevisions: { 'nobase-guid': 4 }
		});
		vi.mocked(dropboxClient.downloadNoteAtRevision).mockResolvedValue(remoteXml);

		const result = await sync();

		expect(result.merged).toBe(0);
		// Local changeDate newer → upload wins
		expect(result.uploaded).toBe(1);
	});

	it('emits noteReload for downloaded notes so open editors refresh', async () => {
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ notes: [{ guid: 'remote-guid', rev: 5 }] })
		);
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([]);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 4, serverId: 'server-id-123',
			noteRevisions: {}
		});

		const reloadFired = vi.fn();
		subscribeNoteReload('remote-guid', reloadFired);

		await sync();

		expect(reloadFired).toHaveBeenCalledTimes(1);
	});

	it('emits noteReload for merged notes', async () => {
		const base = '<note-content version="0.1">Test Note\nalpha\nbeta\n</note-content>';
		const localXml = '<note-content version="0.1">Test Note\nALPHA\nbeta\n</note-content>';
		const remoteXml = '<note-content version="0.1">Test Note\nalpha\nBETA\n</note-content>';

		const localNote = makeNote({
			guid: 'merge-guid',
			xmlContent: localXml,
			syncedXmlContent: base,
			changeDate: '2024-05-01T00:00:00.0000000+00:00',
			localDirty: true
		});
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ revision: 5, notes: [{ guid: 'merge-guid', rev: 5 }] })
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 4, serverId: 'server-id-123',
			noteRevisions: { 'merge-guid': 4 }
		});
		vi.mocked(dropboxClient.downloadNoteAtRevision).mockResolvedValue(remoteXml);

		const reloadFired = vi.fn();
		subscribeNoteReload('merge-guid', reloadFired);

		const result = await sync();

		expect(result.merged).toBe(1);
		expect(reloadFired).toHaveBeenCalledTimes(1);
	});

	it('does NOT emit noteReload for pure upload-only syncs', async () => {
		const localNote = makeNote({ guid: 'upload-guid', localDirty: true });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ revision: 5, notes: [] })
		);

		const reloadFired = vi.fn();
		subscribeNoteReload('upload-guid', reloadFired);

		await sync();

		expect(reloadFired).not.toHaveBeenCalled();
	});

	it('no-op when already in sync', async () => {
		const localNote = makeNote({ guid: 'clean-guid', localDirty: false });
		vi.mocked(noteStore.getAllNotesIncludingDeleted).mockResolvedValue([localNote]);
		vi.mocked(dropboxClient.downloadServerManifest).mockResolvedValue(
			makeServerManifest({ notes: [{ guid: 'clean-guid', rev: 5 }] })
		);
		vi.mocked(manifest.getManifest).mockResolvedValue({
			id: 'manifest', lastSyncDate: '', lastSyncRev: 5, serverId: 'server-id-123',
			noteRevisions: { 'clean-guid': 5 } // already at latest rev
		});

		const result = await sync();

		expect(result.uploaded).toBe(0);
		expect(result.downloaded).toBe(0);
		expect(result.deleted).toBe(0);
		expect(dropboxClient.commitRevision).not.toHaveBeenCalled();
	});
});
