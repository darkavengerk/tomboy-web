import { getSetting, setSetting } from '$lib/storage/appSettings.js';

// Stored in the appSettings IndexedDB store, so it rides along with the
// settings-sync profile backup. Holds the set of note GUIDs that should
// auto-scroll to the bottom on open.
const KEY = 'scrollBottomNoteGuids';

async function readSet(): Promise<Set<string>> {
	const list = await getSetting<string[]>(KEY);
	return new Set(list ?? []);
}

export async function isScrollBottomNote(guid: string): Promise<boolean> {
	const set = await readSet();
	return set.has(guid);
}

export async function setScrollBottomNote(guid: string, enabled: boolean): Promise<void> {
	const set = await readSet();
	if (enabled) set.add(guid);
	else set.delete(guid);
	await setSetting(KEY, Array.from(set));
}
