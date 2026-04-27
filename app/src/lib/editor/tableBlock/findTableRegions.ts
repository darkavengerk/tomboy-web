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
import {
	detectFenceFormat,
	isFenceClose,
	parseTableRows,
	type TableFormat
} from './parseTable.js';

export interface TableRegion {
	format: TableFormat;
	/** Parsed body rows. Header is conventionally `rows[0]`. */
	rows: string[][];
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
			text: node.textContent
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
		// Look for the next closing fence among subsequent paragraphs.
		let j = i + 1;
		while (j < paras.length && !isFenceClose(paras[j].text)) j++;
		if (j >= paras.length) {
			// Unterminated fence — skip past the open and continue scanning.
			// The dangling open could still later become a valid region as
			// the user types, but we don't synthesise a region for it now.
			i++;
			continue;
		}
		const bodyLines = paras.slice(i + 1, j).map((p) => p.text);
		regions.push({
			format: fmt,
			rows: parseTableRows(bodyLines, fmt),
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
