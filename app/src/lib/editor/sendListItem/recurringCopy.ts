/**
 * Helpers for the "monthly recurring" send-button extension.
 *
 * A list-item line whose text contains `*` is treated as a monthly routine
 * (e.g. card-balance check). When the user presses 보내기 on such an item, in
 * addition to the regular transfer to SEND_TARGET_GUID, the orchestrator
 * copies the line into the next month's section of the schedule note so the
 * routine reappears the following month.
 *
 * This file is pure (no editor / DOM imports) so it can be unit-tested.
 */

import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { transformDayPrefixLine } from '$lib/schedule/autoWeekday.js';

export const RECURRING_MARKER = '*';

const MONTH_HEADER_RE = /^\s*(\d{1,2})월\s*$/;

export function containsRecurringMarker(text: string): boolean {
	return text.includes(RECURRING_MARKER);
}

export function nextMonthOf(month: number): { month: number; yearOffset: number } {
	if (month === 12) return { month: 1, yearOffset: 1 };
	return { month: month + 1, yearOffset: 0 };
}

function nodeFirstParaText(n: PMNode): string {
	if (n.type.name === 'paragraph' || n.type.name === 'heading') return n.textContent;
	if (n.type.name === 'listItem') {
		const first = n.firstChild;
		if (first && (first.type.name === 'paragraph' || first.type.name === 'heading')) {
			return first.textContent;
		}
	}
	return '';
}

/**
 * Walk the doc and return the most recent month header that precedes `liPos`.
 * Supports both shapes used by the schedule note:
 *   - flat: `N월` as a top-level paragraph/heading
 *   - nested: top-level listItem whose first paragraph is `N월`
 */
export function findContainingMonth(doc: PMNode, liPos: number): number | null {
	let result: number | null = null;
	doc.descendants((node, pos) => {
		if (pos >= liPos) return false;
		const text = nodeFirstParaText(node);
		const m = MONTH_HEADER_RE.exec(text);
		if (m) result = parseInt(m[1], 10);
		return true;
	});
	return result;
}

export type NextMonthInsertPlan =
	| { kind: 'append-to-list'; insertPos: number }
	| { kind: 'new-list-after-header'; insertPos: number }
	| { kind: 'new-section-at-end'; insertPos: number };

/**
 * Decide where in `doc` a list-item for `nextMonth` should be inserted.
 *
 *   `append-to-list`        - month header exists and has a following bulletList;
 *                             insert before its closing token.
 *   `new-list-after-header` - month header exists but has no list yet; insert a
 *                             fresh bulletList immediately after the header.
 *   `new-section-at-end`    - no header anywhere; append `N월` paragraph + list
 *                             at the end of the doc.
 */
export function planNextMonthInsert(doc: PMNode, nextMonth: number): NextMonthInsertPlan {
	let headerPos = -1;
	let headerNode: PMNode | null = null;
	let headerIndex = -1;

	doc.forEach((child, offset, index) => {
		if (headerNode) return;
		const text = nodeFirstParaText(child);
		const m = MONTH_HEADER_RE.exec(text);
		if (m && parseInt(m[1], 10) === nextMonth) {
			headerPos = offset;
			headerNode = child;
			headerIndex = index;
		}
	});

	if (headerNode) {
		const header = headerNode as PMNode;
		if (header.type.name === 'listItem') {
			let nestedListPos = -1;
			let nestedListEnd = -1;
			header.forEach((nested, nestedOffset) => {
				if (nestedListPos >= 0) return;
				if (nested.type.name === 'bulletList' || nested.type.name === 'orderedList') {
					nestedListPos = headerPos + 1 + nestedOffset;
					nestedListEnd = nestedListPos + nested.nodeSize;
				}
			});
			if (nestedListPos >= 0) {
				return { kind: 'append-to-list', insertPos: nestedListEnd - 1 };
			}
			return { kind: 'new-list-after-header', insertPos: headerPos + header.nodeSize - 1 };
		}

		const headerEndPos = headerPos + header.nodeSize;
		const nextChild = headerIndex + 1 < doc.childCount ? doc.child(headerIndex + 1) : null;
		if (nextChild && (nextChild.type.name === 'bulletList' || nextChild.type.name === 'orderedList')) {
			const listEnd = headerEndPos + nextChild.nodeSize;
			return { kind: 'append-to-list', insertPos: listEnd - 1 };
		}
		return { kind: 'new-list-after-header', insertPos: headerEndPos };
	}

	return { kind: 'new-section-at-end', insertPos: doc.content.size };
}

/**
 * Clone `liJson` and rewrite the day prefix of its first paragraph for the new
 * month (so `15(금)` in May becomes `15(<weekday-in-June>)` in June). The
 * recurring marker (`*`) is preserved verbatim.
 *
 * If the line has no recognisable day prefix, or the new (day, month) is
 * invalid (e.g. day 31 in February), the text is left unchanged — the user can
 * fix it manually.
 */
export function buildNextMonthLiJson(
	liJson: JSONContent,
	year: number,
	nextMonth: number
): JSONContent {
	const cloned = JSON.parse(JSON.stringify(liJson)) as JSONContent;
	const firstPara = cloned.content?.[0];
	if (firstPara?.type === 'paragraph') {
		const firstChild = firstPara.content?.[0];
		if (firstChild?.type === 'text' && typeof firstChild.text === 'string') {
			const { output } = transformDayPrefixLine(firstChild.text, year, nextMonth);
			firstChild.text = output;
		}
	}
	return cloned;
}
