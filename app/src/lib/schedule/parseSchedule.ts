/**
 * Parser for the schedule note format.
 *
 * Format (each schedule is a list item under a "N월" section):
 *
 *   4월
 *     노트 열심히 만드는 달
 *     15(금) 등산 7시
 *     16(토) 빨래
 *     16(토) 친구 만나기 6시 반 집앞
 *     17(일) 쓰레기 버리기 7시 20분
 *
 * Rules — see CLAUDE.md "일정 알림" section for the canonical spec.
 */

import type { JSONContent } from '@tiptap/core';

export interface ParsedTime {
	h: number;
	m: number;
}

export interface ParsedDayLine {
	day: number;
	time: ParsedTime | null;
	label: string;
}

// `<day>` optionally followed by `(요일)`, then a space (or end), then label.
const DAY_PREFIX_RE = /^\s*(\d{1,2})(?:\s*\([^)]*\))?\s*(.*)$/;

function isValidDay(year: number, month: number, day: number): boolean {
	if (day < 1 || day > 31) return false;
	const d = new Date(year, month - 1, day);
	return (
		d.getFullYear() === year &&
		d.getMonth() === month - 1 &&
		d.getDate() === day
	);
}

export function parseDayLine(text: string, year: number, month: number): ParsedDayLine | null {
	const match = DAY_PREFIX_RE.exec(text);
	if (!match) return null;
	const day = parseInt(match[1], 10);
	if (!isValidDay(year, month, day)) return null;

	const rest = match[2];
	const time = parseKoreanTime(rest);
	let label: string;
	if (time) {
		// Strip the matched time substring, collapse runs of whitespace, trim.
		label = rest.replace(TIME_RE, ' ').replace(/\s+/g, ' ').trim();
	} else {
		label = rest.trim();
	}
	if (label.length === 0) return null;
	return { day, time, label };
}

// Linearised view of the doc. The schedule format treats month sections as
// "any block whose plain text is `Nx월`" — could be a paragraph (flat shape)
// or a top-level listItem (nested shape). We flatten both shapes into a
// single sequence so the section grouping logic is shape-agnostic.
type LinearBlock = { kind: 'paragraph' | 'listItem'; text: string };

function inlineText(node: JSONContent): string {
	if (typeof node.text === 'string') return node.text;
	if (!node.content) return '';
	return node.content.map(inlineText).join('');
}

function firstParagraphText(li: JSONContent): string {
	for (const child of li.content ?? []) {
		if (child.type === 'paragraph' || child.type === 'heading') {
			return inlineText(child).trim();
		}
	}
	return '';
}

function linearizeDoc(doc: JSONContent): LinearBlock[] {
	const out: LinearBlock[] = [];
	function walk(blocks: JSONContent[] | undefined): void {
		if (!blocks) return;
		for (const b of blocks) {
			if (b.type === 'paragraph' || b.type === 'heading') {
				out.push({ kind: 'paragraph', text: inlineText(b).trim() });
			} else if (b.type === 'bulletList' || b.type === 'orderedList') {
				for (const li of b.content ?? []) {
					if (li.type !== 'listItem') continue;
					out.push({ kind: 'listItem', text: firstParagraphText(li) });
					// Recurse only into nested lists; the listItem's own first paragraph
					// was already captured above.
					const nested = (li.content ?? []).filter(
						(c) => c.type === 'bulletList' || c.type === 'orderedList'
					);
					walk(nested);
				}
			}
		}
	}
	walk(doc.content);
	return out;
}

const MONTH_HEADER_RE = /^(\d+)월$/;

export interface ParsedScheduleEntry {
	year: number;
	month: number;
	day: number;
	time: ParsedTime | null;
	label: string;
	/** Raw text of the original list item — used to derive a stable id later. */
	rawLine: string;
}

export function parseScheduleNote(doc: JSONContent, now: Date): ParsedScheduleEntry[] {
	const currYear = now.getFullYear();
	const currMonth = now.getMonth() + 1;
	// Also process the NEXT month so items composed ahead of time are
	// uploaded to Firestore before the month boundary. Without this, the
	// 1st-of-month summary push (and morning pings for events on the 1st)
	// would miss anything the user prepared in advance, because the parser
	// otherwise sees only `currentMonth`. December rolls over to January
	// of the following year.
	const nextMonth = currMonth === 12 ? 1 : currMonth + 1;
	const nextYear = currMonth === 12 ? currYear + 1 : currYear;

	const result: ParsedScheduleEntry[] = [];
	for (const { year, month } of [
		{ year: currYear, month: currMonth },
		{ year: nextYear, month: nextMonth }
	]) {
		const lines = extractMonthListItems(doc, month);
		for (const line of lines) {
			const parsed = parseDayLine(line, year, month);
			if (!parsed) continue;
			result.push({
				year,
				month,
				day: parsed.day,
				time: parsed.time,
				label: parsed.label,
				rawLine: line
			});
		}
	}
	return result;
}

export function extractCurrentMonthListItems(doc: JSONContent, now: Date): string[] {
	return extractMonthListItems(doc, now.getMonth() + 1);
}

function extractMonthListItems(doc: JSONContent, targetMonth: number): string[] {
	const blocks = linearizeDoc(doc);
	const result: string[] = [];
	let collecting = false;
	for (const b of blocks) {
		const m = MONTH_HEADER_RE.exec(b.text);
		if (m) {
			collecting = parseInt(m[1], 10) === targetMonth;
			continue;
		}
		if (collecting && b.kind === 'listItem' && b.text.length > 0) {
			result.push(b.text);
		}
	}
	return result;
}

// Captures `(오전|오후)? <hour>시 (반|<min>분)?` anywhere in the text.
// Hour: 1-2 digits. Minute: 1-2 digits. "반" = :30.
// Whitespace between tokens is optional.
const TIME_RE = /(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(?:(반)|(\d{1,2})\s*분))?/;

export function parseKoreanTime(text: string): ParsedTime | null {
	const match = TIME_RE.exec(text);
	if (!match) return null;
	const [, period, hourStr, hanFlag, minStr] = match;
	let h = parseInt(hourStr, 10);
	const m = hanFlag ? 30 : minStr ? parseInt(minStr, 10) : 0;
	if (h < 0 || h > 23 || m < 0 || m > 59) return null;

	if (period === '오전') {
		// 오전 12시 = 00:00
		if (h === 12) h = 0;
	} else if (period === '오후') {
		// 오후 12시 = 12:00 (noon), 오후 1~11 → +12
		if (h < 12) h += 12;
	} else {
		// PM default for ambiguous 1-11. 12 stays noon. 13+ already 24h.
		if (h >= 1 && h <= 11) h += 12;
	}
	return { h, m };
}
