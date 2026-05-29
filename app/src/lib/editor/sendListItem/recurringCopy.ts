/**
 * Helpers for the recurring send-button extension.
 *
 * A list-item line carries a recurrence based on the POSITION of its marker:
 *   - `25*(수)`   — `*` between the day number and `(` → monthly (next month, same day).
 *   - `25(수*)`   — one `*` inside the parens after the weekday → +1 week.
 *   - `25(수**)`  — N `*` inside the parens → +N weeks (`*` count = weeks).
 * Weekly is just `everyNWeeks` with `weeks = 1`. A `*` anywhere else in the
 * label (or outside the parens) is ignored. When the user presses 보내기 on
 * such an item, in addition to the regular transfer to SEND_TARGET_GUID, the
 * orchestrator copies the line (marker preserved) into the month section of the
 * computed target date so the routine reappears, and keeps recurring.
 *
 * This file is pure (no editor / DOM imports) so it can be unit-tested.
 */

import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { getWeekdayChar } from '$lib/schedule/autoWeekday.js';

const MONTH_HEADER_RE = /^\s*(\d{1,2})월\s*$/;

export function nextMonthOf(month: number): { month: number; yearOffset: number } {
	if (month === 12) return { month: 1, yearOffset: 1 };
	return { month: month + 1, yearOffset: 0 };
}

export type RecurrenceSpec = { kind: 'monthly' } | { kind: 'everyNWeeks'; weeks: number };

export interface PrefixParse {
	/** 선행 공백. */
	leadingWs: string;
	/** 일 번호. */
	day: number;
	/** 일 번호와 `(` 사이의 `*` (월간 마커) 또는 `''`. */
	monthMark: string;
	/** 파렌 안의 요일 글자(틀렸거나 쓰레기일 수 있음, 마커 `*` 제외). */
	weekday: string;
	/** 파렌 안 요일 뒤에 붙은 `*` 개수 (주간 반복 마커, N주). */
	weekStars: number;
	/** 라벨(선행 공백 포함). */
	rest: string;
}

// 일정 줄 prefix: [공백][일][*?]([요일][*…])[라벨]
const PREFIX_RE = /^(\s*)(\d{1,2})(\*?)\(([^)]*)\)(.*)$/;
// 파렌 안: [요일][후행 *들]. lazy 요일 + 후행 `*` 그룹으로 분리.
const PARENS_INNER_RE = /^(.*?)(\**)$/;

/** 일정 줄의 prefix를 구조 분해한다. day 번호 prefix가 없으면 null. */
export function parsePrefix(text: string): PrefixParse | null {
	const m = PREFIX_RE.exec(text);
	if (!m) return null;
	const inner = PARENS_INNER_RE.exec(m[4] ?? '')!;
	return {
		leadingWs: m[1],
		day: parseInt(m[2], 10),
		monthMark: m[3] ?? '',
		weekday: inner[1],
		weekStars: inner[2].length,
		rest: m[5] ?? ''
	};
}

/**
 * 분해된 prefix에서 반복 종류를 판별한다.
 * - 날짜 옆 `*` → monthly (요일 마커보다 우선)
 * - 파렌 안 요일 뒤 `*` N개 → everyNWeeks (weeks = N; 1개면 다음 주)
 * - 그 외 → null (반복 아님)
 */
export function recurrenceFromParse(p: PrefixParse): RecurrenceSpec | null {
	if (p.monthMark === '*') return { kind: 'monthly' };
	if (p.weekStars >= 1) return { kind: 'everyNWeeks', weeks: p.weekStars };
	return null;
}

/**
 * 항목에 적힌 날짜(섹션 월 + 일 번호 + 기준 연도)로부터 반복 목표 날짜를 계산한다.
 * - monthly: 일 번호 유지, 월 +1 (12월 → 다음 해 1월).
 * - everyNWeeks: 기준일 + 7×주 일 (JS Date가 월·연 넘어감 처리).
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
	const d = new Date(baseYear, baseMonth - 1, baseDay + 7 * spec.weeks);
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

export type MonthInsertPlan =
	| { kind: 'append-to-list'; insertPos: number }
	| { kind: 'new-list-after-header'; insertPos: number }
	| { kind: 'new-section-at-end'; insertPos: number };

/**
 * Decide where in `doc` a list-item for `targetMonth` should be inserted.
 *
 *   `append-to-list`        - month header exists and has a following bulletList;
 *                             insert before its closing token.
 *   `new-list-after-header` - month header exists but has no list yet; insert a
 *                             fresh bulletList immediately after the header.
 *   `new-section-at-end`    - no header anywhere; append `N월` paragraph + list
 *                             at the end of the doc.
 */
export function planMonthInsert(doc: PMNode, targetMonth: number): MonthInsertPlan {
	let headerPos = -1;
	let headerNode: PMNode | null = null;
	let headerIndex = -1;

	doc.forEach((child, offset, index) => {
		if (headerNode) return;
		const text = nodeFirstParaText(child);
		const m = MONTH_HEADER_RE.exec(text);
		if (m && parseInt(m[1], 10) === targetMonth) {
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
				const stars = '*'.repeat(p.weekStars);
				firstChild.text = `${p.leadingWs}${target.day}${p.monthMark}(${weekday}${stars})${p.rest}`;
			}
		}
	}
	return cloned;
}

/**
 * targetMonth 섹션의 bulletList 노드와 그 시작 위치를 찾는다. flat/nested 두 형태
 * 모두 지원(planMonthInsert와 동일한 헤더 탐색). 헤더가 없거나 리스트가 아직
 * 없으면 null. 삽입 후 정렬을 위해 현재 doc에서 리스트를 다시 찾는 데 쓴다.
 */
export function findMonthBulletList(
	doc: PMNode,
	targetMonth: number
): { pos: number; node: PMNode } | null {
	let headerPos = -1;
	let headerNode: PMNode | null = null;
	let headerIndex = -1;
	doc.forEach((child, offset, index) => {
		if (headerNode) return;
		const text = nodeFirstParaText(child);
		const m = MONTH_HEADER_RE.exec(text);
		if (m && parseInt(m[1], 10) === targetMonth) {
			headerPos = offset;
			headerNode = child;
			headerIndex = index;
		}
	});
	if (!headerNode) return null;
	const header = headerNode as PMNode;

	if (header.type.name === 'listItem') {
		let result: { pos: number; node: PMNode } | null = null;
		header.forEach((nested, nestedOffset) => {
			if (result) return;
			if (nested.type.name === 'bulletList' || nested.type.name === 'orderedList') {
				result = { pos: headerPos + 1 + nestedOffset, node: nested };
			}
		});
		return result;
	}

	const nextChild = headerIndex + 1 < doc.childCount ? doc.child(headerIndex + 1) : null;
	if (nextChild && (nextChild.type.name === 'bulletList' || nextChild.type.name === 'orderedList')) {
		return { pos: headerPos + header.nodeSize, node: nextChild };
	}
	return null;
}

// 정렬용 일 번호 추출: 선행 공백 + 한두 자리, 뒤가 `(`/`*`(월간 마커)/공백/끝일
// 때만 인정. "100 ..."(세 자리) 같은 오인식을 막는다.
const DAY_SORT_RE = /^\s*(\d{1,2})(?=[(*\s]|$)/;

function firstParaTextJson(li: JSONContent): string {
	const para = li.content?.[0];
	if (!para || para.type !== 'paragraph') return '';
	return (para.content ?? [])
		.map((n) => (n.type === 'text' && typeof n.text === 'string' ? n.text : ''))
		.join('');
}

/** 리스트 아이템 JSON에서 일정 일 번호(1~31 등)를 뽑는다. 없으면 null. */
export function scheduleDayOf(li: JSONContent): number | null {
	const m = DAY_SORT_RE.exec(firstParaTextJson(li));
	if (!m) return null;
	const day = parseInt(m[1], 10);
	return day >= 1 ? day : null;
}

/**
 * 리스트 아이템들을 일 번호 오름차순으로 안정 정렬한다. 날짜(일 번호)가 없는
 * 항목은 원래 인덱스에 그대로 고정(pin)되고, 날짜 있는 항목끼리만 남은 슬롯에
 * 순서대로 채워진다. 입력 배열은 변형하지 않는다.
 */
export function sortListItemsByDay(items: JSONContent[]): JSONContent[] {
	const days = items.map(scheduleDayOf);
	const dated = items
		.map((node, idx) => ({ node, idx, day: days[idx] }))
		.filter((e): e is { node: JSONContent; idx: number; day: number } => e.day !== null);
	dated.sort((a, b) => a.day - b.day || a.idx - b.idx);
	let di = 0;
	return items.map((node, idx) => (days[idx] === null ? node : dated[di++].node));
}
