/**
 * Pure helpers for the weekly/monthly schedule summary push.
 *
 * No firebase-admin imports here — kept side-effect-free so the date math
 * and body-rendering can be reasoned about (and unit-tested from the app
 * suite if we ever wire that up). The `index.ts` orchestrator queries
 * Firestore and calls these helpers to format the outgoing FCM body.
 */

const KOR_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const KST_OFFSET_MS = 9 * 3600_000;
const SUMMARY_BODY_MAX_ITEMS = 10;

/** UTC instant of midnight (00:00) on the KST calendar day containing `at`. */
export function kstMidnightOf(at: Date): Date {
	const shifted = new Date(at.getTime() + KST_OFFSET_MS);
	const y = shifted.getUTCFullYear();
	const m = shifted.getUTCMonth();
	const d = shifted.getUTCDate();
	return new Date(Date.UTC(y, m, d) - KST_OFFSET_MS);
}

/** KST day-of-week: 0 = Sun … 6 = Sat. */
export function kstDayOfWeek(at: Date): number {
	const shifted = new Date(at.getTime() + KST_OFFSET_MS);
	return shifted.getUTCDay();
}

/**
 * `[start, end)` UTC range for the Mon-through-next-Mon week containing
 * `now` in KST. End is exclusive so events at exactly next-Monday-00:00
 * KST belong to the following week.
 */
export function weekRangeKst(now: Date): { start: Date; end: Date } {
	const today = kstMidnightOf(now);
	// Days back to Monday in KST. Mon (1) → 0, Tue (2) → 1, …, Sun (0) → 6.
	const daysBackToMon = (kstDayOfWeek(now) + 6) % 7;
	const start = new Date(today.getTime() - daysBackToMon * 86400_000);
	const end = new Date(start.getTime() + 7 * 86400_000);
	return { start, end };
}

/**
 * `[start, end)` UTC range for the calendar month containing `now` in KST.
 * Boundaries land on the 1st at 00:00 KST.
 */
export function monthRangeKst(now: Date): { start: Date; end: Date } {
	const shifted = new Date(now.getTime() + KST_OFFSET_MS);
	const y = shifted.getUTCFullYear();
	const m = shifted.getUTCMonth();
	const start = new Date(Date.UTC(y, m, 1) - KST_OFFSET_MS);
	const end = new Date(Date.UTC(y, m + 1, 1) - KST_OFFSET_MS);
	return { start, end };
}

export interface SummaryItem {
	eventAt: Date;
	hasTime: boolean;
	month: number;
	day: number;
	label: string;
}

/**
 * Render a multi-line list of items for the FCM body. Caps at
 * `SUMMARY_BODY_MAX_ITEMS` lines and adds a "외 N건" overflow marker so
 * a long week / busy month doesn't blow up the notification height.
 *
 * Each line: `M/D(요일) 라벨` + ` HH:MM` if the item has a time.
 */
export function formatSummaryBody(items: SummaryItem[]): string {
	if (items.length === 0) return '';
	const head = items.slice(0, SUMMARY_BODY_MAX_ITEMS);
	const lines = head.map((it) => {
		const dow = KOR_WEEKDAYS[kstDayOfWeek(it.eventAt)];
		let line = `${it.month}/${it.day}(${dow}) ${it.label}`;
		if (it.hasTime) {
			const fmt = new Intl.DateTimeFormat('ko-KR', {
				timeZone: 'Asia/Seoul',
				hour: '2-digit',
				minute: '2-digit',
				hour12: false
			});
			line += ` ${fmt.format(it.eventAt)}`;
		}
		return line;
	});
	if (items.length > SUMMARY_BODY_MAX_ITEMS) {
		lines.push(`외 ${items.length - SUMMARY_BODY_MAX_ITEMS}건`);
	}
	return lines.join('\n');
}
