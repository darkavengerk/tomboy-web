import type { JSONContent } from '@tiptap/core';
import { parseChartHeader } from '../../chart/parseChartBlock';

export interface ChartRegion {
	/** Position just inside the header paragraph (where text starts). */
	headerFromPos: number;
	/** Position at the end of the header paragraph text. */
	headerToPos: number;
	/** Position of the '[' marker char within the header text (for toggle). */
	checkboxPos: number;
	headerText: string;
	checked: boolean;
	configLines: string[];
}

function paragraphText(node: JSONContent): string {
	if (!node.content) return '';
	return node.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

/** Recursively collect the first-paragraph text of every listItem in a list. */
function collectListLines(list: JSONContent, out: string[]): void {
	for (const item of list.content ?? []) {
		if (item.type !== 'listItem') continue;
		const kids = item.content ?? [];
		if (kids[0]) out.push(paragraphText(kids[0]));
		for (const k of kids.slice(1)) {
			if (k.type === 'bulletList' || k.type === 'orderedList') collectListLines(k, out);
		}
	}
}

/**
 * Walk top-level nodes. A chart region is a paragraph whose text is a valid
 * chart header, optionally followed by a bulletList holding the config.
 *
 * Position model mirrors ProseMirror: top-level node N starts at `pos`, its
 * inner content starts at `pos + 1`. We track a running offset.
 */
export function findChartRegions(doc: JSONContent): ChartRegion[] {
	const regions: ChartRegion[] = [];
	const nodes = doc.content ?? [];
	let pos = 0; // position before current top-level node
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		const nodeSize = sizeOf(node);
		if (node.type === 'paragraph') {
			const text = paragraphText(node);
			const header = parseChartHeader(text);
			if (header) {
				const headerFromPos = pos + 1; // inside the paragraph
				const configLines: string[] = [];
				const next = nodes[i + 1];
				if (next && (next.type === 'bulletList' || next.type === 'orderedList')) {
					collectListLines(next, configLines);
				}
				regions.push({
					headerFromPos,
					headerToPos: headerFromPos + text.length,
					checkboxPos: headerFromPos + text.indexOf('['),
					headerText: text,
					checked: header.checked,
					configLines
				});
			}
		}
		pos += nodeSize;
	}
	return regions;
}

/** Approximate ProseMirror node size for offset tracking. */
function sizeOf(node: JSONContent): number {
	if (node.type === 'text') return (node.text ?? '').length;
	let inner = 0;
	for (const c of node.content ?? []) inner += sizeOf(c);
	// leaf/textblock wrapper contributes 2 (open+close); text nodes none
	return node.type ? inner + 2 : inner;
}
