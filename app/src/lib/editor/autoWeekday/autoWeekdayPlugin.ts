import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { transformDayPrefixLine } from '$lib/schedule/autoWeekday.js';

export const autoWeekdayPluginKey = new PluginKey<undefined>('autoWeekday');

export interface AutoWeekdayPluginOptions {
	now: () => Date;
	enabled: () => boolean;
}

const MONTH_HEADER_RE = /^\s*(\d{1,2})월\s*$/;

/**
 * Extract the text content of the first paragraph inside a listItem,
 * or the text content of the node itself if it is a paragraph/heading.
 */
function nodeFirstParagraphText(node: PMNode): string {
	if (node.type.name === 'paragraph' || node.type.name === 'heading') {
		return node.textContent;
	}
	if (node.type.name === 'listItem') {
		const first = node.firstChild;
		if (first && (first.type.name === 'paragraph' || first.type.name === 'heading')) {
			return first.textContent;
		}
	}
	return '';
}

/**
 * Walk the children of `parent` before `targetIndex` to find the most recent
 * "N월" month anchor in a paragraph, heading, or listItem first-paragraph.
 * Returns the month number, or null if none found.
 */
function findPrecedingMonth(parent: PMNode, targetIndex: number): number | null {
	for (let i = targetIndex - 1; i >= 0; i--) {
		const sibling = parent.child(i);
		const text = nodeFirstParagraphText(sibling);
		const m = MONTH_HEADER_RE.exec(text);
		if (m) return parseInt(m[1], 10);
	}
	return null;
}

/**
 * Within a `bulletList` or `orderedList`, find the month applicable to the
 * listItem at `targetListIndex`:
 *   1. Scan backwards through earlier siblings within the same list.
 *   2. Fall back to doc-level siblings before `listIndex` (the list's own position).
 */
function findMonthForListItem(
	list: PMNode,
	listIndex: number,
	targetListIndex: number,
	doc: PMNode
): number | null {
	for (let i = targetListIndex - 1; i >= 0; i--) {
		const sibling = list.child(i);
		const text = nodeFirstParagraphText(sibling);
		const m = MONTH_HEADER_RE.exec(text);
		if (m) return parseInt(m[1], 10);
	}
	return findPrecedingMonth(doc, listIndex);
}

/**
 * Collect rewrites for the first paragraph of `liNode` and any nested
 * listItem first paragraphs. When a nested list item's own first-paragraph
 * text matches the month-header pattern, it becomes the new month anchor for
 * ITS descendants (the "4월" listItem containing nested schedule items).
 *
 * `liPos` is the absolute document position of the listItem node (before its
 * opening token). `month` is null when only nested processing should happen
 * (i.e. the node itself is a month header, not a transformable item).
 */
function collectListItemRewrites(
	liNode: PMNode,
	liPos: number,
	month: number | null,
	year: number,
	rewrites: Array<{ from: number; to: number; newText: string }>
): void {
	const firstPara = liNode.firstChild;
	const firstParaText =
		firstPara && (firstPara.type.name === 'paragraph' || firstPara.type.name === 'heading')
			? firstPara.textContent
			: '';

	// Check if THIS listItem is itself a month header. If so, its nested items
	// should use this month.
	const selfMonthMatch = MONTH_HEADER_RE.exec(firstParaText);
	const effectiveNestedMonth = selfMonthMatch ? parseInt(selfMonthMatch[1], 10) : month;

	if (month !== null && !selfMonthMatch) {
		// Transform the first paragraph of this listItem (not a month header).
		if (
			firstPara &&
			(firstPara.type.name === 'paragraph' || firstPara.type.name === 'heading')
		) {
			const result = transformDayPrefixLine(firstParaText, year, month);
			if (result.changed) {
				const paraContentFrom = liPos + 1 + 1;
				const paraContentTo = paraContentFrom + firstPara.content.size;
				rewrites.push({ from: paraContentFrom, to: paraContentTo, newText: result.output });
			}
		}
	}

	if (effectiveNestedMonth === null) return;

	// Recurse into nested bullet/ordered lists.
	liNode.forEach((child, childOffset) => {
		if (child.type.name !== 'bulletList' && child.type.name !== 'orderedList') return;
		const nestedListPos = liPos + 1 + childOffset;
		child.forEach((nestedLi, nestedLiOffset) => {
			if (nestedLi.type.name !== 'listItem') return;
			const nestedLiPos = nestedListPos + 1 + nestedLiOffset;
			collectListItemRewrites(nestedLi, nestedLiPos, effectiveNestedMonth, year, rewrites);
		});
	});
}

function collectDocRewrites(
	doc: PMNode,
	year: number,
	rewrites: Array<{ from: number; to: number; newText: string }>
): void {
	doc.forEach((topNode, topOffset, topIndex) => {
		if (topNode.type.name !== 'bulletList' && topNode.type.name !== 'orderedList') return;

		const listAbsPos = topOffset;

		topNode.forEach((liNode, liOffset, liIndex) => {
			if (liNode.type.name !== 'listItem') return;

			const liText = nodeFirstParagraphText(liNode);
			const selfMonth = MONTH_HEADER_RE.exec(liText);

			let month: number | null;
			if (selfMonth) {
				month = null;
			} else {
				month = findMonthForListItem(topNode, topIndex, liIndex, doc);
			}

			const liAbsPos = listAbsPos + 1 + liOffset;
			const effectiveMonth = selfMonth ? parseInt(selfMonth[1], 10) : month;

			if (effectiveMonth === null && !selfMonth) return;

			if (selfMonth) {
				collectListItemRewrites(liNode, liAbsPos, null, year, rewrites);
			} else {
				collectListItemRewrites(liNode, liAbsPos, month, year, rewrites);
			}
		});
	});
}

export function createAutoWeekdayPlugin(opts: AutoWeekdayPluginOptions): Plugin {
	return new Plugin({
		key: autoWeekdayPluginKey,
		appendTransaction(trs, _oldState, newState) {
			if (!opts.enabled()) return null;

			const rescan = trs.some((tr) => tr.getMeta(autoWeekdayPluginKey)?.rescan === true);
			if (!rescan && !trs.some((tr) => tr.docChanged)) return null;

			const { doc, schema } = newState;
			const year = opts.now().getFullYear();

			const rewrites: Array<{ from: number; to: number; newText: string }> = [];
			collectDocRewrites(doc, year, rewrites);

			if (rewrites.length === 0) return null;

			const tr = newState.tr;
			for (let i = rewrites.length - 1; i >= 0; i--) {
				const { from, to, newText } = rewrites[i];
				const textNode = (schema as Schema).text(newText);
				tr.replaceWith(from, to, textNode);
			}

			return tr;
		}
	});
}
