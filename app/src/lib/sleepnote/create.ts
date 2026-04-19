/**
 * Create a new note that already satisfies the slip-note block layout
 * enforced by `validateSlipNoteFormat`:
 *
 *   [0] title
 *   [1] blank
 *   [2] "이전: 없음"
 *   [3] "다음: 없음"
 *   [4] blank
 *   [5] blank (body)
 *
 * The title is the shared `yyyy-mm-dd HH:mm` default used by all newly
 * created notes — it matches `isSlipNoteTitle` so the note can later be
 * added to the slip-box chain without being renamed.
 */

import { createEmptyNote, escapeXml, type NoteData } from '$lib/core/note.js';
import { ensureUniqueTitle, formatDateTimeTitle } from '$lib/core/noteManager.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { generateGuid } from '$lib/utils/guid.js';
import { invalidateCache } from '$lib/stores/noteListCache.js';

export function buildSlipNoteXml(title: string): string {
	return `<note-content version="0.1">${escapeXml(title)}\n\n이전: 없음\n다음: 없음\n\n</note-content>`;
}

export async function createSlipNote(): Promise<NoteData> {
	const guid = generateGuid();
	const note = createEmptyNote(guid);
	const title = await ensureUniqueTitle(formatDateTimeTitle(new Date()));
	note.title = title;
	note.xmlContent = buildSlipNoteXml(title);
	await noteStore.putNote(note);
	invalidateCache();
	return note;
}
