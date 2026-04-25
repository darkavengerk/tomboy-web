import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { getOrCreateInstallId } from '$lib/schedule/installId.js';
import { _resetDBForTest } from '$lib/storage/db.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
});

describe('getOrCreateInstallId', () => {
	it('generates a UUID-like id on first call', async () => {
		const id = await getOrCreateInstallId();
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		);
	});

	it('returns the same id on subsequent calls', async () => {
		const a = await getOrCreateInstallId();
		const b = await getOrCreateInstallId();
		expect(a).toBe(b);
	});
});
