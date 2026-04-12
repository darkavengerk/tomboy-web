import { getSetting, setSetting, deleteSetting } from '$lib/storage/appSettings.js';
import * as noteStore from '$lib/storage/noteStore.js';
import type { NoteData } from './note.js';

const KEY = 'homeNoteGuid';

export async function setHomeNote(guid: string): Promise<void> {
	await setSetting(KEY, guid);
}

export async function clearHomeNote(): Promise<void> {
	await deleteSetting(KEY);
}

export async function getHomeNoteGuid(): Promise<string | undefined> {
	return getSetting<string>(KEY);
}

export async function getHomeNote(): Promise<NoteData | null> {
	const guid = await getHomeNoteGuid();
	if (guid) {
		const n = await noteStore.getNote(guid);
		if (n && !n.deleted) return n;
	}
	// Fallback: most recently changed note (templates excluded via getAllNotes)
	const all = await noteStore.getAllNotes();
	if (all.length === 0) return null;
	return [...all].sort((a, b) => (b.changeDate ?? '').localeCompare(a.changeDate ?? ''))[0];
}
