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

export type TableFormat = 'csv' | 'tsv' | 'markdown';
export type Alignment = 'left' | 'center' | 'right' | null;

/** Cell separator character for a format. Markdown uses the pipe. */
function sepFor(format: TableFormat): string {
	if (format === 'csv') return ',';
	if (format === 'tsv') return '\t';
	return '|';
}

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
	const sep = sepFor(format);
	const out: string[][] = [];
	for (const raw of lines) {
		if (isBlankRow(raw, sep)) continue;
		if (format === 'markdown') {
			if (isSeparatorRow(raw)) continue;
			const inner = raw.trim().replace(/^\|/, '').replace(/\|$/, '');
			out.push(inner.split('|').map((c) => c.trim()));
		} else if (format === 'csv') {
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
	const sep = sepFor(format);
	for (const para of bodyParagraphs) {
		const inlines = para.content ?? [];
		const plain = inlines
			.filter((n) => n.type === 'text')
			.map((n) => n.text ?? '')
			.join('');
		if (isBlankRow(plain, sep)) continue;
		if (format === 'markdown') {
			if (isSeparatorRow(plain)) continue;
			const stripped = stripOuterPipeInlines(inlines);
			const cells = splitInlinesByChar(stripped, '|');
			rows.push(cells.map((c) => trimInlines(c)));
		} else {
			const cells = splitInlinesByChar(inlines, sep);
			rows.push(format === 'csv' ? cells.map((c) => trimInlines(c)) : cells);
		}
	}
	return rows;
}

/**
 * A markdown separator row (` | --- | :--: | ` etc.) — the row that turns a
 * pipe-delimited line into a real table. Each cell must be `:?-+:?` after
 * outer-pipe stripping, AND the raw line must contain at least one `|`. The
 * pipe requirement is load-bearing: it disambiguates from the `hrSplit`
 * feature, where a bare `---` line means a vertical column divider.
 */
export function isSeparatorRow(line: string): boolean {
	if (!line.includes('|')) return false;
	const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
	const cells = inner.split('|').map((c) => c.trim());
	if (cells.length === 0) return false;
	return cells.every((c) => /^:?-+:?$/.test(c));
}

/** Parse per-column alignment from a markdown separator row. */
export function parseAlignments(line: string): Alignment[] {
	const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
	return inner.split('|').map((raw) => {
		const c = raw.trim();
		const left = c.startsWith(':');
		const right = c.endsWith(':');
		if (left && right) return 'center';
		if (right) return 'right';
		if (left) return 'left';
		return null;
	});
}

/**
 * Drop exactly one leading and one trailing `|` from an inline-node array
 * (GFM optional outer pipes), preserving marks. Inner spacing is left for
 * per-cell `trimInlines` to handle.
 */
export function stripOuterPipeInlines(inlines: JSONContent[]): JSONContent[] {
	const out = inlines.map((n) => ({ ...n }));
	for (let i = 0; i < out.length; i++) {
		const n = out[i];
		if (n.type !== 'text' || typeof n.text !== 'string') break;
		if (n.text.trim().length === 0) continue;
		n.text = n.text.replace(/^(\s*)\|/, '$1');
		break;
	}
	for (let i = out.length - 1; i >= 0; i--) {
		const n = out[i];
		if (n.type !== 'text' || typeof n.text !== 'string') break;
		if (n.text.trim().length === 0) continue;
		n.text = n.text.replace(/\|(\s*)$/, '$1');
		break;
	}
	return out;
}

export interface MarkdownRowLayout {
	hasLead: boolean;
	hasTrail: boolean;
	/** Raw (untrimmed) inter-pipe chunk bounds in the original text. */
	cells: { start: number; end: number }[];
}

/**
 * Locate the raw cell chunks of a markdown row in `text` coordinates,
 * reporting whether outer pipes are present. Used by cell-range and
 * column-op math so the pipe bookkeeping lives in one place.
 */
export function markdownRowLayout(text: string): MarkdownRowLayout {
	const leadWs = text.length - text.replace(/^\s+/, '').length;
	const trailWs = text.length - text.replace(/\s+$/, '').length;
	let i = leadWs;
	let j = text.length - trailWs;
	let hasLead = false;
	let hasTrail = false;
	if (i < j && text[i] === '|') {
		hasLead = true;
		i++;
	}
	if (j > i && text[j - 1] === '|') {
		hasTrail = true;
		j--;
	}
	const cells: { start: number; end: number }[] = [];
	let cellStart = i;
	for (let k = i; k < j; k++) {
		if (text[k] === '|') {
			cells.push({ start: cellStart, end: k });
			cellStart = k + 1;
		}
	}
	cells.push({ start: cellStart, end: j });
	return { hasLead, hasTrail, cells };
}

/**
 * Per-cell editable-content ranges in `text` coordinates for a row of the
 * given format. Single source of truth for cell-edit and column-delete math.
 *
 *  - tsv: full inter-tab chunk, untrimmed.
 *  - csv / markdown: trimmed content; an all-whitespace cell collapses to a
 *    zero-width range at its logical caret slot (after leading whitespace).
 *  - markdown additionally strips outer pipes via `markdownRowLayout`.
 */
export function cellCharRanges(
	text: string,
	format: TableFormat
): { start: number; end: number }[] {
	if (format === 'markdown') {
		const layout = markdownRowLayout(text);
		return layout.cells.map(({ start, end }) => {
			const raw = text.slice(start, end);
			const lead = raw.length - raw.replace(/^\s+/, '').length;
			const trimmed = raw.trim();
			if (trimmed.length === 0) {
				return { start: start + lead, end: start + lead };
			}
			return { start: start + lead, end: start + lead + trimmed.length };
		});
	}
	const sep = sepFor(format);
	const parts = text.split(sep);
	const out: { start: number; end: number }[] = [];
	let offset = 0;
	for (const cell of parts) {
		if (format === 'tsv') {
			out.push({ start: offset, end: offset + cell.length });
		} else {
			const lead = cell.length - cell.replace(/^\s+/, '').length;
			const trimmed = cell.trim();
			if (trimmed.length === 0) {
				out.push({ start: offset + lead, end: offset + lead });
			} else {
				out.push({ start: offset + lead, end: offset + lead + trimmed.length });
			}
		}
		offset += cell.length + sep.length;
	}
	return out;
}
