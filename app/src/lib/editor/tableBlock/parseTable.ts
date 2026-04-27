/**
 * Pure helpers for the editor's CSV/TSV table-block feature.
 *
 * A "table block" lives in the editor as plain consecutive paragraphs:
 *
 *   ```csv          ← opening fence (or ```tsv)
 *   header1, header2
 *   row1cell1, row1cell2
 *   row2cell1, row2cell2
 *   ```             ← closing fence
 *
 * The fence syntax mirrors GitHub-flavored markdown so it's familiar and
 * round-trips through Tomboy XML untouched (it is just text). Tables are
 * a render-time decoration only — the underlying paragraphs remain the
 * source of truth.
 */

export type TableFormat = 'csv' | 'tsv';

/**
 * If `line` is an opening table fence (` ```csv ` or ` ```tsv `, with the
 * language tag case-insensitive and surrounding whitespace tolerated),
 * return the format. Otherwise null.
 *
 * Strict on extra content after the language tag: ` ```csv extra ` is NOT
 * a fence, so accidental backtick-prefixed prose can't trigger table mode.
 */
export function detectFenceFormat(line: string): TableFormat | null {
	const trimmed = line.trim();
	const m = /^```([A-Za-z]+)$/.exec(trimmed);
	if (!m) return null;
	const tag = m[1].toLowerCase();
	if (tag === 'csv' || tag === 'tsv') return tag;
	return null;
}

/** A closing fence is a bare ` ``` ` line (whitespace tolerated). */
export function isFenceClose(line: string): boolean {
	return line.trim() === '```';
}

/**
 * Parse the body lines of a table block into rows of cells.
 *
 *  - csv: split on `,`, trim each cell.
 *  - tsv: split on `\t`, do NOT trim (whitespace inside cells matters
 *         for tab-separated data).
 *
 * Empty / whitespace-only lines are skipped so a stray blank line inside a
 * fenced block doesn't produce an all-empty row.
 *
 * Ragged rows (different cell counts per row) are returned as-is — the
 * renderer is responsible for any padding so the parser never silently
 * loses data.
 */
export function parseTableRows(lines: string[], format: TableFormat): string[][] {
	const out: string[][] = [];
	for (const raw of lines) {
		if (raw.trim().length === 0) continue;
		if (format === 'csv') {
			out.push(raw.split(',').map((c) => c.trim()));
		} else {
			out.push(raw.split('\t'));
		}
	}
	return out;
}
