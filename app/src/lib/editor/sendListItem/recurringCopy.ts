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
import { transformDayPrefixLine, getWeekdayChar } from '$lib/schedule/autoWeekday.js';

export const RECURRING_MARKER = '*';

const MONTH_HEADER_RE = /^\s*(\d{1,2})월\s*$/;

export function containsRecurringMarker(text: string): boolean {
	return text.includes(RECURRING_MARKER);
}

export function nextMonthOf(month: number): { month: number; yearOffset: number } {
	if (month === 12) return { month: 1, yearOffset: 1 };
	return { month: month + 1, yearOffset: 0 };
}

export type RecurrenceSpec =
	| { kind: 'monthly' }
	| { kind: 'weekly' }
	| { kind: 'everyNWeeks'; weeks: number };

export interface PrefixParse {
	/** 선행 공백. */
	leadingWs: string;
	/** 일 번호. */
	day: number;
	/** 일 번호와 `(` 사이의 `*` (월간 마커) 또는 `''`. */
	monthMark: string;
	/** 파렌 안의 요일 글자(틀렸거나 쓰레기일 수 있음). */
	weekday: string;
	/** `)` 바로 뒤의 `*` / `^N` (요일 마커) 또는 `''`. */
	weekMark: string;
	/** 라벨(선행 공백 포함). */
	rest: string;
}

// 일정 줄 prefix: [공백][일][*?]([요일])[*|^N]?[라벨]
const PREFIX_RE = /^(\s*)(\d{1,2})(\*?)\(([^)]*)\)(\*|\^\d{1,2})?(.*)$/;

/** 일정 줄의 prefix를 구조 분해한다. day 번호 prefix가 없으면 null. */
export function parsePrefix(text: string): PrefixParse | null {
	const m = PREFIX_RE.exec(text);
	if (!m) return null;
	return {
		leadingWs: m[1],
		day: parseInt(m[2], 10),
		monthMark: m[3] ?? '',
		weekday: m[4],
		weekMark: m[5] ?? '',
		rest: m[6] ?? ''
	};
}

/**
 * 분해된 prefix에서 반복 종류를 판별한다.
 * - 날짜 옆 `*` → monthly (요일 마커보다 우선)
 * - 요일 옆 `*` → weekly
 * - 요일 옆 `^N` (N ≥ 1) → everyNWeeks
 * - 그 외 → null (반복 아님)
 */
export function recurrenceFromParse(p: PrefixParse): RecurrenceSpec | null {
	if (p.monthMark === '*') return { kind: 'monthly' };
	if (p.weekMark === '*') return { kind: 'weekly' };
	const m = /^\^(\d{1,2})$/.exec(p.weekMark);
	if (m) {
		const weeks = parseInt(m[1], 10);
		if (weeks >= 1) return { kind: 'everyNWeeks', weeks };
	}
	return null;
}

/**
 * 항목에 적힌 날짜(섹션 월 + 일 번호 + 기준 연도)로부터 반복 목표 날짜를 계산한다.
 * - monthly: 일 번호 유지, 월 +1 (12월 → 다음 해 1월).
 * - weekly / everyNWeeks: 기준일 + 7×주 일 (JS Date가 월·연 넘어감 처리).
 */
export function computeTargetDate(
	baseYear: number,
	baseMonth: number,
	baseDay: number,
	spec: RecurrenceSpec
): { year: number; month: number; day: number } {
	if (spec.kind === 'monthly') {
		const { month, yearOffset } = nextMonthOf(baseMonth);
		return { year: baseYear + yearOffset, month, day: baseDay };
	}
	const weeks = spec.kind === 'weekly' ? 1 : spec.weeks;
	const d = new Date(baseYear, baseMonth - 1, baseDay + 7 * weeks);
	return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
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

/**
 * `liJson`을 복제하고 첫 문단 prefix를 `target` 날짜로 다시 쓴다.
 * 일 번호와 요일을 `target`으로 갱신하되, 마커(`*`/`^N`)는 원위치 그대로 보존한다.
 * day prefix가 없으면 텍스트를 건드리지 않는다. 목표 날짜가 무효면(예: 30일 달의
 * 31일) 요일 재계산을 생략하고 기존 요일 글자를 유지한다.
 */
export function buildRecurredLiJson(
	liJson: JSONContent,
	target: { year: number; month: number; day: number }
): JSONContent {
	const cloned = JSON.parse(JSON.stringify(liJson)) as JSONContent;
	const firstPara = cloned.content?.[0];
	if (firstPara?.type === 'paragraph') {
		const firstChild = firstPara.content?.[0];
		if (firstChild?.type === 'text' && typeof firstChild.text === 'string') {
			const p = parsePrefix(firstChild.text);
			if (p) {
				let weekday = p.weekday;
				try {
					weekday = getWeekdayChar(target.year, target.month, target.day);
				} catch {
					// 무효한 목표 날짜 — 기존 요일 글자 유지
				}
				firstChild.text = `${p.leadingWs}${target.day}${p.monthMark}(${weekday})${p.weekMark}${p.rest}`;
			}
		}
	}
	return cloned;
}
