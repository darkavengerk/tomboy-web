import { getDB } from './db.js';
import { formatTomboyDate, type NoteData } from '$lib/core/note.js';
import * as backlinkIndex from '$lib/core/backlinkIndex.js';

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
	try {
		backlinkIndex.updateNote(note.guid, note.xmlContent, note.deleted);
	} catch (err) {
		console.error('[backlinkIndex] updateNote failed for', note.guid, err);
	}
}

/**
 * Save a note without changing the dirty flag (used by sync).
 * Also captures the current xmlContent as `syncedXmlContent` so it can
 * serve as the common ancestor for future 3-way merges.
 */
export async function putNoteSynced(note: NoteData): Promise<void> {
	const db = await getDB();
	await db.put('notes', { ...note, syncedXmlContent: note.xmlContent });
	try {
		backlinkIndex.updateNote(note.guid, note.xmlContent, note.deleted);
	} catch (err) {
		console.error('[backlinkIndex] updateNote failed for', note.guid, err);
	}
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
		try {
			backlinkIndex.updateNote(guid, note.xmlContent, true);
		} catch (err) {
			console.error('[backlinkIndex] updateNote failed for', guid, err);
		}
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

/** Find a non-deleted note by title (exact case). Returns the most recently changed match if the uniqueness invariant is somehow violated.
 *
 * Fast path: keyed lookup on the `by-title` IDB index — titles are stored
 * trimmed (whole-app invariant), so raw-key equality is the common case and
 * costs O(matches) instead of a full-corpus `getAll` (which deserializes
 * every note's xmlContent on the main thread).
 *
 * Fallback (index miss only): full scan with trimmed comparison, so a
 * legacy/imported note whose STORED title carries stray whitespace (an
 * invariant violator — surfaced by the /admin duplicate scan) still
 * resolves. Known edge: when both a raw-key match and an untrimmed-only
 * match exist, the raw-key match wins regardless of changeDate — that
 * state already violates title uniqueness, so deterministic-but-arbitrary
 * is acceptable.
 */
export async function findNoteByTitle(title: string): Promise<NoteData | undefined> {
	const needle = title.trim();
	if (!needle) return undefined;
	const db = await getDB();
	const indexed = (await db.getAllFromIndex('notes', 'by-title', needle)).filter(
		(n) => !n.deleted
	);
	if (indexed.length > 0) {
		indexed.sort((a, b) => (b.changeDate > a.changeDate ? 1 : -1));
		return indexed[0];
	}
	const all = await db.getAll('notes');
	const matches = all.filter(
		(n) => !n.deleted && n.title.trim() === needle
	);
	if (matches.length === 0) return undefined;
	matches.sort((a, b) => (b.changeDate > a.changeDate ? 1 : -1));
	return matches[0];
}

/**
 * Index-only existence probe: is there a non-deleted note whose RAW stored
 * title equals `title` (trimmed)?
 *
 * Used by `ensureUniqueTitle`, where the candidate almost never exists —
 * `findNoteByTitle`'s full-scan fallback would fire on every probe and pay a
 * full-corpus read in the tap→navigate critical path of 새 노트. Deliberately
 * NO fallback: a legacy untrimmed title won't block a candidate, which at
 * worst recreates a duplicate the /admin scan already reports.
 */
export async function titleExists(title: string): Promise<boolean> {
	const needle = title.trim();
	if (!needle) return false;
	const db = await getDB();
	const matches = await db.getAllFromIndex('notes', 'by-title', needle);
	return matches.some((n) => !n.deleted);
}
