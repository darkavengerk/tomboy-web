import { createEmptyNote, formatTomboyDate, type NoteData } from './note.js';
import { serializeContent, extractTitleFromDoc, deserializeContent } from './noteContentArchiver.js';
import { parseNote, serializeNote } from './noteArchiver.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { generateGuid } from '$lib/utils/guid.js';
import { invalidateCache } from '$lib/stores/noteListCache.js';
import type { JSONContent } from '@tiptap/core';

/** Create a new note and persist it to IndexedDB */
export async function createNote(initialTitle?: string): Promise<NoteData> {
	const guid = generateGuid();
	const note = createEmptyNote(guid);
	if (initialTitle) {
		note.title = initialTitle;
		note.xmlContent = `<note-content version="0.1">${initialTitle}\n\n</note-content>`;
	}
	await noteStore.putNote(note);
	invalidateCache();
	return note;
}

/** Update a note from the editor's JSON document */
export async function updateNoteFromEditor(guid: string, doc: JSONContent): Promise<NoteData | undefined> {
	const note = await noteStore.getNote(guid);
	if (!note) return undefined;

	const now = formatTomboyDate(new Date());
	note.xmlContent = serializeContent(doc);
	note.title = extractTitleFromDoc(doc);
	note.changeDate = now;
	note.metadataChangeDate = now;

	await noteStore.putNote(note);
	invalidateCache();
	return note;
}

/** Delete a note (soft-delete for sync) */
export async function deleteNoteById(guid: string): Promise<void> {
	await noteStore.deleteNote(guid);
	invalidateCache();
}

/** Get the TipTap JSON content for a note */
export function getNoteEditorContent(note: NoteData): JSONContent {
	return deserializeContent(note.xmlContent);
}

/** Get all notes sorted by changeDate descending */
export async function listNotes(): Promise<NoteData[]> {
	return noteStore.getAllNotes();
}

/** Get a single note */
export async function getNote(guid: string): Promise<NoteData | undefined> {
	return noteStore.getNote(guid);
}

/** Find a note by its title (case-insensitive). */
export async function findNoteByTitle(title: string): Promise<NoteData | undefined> {
	return noteStore.findNoteByTitle(title);
}

/** Import a .note XML string into IndexedDB */
export async function importNoteXml(xml: string, filename: string): Promise<NoteData> {
	const guid = filename.replace(/\.note$/, '');
	const uri = `note://tomboy/${guid}`;
	const note = parseNote(xml, uri);
	note.guid = guid;
	note.localDirty = false;
	await noteStore.putNoteSynced(note);
	return note;
}

/** Export a note to .note XML string */
export function exportNoteXml(note: NoteData): string {
	return serializeNote(note);
}

/** Toggle the system:pinned tag on a note */
export async function toggleFavorite(guid: string): Promise<NoteData | undefined> {
	const n = await noteStore.getNote(guid);
	if (!n) return undefined;
	const i = n.tags.indexOf('system:pinned');
	if (i >= 0) {
		n.tags.splice(i, 1);
	} else {
		n.tags.push('system:pinned');
	}
	const now = formatTomboyDate(new Date());
	n.metadataChangeDate = now;
	await noteStore.putNote(n);
	invalidateCache();
	return n;
}

/** Check if a note is favorited (has system:pinned tag) */
export function isFavorite(n: NoteData): boolean {
	return n.tags.includes('system:pinned');
}

/** Sort notes: pinned first, then by the given date field descending */
export function sortForList(notes: NoteData[], by: 'changeDate' | 'createDate'): NoteData[] {
	return [...notes].sort((a, b) => {
		const pa = isFavorite(a) ? 1 : 0;
		const pb = isFavorite(b) ? 1 : 0;
		if (pa !== pb) return pb - pa;
		return (b[by] ?? '').localeCompare(a[by] ?? '');
	});
}
