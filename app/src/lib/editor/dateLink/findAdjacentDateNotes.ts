/**
 * Date-title parsing + adjacency lookup.
 *
 * Notes whose trimmed title STARTS with one of the supported date forms
 * can navigate to the nearest earlier / nearest later date-titled note via
 * a pair of arrows rendered by the `DateArrows` extension.
 *
 * Three title prefixes are recognised:
 *   - ISO:    `yyyy-mm-dd`            (e.g. `2026-04-26`)
 *   - Dot:    `yyyy.mm.dd`            (whitespace around dots optional;
 *                                      zero-pad optional)
 *   - Korean: `yyyy년 m월 d일`         (whitespace between segments
 *                                      optional; zero-pad optional)
 *
 * Anything after the date prefix is treated as descriptive suffix text and
 * doesn't affect parsing — `2026-04-26 일기` is still a date note. The
 * boundary rule for the digit-tail forms (ISO and dot) is "no digit may
 * follow the day", so `2026-04-260` is NOT a date note. The Korean form
 * has its own `일` boundary built in.
 *
 * All forms parse to the same canonical `iso` string (`yyyy-mm-dd`,
 * zero-padded) so adjacency comparisons can ignore the format the title
 * was written in.
 *
 * Invariants:
 *   - Multiple notes can share the same date prefix (e.g. `2026-04-26`,
 *     `2026-04-26 일기`, `2026-04-26 회의`). Within a date, the trimmed
 *     full title is the tie-break key for ordering.
 *   - `entry.guid === currentGuid` is filtered out defensively so a
 *     self-link never shows up.
 *   - Future dates (> today) are skipped for the "next" search as a
 *     correctness cap: the user's mental model treats today as the latest
 *     entry, so a stray future-dated note should not swallow the next
 *     arrow.
 */

const ISO_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/;
const DOT_PREFIX_RE = /^(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})(?!\d)/;
const KOREAN_PREFIX_RE = /^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/;

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

	const match =
		ISO_PREFIX_RE.exec(t) ??
		DOT_PREFIX_RE.exec(t) ??
		KOREAN_PREFIX_RE.exec(t);
	if (!match) return null;

	const y = Number(match[1]);
	const m = Number(match[2]);
	const d = Number(match[3]);

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

interface SortKey {
	iso: string;
	title: string;
}

/** Tuple comparator: iso first, then trimmed full title for tie-break. */
function cmpKey(a: SortKey, b: SortKey): number {
	if (a.iso !== b.iso) return a.iso < b.iso ? -1 : 1;
	if (a.title === b.title) return 0;
	return a.title < b.title ? -1 : 1;
}

export function findAdjacentDateNotes(
	currentTitle: string,
	currentGuid: string,
	titles: DateTitleEntry[],
	today: Date = new Date()
): DateAdjacency {
	const parsedCur = parseDateTitle(currentTitle);
	if (!parsedCur) return { prev: null, next: null };
	const cur: SortKey = { iso: parsedCur.iso, title: currentTitle.trim() };

	const todayIso = fmtDate(today);

	let prev: SortKey | null = null;
	let next: SortKey | null = null;

	for (const entry of titles) {
		if (entry.guid === currentGuid) continue;
		const parsed = parseDateTitle(entry.title);
		if (!parsed) continue;
		const e: SortKey = { iso: parsed.iso, title: entry.title.trim() };
		const ord = cmpKey(e, cur);
		if (ord < 0) {
			if (prev === null || cmpKey(e, prev) > 0) prev = e;
		} else if (ord > 0) {
			if (e.iso > todayIso) continue;
			if (next === null || cmpKey(e, next) < 0) next = e;
		}
	}
	return { prev: prev?.title ?? null, next: next?.title ?? null };
}

function fmtDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}
