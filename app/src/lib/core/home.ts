import { getSetting, setSetting, deleteSetting } from '$lib/storage/appSettings.js';
import * as noteStore from '$lib/storage/noteStore.js';
import type { NoteData } from './note.js';

const KEY = 'homeNoteGuid';

// In-memory cache. Hydrated lazily on first read; mutated directly by the
// setter / clearer so subsequent reads skip IndexedDB. Many callsites
// (+page.svelte, NoteWindow.svelte) look this up on every note open, and
// workspace-switch can fire N of those in parallel, so the IDB round-trip
// is worth avoiding.
let cachedGuid: string | undefined;
let cacheHydrated = false;

export async function setHomeNote(guid: string): Promise<void> {
	await setSetting(KEY, guid);
	cachedGuid = guid;
	cacheHydrated = true;
}

export async function clearHomeNote(): Promise<void> {
	await deleteSetting(KEY);
	cachedGuid = undefined;
	cacheHydrated = true;
}

export async function getHomeNoteGuid(): Promise<string | undefined> {
	if (cacheHydrated) return cachedGuid;
	cachedGuid = await getSetting<string>(KEY);
	cacheHydrated = true;
	return cachedGuid;
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

export function _resetHomeCacheForTest(): void {
	cachedGuid = undefined;
	cacheHydrated = false;
}
