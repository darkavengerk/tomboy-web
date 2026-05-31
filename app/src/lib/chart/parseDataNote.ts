import type { JSONContent } from '@tiptap/core';
import {
	detectFenceFormat,
	isFenceClose,
	parseTableRows,
	type TableFormat
} from '../editor/tableBlock/parseTable';

export interface DataTable {
	format: TableFormat;
	columns: string[];
	rows: string[][];
}

/** Concatenate the text of a paragraph's inline children. */
function paragraphText(node: JSONContent): string {
	if (!node.content) return '';
	return node.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

/**
 * Walk top-level paragraphs of a note document and extract every fenced
 * csv/tsv block as a DataTable. The first row of each block is the header.
 */
export function parseDataNote(doc: JSONContent): DataTable[] {
	const tables: DataTable[] = [];
	const nodes = doc.content ?? [];
	let i = 0;
	while (i < nodes.length) {
		const text = paragraphText(nodes[i]);
		const format = detectFenceFormat(text);
		if (!format) {
			i++;
			continue;
		}
		// collect body lines until the closing fence
		const body: string[] = [];
		let j = i + 1;
		let closed = false;
		for (; j < nodes.length; j++) {
			const line = paragraphText(nodes[j]);
			if (isFenceClose(line)) {
				closed = true;
				break;
			}
			body.push(line);
		}
		if (closed && body.length > 0) {
			const grid = parseTableRows(body, format);
			if (grid.length > 0) {
				tables.push({ format, columns: grid[0], rows: grid.slice(1) });
			}
		}
		i = closed ? j + 1 : j;
	}
	return tables;
}
