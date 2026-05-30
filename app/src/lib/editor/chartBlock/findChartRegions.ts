/**
 * Doc walker for chart blocks. A chart block is a top-level paragraph whose
 * text is a valid chart header (`[x] Chart:bar 제목`), optionally followed by a
 * bulletList holding the config.
 *
 * IMPORTANT — inlineCheckbox atoms: this editor converts every `[ ]`/`[x]` in
 * body text into an atomic `inlineCheckbox` node (on type via input rule, and
 * on load via the archiver — see inlineCheckbox/node.ts + noteContentArchiver).
 * So in the LIVE document a chart header is stored as
 * `[inlineCheckbox(checked)] + text(" Chart:bar 제목")`, NOT as literal `[x]`
 * text. We therefore take a live PMNode and reconstruct each block's text with
 * `inlineText`, rendering inlineCheckbox atoms back to `[x]`/`[ ]` so the
 * parser sees the marker. Mirrors the position model of the sibling walkers
 * (findTableRegions / checklist/regions) by reading real `nodeSize` offsets.
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseChartHeader } from '../../chart/parseChartBlock.js';

export interface ChartRegion {
	/** Position just inside the end of the header paragraph — the widget anchor. */
	headerEndPos: number;
	/** Reconstructed header text, including the `[x]`/`[ ]` checkbox marker. */
	headerText: string;
	checked: boolean;
	/** Flattened text of every list-item in the following list (nested incl.),
	 *  each line reconstructed with its `[x]`/`[ ]` markers. */
	configLines: string[];
	/** Node range of the following config list, if any. Lets the plugin hide
	 *  the config list while a checked chart is shown. Undefined when no list. */
	configListFrom?: number;
	configListTo?: number;
}

/**
 * Reconstruct a textblock's inline text, rendering `inlineCheckbox` atoms as
 * `[x]`/`[ ]`. Other inline atoms (footnote markers, etc.) contribute nothing,
 * matching how the archiver's plain-text path treats them.
 */
function inlineText(node: PMNode): string {
	let out = '';
	node.forEach((child) => {
		if (child.isText) {
			out += child.text ?? '';
		} else if (child.type.name === 'inlineCheckbox') {
			out += child.attrs.checked ? '[x]' : '[ ]';
		}
	});
	return out;
}

const LIST_TYPES = new Set(['bulletList', 'orderedList']);

/** Recursively collect the first-paragraph text of every listItem in a list. */
function collectListLines(list: PMNode, out: string[]): void {
	list.forEach((item) => {
		if (item.type.name !== 'listItem') return;
		const first = item.firstChild;
		if (first) out.push(inlineText(first));
		item.forEach((sub) => {
			if (LIST_TYPES.has(sub.type.name)) collectListLines(sub, out);
		});
	});
}

export function findChartRegions(doc: PMNode): ChartRegion[] {
	const regions: ChartRegion[] = [];
	const children: Array<{ node: PMNode; offset: number }> = [];
	doc.forEach((node, offset) => children.push({ node, offset }));

	for (let i = 0; i < children.length; i++) {
		const { node, offset } = children[i];
		if (node.type.name !== 'paragraph') continue;
		const text = inlineText(node);
		const header = parseChartHeader(text);
		if (!header) continue;

		const configLines: string[] = [];
		const nextEntry = children[i + 1];
		let configListFrom: number | undefined;
		let configListTo: number | undefined;
		if (nextEntry && LIST_TYPES.has(nextEntry.node.type.name)) {
			collectListLines(nextEntry.node, configLines);
			configListFrom = nextEntry.offset;
			configListTo = nextEntry.offset + nextEntry.node.nodeSize;
		}

		regions.push({
			// offset is the paragraph's start; +nodeSize-1 lands just inside its
			// closing token (end of content) — a robust widget anchor that doesn't
			// depend on counting inline characters.
			headerEndPos: offset + node.nodeSize - 1,
			headerText: text,
			checked: header.checked,
			configLines,
			configListFrom,
			configListTo
		});
	}
	return regions;
}
