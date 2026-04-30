import type { ParsedScheduleEntry } from './parseSchedule.js';

export type ScheduleKind = 'morning' | 'pre1h' | 'at';

export interface ScheduleItem {
	/** Stable id derived from `(date, time, label, kind)`. Any text or kind change → new id. */
	id: string;
	year: number;
	month: number;
	day: number;
	hasTime: boolean;
	label: string;
	/** Notification slot — one of:
	 *  - `morning`: that day at 07:00 local. Always emitted.
	 *  - `pre1h`  : 1 hour before the event time. Time-bearing entries only.
	 *  - `at`     : exactly at the event time. Time-bearing entries only. */
	kind: ScheduleKind;
	/** ISO-8601 (UTC) of the event itself. Date-only entries use 00:00 local. */
	eventAt: string;
	/** ISO-8601 (UTC) of when to push the notification. Slot-dependent (see `kind`). */
	fireAt: string;
}

const PRE_NOTIFY_MS = 60 * 60_000;
const MORNING_HOUR = 7;

function localDate(year: number, month: number, day: number, h: number, m: number): Date {
	// month is 1-based here; Date expects 0-based.
	return new Date(year, month - 1, day, h, m, 0, 0);
}

/**
 * Expand a parsed entry into all of its notification slots.
 *
 * - Date-only entry → 1 item (`morning` at 07:00).
 * - Time-bearing entry → 3 items (`morning` at 07:00, `pre1h` at T-1h, `at` at T).
 *
 * Slot kind participates in the id hash so each slot has its own Firestore
 * doc and the diff pipeline cleanly handles partial removals (the user
 * editing a time changes the (time)-dependent ids of `pre1h`/`at` but not
 * `morning`'s — diff handles it correctly because the morning slot's id
 * also changes whenever date/label changes).
 */
export function buildScheduleItems(entry: ParsedScheduleEntry): ScheduleItem[] {
	const { year, month, day, time, label } = entry;
	const hasTime = time !== null;

	const morningEvent = hasTime
		? localDate(year, month, day, time!.h, time!.m)
		: localDate(year, month, day, 0, 0);
	const morningFire = localDate(year, month, day, MORNING_HOUR, 0);
	const morning = makeItem(entry, 'morning', morningEvent, morningFire);

	if (!hasTime) return [morning];

	const event = morningEvent;
	const pre1h = makeItem(entry, 'pre1h', event, new Date(event.getTime() - PRE_NOTIFY_MS));
	const at = makeItem(entry, 'at', event, event);
	return [morning, pre1h, at];
}

function makeItem(
	entry: ParsedScheduleEntry,
	kind: ScheduleKind,
	event: Date,
	fire: Date
): ScheduleItem {
	const { year, month, day, time, label } = entry;
	const hasTime = time !== null;
	const idInput = `${year}-${pad(month)}-${pad(day)}|${
		hasTime ? `${pad(time!.h)}:${pad(time!.m)}` : ''
	}|${label}|${kind}`;
	return {
		id: hashId(idInput),
		year,
		month,
		day,
		hasTime,
		label,
		kind,
		eventAt: event.toISOString(),
		fireAt: fire.toISOString()
	};
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

// 64-bit FNV-1a (computed as two 32-bit halves with seed variation) → 16 hex chars.
// Cryptographic strength is not needed here; we just need a stable, low-collision
// identifier for line-based schedule items in a single user's note.
function hashId(input: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x811c9dc5 ^ 0xdeadbeef;
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		h1 ^= c;
		h1 = Math.imul(h1, 0x01000193);
		h2 ^= c;
		h2 = Math.imul(h2, 0x01000193);
	}
	const a = (h1 >>> 0).toString(16).padStart(8, '0');
	const b = (h2 >>> 0).toString(16).padStart(8, '0');
	return a + b;
}
