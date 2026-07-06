import { localDayKey } from './groupNotesByCreateDay.js';

/** One day cell in the month grid. */
export interface MonthCell {
	date: Date;
	/** Local `YYYY-MM-DD` key. */
	key: string;
	/** Day-of-month number (1–31). */
	day: number;
	/** True when the cell belongs to the displayed month (not spill-over). */
	inMonth: boolean;
	/** True when the cell's key equals `todayKey`. */
	isToday: boolean;
	/** Number of notes created on this day. */
	count: number;
}

/**
 * Build the 42-cell (6×7) month grid for `year`/`month` (month 0-based),
 * starting on the Sunday on or before the 1st. Pure — `todayKey` and the
 * per-day count map are passed in so the result is deterministic.
 */
export function buildMonthCells<T = unknown>(
	year: number,
	month: number,
	todayKey: string,
	dayMap: Map<string, T[]>
): MonthCell[] {
	const first = new Date(year, month, 1);
	const startOffset = first.getDay(); // 0 = Sunday
	const cells: MonthCell[] = [];
	for (let i = 0; i < 42; i++) {
		const date = new Date(year, month, 1 - startOffset + i);
		const key = localDayKey(date);
		cells.push({
			date,
			key,
			day: date.getDate(),
			inMonth: date.getMonth() === month,
			isToday: key === todayKey,
			count: dayMap.get(key)?.length ?? 0
		});
	}
	return cells;
}
