import { describe, it, expect, beforeEach } from 'vitest';
import { setDbMode, getDbName, _resetDBForTest } from '$lib/storage/db.js';

describe('getDbName', () => {
	beforeEach(() => {
		_resetDBForTest();
	});

	it('defaults to tomboy-web', () => {
		expect(getDbName()).toBe('tomboy-web');
	});

	it('switches to tomboy-web-guest in guest mode', () => {
		setDbMode('guest');
		expect(getDbName()).toBe('tomboy-web-guest');
	});

	it('switches back to tomboy-web in host mode', () => {
		setDbMode('guest');
		setDbMode('host');
		expect(getDbName()).toBe('tomboy-web');
	});
});
