/**
 * Client-side sync manifest — tracks the last known sync state.
 * Stored in IndexedDB (syncManifest object store).
 *
 * Mirrors the Tomboy client manifest format:
 *   ~/.local/share/tomboy/manifest.xml
 */

import { getDB } from '$lib/storage/db.js';

export interface SyncManifest {
	id: string;            // always 'manifest' (singleton)
	lastSyncDate: string;
	lastSyncRev: number;   // last server revision number (-1 = never synced)
	serverId: string;      // server's unique ID — if it changes, reset sync state
	/** guid → server revision number at which we last synced this note */
	noteRevisions: Record<string, number>;
}

const MANIFEST_ID = 'manifest';

function defaultManifest(): SyncManifest {
	return {
		id: MANIFEST_ID,
		lastSyncDate: '',
		lastSyncRev: -1,
		serverId: '',
		noteRevisions: {}
	};
}

export async function getManifest(): Promise<SyncManifest> {
	const db = await getDB();
	const stored = await db.get('syncManifest', MANIFEST_ID);
	return stored ?? defaultManifest();
}

export async function saveManifest(manifest: SyncManifest): Promise<void> {
	const db = await getDB();
	manifest.id = MANIFEST_ID;
	await db.put('syncManifest', manifest);
}

export async function clearManifest(): Promise<void> {
	const db = await getDB();
	await db.delete('syncManifest', MANIFEST_ID);
}

/** Remove a specific note from the local manifest so it will be re-downloaded on next sync. */
export async function removeNoteRevision(guid: string): Promise<void> {
	const m = await getManifest();
	if (m.noteRevisions[guid] !== undefined) {
		delete m.noteRevisions[guid];
		await saveManifest(m);
	}
}
