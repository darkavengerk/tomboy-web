import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
	getImageStorageToken,
	setImageStorageToken
} from '$lib/storage/appSettings.js';
import { deleteSetting } from '$lib/storage/appSettings.js';

describe('imageStorageToken', () => {
	beforeEach(async () => {
		await setImageStorageToken('');
	});

	it('returns empty string when unset', async () => {
		expect(await getImageStorageToken()).toBe('');
	});

	it('roundtrips a value', async () => {
		await setImageStorageToken('hunter2');
		expect(await getImageStorageToken()).toBe('hunter2');
	});

	it('empty string overwrites previously stored value', async () => {
		await setImageStorageToken('value');
		await setImageStorageToken('');
		expect(await getImageStorageToken()).toBe('');
	});

	it('returns empty string when key was never written', async () => {
		await deleteSetting('imageStorageToken');
		expect(await getImageStorageToken()).toBe('');
	});
});
