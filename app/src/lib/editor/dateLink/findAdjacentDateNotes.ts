/**
 * Date-title parsing + adjacency lookup.
 *
 * Notes whose trimmed title parses as a calendar date can navigate to the
 * nearest earlier / nearest later date-titled note via a pair of arrows
 * rendered by the `DateArrows` extension.
 *
 * Two title forms are recognised:
 *   - ISO:    `yyyy-mm-dd`            (e.g. `2026-04-26`)
 *   - Korean: `yyyy년 m월 d일`         (zero-pad optional, whitespace
 *                                      between segments optional)
 *
 * Both parse to the same canonical `iso` string (`yyyy-mm-dd`, zero-padded)
 * so adjacency comparisons can ignore the format the title was written in.
 *
 * Invariants:
 *   - Titles are globally unique (so date collisions across notes don't
 *     happen in practice), but `entry.guid === currentGuid` is filtered out
 *     defensively so a self-link never shows up.
 *   - Future dates (> today) are skipped for the "next" search as a
 *     correctness cap: the user's mental model treats today as the latest
 *     entry, so a stray future-dated note should not swallow the next
 *     arrow.
 */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const KOREAN_RE = /^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일$/;

export interface ParsedDateTitle {
	y: number;
	m: number;
	d: number;
	/** Canonical zero-padded yyyy-mm-dd string. */
	iso: string;
}

export function parseDateTitle(title: string): ParsedDateTitle | null {
	const t = title.trim();
	if (!t) return null;

	let y: number, m: number, d: number;
	const iso = ISO_RE.exec(t);
	if (iso) {
		y = Number(iso[1]);
		m = Number(iso[2]);
		d = Number(iso[3]);
	} else {
		const kr = KOREAN_RE.exec(t);
		if (!kr) return null;
		y = Number(kr[1]);
		m = Number(kr[2]);
		d = Number(kr[3]);
	}

	if (m < 1 || m > 12) return null;
	if (d < 1 || d > 31) return null;

	const mm = String(m).padStart(2, '0');
	const dd = String(d).padStart(2, '0');
	return { y, m, d, iso: `${y}-${mm}-${dd}` };
}

export function isDateTitle(title: string): boolean {
	return parseDateTitle(title) !== null;
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
	const cur = parseDateTitle(currentTitle);
	if (!cur) return { prev: null, next: null };

	const todayIso = fmtDate(today);

	let prevIso: string | null = null;
	let prevTitle: string | null = null;
	let nextIso: string | null = null;
	let nextTitle: string | null = null;

	for (const entry of titles) {
		if (entry.guid === currentGuid) continue;
		const parsed = parseDateTitle(entry.title);
		if (!parsed) continue;
		const t = parsed.iso;
		if (t < cur.iso) {
			if (prevIso === null || t > prevIso) {
				prevIso = t;
				prevTitle = entry.title.trim();
			}
		} else if (t > cur.iso) {
			if (t > todayIso) continue;
			if (nextIso === null || t < nextIso) {
				nextIso = t;
				nextTitle = entry.title.trim();
			}
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
