/**
 * Cross-page cache for the /admin section.
 *
 * The admin pages share a lot of data (root/local manifest, per-revision
 * manifests) and fetching it is slow, so we hold it here at module scope
 * and only refetch on explicit refresh. This lets the user switch between
 * admin tabs without re-running big Dropbox traversals.
 *
 * Reactivity: Svelte 5 `$state` in a `.svelte.ts` module. We copy-on-write
 * the Map because Map mutations aren't tracked by $state proxies.
 */

import {
	downloadServerManifest,
	downloadRevisionManifest,
	type TomboyServerManifest
} from '$lib/sync/dropboxClient';
import { getManifest, type SyncManifest } from '$lib/sync/manifest';
import {
	scanDuplicateTitles,
	type DuplicateTitleGroup
} from '$lib/core/titleInvariantCheck';

export const ADMIN_PAGE_SIZE = 10;

interface AdminCacheState {
	initialized: boolean;
	loading: boolean;
	error: string;
	rootManifest: TomboyServerManifest | null;
	localManifest: SyncManifest | null;
	/** All rev manifests we've seen so far. null value = confirmed 404 on server. */
	manifestsByRev: Map<number, TomboyServerManifest | null>;
	/** Rev numbers shown in the revisions list, ordered descending. */
	displayedRevs: number[];
	/** Next rev to attempt loading into `displayedRevs` (one below the lowest loaded). */
	nextRevToLoad: number | null;
	hasMore: boolean;
	/** Groups of local notes sharing the same trimmed, case-sensitive title. */
	duplicateTitles: DuplicateTitleGroup[];
}

export const adminCache = $state<AdminCacheState>({
	initialized: false,
	loading: false,
	error: '',
	rootManifest: null,
	localManifest: null,
	manifestsByRev: new Map(),
	displayedRevs: [],
	nextRevToLoad: null,
	hasMore: false,
	duplicateTitles: []
});

/**
 * Load root manifest + local manifest + first page of revisions.
 * No-op if already initialized. Pass `forceRefresh` to reset and reload.
 */
export async function initAdminCache(forceRefresh = false): Promise<void> {
	if (adminCache.loading) return;
	if (adminCache.initialized && !forceRefresh) return;

	if (forceRefresh) resetAdminCache();

	adminCache.loading = true;
	adminCache.error = '';
	try {
		const [root, local, duplicates] = await Promise.all([
			downloadServerManifest(),
			getManifest(),
			scanDuplicateTitles()
		]);
		adminCache.rootManifest = root;
		adminCache.localManifest = local;
		adminCache.duplicateTitles = duplicates;

		// Seed the per-rev cache with the root manifest at its own rev.
		if (root) {
			const newMap = new Map(adminCache.manifestsByRev);
			newMap.set(root.revision, root);
			adminCache.manifestsByRev = newMap;
		}

		adminCache.nextRevToLoad = root?.revision ?? null;
		adminCache.hasMore = adminCache.nextRevToLoad !== null && adminCache.nextRevToLoad >= 1;
		adminCache.initialized = true;

		if (adminCache.displayedRevs.length === 0 && adminCache.hasMore) {
			// Call the internal fetch directly — we're already inside the
			// outer `loading=true` critical section, so the public wrapper
			// would short-circuit on its guard.
			await fetchMoreRevsInternal(ADMIN_PAGE_SIZE);
		}
	} catch (e) {
		adminCache.error = String(e);
	} finally {
		adminCache.loading = false;
	}
}

/**
 * Fetch the next `count` revs into `manifestsByRev` and `displayedRevs`.
 * No loading-flag management — caller is responsible.
 */
async function fetchMoreRevsInternal(count: number): Promise<void> {
	if (adminCache.nextRevToLoad === null || adminCache.nextRevToLoad < 1) {
		adminCache.hasMore = false;
		return;
	}
	const toLoad: number[] = [];
	let rev = adminCache.nextRevToLoad;
	while (toLoad.length < count && rev >= 1) {
		toLoad.push(rev);
		rev--;
	}

	const results = await Promise.all(
		toLoad.map(async (r) => {
			if (adminCache.manifestsByRev.has(r)) {
				return { rev: r, manifest: adminCache.manifestsByRev.get(r) ?? null };
			}
			const m = await downloadRevisionManifest(r).catch(() => null);
			return { rev: r, manifest: m };
		})
	);

	const newMap = new Map(adminCache.manifestsByRev);
	for (const { rev: r, manifest } of results) newMap.set(r, manifest);
	adminCache.manifestsByRev = newMap;

	const existing = new Set(adminCache.displayedRevs);
	const added = results.map((r) => r.rev).filter((r) => !existing.has(r));
	adminCache.displayedRevs = [...adminCache.displayedRevs, ...added];

	adminCache.nextRevToLoad = rev >= 1 ? rev : null;
	adminCache.hasMore = adminCache.nextRevToLoad !== null;
}

/**
 * Extend the displayed rev list by `count` entries, fetching manifests in
 * parallel. Uses the per-rev cache when possible. Public entry point used
 * by "load more" buttons; guards against concurrent runs.
 */
export async function loadMoreRevs(count = ADMIN_PAGE_SIZE): Promise<void> {
	if (adminCache.loading) return;
	if (adminCache.nextRevToLoad === null || adminCache.nextRevToLoad < 1) {
		adminCache.hasMore = false;
		return;
	}
	adminCache.loading = true;
	try {
		await fetchMoreRevsInternal(count);
	} finally {
		adminCache.loading = false;
	}
}

/**
 * Ensure a specific rev is in the cache without affecting the paginated
 * displayed list. Used by the rev-detail page when the user navigates
 * directly to a rev URL.
 */
export async function ensureRevLoaded(rev: number): Promise<TomboyServerManifest | null> {
	if (adminCache.manifestsByRev.has(rev)) {
		return adminCache.manifestsByRev.get(rev) ?? null;
	}
	const m = await downloadRevisionManifest(rev).catch(() => null);
	const newMap = new Map(adminCache.manifestsByRev);
	newMap.set(rev, m);
	adminCache.manifestsByRev = newMap;
	return m;
}

export function resetAdminCache(): void {
	adminCache.initialized = false;
	adminCache.rootManifest = null;
	adminCache.localManifest = null;
	adminCache.manifestsByRev = new Map();
	adminCache.displayedRevs = [];
	adminCache.nextRevToLoad = null;
	adminCache.hasMore = false;
	adminCache.error = '';
	adminCache.duplicateTitles = [];
}
