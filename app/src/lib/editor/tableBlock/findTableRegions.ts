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
	isFenceClose,
	parseTableRows,
	parseInlineCells,
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
		// produced `cells[r]`. Mirrors the rule "trim().length === 0 →
		// skip" exactly.
		const bodyParaRanges: BodyParaRange[] = body
			.filter((p) => p.text.trim().length > 0)
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
