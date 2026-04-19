/**
 * Pure text-matching utility for the auto-link feature.
 *
 * Given a text blob and a list of note titles, finds non-overlapping
 * substrings of `text` that match any title as a whole "word" (using
 * unicode-aware word boundaries). Longer titles take priority when
 * candidates overlap.
 */

export interface TitleEntry {
	/** Title used for matching (exact case). */
	title: string;
	/** GUID of the note this title belongs to. */
	guid: string;
}

export interface Match {
	/** Inclusive start offset into the original text. */
	from: number;
	/** Exclusive end offset into the original text. */
	to: number;
	/** Original-cased title to store on the mark. */
	target: string;
	/** GUID of the target note. */
	guid: string;
}

export interface FindOptions {
	/** Skip candidate titles belonging to this guid (e.g. the current note). */
	excludeGuid?: string | null;
}

// Word character = Unicode letter / number / underscore.
// We use \p{L}\p{N}_ classes so this works for ASCII + CJK + accented scripts.
const WORD_CHAR = /[\p{L}\p{N}_]/u;

export function isWordChar(ch: string | undefined): boolean {
	if (!ch) return false;
	return WORD_CHAR.test(ch);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findTitleMatches(
	text: string,
	titles: TitleEntry[],
	options: FindOptions = {}
): Match[] {
	if (!text) return [];
	const exclude = options.excludeGuid ?? null;

	// Keep only non-empty, non-excluded titles; de-dup by title.
	const seen = new Set<string>();
	const candidates: TitleEntry[] = [];
	for (const entry of titles) {
		const trimmed = entry.title.trim();
		if (!trimmed) continue;
		if (exclude !== null && entry.guid === exclude) continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		candidates.push({ ...entry, title: trimmed });
	}
	if (candidates.length === 0) return [];

	// Sort longest-first so longer titles win overlaps.
	candidates.sort((a, b) => b.title.length - a.title.length);

	const matches: Match[] = [];

	let cursor = 0;
	outer: while (cursor < text.length) {
		for (const cand of candidates) {
			const needle = cand.title;
			if (needle.length === 0) continue;
			if (cursor + needle.length > text.length) continue;
			if (text.startsWith(needle, cursor)) {
				const from = cursor;
				const to = cursor + needle.length;
				const before = from > 0 ? text[from - 1] : undefined;
				const after = to < text.length ? text[to] : undefined;
				if (!isWordChar(before) && !isWordChar(after)) {
					matches.push({ from, to, target: cand.title, guid: cand.guid });
					cursor = to;
					continue outer;
				}
			}
		}
		// Advance by one code point (handle surrogate pairs).
		const code = text.codePointAt(cursor) ?? 0;
		cursor += code > 0xffff ? 2 : 1;
	}

	// Assert non-overlapping (defensive; loop guarantees this).
	return matches;
}

// Re-exported for convenience (the regex is only internal, but the escape
// helper is useful to any consumer who wants to build its own matcher).
export { escapeRegExp };
