import { getSetting, setSetting } from '$lib/storage/appSettings.js';

// Stored in the appSettings IndexedDB store, so it rides along with the
// settings-sync profile backup. Holds the set of note GUIDs that should
// auto-scroll to the bottom on open.
const KEY = 'scrollBottomNoteGuids';

// In-memory cache of the guid set. Loaded lazily on first read and kept in
// sync by the setter. Avoids a full appSettings read per note-open, which
// matters when many windows mount at once (desktop workspace switching).
let cachedSet: Set<string> | null = null;

async function loadSet(): Promise<Set<string>> {
	if (cachedSet) return cachedSet;
	const list = await getSetting<string[]>(KEY);
	cachedSet = new Set(list ?? []);
	return cachedSet;
}

export async function isScrollBottomNote(guid: string): Promise<boolean> {
	const set = await loadSet();
	return set.has(guid);
}

export async function setScrollBottomNote(guid: string, enabled: boolean): Promise<void> {
	const set = await loadSet();
	if (enabled) set.add(guid);
	else set.delete(guid);
	await setSetting(KEY, Array.from(set));
}

export function _resetScrollBottomCacheForTest(): void {
	cachedSet = null;
}
