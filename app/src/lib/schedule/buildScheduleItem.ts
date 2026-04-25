import type { ParsedScheduleEntry } from './parseSchedule.js';

export interface ScheduleItem {
	/** Stable id derived from `(date, time, label)`. Any text change → new id. */
	id: string;
	year: number;
	month: number;
	day: number;
	hasTime: boolean;
	label: string;
	/** ISO-8601 (UTC) of the event itself. Date-only items use 00:00 local. */
	eventAt: string;
	/** ISO-8601 (UTC) of when to push the notification.
	 *  Time-bearing: eventAt - 30 min.
	 *  Date-only: that day at 07:00 local.  */
	fireAt: string;
}

const PRE_NOTIFY_MS = 30 * 60_000;

function localDate(year: number, month: number, day: number, h: number, m: number): Date {
	// month is 1-based here; Date expects 0-based.
	return new Date(year, month - 1, day, h, m, 0, 0);
}

export function buildScheduleItem(entry: ParsedScheduleEntry): ScheduleItem {
	const { year, month, day, time, label } = entry;
	const hasTime = time !== null;

	let event: Date;
	let fire: Date;
	if (hasTime) {
		event = localDate(year, month, day, time!.h, time!.m);
		fire = new Date(event.getTime() - PRE_NOTIFY_MS);
	} else {
		event = localDate(year, month, day, 0, 0);
		fire = localDate(year, month, day, 7, 0);
	}

	const idInput = `${year}-${pad(month)}-${pad(day)}|${
		hasTime ? `${pad(time!.h)}:${pad(time!.m)}` : ''
	}|${label}`;

	return {
		id: hashId(idInput),
		year,
		month,
		day,
		hasTime,
		label,
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
