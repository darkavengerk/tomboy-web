import { parseScheduleNote, type ParsedScheduleEntry } from '$lib/schedule/parseSchedule.js';
import { getScheduleNoteGuid } from '$lib/core/schedule.js';
import { getNote } from '$lib/storage/noteStore.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { SEND_TARGET_GUID } from '$lib/editor/sendListItem/transferListItem.js';

/** One diary line placed in a day cell. */
export interface DiaryEntry {
	day: number;
	time: { h: number; m: number } | null;
	label: string;
	source: 'schedule' | 'history';
}

function minutesOf(time: { h: number; m: number } | null): number {
	return time ? time.h * 60 + time.m : Number.POSITIVE_INFINITY;
}

/**
 * Filter schedule + history entries to the target `year`/`month` (month
 * **1-based**, matching `ParsedScheduleEntry.month`), tag each by source, group
 * by day-of-month, and sort each day by time ascending (untimed entries last).
 * Pure — no IO.
 */
export function buildDiaryDayMap(
	scheduleEntries: ParsedScheduleEntry[],
	historyEntries: ParsedScheduleEntry[],
	year: number,
	month: number
): Map<number, DiaryEntry[]> {
	const map = new Map<number, DiaryEntry[]>();
	const add = (entries: ParsedScheduleEntry[], source: DiaryEntry['source']) => {
		for (const e of entries) {
			if (e.year !== year || e.month !== month) continue;
			const de: DiaryEntry = { day: e.day, time: e.time, label: e.label, source };
			const bucket = map.get(e.day);
			if (bucket) bucket.push(de);
			else map.set(e.day, [de]);
		}
	};
	add(scheduleEntries, 'schedule');
	add(historyEntries, 'history');
	for (const bucket of map.values()) {
		bucket.sort((a, b) => minutesOf(a.time) - minutesOf(b.time));
	}
	return map;
}

async function parseNoteAsSchedule(
	guid: string | null | undefined,
	now: Date
): Promise<ParsedScheduleEntry[]> {
	if (!guid) return [];
	const note = await getNote(guid);
	if (!note) return [];
	try {
		const doc = deserializeContent(note.xmlContent);
		return parseScheduleNote(doc, now);
	} catch {
		return [];
	}
}

/**
 * Load the diary day map for a viewed month (`month` **0-based**, calendar
 * convention). Reads the user-designated schedule note (settings) and the
 * hardcoded history note (Ctrl-보내기 destination), parses both as schedule
 * notes, and buckets by day. A note without `N월` headers contributes nothing.
 */
export async function loadDiaryDayMap(
	year: number,
	month: number
): Promise<Map<number, DiaryEntry[]>> {
	// parseScheduleNote emits entries for `now`'s month and the next month, with
	// the year inferred — so pass the 1st of the viewed month as `now`.
	const now = new Date(year, month, 1);
	const scheduleGuid = await getScheduleNoteGuid();
	const [sched, hist] = await Promise.all([
		parseNoteAsSchedule(scheduleGuid, now),
		parseNoteAsSchedule(SEND_TARGET_GUID, now)
	]);
	return buildDiaryDayMap(sched, hist, year, month + 1);
}
