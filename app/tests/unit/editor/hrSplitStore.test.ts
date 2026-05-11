import { describe, it, expect, beforeEach } from 'vitest';
import { loadActiveOrdinals, saveActiveOrdinals } from '$lib/editor/hrSplit/hrSplitStore.js';

const GUID = 'aaaaaaaa-0000-0000-0000-000000000000';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000000';

describe('hrSplitStore', () => {
	beforeEach(() => {
		try {
			window.localStorage.clear();
		} catch {
			/* ignore */
		}
	});

	it('returns empty set for unknown guid', () => {
		expect(loadActiveOrdinals(GUID).size).toBe(0);
	});

	it('round-trips ordinals', () => {
		saveActiveOrdinals(GUID, new Set([0, 3, 7]));
		const loaded = loadActiveOrdinals(GUID);
		expect(Array.from(loaded).sort((a, b) => a - b)).toEqual([0, 3, 7]);
	});

	it('saves are scoped per guid', () => {
		saveActiveOrdinals(GUID, new Set([1, 2]));
		saveActiveOrdinals(OTHER, new Set([5]));
		expect(Array.from(loadActiveOrdinals(GUID)).sort()).toEqual([1, 2]);
		expect(Array.from(loadActiveOrdinals(OTHER))).toEqual([5]);
	});

	it('empty set removes the storage entry', () => {
		saveActiveOrdinals(GUID, new Set([0]));
		saveActiveOrdinals(GUID, new Set());
		expect(loadActiveOrdinals(GUID).size).toBe(0);
		expect(window.localStorage.getItem('tomboy.hrSplit.' + GUID)).toBeNull();
	});

	it('null guid is a no-op', () => {
		// Should not throw.
		saveActiveOrdinals(null, new Set([1]));
		expect(loadActiveOrdinals(null).size).toBe(0);
	});

	it('rejects malformed stored values', () => {
		window.localStorage.setItem('tomboy.hrSplit.' + GUID, 'not json');
		expect(loadActiveOrdinals(GUID).size).toBe(0);

		window.localStorage.setItem('tomboy.hrSplit.' + GUID, JSON.stringify({ foo: 1 }));
		expect(loadActiveOrdinals(GUID).size).toBe(0);

		window.localStorage.setItem(
			'tomboy.hrSplit.' + GUID,
			JSON.stringify([0, 'x', -1, 1.5, 2])
		);
		expect(Array.from(loadActiveOrdinals(GUID)).sort((a, b) => a - b)).toEqual([0, 2]);
	});
});
