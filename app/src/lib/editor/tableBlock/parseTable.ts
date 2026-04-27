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

import type { JSONContent } from '@tiptap/core';

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
 * Skip rule: a line is treated as a stray blank line ONLY if it is
 * pure whitespace AND contains no separator character. So an
 * intentionally-empty TSV row of `"\t\t"` (three empty cells) survives,
 * even though `trim()` would reduce it to nothing — its tab structure
 * is meaningful data.
 *
 * Ragged rows (different cell counts per row) are returned as-is — the
 * renderer is responsible for any padding so the parser never silently
 * loses data.
 */
export function parseTableRows(lines: string[], format: TableFormat): string[][] {
	const sep = format === 'csv' ? ',' : '\t';
	const out: string[][] = [];
	for (const raw of lines) {
		if (isBlankRow(raw, sep)) continue;
		if (format === 'csv') {
			out.push(raw.split(',').map((c) => c.trim()));
		} else {
			out.push(raw.split('\t'));
		}
	}
	return out;
}

/**
 * Shared "blank row" predicate used by both `parseTableRows` and
 * `parseInlineCells`, plus by `findTableRegions` when filtering body
 * paragraph ranges. Keeping the rule in one place ensures the three
 * derivations (rows / cells / bodyParaRanges) stay aligned.
 */
export function isBlankRow(raw: string, separator: string): boolean {
	if (raw.includes(separator)) return false;
	return raw.trim().length === 0;
}

/**
 * Split a flat array of inline nodes into cells at every occurrence of
 * `separator` inside text-node content. Marks survive: each chunk of a
 * split text node retains the original node's marks. Non-text nodes
 * (e.g. hardBreak) are passed through into whichever cell they fell in.
 *
 * The result is one inline-array per cell — `n + 1` cells for `n`
 * separator characters seen. Empty cells (e.g. from `,,`) are kept so
 * callers can preserve column counts.
 */
export function splitInlinesByChar(
	inlines: JSONContent[],
	separator: string
): JSONContent[][] {
	const cells: JSONContent[][] = [];
	let current: JSONContent[] = [];
	for (const node of inlines) {
		if (node.type !== 'text' || typeof node.text !== 'string') {
			current.push(node);
			continue;
		}
		const parts = node.text.split(separator);
		for (let i = 0; i < parts.length; i++) {
			if (i > 0) {
				cells.push(current);
				current = [];
			}
			if (parts[i].length > 0) {
				const piece: JSONContent = { type: 'text', text: parts[i] };
				if (node.marks) piece.marks = node.marks;
				current.push(piece);
			}
		}
	}
	cells.push(current);
	return cells;
}

/**
 * Strip leading/trailing whitespace from a cell's inline content while
 * preserving marks on the surviving text. Whitespace-only edge text
 * nodes are dropped entirely; partial-whitespace edges have their text
 * trimmed in-place. Non-text edge nodes (hardBreak etc.) are not
 * touched and stop the trim on that side.
 */
export function trimInlines(cell: JSONContent[]): JSONContent[] {
	const out = cell.map((n) => ({ ...n }));
	while (out.length > 0) {
		const first = out[0];
		if (first.type !== 'text' || typeof first.text !== 'string') break;
		const trimmed = first.text.replace(/^\s+/, '');
		if (trimmed.length === 0) {
			out.shift();
			continue;
		}
		first.text = trimmed;
		break;
	}
	while (out.length > 0) {
		const last = out[out.length - 1];
		if (last.type !== 'text' || typeof last.text !== 'string') break;
		const trimmed = last.text.replace(/\s+$/, '');
		if (trimmed.length === 0) {
			out.pop();
			continue;
		}
		last.text = trimmed;
		break;
	}
	return out;
}

/**
 * Convert the body paragraphs of a fenced region into the renderer's
 * cell model: a 3D array of `rows[r][c][i]` where the innermost layer
 * is the inline TipTap nodes (text + marks) for cell `c` of row `r`.
 *
 * Mirrors the line-skip and per-format trim rules of `parseTableRows`,
 * but preserves marks (so links/bold/etc. survive into rendered cells).
 * Paragraphs without inline content are skipped, matching the behavior
 * of `parseTableRows` for blank lines.
 */
export function parseInlineCells(
	bodyParagraphs: JSONContent[],
	format: TableFormat
): JSONContent[][][] {
	const rows: JSONContent[][][] = [];
	const sep = format === 'csv' ? ',' : '\t';
	for (const para of bodyParagraphs) {
		const inlines = para.content ?? [];
		const plain = inlines
			.filter((n) => n.type === 'text')
			.map((n) => n.text ?? '')
			.join('');
		if (isBlankRow(plain, sep)) continue;
		const cells = splitInlinesByChar(inlines, sep);
		rows.push(format === 'csv' ? cells.map((c) => trimInlines(c)) : cells);
	}
	return rows;
}
