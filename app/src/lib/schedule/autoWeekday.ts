const WEEKDAY_CHARS = ['일', '월', '화', '수', '목', '금', '토'] as const;

function isValidDate(year: number, month: number, day: number): boolean {
	if (day < 1 || day > 31) return false;
	const d = new Date(year, month - 1, day);
	return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

export function getWeekdayChar(year: number, month: number, day: number): string {
	if (!isValidDate(year, month, day)) {
		throw new RangeError(`Invalid date: ${year}-${month}-${day}`);
	}
	return WEEKDAY_CHARS[new Date(year, month - 1, day).getDay()];
}

export function formatDayWithWeekday(year: number, month: number, day: number): string {
	return `${day}(${getWeekdayChar(year, month, day)})`;
}

// Bare-number-then-space: optional leading ws, digits, one+ spaces, no opening paren next.
const BARE_SPACE_RE = /^(\s*)(\d{1,2})(\s+)(?!\()(.*)$/;
// Number-then-parens (no gap): optional leading ws, digits, optional `*`, parens group, rest.
const WITH_PARENS_RE = /^(\s*)(\d{1,2})(\*?)(\([^)]*\))(.*)$/;
// Number-then-space-then-parens: optional `*`, gap between digit and open paren.
const SPACE_BEFORE_PARENS_RE = /^(\s*)(\d{1,2})(\*?)(\s+)(\([^)]*\))(.*)$/;
// Inside the parens: weekday text + trailing `*` recurrence markers (e.g. "수**").
// The weekday is corrected; the `*` markers are preserved verbatim.
const INNER_STARS_RE = /^(.*?)(\**)$/;

/** Split paren inner content into its weekday text (trimmed) and trailing `*` markers. */
function splitInnerStars(inner: string): { weekday: string; stars: string } {
	const m = INNER_STARS_RE.exec(inner)!;
	return { weekday: m[1].trim(), stars: m[2] };
}

export function transformDayPrefixLine(
	input: string,
	year: number,
	month: number
): { changed: boolean; output: string } {
	const unchanged = { changed: false, output: input };

	// Space-between-number-and-parens: "12 (수) 등산" → collapse gap + correct weekday.
	// Must be checked before BARE_SPACE_RE so the lookahead logic in BARE_SPACE_RE
	// (which rejects input where a paren follows the spaces) doesn't swallow this case.
	const spaceParensMatch = SPACE_BEFORE_PARENS_RE.exec(input);
	if (spaceParensMatch) {
		const [, leadingWs, dayStr, star, , parensGroup, rest] = spaceParensMatch;
		const day = parseInt(dayStr, 10);
		if (!isValidDate(year, month, day)) return unchanged;
		const wd = getWeekdayChar(year, month, day);
		const { stars } = splitInnerStars(parensGroup.slice(1, -1));
		return { changed: true, output: `${leadingWs}${day}${star}(${wd}${stars})${rest}` };
	}

	// Try bare-number + space first (no parens after the number).
	const bareMatch = BARE_SPACE_RE.exec(input);
	if (bareMatch) {
		const [, leadingWs, dayStr, spaces, rest] = bareMatch;
		const day = parseInt(dayStr, 10);
		if (!isValidDate(year, month, day)) return unchanged;
		const wd = getWeekdayChar(year, month, day);
		return { changed: true, output: `${leadingWs}${day}(${wd})${spaces}${rest}` };
	}

	// Try number + parens (no gap between digit and open paren).
	const parensMatch = WITH_PARENS_RE.exec(input);
	if (parensMatch) {
		const [, leadingWs, dayStr, star, parensGroup, rest] = parensMatch;
		const day = parseInt(dayStr, 10);
		if (!isValidDate(year, month, day)) return unchanged;
		const wd = getWeekdayChar(year, month, day);
		// Separate the weekday (trimmed) from any trailing `*` recurrence markers.
		const { weekday, stars } = splitInnerStars(parensGroup.slice(1, -1));
		if (weekday === wd) return unchanged; // already correct (markers/spaces preserved)
		return { changed: true, output: `${leadingWs}${day}${star}(${wd}${stars})${rest}` };
	}

	return unchanged;
}

export function transformMultilineDayPrefix(input: string, year: number, month: number): string {
	if (input === '') return '';
	// Detect line ending style: CRLF or LF. We split on \n and restore \r if present.
	const usesCRLF = input.includes('\r\n');
	const normalized = usesCRLF ? input.replace(/\r\n/g, '\n') : input;
	const lines = normalized.split('\n');
	const transformed = lines.map((line) => transformDayPrefixLine(line, year, month).output);
	const joined = transformed.join('\n');
	return usesCRLF ? joined.replace(/\n/g, '\r\n') : joined;
}
