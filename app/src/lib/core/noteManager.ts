import { createEmptyNote, formatTomboyDate, type NoteData } from './note.js';
import { serializeContent, extractTitleFromDoc, deserializeContent } from './noteContentArchiver.js';
import { parseNote, serializeNote } from './noteArchiver.js';
import {
	prepareIncomingNoteForLocal,
	rewriteInternalLinkRefsInXml
} from './titleRewrite.js';
import { emitNoteReload } from './noteReloadBus.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { generateGuid } from '$lib/utils/guid.js';
import { invalidateCache } from '$lib/stores/noteListCache.js';
import { ensureTitleIndexReady } from '$lib/editor/autoLink/titleProvider.js';
import { checkTitleConflict } from '$lib/editor/titleUniqueGuard.js';
import { pushToast } from '$lib/stores/toast.js';
import { syncScheduleFromNote } from '$lib/schedule/syncSchedule.js';
import { flushIfEnabled } from '$lib/schedule/flushScheduler.js';
import { notifyNoteSaved } from '$lib/sync/firebase/orchestrator.js';
import { buildDateNoteScheduleSeed } from '$lib/schedule/dateNoteSeed.js';
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
	const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(title);
	const suffix = dateMatch ? `\n${dateMatch[1]}년\n` : `\n\n`;
	note.xmlContent = `<note-content version="0.1">${title}${suffix}</note-content>`;
	if (dateMatch) {
		const year = Number(dateMatch[1]);
		const month = Number(dateMatch[2]);
		const day = Number(dateMatch[3]);
		const seed = await buildDateNoteScheduleSeed(year, month, day);
		if (seed.length > 0) {
			const doc: JSONContent = {
				type: 'doc',
				content: [
					{ type: 'paragraph', content: [{ type: 'text', text: title }] },
					{ type: 'paragraph', content: [{ type: 'text', text: `${year}년` }] },
					{ type: 'paragraph' },
					...seed,
					{ type: 'paragraph' }
				]
			};
			note.xmlContent = serializeContent(doc);
		}
	}
	await noteStore.putNote(note);
	// Push to Firestore even before the first edit. Otherwise a "create new
	// note + drop a link to it from another note" workflow leaves the new
	// note absent from Firestore — receiving devices see the link but
	// cannot resolve it. The debounced push queue coalesces this with any
	// follow-up edit that lands within the debounce window.
	notifyNoteSaved(guid);
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
	const oldTitle = note.title;

	// Defensive title-uniqueness guard. The editor's blur validator is the
	// primary UX surface for this (it toasts + snaps the cursor back so the
	// user can edit), but code paths that bypass the editor — programmatic
	// edits, transferListItem moving into a note, etc. — also funnel through
	// this function, so we re-check here and silently refuse the write on a
	// collision. The UI is responsible for surfacing the error.
	if (titleChanged) {
		await ensureTitleIndexReady();
		const { conflict } = checkTitleConflict(newTitle, guid);
		if (conflict) return note;
	}

	const now = formatTomboyDate(new Date());
	note.xmlContent = newXmlContent;
	note.title = newTitle;
	note.changeDate = now;
	note.metadataChangeDate = now;

	await noteStore.putNote(note);
	notifyNoteSaved(guid);
	// Only invalidate the shared note-list cache when the title changed.
	// Body-only edits don't affect any derived views that matter while the
	// user is actively typing (the title list for auto-linking, notebook
	// chips, etc.), so skipping invalidate here avoids a cascade where every
	// keystroke's debounced save triggers a full titleProvider refetch +
	// full-doc auto-link rescan. List pages remount on navigation and
	// refetch fresh data then.
	if (titleChanged) {
		invalidateCache();
		// Rewrite backlinks: every OTHER note that stored
		// <link:internal>oldTitle</link:internal> (or broken) still holds the
		// OLD title as text — Tomboy's auto-link marks store the title
		// string, not the target guid. Sweep them now so they resolve again
		// on next load, and reload any open editors so an in-memory
		// pendingDoc doesn't clobber our fix on the next debounced save.
		const affected = await rewriteBacklinksForRename(oldTitle, newTitle, guid);
		if (affected.length > 0) {
			invalidateCache();
			await emitNoteReload(affected);
		}
	}
	// Schedule-note hook: if this guid is the user-designated schedule note,
	// re-parse, stash the diff, and (when notifications are enabled) drain
	// it to Firestore. Wrapped so a parser/IDB/network hiccup never blocks
	// the actual note save.
	try {
		const r = await syncScheduleFromNote(note, new Date());
		if (r.isScheduleNote && (r.added > 0 || r.removed > 0)) {
			await flushIfEnabled();
		}
	} catch (err) {
		console.warn('[schedule] sync/flush failed', err);
	}
	return note;
}

/**
 * Scan every non-deleted note (except `selfGuid`) and rewrite any
 * `<link:internal>OLD</link:internal>` / `<link:broken>OLD</link:broken>`
 * references to use `newTitle`. Updated notes land via `putNote` so they
 * are `localDirty=true` and will upload on the next sync. Returns the list
 * of affected guids.
 */
async function rewriteBacklinksForRename(
	oldTitle: string,
	newTitle: string,
	selfGuid: string
): Promise<string[]> {
	if (oldTitle === newTitle) return [];
	const all = await noteStore.getAllNotesIncludingTemplates();
	const affected: string[] = [];
	const now = formatTomboyDate(new Date());
	for (const other of all) {
		if (other.guid === selfGuid) continue;
		if (other.deleted) continue;
		const { xml, changed } = rewriteInternalLinkRefsInXml(
			other.xmlContent,
			oldTitle,
			newTitle
		);
		if (!changed) continue;
		other.xmlContent = xml;
		other.changeDate = now;
		other.metadataChangeDate = now;
		await noteStore.putNote(other);
		notifyNoteSaved(other.guid);
		affected.push(other.guid);
	}
	return affected;
}

/** Delete a note (soft-delete for sync) */
export async function deleteNoteById(guid: string): Promise<void> {
	await noteStore.deleteNote(guid);
	notifyNoteSaved(guid);
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

/** Find a note by its title (case-sensitive, trimmed). */
export async function findNoteByTitle(title: string): Promise<NoteData | undefined> {
	return noteStore.findNoteByTitle(title);
}

/** Import a .note XML string into IndexedDB.
 *
 * Enforces the case-sensitive title uniqueness invariant: if another LOCAL
 * note (different guid) already owns this title, suffix with `(2)`,
 * `(3)`, … and mark the imported copy dirty so the rename propagates back
 * on the next sync. A toast notifies the user of the rename.
 */
export async function importNoteXml(xml: string, filename: string): Promise<NoteData> {
	const guid = filename.replace(/\.note$/, '');
	const uri = `note://tomboy/${guid}`;
	const parsed = parseNote(xml, uri);
	parsed.guid = guid;
	parsed.localDirty = false;

	const { renamed, from, to, note } = await prepareIncomingNoteForLocal(parsed, {
		findByTitle: (title) => noteStore.findNoteByTitle(title),
		now: () => formatTomboyDate(new Date())
	});

	if (renamed) {
		// localDirty=true is already set by prepareIncomingNoteForLocal; use
		// putNote so the renamed note uploads on next sync.
		await noteStore.putNote(note);
		pushToast(`제목 중복 — '${from}' → '${to}' 로 이름 변경됨`, { kind: 'info' });
	} else {
		await noteStore.putNoteSynced(note);
	}
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
	notifyNoteSaved(guid);
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
