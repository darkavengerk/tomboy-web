/**
 * Admin-layer operations built on top of dropboxClient + syncManager.
 * Used by the /admin pages for revision history, diffs, rollback, etc.
 */

import { parseNoteFromFile } from '$lib/core/noteArchiver.js';
import type { NoteData } from '$lib/core/note.js';
import { purgeAllLocal } from '$lib/storage/noteStore.js';
import { clearManifest } from './manifest.js';
import { invalidateCache } from '$lib/stores/noteListCache.js';
import { refreshNotebooksCache } from '$lib/core/notebooks.js';
import {
	downloadRevisionManifest,
	downloadNoteAtRevision,
	softRollbackToRevision,
	listFolder,
	downloadFileText,
	notesRootPath,
	type TomboyServerManifest,
	type FolderEntry
} from './dropboxClient.js';
import { sync, type SyncResult } from './syncManager.js';

export type { FolderEntry };

export interface RevisionChangeSet {
	added: Array<{ guid: string; rev: number }>;
	removed: Array<{ guid: string; rev: number }>;
	/** Notes whose rev number changed — same guid, different rev between prev and this manifest */
	modified: Array<{ guid: string; prevRev: number; rev: number }>;
}

/** Diff two manifests' note lists. `prev` may be null (for rev 1). */
export function diffManifests(
	prev: TomboyServerManifest | null,
	next: TomboyServerManifest
): RevisionChangeSet {
	const prevMap = new Map<string, number>();
	if (prev) for (const n of prev.notes) prevMap.set(n.guid, n.rev);
	const nextMap = new Map<string, number>();
	for (const n of next.notes) nextMap.set(n.guid, n.rev);

	const added: RevisionChangeSet['added'] = [];
	const removed: RevisionChangeSet['removed'] = [];
	const modified: RevisionChangeSet['modified'] = [];

	for (const [guid, rev] of nextMap) {
		const p = prevMap.get(guid);
		if (p === undefined) added.push({ guid, rev });
		else if (p !== rev) modified.push({ guid, prevRev: p, rev });
	}
	for (const [guid, rev] of prevMap) {
		if (!nextMap.has(guid)) removed.push({ guid, rev });
	}

	added.sort((a, b) => a.guid.localeCompare(b.guid));
	removed.sort((a, b) => a.guid.localeCompare(b.guid));
	modified.sort((a, b) => a.guid.localeCompare(b.guid));
	return { added, removed, modified };
}

/**
 * Download and parse a note at a specific revision. Returns null on 404.
 */
export async function fetchNoteAtRevision(guid: string, rev: number): Promise<NoteData | null> {
	try {
		const xml = await downloadNoteAtRevision(guid, rev);
		return parseNoteFromFile(xml, `${guid}.note`);
	} catch (err: unknown) {
		const e = err as { status?: number };
		if (e.status === 409) return null;
		throw err;
	}
}

/**
 * Perform a soft rollback on the server, then reset the local state so the
 * next sync downloads the rolled-back notes. Returns the new committed rev
 * and the sync result from the subsequent re-download.
 */
export async function rollbackAndResync(
	targetRev: number
): Promise<{ newRev: number; syncResult: SyncResult }> {
	const newRev = await softRollbackToRevision(targetRev);

	// Reset local state so the next sync re-downloads against the new
	// (rolled-back) server manifest. Without this, computePlan would see
	// `serverRev <= localKnownRev` for rolled-back notes and skip them.
	await purgeAllLocal();
	await clearManifest();

	const syncResult = await sync();
	invalidateCache();
	try { await refreshNotebooksCache(); } catch { /* non-fatal */ }

	return { newRev, syncResult };
}

export { downloadRevisionManifest, listFolder, downloadFileText, notesRootPath };
