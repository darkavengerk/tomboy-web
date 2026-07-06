import { parseTomboyDate } from '$lib/core/note.js';

/** Minimal shape the calendar needs from a note. */
export interface CalendarNote {
	guid: string;
	title: string;
	createDate: string;
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

/** Local-timezone `YYYY-MM-DD` key for a Date. */
export function localDayKey(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Group notes by the local-timezone day of their `createDate`. Returns a map
 * keyed `YYYY-MM-DD`; each bucket is sorted by createDate ascending. Notes with
 * a missing or unparseable createDate are skipped (never crash on bad data).
 */
export function groupNotesByCreateDay<T extends CalendarNote>(notes: T[]): Map<string, T[]> {
	const withDate: Array<{ note: T; time: number; key: string }> = [];
	for (const note of notes) {
		if (!note.createDate) continue;
		const d = parseTomboyDate(note.createDate);
		const time = d.getTime();
		if (Number.isNaN(time)) continue;
		withDate.push({ note, time, key: localDayKey(d) });
	}
	withDate.sort((a, b) => a.time - b.time);
	const map = new Map<string, T[]>();
	for (const { note, key } of withDate) {
		const bucket = map.get(key);
		if (bucket) bucket.push(note);
		else map.set(key, [note]);
	}
	return map;
}
