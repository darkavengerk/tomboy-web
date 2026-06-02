import { describe, it, expect, beforeEach } from 'vitest';
import {
	loadFoldedOrdinals,
	saveFoldedOrdinals
} from '$lib/editor/hrSplit/hrFoldStore.js';

const GUID = 'aaaaaaaa-0000-0000-0000-000000000000';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000000';

describe('hrFoldStore', () => {
	beforeEach(() => {
		try {
			window.localStorage.clear();
		} catch {
			/* ignore */
		}
	});

	it('returns empty set for unknown guid', () => {
		expect(loadFoldedOrdinals(GUID).size).toBe(0);
	});

	it('round-trips ordinals', () => {
		saveFoldedOrdinals(GUID, new Set([0, 3, 7]));
		const loaded = loadFoldedOrdinals(GUID);
		expect(Array.from(loaded).sort((a, b) => a - b)).toEqual([0, 3, 7]);
	});

	it('saves are scoped per guid', () => {
		saveFoldedOrdinals(GUID, new Set([1, 2]));
		saveFoldedOrdinals(OTHER, new Set([5]));
		expect(Array.from(loadFoldedOrdinals(GUID)).sort()).toEqual([1, 2]);
		expect(Array.from(loadFoldedOrdinals(OTHER))).toEqual([5]);
	});

	it('empty set removes the storage entry', () => {
		saveFoldedOrdinals(GUID, new Set([0]));
		saveFoldedOrdinals(GUID, new Set());
		expect(loadFoldedOrdinals(GUID).size).toBe(0);
		expect(window.localStorage.getItem('tomboy.hrFold.' + GUID)).toBeNull();
	});

	it('null guid is a no-op', () => {
		saveFoldedOrdinals(null, new Set([1]));
		expect(loadFoldedOrdinals(null).size).toBe(0);
	});

	it('does not collide with hrSplit storage keys', () => {
		saveFoldedOrdinals(GUID, new Set([4]));
		expect(window.localStorage.getItem('tomboy.hrSplit.' + GUID)).toBeNull();
		expect(window.localStorage.getItem('tomboy.hrFold.' + GUID)).not.toBeNull();
	});

	it('ignores malformed stored JSON', () => {
		window.localStorage.setItem('tomboy.hrFold.' + GUID, 'not json');
		expect(loadFoldedOrdinals(GUID).size).toBe(0);
	});

	it('filters non-integer / negative entries', () => {
		window.localStorage.setItem(
			'tomboy.hrFold.' + GUID,
			JSON.stringify([0, -1, 1.5, 'x', 2])
		);
		expect(Array.from(loadFoldedOrdinals(GUID)).sort()).toEqual([0, 2]);
	});
});
