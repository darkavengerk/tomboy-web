import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NoteData } from '$lib/core/note.js';
import type { TomboyServerManifest } from '$lib/sync/dropboxClient.js';

vi.mock('$lib/sync/dropboxClient.js', () => ({
	isAuthenticated: vi.fn(() => true),
	downloadServerManifest: vi.fn(),
	downloadNoteAtRevision: vi.fn(),
	commitRevision: vi.fn(),
	initServerManifest: vi.fn()
}));

vi.mock('$lib/storage/noteStore.js', () => ({
	getAllNotesIncludingDeleted: vi.fn(async () => []),
	putNoteSynced: vi.fn(async () => undefined),
	purgeNote: vi.fn(async () => undefined)
}));

vi.mock('$lib/sync/manifest.js', () => ({
	getManifest: vi.fn(),
	saveManifest: vi.fn(async () => undefined),
	clearManifest: vi.fn(async () => undefined)
}));

vi.mock('$lib/core/noteArchiver.js', () => ({
	parseNoteFromFile: vi.fn((content: string, filename: string) => {
		const guid = filename.replace(/\.note$/, '');
		return {
			uri: `note://tomboy/${guid}`,
			guid,
			title: `Server ${guid}`,
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
		} as NoteData;
	}),
	serializeNote: vi.fn(() => '<note>xml</note>'),
	filenameFromGuid: vi.fn((guid: string) => `${guid}.note`)
}));

vi.mock('$lib/stores/noteListCache.js', () => ({
	invalidateCache: vi.fn()
}));

vi.mock('$lib/core/notebooks.js', () => ({
	refreshNotebooksCache: vi.fn(async () => undefined)
}));

import { revertNoteToServer, _resetForTest } from '$lib/sync/syncManager.js';
import * as dropboxClient from '$lib/sync/dropboxClient.js';
import * as noteStore from '$lib/storage/noteStore.js';
import * as manifest from '$lib/sync/manifest.js';
import { invalidateCache } from '$lib/stores/noteListCache.js';

beforeEach(() => {
	_resetForTest();
	vi.clearAllMocks();
});

function serverManifest(notes: { guid: string; rev: number }[]): TomboyServerManifest {
	return { revision: 10, serverId: 'server-1', notes };
}

describe('revertNoteToServer', () => {
	it('downloads the note at its current server revision and overwrites local', async () => {
		(manifest.getManifest as any).mockResolvedValue({
			id: 'manifest',
			lastSyncDate: '',
			lastSyncRev: 5,
			serverId: 'server-1',
			noteRevisions: { abc: 2 }
		});
		(dropboxClient.downloadServerManifest as any).mockResolvedValue(
			serverManifest([{ guid: 'abc', rev: 7 }])
		);
		(dropboxClient.downloadNoteAtRevision as any).mockResolvedValue(
			'<note>remote-content</note>'
		);

		const res = await revertNoteToServer('abc');

		expect(res.status).toBe('success');
		expect(dropboxClient.downloadNoteAtRevision).toHaveBeenCalledWith('abc', 7);
		expect(noteStore.putNoteSynced).toHaveBeenCalledTimes(1);
		const saved = (noteStore.putNoteSynced as any).mock.calls[0][0] as NoteData;
		expect(saved.guid).toBe('abc');
		expect(saved.localDirty).toBe(false);
		expect(saved.deleted).toBe(false);

		// Manifest should record the new revision.
		const savedManifest = (manifest.saveManifest as any).mock.calls.at(-1)[0];
		expect(savedManifest.noteRevisions.abc).toBe(7);

		expect(invalidateCache).toHaveBeenCalled();
	});

	it('returns error when the guid is not on the server (note to be uploaded = new)', async () => {
		(manifest.getManifest as any).mockResolvedValue({
			id: 'manifest',
			lastSyncDate: '',
			lastSyncRev: 5,
			serverId: 'server-1',
			noteRevisions: {}
		});
		(dropboxClient.downloadServerManifest as any).mockResolvedValue(
			serverManifest([]) // 'abc' not on server
		);

		const res = await revertNoteToServer('abc');
		expect(res.status).toBe('error');
		expect(res.message).toMatch(/없|not/i);
		expect(noteStore.putNoteSynced).not.toHaveBeenCalled();
	});

	it('returns error when server manifest cannot be loaded', async () => {
		(manifest.getManifest as any).mockResolvedValue({
			id: 'manifest',
			lastSyncDate: '',
			lastSyncRev: 5,
			serverId: 'server-1',
			noteRevisions: {}
		});
		(dropboxClient.downloadServerManifest as any).mockResolvedValue(null);

		const res = await revertNoteToServer('abc');
		expect(res.status).toBe('error');
	});

	it('returns error when not authenticated', async () => {
		(dropboxClient.isAuthenticated as any).mockReturnValueOnce(false);
		const res = await revertNoteToServer('abc');
		expect(res.status).toBe('error');
	});

	it('propagates download errors', async () => {
		(manifest.getManifest as any).mockResolvedValue({
			id: 'manifest',
			lastSyncDate: '',
			lastSyncRev: 5,
			serverId: 'server-1',
			noteRevisions: { abc: 2 }
		});
		(dropboxClient.downloadServerManifest as any).mockResolvedValue(
			serverManifest([{ guid: 'abc', rev: 7 }])
		);
		(dropboxClient.downloadNoteAtRevision as any).mockRejectedValue(new Error('network'));

		const res = await revertNoteToServer('abc');
		expect(res.status).toBe('error');
		expect(res.message).toMatch(/network/);
		expect(noteStore.putNoteSynced).not.toHaveBeenCalled();
	});
});
