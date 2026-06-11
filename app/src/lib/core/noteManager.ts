import { createEmptyNote, formatTomboyDate, type NoteData } from './note.js';
import { favoriteStore } from '$lib/storage/favoriteStore.svelte.js';
import { serializeContent, extractTitleFromDoc, deserializeContent } from './noteContentArchiver.js';
import { parseNote, serializeNote } from './noteArchiver.js';
import {
	prepareIncomingNoteForLocal,
	rewriteInternalLinkRefsInXml
} from './titleRewrite.js';
import { emitNoteReload, emitNoteFlush } from './noteReloadBus.js';
import * as noteStore from '$lib/storage/noteStore.js';
import * as backlinkIndex from './backlinkIndex.js';
import { generateGuid } from '$lib/utils/guid.js';
import { invalidateCache, noteMutated, readThroughNotes } from '$lib/stores/noteListCache.js';
import { ensureTitleIndexReady, lookupGuidByTitle } from '$lib/editor/autoLink/titleProvider.js';
import { checkTitleConflict } from '$lib/editor/titleUniqueGuard.js';
import { pushToast } from '$lib/stores/toast.js';
import { syncScheduleFromNote } from '$lib/schedule/syncSchedule.js';
import { flushIfEnabled } from '$lib/schedule/flushScheduler.js';
import { notifyNoteSaved } from '$lib/sync/firebase/orchestrator.js';
import { buildDateNoteScheduleSeed } from '$lib/schedule/dateNoteSeed.js';
import { setNewNoteIntent } from './newNoteIntent.js';
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

/** Append " (2)", " (3)", … until the title is not in use by any note.
 *
 * Uses the index-only `titleExists` probe rather than `findNoteByTitle`:
 * the candidate almost never exists, and on a miss `findNoteByTitle` falls
 * back to a full-corpus scan — which sat directly in the tap→navigate
 * critical path of every 새 노트 creation. */
export async function ensureUniqueTitle(base: string): Promise<string> {
	let candidate = base;
	let n = 2;
	while (await noteStore.titleExists(candidate)) {
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
					...seed,
					{ type: 'paragraph' },
					{ type: 'paragraph' }
				]
			};
			note.xmlContent = serializeContent(doc);
		}
	}
	await noteStore.putNote(note);
	// Tell the editor how to place the cursor when it first loads this note.
	// No initialTitle → the title is the auto-generated date, so select it
	// whole (one keystroke replaces it). An explicit title was chosen by the
	// caller → put the cursor in the body (line after the line-2 placeholder).
	setNewNoteIntent(guid, initialTitle === undefined ? 'selectTitle' : 'bodyCursor');
	// Push to Firestore even before the first edit. Otherwise a "create new
	// note + drop a link to it from another note" workflow leaves the new
	// note absent from Firestore — receiving devices see the link but
	// cannot resolve it. The debounced push queue coalesces this with any
	// follow-up edit that lands within the debounce window.
	notifyNoteSaved(guid);
	// Patch (not invalidate) the shared list cache: a single known note was
	// written, so downstream index refreshes can stay in-memory instead of
	// re-reading the full corpus from IDB.
	noteMutated(note);
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
	// Patch (not invalidate) the shared note-list cache on every real write.
	// While the user types a title EVERY debounced save lands here with
	// titleChanged=true, and the old hard invalidate forced a cold
	// full-corpus getAll per save — the dominant 새 노트 jank source. The
	// patch keeps the cache identical to committed IDB state for pure
	// in-memory cost; downstream refreshers' equivalence guards
	// (entriesEquivalent / sameSet) then drop body-only fan-outs before any
	// editor rescan is scheduled.
	noteMutated(note);
	if (titleChanged) {
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
 * Sweep backlinks for a renamed note. Uses the in-memory backlinkIndex
 * to look up affected sources directly (O(M) where M = notes containing
 * a mark targeting `oldTitle`), then rewrites them in parallel via
 * `Promise.allSettled`. Returns the list of affected guids.
 *
 * Each `putNote` call automatically updates the index — by the time
 * Promise.allSettled resolves, the `oldTitle` entry is empty (and pruned) and
 * the same source guids live under `newTitle`.
 */
async function rewriteBacklinksForRename(
	oldTitle: string,
	newTitle: string,
	selfGuid: string
): Promise<string[]> {
	if (oldTitle === newTitle) return [];
	await backlinkIndex.ensureBacklinkIndexReady();
	const sources = backlinkIndex.getSourcesFor(oldTitle);
	if (!sources || sources.size === 0) return [];

	// Snapshot — `sources` is the live Set; putNote mutates it during the
	// sweep, so iterating directly would skip notes.
	const targetGuids = [...sources].filter((g) => g !== selfGuid);

	// Flush any open editor for a backlinked target so its unsaved pending
	// body edit is persisted to IDB BEFORE we read + rewrite it below.
	// Without this, a desktop window editing one of these notes within the
	// 1.5s debounce window would have that edit read stale here, overwritten
	// by the link rewrite, then dropped by the caller's emitNoteReload() —
	// silent content loss. No-op on mobile (the backlinked targets are never
	// open) and for any guid without a registered editor. The renamed note's
	// own guid is already filtered out, so this never re-enters its flush.
	await emitNoteFlush(targetGuids);

	// Single timestamp so the whole sweep appears as one atomic operation.
	const now = formatTomboyDate(new Date());

	const results = await Promise.allSettled(
		targetGuids.map(async (g) => {
			const other = await noteStore.getNote(g);
			if (!other || other.deleted) return null;
			const { xml, changed } = rewriteInternalLinkRefsInXml(
				other.xmlContent,
				oldTitle,
				newTitle
			);
			if (!changed) {
				console.warn('[backlinkIndex] stale entry: no mark in xml for', g, oldTitle);
				return null;
			}
			other.xmlContent = xml;
			other.changeDate = now;
			other.metadataChangeDate = now;
			await noteStore.putNote(other);
			notifyNoteSaved(other.guid);
			return other.guid;
		})
	);

	const affected: string[] = [];
	for (const r of results) {
		if (r.status === 'fulfilled' && r.value !== null) {
			affected.push(r.value);
		} else if (r.status === 'rejected') {
			console.error('[rename-sweep] target failed', r.reason);
		}
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

/** Get all notes sorted by changeDate descending (always a fresh IDB read). */
export async function listNotes(): Promise<NoteData[]> {
	return noteStore.getAllNotes();
}

/**
 * Read-through, cache-shared variant of `listNotes()` for the in-memory
 * index refreshers (auto-link title index + slip-note guid set) and the
 * desktop SidePanel. All fire on the same listener fan-out; routing them
 * through the shared `readThroughNotes` cache collapses what were multiple
 * full `getAllNotes()` scans per change into AT MOST one — and editor-path
 * mutations (`noteMutated`) patch the warm cache in place, so the steady
 * state is ZERO IDB reads per save. Freshness-absolutist callers (the 전체
 * list, home "latest" redirect) stay on `listNotes()`, which also covers
 * write paths that bypass the patch and rely on bulk `invalidateCache()`
 * (sync pull, import, purge, admin rollback).
 */
export async function listNotesShared(): Promise<NoteData[]> {
	return readThroughNotes(() => noteStore.getAllNotes());
}

/** Get a single note */
export async function getNote(guid: string): Promise<NoteData | undefined> {
	return noteStore.getNote(guid);
}

/** Find a note by its title (case-sensitive, trimmed). */
export async function findNoteByTitle(title: string): Promise<NoteData | undefined> {
	return noteStore.findNoteByTitle(title);
}

/**
 * Title → note lookup that takes the O(1) in-memory title index as a FAST
 * PATH but stays as correct as `findNoteByTitle` via an authoritative
 * fallback. Behaviour is identical to `findNoteByTitle` for every input —
 * only the cost differs.
 *
 *  1. await `ensureTitleIndexReady()` (also awaits any in-flight refresh);
 *  2. `lookupGuidByTitle` → `getNote` by key. Return it ONLY if it is
 *     non-deleted and its CURRENT trimmed title still equals the query — so a
 *     stale index entry can never yield a wrong-note match;
 *  3. on any miss (cold index, lagged entry, guid since renamed) fall back to
 *     `noteStore.findNoteByTitle`'s full scan, which always reflects committed
 *     IDB state.
 *
 * The fast path hits whenever the requested title actually exists and the
 * index is warm — which is the case on slip-note chain walks (every hop
 * resolves an existing neighbour), turning the old O(chain × corpus) into
 * O(chain). It is NOT worth using for the uniqueness GUARD in
 * `ensureUniqueTitle`, where the title almost never exists → the fast path
 * always misses and falls back, so it would just add an index round-trip.
 */
export async function findNoteByTitleIndexed(title: string): Promise<NoteData | undefined> {
	const needle = title.trim();
	if (!needle) return undefined;
	await ensureTitleIndexReady();
	const guid = lookupGuidByTitle(needle);
	if (guid) {
		const note = await noteStore.getNote(guid);
		if (note && !note.deleted && note.title.trim() === needle) return note;
	}
	// Index miss or stale entry → authoritative full scan (correctness net).
	return noteStore.findNoteByTitle(needle);
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

/** Toggle local-only favorite for this note. Returns the new state. */
export function toggleFavorite(guid: string): boolean {
	return favoriteStore.toggle(guid);
}

/** Check if a note is favorited on THIS device (local-only). */
export function isFavorite(n: NoteData): boolean {
	return favoriteStore.has(n.guid);
}

/** Sort notes by the given date field descending. No favorite priority. */
export function sortForList(notes: NoteData[], by: 'changeDate' | 'createDate'): NoteData[] {
	return [...notes].sort((a, b) => (b[by] ?? '').localeCompare(a[by] ?? ''));
}
