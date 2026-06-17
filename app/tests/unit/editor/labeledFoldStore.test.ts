import { describe, it, expect, beforeEach } from 'vitest';
import {
	loadFocusedOrdinals,
	saveFocusedOrdinals
} from '$lib/editor/labeledDivider/labeledFoldStore.js';

const GUID = 'aaaaaaaa-0000-0000-0000-000000000000';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000000';

describe('labeledFoldStore', () => {
	beforeEach(() => {
		try {
			window.localStorage.clear();
		} catch {
			/* ignore */
		}
	});

	it('returns empty set for unknown guid', () => {
		expect(loadFocusedOrdinals(GUID).size).toBe(0);
	});

	it('round-trips ordinals', () => {
		saveFocusedOrdinals(GUID, new Set([0, 2]));
		expect(Array.from(loadFocusedOrdinals(GUID)).sort((a, b) => a - b)).toEqual([
			0, 2
		]);
	});

	it('is scoped per guid', () => {
		saveFocusedOrdinals(GUID, new Set([1]));
		expect(loadFocusedOrdinals(OTHER).size).toBe(0);
	});

	it('empty set removes the key', () => {
		saveFocusedOrdinals(GUID, new Set([1]));
		saveFocusedOrdinals(GUID, new Set());
		expect(loadFocusedOrdinals(GUID).size).toBe(0);
	});

	it('null guid is a no-op / empty', () => {
		expect(loadFocusedOrdinals(null).size).toBe(0);
		expect(() => saveFocusedOrdinals(null, new Set([1]))).not.toThrow();
	});

	it('corrupt JSON returns empty set', () => {
		window.localStorage.setItem('tomboy.labeledFold.' + GUID, '{not json');
		expect(loadFocusedOrdinals(GUID).size).toBe(0);
	});
});
