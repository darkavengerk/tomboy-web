import { createEmptyNote, formatTomboyDate, type NoteData } from './note.js';
import { serializeContent, extractTitleFromDoc, deserializeContent } from './noteContentArchiver.js';
import { parseNote, serializeNote } from './noteArchiver.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { generateGuid } from '$lib/utils/guid.js';
import { invalidateCache } from '$lib/stores/noteListCache.js';
import type { JSONContent } from '@tiptap/core';

/** Format a Date as a plain `yyyy-mm-dd HH:mm` title — the default title
 *  for every newly-created note. Matches `isSlipNoteTitle`, so a note can
 *  later be added to the slip-box chain without renaming. */
export function formatDateTimeTitle(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const yyyy = date.getFullYear();
	const MM = pad(date.getMonth() + 1);
	const dd = pad(date.getDate());
	const HH = pad(date.getHours());
	const mm = pad(date.getMinutes());
	return `${yyyy}-${MM}-${dd} ${HH}:${mm}`;
}

/** Append " (2)", " (3)", … until the title is not in use by any note. */
export async function ensureUniqueTitle(base: string): Promise<string> {
	let candidate = base;
	let n = 2;
	while (await noteStore.findNoteByTitle(candidate)) {
		candidate = `${base} (${n})`;
		n++;
	}
	return candidate;
}

/** Create a new note and persist it to IndexedDB */
export async function createNote(initialTitle?: string): Promise<NoteData> {
	const guid = generateGuid();
	const note = createEmptyNote(guid);
	const title =
		initialTitle ?? (await ensureUniqueTitle(formatDateTimeTitle(new Date())));
	note.title = title;
	// When the title looks like yyyy-mm-dd, seed the subtitle slot (second
	// line) with the year so date-titled notes have an auto-filled header.
	const dateMatch = /^(\d{4})-\d{2}-\d{2}$/.exec(title);
	const suffix = dateMatch ? `\n${dateMatch[1]}년\n` : `\n\n`;
	note.xmlContent = `<note-content version="0.1">${title}${suffix}</note-content>`;
	await noteStore.putNote(note);
	invalidateCache();
	return note;
}

/** Update a note from the editor's JSON document */
export async function updateNoteFromEditor(guid: string, doc: JSONContent): Promise<NoteData | undefined> {
	const note = await noteStore.getNote(guid);
	if (!note) return undefined;

	const newXmlContent = serializeContent(doc);
	const newTitle = extractTitleFromDoc(doc);

	// No-op skip: if the serialized doc is byte-identical to what's already
	// in storage, don't touch the note. This prevents spurious "dirty" state
	// when a user types a character and then deletes it — the final doc
	// equals the stored one, so there's nothing to save. Without this check
	// the date fields would tick forward on every transient edit cycle and
	// the note would re-appear on the upload list.
	if (newXmlContent === note.xmlContent && newTitle === note.title) {
		return note;
	}

	const titleChanged = newTitle !== note.title;
	const now = formatTomboyDate(new Date());
	note.xmlContent = newXmlContent;
	note.title = newTitle;
	note.changeDate = now;
	note.metadataChangeDate = now;

	await noteStore.putNote(note);
	// Only invalidate the shared note-list cache when the title changed.
	// Body-only edits don't affect any derived views that matter while the
	// user is actively typing (the title list for auto-linking, notebook
	// chips, etc.), so skipping invalidate here avoids a cascade where every
	// keystroke's debounced save triggers a full titleProvider refetch +
	// full-doc auto-link rescan. List pages remount on navigation and
	// refetch fresh data then.
	if (titleChanged) invalidateCache();
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
