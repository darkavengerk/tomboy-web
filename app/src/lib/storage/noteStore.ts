import { getDB } from './db.js';
import type { NoteData } from '$lib/core/note.js';

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

/** Insert or update a note, marking it as locally dirty */
export async function putNote(note: NoteData): Promise<void> {
	const db = await getDB();
	await db.put('notes', { ...note, localDirty: true });
}

/** Save a note without changing the dirty flag (used by sync) */
export async function putNoteSynced(note: NoteData): Promise<void> {
	const db = await getDB();
	await db.put('notes', note);
}

/** Soft-delete a note (tombstone for sync) */
export async function deleteNote(guid: string): Promise<void> {
	const db = await getDB();
	const note = await db.get('notes', guid);
	if (note) {
		note.deleted = true;
		note.localDirty = true;
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

/** Find a non-deleted note by title (case-insensitive). Returns the most recently changed match. */
export async function findNoteByTitle(title: string): Promise<NoteData | undefined> {
	const db = await getDB();
	const all = await db.getAll('notes');
	const needle = title.trim().toLowerCase();
	if (!needle) return undefined;
	const matches = all.filter(
		(n) => !n.deleted && n.title.trim().toLowerCase() === needle
	);
	if (matches.length === 0) return undefined;
	matches.sort((a, b) => (b.changeDate > a.changeDate ? 1 : -1));
	return matches[0];
}
