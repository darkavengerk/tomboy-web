import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import {
	setScheduleNote,
	getScheduleNoteGuid,
	clearScheduleNote,
	_resetScheduleCacheForTest
} from '$lib/core/schedule.js';
import { _resetDBForTest } from '$lib/storage/db.js';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	_resetScheduleCacheForTest();
});

describe('schedule note pointer', () => {
	it('setScheduleNote stores guid in appSettings', async () => {
		await setScheduleNote('abc');
		expect(await getScheduleNoteGuid()).toBe('abc');
	});

	it('getScheduleNoteGuid is undefined when never set', async () => {
		expect(await getScheduleNoteGuid()).toBeUndefined();
	});

	it('clearScheduleNote removes the setting', async () => {
		await setScheduleNote('abc');
		await clearScheduleNote();
		expect(await getScheduleNoteGuid()).toBeUndefined();
	});

	it('cache stays consistent across set/get', async () => {
		await setScheduleNote('xyz');
		// Two consecutive reads should both return the same value (in-memory cache)
		expect(await getScheduleNoteGuid()).toBe('xyz');
		expect(await getScheduleNoteGuid()).toBe('xyz');
	});
});
