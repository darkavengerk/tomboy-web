/**
 * Pointer to the user-designated "schedule note" — a single note whose
 * list-item content is parsed for date/time entries that schedule push
 * notifications. Mirrors the home-note pointer pattern in `home.ts`.
 */
import { getSetting, setSetting, deleteSetting } from '$lib/storage/appSettings.js';

const KEY = 'scheduleNoteGuid';

let cachedGuid: string | undefined;
let cacheHydrated = false;

export async function setScheduleNote(guid: string): Promise<void> {
	await setSetting(KEY, guid);
	cachedGuid = guid;
	cacheHydrated = true;
}

export async function clearScheduleNote(): Promise<void> {
	await deleteSetting(KEY);
	cachedGuid = undefined;
	cacheHydrated = true;
}

export async function getScheduleNoteGuid(): Promise<string | undefined> {
	if (cacheHydrated) return cachedGuid;
	cachedGuid = await getSetting<string>(KEY);
	cacheHydrated = true;
	return cachedGuid;
}

export function _resetScheduleCacheForTest(): void {
	cachedGuid = undefined;
	cacheHydrated = false;
}
