import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	_resetForTest,
	getCachedNotes,
	setCachedNotes,
	getCachedScrollTop,
	setCachedScrollTop,
	invalidateCache,
	onInvalidate
} from '$lib/stores/noteListCache.js';
import type { NoteData } from '$lib/core/note.js';

const stub = (guid: string) => ({ guid } as NoteData);

beforeEach(() => {
	_resetForTest();
});

describe('noteListCache', () => {
	it('starts empty', () => {
		expect(getCachedNotes()).toBeNull();
		expect(getCachedScrollTop()).toBe(0);
	});

	it('setCache(notes) stores value retrievable synchronously', () => {
		setCachedNotes([stub('a'), stub('b')]);
		expect(getCachedNotes()).toHaveLength(2);
	});

	it('invalidate() clears notes but keeps scrollTop', () => {
		setCachedNotes([stub('a')]);
		setCachedScrollTop(123);
		invalidateCache();
		expect(getCachedNotes()).toBeNull();
		expect(getCachedScrollTop()).toBe(123);
	});

	it('setScrollTop(n) / getScrollTop() roundtrip', () => {
		setCachedScrollTop(456);
		expect(getCachedScrollTop()).toBe(456);
	});

	it('onInvalidate listener fires once per invalidation', () => {
		const cb = vi.fn();
		const off = onInvalidate(cb);
		invalidateCache();
		invalidateCache();
		expect(cb).toHaveBeenCalledTimes(2);
		off();
		invalidateCache();
		expect(cb).toHaveBeenCalledTimes(2); // no more after unsubscribe
	});
});
