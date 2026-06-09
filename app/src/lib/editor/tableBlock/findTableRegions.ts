/**
 * Walk a ProseMirror doc and return every CSV/TSV table region found at
 * the top level. A region is a sequence of consecutive top-level
 * paragraphs bounded by a ` ```csv ` / ` ```tsv ` opening fence and a
 * bare ` ``` ` closing fence (see `parseTable.ts` for the line-level
 * grammar).
 *
 * Pure: takes a doc, returns plain data. The plugin layer wires this to
 * decorations and per-region UI state.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';
import {
	detectFenceFormat,
	isBlankRow,
	isFenceClose,
	isSeparatorRow,
	parseAlignments,
	parseTableRows,
	parseInlineCells,
	type Alignment,
	type TableFormat
} from './parseTable.js';

/**
 * Absolute position bounds of one body paragraph that contributed a row
 * to `cells`. `from` / `to` are the paragraph node boundaries (`<p>` /
 * `</p>` slots); `textFrom` / `textTo` are the inner text-content
 * boundaries (just inside the paragraph's open/close tags). Cell-edit
 * range computation works in the textFrom/textTo space.
 */
export interface BodyParaRange {
	from: number;
	to: number;
	textFrom: number;
	textTo: number;
}

export interface TableRegion {
	format: TableFormat;
	/** Parsed body rows as plain text (header at `rows[0]`) — kept for
	 *  callers that don't need mark-aware cells. */
	rows: string[][];
	/** Body rows as inline-node arrays per cell — preserves marks (bold,
	 *  italic, internal/url links, etc.) so the renderer can map them to
	 *  real DOM elements instead of lossy text. Same shape as `rows`
	 *  with one extra dimension. */
	cells: JSONContent[][][];
	/** Per-row absolute paragraph ranges aligned with `cells` — same
	 *  blank-paragraph skipping as `parseInlineCells`, so
	 *  `bodyParaRanges[r]` describes the source paragraph that produced
	 *  `cells[r]`. Used to compute cell-edit ranges. */
	bodyParaRanges: BodyParaRange[];
	/** Index of the opening-fence paragraph among the doc's top-level children. */
	openParaIdx: number;
	/** Index of the closing-fence paragraph among the doc's top-level children. */
	closeParaIdx: number;
	/** Absolute doc position of the start of the opening-fence paragraph. */
	openFromPos: number;
	/** Absolute doc position immediately after the closing-fence paragraph. */
	closeToPos: number;
	/** The opening-fence paragraph's plain-text content, useful for diagnostics. */
	openLine: string;
	/** Per-column alignment (markdown only; undefined for csv/tsv). */
	align?: Alignment[];
	/** The `| --- |` separator paragraph (markdown only) — column ops keep
	 *  it in sync with the data rows. Not part of `bodyParaRanges`. */
	separatorParaRange?: BodyParaRange;
}

interface ParaInfo {
	idx: number;
	from: number;
	to: number;
	text: string;
	json: JSONContent;
}

function collectTopLevelParagraphs(doc: PMNode): ParaInfo[] {
	const out: ParaInfo[] = [];
	doc.forEach((node, offset, idx) => {
		if (node.type.name !== 'paragraph') return;
		// `offset` is the start position of `node`'s content frame within its
		// parent; the absolute "from" of a top-level paragraph is `offset`.
		// `to` is `offset + node.nodeSize`.
		out.push({
			idx,
			from: offset,
			to: offset + node.nodeSize,
			text: node.textContent,
			json: node.toJSON() as JSONContent
		});
	});
	return out;
}

export function findTableRegions(doc: PMNode): TableRegion[] {
	const paras = collectTopLevelParagraphs(doc);
	const regions: TableRegion[] = [];
	let i = 0;
	while (i < paras.length) {
		const fmt = detectFenceFormat(paras[i].text);
		if (!fmt) {
			i++;
			continue;
		}
		// Scan forward for the next closing fence. If we hit ANOTHER opening
		// fence first, abort: the current open is unterminated, and we must
		// not let its scan walk past a sibling open and steal that sibling's
		// close — otherwise two stacked tables would merge into one. Resume
		// the outer loop at j so the sibling open gets a clean scan.
		let j = i + 1;
		let foundClose = false;
		while (j < paras.length) {
			if (isFenceClose(paras[j].text)) {
				foundClose = true;
				break;
			}
			if (detectFenceFormat(paras[j].text) !== null) break;
			j++;
		}
		if (!foundClose) {
			i = Math.max(j, i + 1);
			continue;
		}
		const body = paras.slice(i + 1, j);
		const bodyLines = body.map((p) => p.text);
		const bodyJson = body.map((p) => p.json);
		// Skip the same blank paragraphs `parseInlineCells` skips so
		// `bodyParaRanges[r]` always refers to the source paragraph that
		// produced `cells[r]`. Both use `isBlankRow` (a paragraph counts
		// as blank only if it's pure whitespace AND has no separator).
		const sep = fmt === 'csv' ? ',' : '\t';
		const bodyParaRanges: BodyParaRange[] = body
			.filter((p) => !isBlankRow(p.text, sep))
			.map((p) => ({
				from: p.from,
				to: p.to,
				textFrom: p.from + 1,
				textTo: p.to - 1
			}));
		regions.push({
			format: fmt,
			rows: parseTableRows(bodyLines, fmt),
			cells: parseInlineCells(bodyJson, fmt),
			bodyParaRanges,
			openParaIdx: paras[i].idx,
			closeParaIdx: paras[j].idx,
			openFromPos: paras[i].from,
			closeToPos: paras[j].to,
			openLine: paras[i].text
		});
		i = j + 1;
	}
	return regions;
}

/**
 * Paragraph indices that fall INSIDE a ` ```csv ` / ` ```tsv ` fenced region
 * (inclusive of the fence lines). Markdown detection skips these so the two
 * table features never claim the same paragraphs.
 */
function fencedParaIndices(paras: ParaInfo[]): Set<number> {
	const inside = new Set<number>();
	let i = 0;
	while (i < paras.length) {
		if (!detectFenceFormat(paras[i].text)) {
			i++;
			continue;
		}
		let j = i + 1;
		let foundClose = false;
		while (j < paras.length) {
			if (isFenceClose(paras[j].text)) {
				foundClose = true;
				break;
			}
			if (detectFenceFormat(paras[j].text) !== null) break;
			j++;
		}
		if (!foundClose) {
			i = Math.max(j, i + 1);
			continue;
		}
		for (let k = i; k <= j; k++) inside.add(paras[k].idx);
		i = j + 1;
	}
	return inside;
}

function bodyRange(p: ParaInfo): BodyParaRange {
	return { from: p.from, to: p.to, textFrom: p.from + 1, textTo: p.to - 1 };
}

/**
 * Native GFM markdown tables: a header paragraph containing `|`, immediately
 * followed by a separator row (`| --- |`), then zero or more data paragraphs
 * containing `|`. No fences. The separator row is tracked separately and is
 * NOT part of `cells` / `rows` / `bodyParaRanges`, so row indices keep the
 * `0 = header, 1+ = data` meaning shared with the csv/tsv engine.
 */
export function findMarkdownTableRegions(doc: PMNode): TableRegion[] {
	const paras = collectTopLevelParagraphs(doc);
	const fenced = fencedParaIndices(paras);
	const regions: TableRegion[] = [];
	let i = 0;
	while (i < paras.length) {
		const header = paras[i];
		const sepP = paras[i + 1];
		const isHeader =
			!fenced.has(header.idx) &&
			header.text.includes('|') &&
			!isSeparatorRow(header.text) &&
			header.text.trim().length > 0 &&
			sepP &&
			!fenced.has(sepP.idx) &&
			isSeparatorRow(sepP.text);
		if (!isHeader) {
			i++;
			continue;
		}
		let j = i + 2;
		while (
			j < paras.length &&
			!fenced.has(paras[j].idx) &&
			paras[j].text.includes('|') &&
			!isSeparatorRow(paras[j].text) &&
			paras[j].text.trim().length > 0
		) {
			j++;
		}
		const dataParas = paras.slice(i + 2, j);
		const contentParas = [header, ...dataParas];
		const lines = contentParas.map((p) => p.text);
		const json = contentParas.map((p) => p.json);
		const lastData = dataParas.length > 0 ? dataParas[dataParas.length - 1] : sepP;
		regions.push({
			format: 'markdown',
			rows: parseTableRows(lines, 'markdown'),
			cells: parseInlineCells(json, 'markdown'),
			bodyParaRanges: contentParas.map(bodyRange),
			separatorParaRange: bodyRange(sepP),
			align: parseAlignments(sepP.text),
			openParaIdx: header.idx,
			closeParaIdx: lastData.idx,
			openFromPos: header.from,
			closeToPos: lastData.to,
			openLine: header.text
		});
		i = j;
	}
	return regions;
}
