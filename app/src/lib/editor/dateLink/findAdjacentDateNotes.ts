/**
 * Date-title adjacency lookup.
 *
 * Notes whose trimmed title matches `yyyy-mm-dd` can navigate to the
 * nearest earlier / nearest later date-titled note via a pair of arrows
 * rendered by the `DateArrows` extension. This module is the pure lookup
 * that turns a full title list into `{ prev, next }` titles for a given
 * current note.
 *
 * Invariants:
 *   - Titles are globally unique, so date collisions across notes don't
 *     happen in practice — `entry.guid === currentGuid` is still filtered
 *     out defensively so a self-link never shows up.
 *   - yyyy-mm-dd sorts lexicographically identical to calendar order, so
 *     string `<` / `>` is used instead of Date parsing.
 *   - Future dates (> today) are skipped for the "next" search as a
 *     correctness cap: the user's mental model treats today as the latest
 *     entry, so a stray future-dated note should not swallow the next
 *     arrow.
 */

const DATE_TITLE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isDateTitle(title: string): boolean {
	return DATE_TITLE_REGEX.test(title.trim());
}

export interface DateTitleEntry {
	title: string;
	guid: string;
}

export interface DateAdjacency {
	/** Title of the nearest note with an earlier date, or null. */
	prev: string | null;
	/** Title of the nearest note with a later date (and ≤ today), or null. */
	next: string | null;
}

export function findAdjacentDateNotes(
	currentTitle: string,
	currentGuid: string,
	titles: DateTitleEntry[],
	today: Date = new Date()
): DateAdjacency {
	const curTrim = currentTitle.trim();
	if (!DATE_TITLE_REGEX.test(curTrim)) return { prev: null, next: null };

	const todayStr = fmtDate(today);

	let prevTitle: string | null = null;
	let nextTitle: string | null = null;

	for (const entry of titles) {
		if (entry.guid === currentGuid) continue;
		const t = entry.title.trim();
		if (!DATE_TITLE_REGEX.test(t)) continue;
		if (t < curTrim) {
			if (prevTitle === null || t > prevTitle) prevTitle = t;
		} else if (t > curTrim) {
			if (t > todayStr) continue;
			if (nextTitle === null || t < nextTitle) nextTitle = t;
		}
	}
	return { prev: prevTitle, next: nextTitle };
}

function fmtDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}
