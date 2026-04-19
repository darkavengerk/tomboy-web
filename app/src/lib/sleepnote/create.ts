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
 * The title is seeded as `yyyy-mm-dd HH:mm 새 노트` so it matches
 * `isSlipNoteTitle` (the date-time variant) — the user can rename it to the
 * canonical slip-note title without losing the format marker while typing.
 */

import { createEmptyNote, escapeXml, type NoteData } from '$lib/core/note.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { generateGuid } from '$lib/utils/guid.js';
import { invalidateCache } from '$lib/stores/noteListCache.js';

export function formatSlipNoteTitle(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const yyyy = date.getFullYear();
	const MM = pad(date.getMonth() + 1);
	const dd = pad(date.getDate());
	const HH = pad(date.getHours());
	const mm = pad(date.getMinutes());
	return `${yyyy}-${MM}-${dd} ${HH}:${mm} 새 노트`;
}

export function buildSlipNoteXml(title: string): string {
	return `<note-content version="0.1">${escapeXml(title)}\n\n이전: 없음\n다음: 없음\n\n</note-content>`;
}

export async function createSlipNote(): Promise<NoteData> {
	const guid = generateGuid();
	const note = createEmptyNote(guid);
	const title = formatSlipNoteTitle(new Date());
	note.title = title;
	note.xmlContent = buildSlipNoteXml(title);
	await noteStore.putNote(note);
	invalidateCache();
	return note;
}
