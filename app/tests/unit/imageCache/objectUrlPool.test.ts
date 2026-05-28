import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	peek,
	getOrCreate,
	revoke,
	revokeAll,
	__resetForTest
} from '../../../src/lib/imageCache/objectUrlPool';

describe('objectUrlPool', () => {
	let createSpy: ReturnType<typeof vi.spyOn>;
	let revokeSpy: ReturnType<typeof vi.spyOn>;
	let counter = 0;

	beforeEach(() => {
		vi.restoreAllMocks();
		__resetForTest();
		counter = 0;
		createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:fake-${++counter}`);
		revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
	});

	it('peek on missing url returns null', () => {
		expect(peek('https://a/x.png')).toBeNull();
	});

	it('getOrCreate returns ObjectURL and registers it', () => {
		const blob = new Blob(['x'], { type: 'image/png' });
		const url = getOrCreate('https://a/x.png', blob);
		expect(url).toBe('blob:fake-1');
		expect(peek('https://a/x.png')).toBe('blob:fake-1');
		expect(createSpy).toHaveBeenCalledTimes(1);
	});

	it('getOrCreate twice for same url → same ObjectURL, single create', () => {
		const blob = new Blob(['x']);
		const a = getOrCreate('https://a/x.png', blob);
		const b = getOrCreate('https://a/x.png', blob);
		expect(a).toBe(b);
		expect(createSpy).toHaveBeenCalledTimes(1);
	});

	it('revoke removes from pool and calls revokeObjectURL', () => {
		const blob = new Blob(['x']);
		const u = getOrCreate('https://a/x.png', blob);
		revoke('https://a/x.png');
		expect(peek('https://a/x.png')).toBeNull();
		expect(revokeSpy).toHaveBeenCalledWith(u);
	});

	it('revoke on missing url is a no-op', () => {
		revoke('https://nope/x.png');
		expect(revokeSpy).not.toHaveBeenCalled();
	});

	it('revokeAll clears pool and revokes each', () => {
		getOrCreate('https://a/1.png', new Blob(['x']));
		getOrCreate('https://a/2.png', new Blob(['y']));
		revokeAll();
		expect(peek('https://a/1.png')).toBeNull();
		expect(peek('https://a/2.png')).toBeNull();
		expect(revokeSpy).toHaveBeenCalledTimes(2);
	});
});
