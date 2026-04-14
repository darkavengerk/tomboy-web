import { describe, it, expect, vi, beforeEach } from 'vitest';
import { removeNoteRevision } from '$lib/sync/manifest.js';

vi.mock('$lib/sync/manifest.js', async (importOriginal) => {
	// We test removeNoteRevision by mocking getManifest/saveManifest internally
	const actual = await importOriginal<typeof import('$lib/sync/manifest.js')>();
	return actual;
});

// Single mock of `$lib/storage/db.js` — previously there were two
// `vi.mock(...)` calls for the same path and vitest's hoisting picked
// one non-deterministically, which made the test flaky depending on
// which other test files ran in the same worker.
vi.mock('$lib/storage/db.js', () => {
	let stored: Record<string, unknown> = {};
	const fakeDb = {
		get: vi.fn(async (_store: string, key: string) => stored[key]),
		put: vi.fn(async (_store: string, val: unknown) => {
			stored[(val as any).id] = val;
		}),
		delete: vi.fn(async (_store: string, key: string) => {
			delete stored[key];
		})
	};
	return {
		getDB: vi.fn(async () => fakeDb),
		_fakeDb: fakeDb,
		_reset: () => {
			stored = {};
		}
	};
});

import * as dbMod from '$lib/storage/db.js';

beforeEach(() => {
	(dbMod as any)._reset();
});

describe('removeNoteRevision', () => {
	it('markNoteForRedownload(guid) deletes that guid from manifest.noteRevisions', async () => {
		// Setup manifest with a revision for 'abc'
		const db = await (dbMod.getDB as any)();
		await db.put('syncManifest', {
			id: 'manifest',
			lastSyncDate: '',
			lastSyncRev: 5,
			serverId: 'srv',
			noteRevisions: { abc: 3, def: 4 }
		});

		await removeNoteRevision('abc');

		const manifest = await db.get('syncManifest', 'manifest');
		expect(manifest.noteRevisions).not.toHaveProperty('abc');
		expect(manifest.noteRevisions).toHaveProperty('def');
	});

	it('is a no-op when guid not in manifest', async () => {
		const db = await (dbMod.getDB as any)();
		await db.put('syncManifest', {
			id: 'manifest',
			lastSyncDate: '',
			lastSyncRev: 5,
			serverId: 'srv',
			noteRevisions: { def: 4 }
		});

		await removeNoteRevision('nonexistent');

		const manifest = await db.get('syncManifest', 'manifest');
		expect(manifest.noteRevisions).toEqual({ def: 4 });
	});
});
