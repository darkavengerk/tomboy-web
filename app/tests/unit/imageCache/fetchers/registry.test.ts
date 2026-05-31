import { describe, it, expect, beforeEach } from 'vitest';
import {
	registerFetcher,
	unregisterFetcher,
	findFetcher,
	__resetForTest,
} from '../../../../src/lib/imageCache/fetchers/registry';
import type { ImageFetcher } from '../../../../src/lib/imageCache/fetchers/types';

function makeFetcher(name: string, predicate: (url: string) => boolean): ImageFetcher {
	return {
		name,
		matches: predicate,
		fetch: async () => new Blob([new Uint8Array(1)]),
	};
}

describe('fetcher registry', () => {
	beforeEach(() => __resetForTest());

	it('findFetcher returns null when nothing registered', () => {
		expect(findFetcher('https://example.com/x.png')).toBeNull();
	});

	it('register + findFetcher matching url', () => {
		const dropbox = makeFetcher('dropbox', (u) => u.includes('dropbox.com'));
		registerFetcher(dropbox);
		expect(findFetcher('https://www.dropbox.com/x.png')).toBe(dropbox);
		expect(findFetcher('https://example.com/x.png')).toBeNull();
	});

	it('first-match-wins on registration order', () => {
		const a = makeFetcher('a', () => true);
		const b = makeFetcher('b', () => true);
		registerFetcher(a);
		registerFetcher(b);
		expect(findFetcher('https://example.com/x.png')).toBe(a);
	});

	it('re-registering same name replaces existing', () => {
		const v1 = makeFetcher('dropbox', () => false);
		const v2 = makeFetcher('dropbox', () => true);
		registerFetcher(v1);
		registerFetcher(v2);
		expect(findFetcher('https://x/y.png')).toBe(v2);
	});

	it('unregisterFetcher removes by name', () => {
		const f = makeFetcher('dropbox', () => true);
		registerFetcher(f);
		unregisterFetcher('dropbox');
		expect(findFetcher('https://x/y.png')).toBeNull();
	});

	it('unregisterFetcher on missing name is no-op', () => {
		expect(() => unregisterFetcher('nope')).not.toThrow();
	});

	it('matches() throwing does not break the chain', () => {
		const broken: ImageFetcher = {
			name: 'broken',
			matches: () => {
				throw new Error('boom');
			},
			fetch: async () => new Blob(),
		};
		const good = makeFetcher('good', () => true);
		registerFetcher(broken);
		registerFetcher(good);
		expect(findFetcher('https://x/y.png')).toBe(good);
	});
});
