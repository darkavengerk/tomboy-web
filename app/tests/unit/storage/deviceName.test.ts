import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { getDeviceName, setDeviceName } from '$lib/storage/appSettings.js';

describe('deviceName setting', () => {
	it('defaults to empty and round-trips trimmed', async () => {
		expect(await getDeviceName()).toBe('');
		await setDeviceName('  내 노트북  ');
		expect(await getDeviceName()).toBe('내 노트북');
	});
});
