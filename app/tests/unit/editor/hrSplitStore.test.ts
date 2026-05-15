import { describe, it, expect, beforeEach } from 'vitest';
import {
	loadActiveOrdinals,
	saveActiveOrdinals,
	loadColumnWidths,
	saveColumnWidths
} from '$lib/editor/hrSplit/hrSplitStore.js';

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

	describe('column widths', () => {
		it('returns null for unknown guid', () => {
			expect(loadColumnWidths(GUID)).toBeNull();
		});

		it('round-trips a non-trivial ratio', () => {
			saveColumnWidths(GUID, [2, 1]);
			expect(loadColumnWidths(GUID)).toEqual([2, 1]);
		});

		it('does not persist equal widths (would round-trip to default)', () => {
			saveColumnWidths(GUID, [1, 1]);
			expect(loadColumnWidths(GUID)).toBeNull();
		});

		it('clears the entry when widths become equal again', () => {
			saveColumnWidths(GUID, [2, 1]);
			saveColumnWidths(GUID, [1, 1]);
			expect(loadColumnWidths(GUID)).toBeNull();
			expect(
				window.localStorage.getItem('tomboy.hrSplit.widths.' + GUID)
			).toBeNull();
		});

		it('scopes widths per guid', () => {
			saveColumnWidths(GUID, [2, 1]);
			saveColumnWidths(OTHER, [1, 2, 1]);
			expect(loadColumnWidths(GUID)).toEqual([2, 1]);
			expect(loadColumnWidths(OTHER)).toEqual([1, 2, 1]);
		});

		it('rejects malformed stored values', () => {
			window.localStorage.setItem(
				'tomboy.hrSplit.widths.' + GUID,
				'not json'
			);
			expect(loadColumnWidths(GUID)).toBeNull();

			window.localStorage.setItem(
				'tomboy.hrSplit.widths.' + GUID,
				JSON.stringify({ a: 1 })
			);
			expect(loadColumnWidths(GUID)).toBeNull();

			window.localStorage.setItem(
				'tomboy.hrSplit.widths.' + GUID,
				JSON.stringify([1])
			);
			expect(loadColumnWidths(GUID)).toBeNull();

			window.localStorage.setItem(
				'tomboy.hrSplit.widths.' + GUID,
				JSON.stringify([1, -1])
			);
			expect(loadColumnWidths(GUID)).toBeNull();
		});

		it('does not write under a null guid', () => {
			saveColumnWidths(null, [2, 1]);
			expect(loadColumnWidths(null)).toBeNull();
		});

		it('save scope is independent from active ordinals', () => {
			saveActiveOrdinals(GUID, new Set([0]));
			saveColumnWidths(GUID, [3, 1]);
			expect(Array.from(loadActiveOrdinals(GUID))).toEqual([0]);
			expect(loadColumnWidths(GUID)).toEqual([3, 1]);
			// Clearing the active set does not clobber the widths key (and
			// vice-versa).
			saveActiveOrdinals(GUID, new Set());
			expect(loadColumnWidths(GUID)).toEqual([3, 1]);
		});
	});
});
