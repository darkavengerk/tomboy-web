import { getDB } from './db.js';
import { formatTomboyDate, type NoteData } from '$lib/core/note.js';

/** Get all non-deleted notes excluding templates, sorted by changeDate descending */
export async function getAllNotes(): Promise<NoteData[]> {
	const db = await getDB();
	const all = await db.getAll('notes');
	return all
		.filter((n) => !n.deleted && !n.tags.includes('system:template'))
		.sort((a, b) => (b.changeDate > a.changeDate ? 1 : -1));
}

/** Get all non-deleted notes including template notes (for notebook management) */
export async function getAllNotesIncludingTemplates(): Promise<NoteData[]> {
	const db = await getDB();
	const all = await db.getAll('notes');
	return all
		.filter((n) => !n.deleted)
		.sort((a, b) => (b.changeDate > a.changeDate ? 1 : -1));
}

/** Get a single note by GUID */
export async function getNote(guid: string): Promise<NoteData | undefined> {
	const db = await getDB();
	return db.get('notes', guid);
}

/**
 * Insert or update a note, marking it as locally dirty.
 *
 * Preserves the existing `syncedXmlContent` baseline (set by the last
 * `putNoteSynced`) — that is the common ancestor used for 3-way merge
 * when a conflict is detected on next sync. If no prior row exists the
 * baseline stays undefined (new local note that has never been synced).
 */
export async function putNote(note: NoteData): Promise<void> {
	const db = await getDB();
	const existing = await db.get('notes', note.guid);
	await db.put('notes', {
		...note,
		localDirty: true,
		syncedXmlContent: existing?.syncedXmlContent ?? note.syncedXmlContent
	});
}

/**
 * Save a note without changing the dirty flag (used by sync).
 * Also captures the current xmlContent as `syncedXmlContent` so it can
 * serve as the common ancestor for future 3-way merges.
 */
export async function putNoteSynced(note: NoteData): Promise<void> {
	const db = await getDB();
	await db.put('notes', { ...note, syncedXmlContent: note.xmlContent });
}

/** Soft-delete a note (tombstone for sync). Bumps changeDate /
 * metadataChangeDate so cross-device conflict resolution treats the
 * tombstone as strictly newer than the pre-delete row — without this,
 * a same-changeDate tombstone would tie with the receiver's local row
 * and the resolver's `tie-prefers-local` fallback would silently undo
 * the delete on every other device.
 */
export async function deleteNote(guid: string): Promise<void> {
	const db = await getDB();
	const note = await db.get('notes', guid);
	if (note) {
		const now = formatTomboyDate(new Date());
		note.deleted = true;
		note.localDirty = true;
		note.changeDate = now;
		note.metadataChangeDate = now;
		await db.put('notes', note);
	}
}

/** Get all notes that have been modified since last sync */
export async function getDirtyNotes(): Promise<NoteData[]> {
	const db = await getDB();
	const all = await db.getAll('notes');
	return all.filter((n) => n.localDirty);
}

/** Hard-delete a note from IDB (after confirmed sync deletion) */
export async function purgeNote(guid: string): Promise<void> {
	const db = await getDB();
	await db.delete('notes', guid);
}

/**
 * Hard-delete a note locally WITHOUT creating a tombstone.
 * Used for "re-download" — we want it to come back from the server,
 * not be deleted from the server on next sync.
 */
export async function purgeLocalOnly(guid: string): Promise<void> {
	const db = await getDB();
	await db.delete('notes', guid);
}

/** Get all notes including deleted ones (for sync) */
export async function getAllNotesIncludingDeleted(): Promise<NoteData[]> {
	const db = await getDB();
	return db.getAll('notes');
}

/**
 * Hard-delete ALL notes locally without creating tombstones.
 * Used for "reset and re-download" — sync manifest should be cleared
 * separately so everything is fetched fresh from the server.
 */
export async function purgeAllLocal(): Promise<void> {
	const db = await getDB();
	await db.clear('notes');
}

/** Find a non-deleted note by title (exact case). Returns the most recently changed match if the uniqueness invariant is somehow violated. */
export async function findNoteByTitle(title: string): Promise<NoteData | undefined> {
	const db = await getDB();
	const all = await db.getAll('notes');
	const needle = title.trim();
	if (!needle) return undefined;
	const matches = all.filter(
		(n) => !n.deleted && n.title.trim() === needle
	);
	if (matches.length === 0) return undefined;
	matches.sort((a, b) => (b.changeDate > a.changeDate ? 1 : -1));
	return matches[0];
}
