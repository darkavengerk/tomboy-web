import type { ImageFetcher } from './types.js';

const fetchers: ImageFetcher[] = [];

/** Register a fetcher. First-match-wins ordering follows registration order. */
export function registerFetcher(f: ImageFetcher): void {
	const existing = fetchers.findIndex((x) => x.name === f.name);
	if (existing >= 0) fetchers[existing] = f;
	else fetchers.push(f);
}

/** Remove a fetcher by name. No-op if not registered. */
export function unregisterFetcher(name: string): void {
	const i = fetchers.findIndex((x) => x.name === name);
	if (i >= 0) fetchers.splice(i, 1);
}

/** First registered fetcher whose `matches(url)` returns true, or null. */
export function findFetcher(url: string): ImageFetcher | null {
	for (const f of fetchers) {
		try {
			if (f.matches(url)) return f;
		} catch {
			// Buggy matches() shouldn't kill the lookup chain.
		}
	}
	return null;
}

export function __resetForTest(): void {
	fetchers.length = 0;
}
