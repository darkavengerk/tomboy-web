import type { JSONContent } from '@tiptap/core';
import { parseChartHeader } from '$lib/chart/parseChartBlock.js';

/**
 * Chart-block walker that operates on tiptap JSON (no PMNode positions).
 * Mirrors `editor/chartBlock/findChartRegions` but addresses children by index
 * in `doc.content` rather than by document offset — we don't need positions
 * for PDF rendering, just indexes so the converter can SKIP the header
 * paragraph and the config list when emitting blocks.
 */

export interface JsonChartRegion {
	/** Index of the header paragraph in `doc.content`. */
	headerIndex: number;
	/** Index of the following config list, or undefined when no list follows. */
	configListIndex?: number;
	/** Reconstructed header text, including `[x]`/`[ ]` markers. */
	headerText: string;
	checked: boolean;
	/** Flattened text of every list-item in the following list (nested incl.). */
	configLines: string[];
}

function inlineText(node: JSONContent): string {
	let out = '';
	for (const child of node.content ?? []) {
		if (child.type === 'text') out += child.text ?? '';
		else if (child.type === 'inlineCheckbox') out += child.attrs?.checked ? '[x]' : '[ ]';
	}
	return out;
}

function collectListLines(list: JSONContent, out: string[]): void {
	for (const item of list.content ?? []) {
		if (item.type !== 'listItem') continue;
		const first = item.content?.[0];
		if (first) out.push(inlineText(first));
		for (const sub of item.content ?? []) {
			if (sub.type === 'bulletList' || sub.type === 'orderedList') {
				collectListLines(sub, out);
			}
		}
	}
}

export function findJsonChartRegions(doc: JSONContent): JsonChartRegion[] {
	const out: JsonChartRegion[] = [];
	const children = doc.content ?? [];
	for (let i = 0; i < children.length; i++) {
		const node = children[i];
		if (node.type !== 'paragraph') continue;
		const text = inlineText(node);
		const header = parseChartHeader(text);
		if (!header) continue;

		const next = children[i + 1];
		const isList = next && (next.type === 'bulletList' || next.type === 'orderedList');
		const configLines: string[] = [];
		if (isList) collectListLines(next, configLines);

		out.push({
			headerIndex: i,
			configListIndex: isList ? i + 1 : undefined,
			headerText: text,
			checked: header.checked,
			configLines
		});
	}
	return out;
}
