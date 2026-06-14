import { describe, it, expect } from 'vitest';
import { shouldRescanForDelta } from '$lib/editor/autoLink/shouldRescanForDelta.js';

const E = { added: [], removed: [] };

describe('shouldRescanForDelta', () => {
	it('removed → always rescan', () =>
		expect(shouldRescanForDelta({ ...E, removed: [{ title: 'X', guid: 'g' }] }, 'no')).toBe(true));
	it('added present → rescan', () =>
		expect(shouldRescanForDelta({ ...E, added: [{ title: 'Foo', guid: 'g' }] }, 'see Foo')).toBe(
			true
		));
	it('added absent → skip', () =>
		expect(shouldRescanForDelta({ ...E, added: [{ title: 'Foo', guid: 'g' }] }, 'nope')).toBe(
			false
		));
	it('empty → skip', () => expect(shouldRescanForDelta(E, 'anything')).toBe(false));
	it('undefined delta → conservative rescan', () =>
		expect(shouldRescanForDelta(undefined, 'anything')).toBe(true));
});
