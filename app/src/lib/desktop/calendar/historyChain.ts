/**
 * 히스토리 기록 체인 로더/파서.
 *
 * 허브 노트 `히스토리 기록`(= SEND_TARGET_GUID)의 `YYYY - 히스토리 기록` 내부
 * 링크를 따라가 각 이전 년도 노트를 파싱, (월,일) 키로 버킷한다. 달력 셀·날짜
 * 노트 푸터·임시 오버레이가 "이전 년도 같은 날짜 기록"을 이걸로 얻는다.
 *
 * 알림용 parseScheduleNote/DAY_PREFIX_RE 는 건드리지 않는다 — 이전 년도 형식
 * (`9일(월)`)과 마커까지 흡수하는 전용 파서를 여기 둔다.
 */
import type { JSONContent } from '@tiptap/core';
import { getNote } from '$lib/storage/noteStore.js';
import { findNoteByTitle } from '$lib/core/noteManager.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { extractLinkTargets } from '$lib/core/backlinkIndex.js';
import { extractMonthListItems } from '$lib/schedule/parseSchedule.js';
import { SEND_TARGET_GUID } from '$lib/editor/sendListItem/transferListItem.js';
import { onInvalidate } from '$lib/stores/noteListCache.js';

export interface HistoryEntry {
	year: number;
	month: number; // 1-based
	day: number;
	label: string;
}

export interface HistoryChain {
	entries: HistoryEntry[];
	/** key = `${MM}-${DD}` (zero-padded). */
	byMonthDay: Map<string, HistoryEntry[]>;
}

// 이전 년도 형식(`9일(월)`) + 마커(`9*(토)`, `(월*)`, `(수, 한글날)`)까지 흡수.
// 캡처: 1=일자 숫자, 2=라벨. `일?` 로 선택적 '일', `*{0,2}` 로 `9*`/`25*` 마커.
const HISTORY_DAY_RE = /^\s*(\d{1,2})일?\*{0,2}\s*(?:\([^)]*\))?\s*(.*)$/;
const YEAR_LINK_RE = /^(\d{4}) - 히스토리 기록$/;
const DATE_TITLE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

function isValidDay(year: number, month: number, day: number): boolean {
	if (day < 1 || day > 31) return false;
	const d = new Date(year, month - 1, day);
	return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

export function parseHistoryDayLine(
	text: string,
	year: number,
	month: number
): { day: number; label: string } | null {
	const m = HISTORY_DAY_RE.exec(text);
	if (!m) return null;
	const day = parseInt(m[1], 10);
	if (!isValidDay(year, month, day)) return null;
	const label = m[2].trim();
	if (label.length === 0) return null;
	return { day, label };
}

// --- Local month-header order detection ---
// parseSchedule.ts's linearizeDoc/MONTH_HEADER_RE are private (notification-critical
// module — only extractMonthListItems is exported, per invariant). We mirror the same
// shape-agnostic traversal here just to recover the *document order* of "N월" sections,
// since looping months 1..12 (ascending) does not match a month-descending note.
type LinearBlock = { kind: 'paragraph' | 'listItem'; text: string };

function inlineText(node: JSONContent): string {
	if (typeof node.text === 'string') return node.text;
	if (node.type === 'footnoteMarker') {
		return `[^${(node.attrs?.label as string | undefined) ?? ''}]`;
	}
	if (node.type === 'inlineCheckbox') {
		return node.attrs?.checked ? '[x]' : '[ ]';
	}
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

function detectMonthOrder(doc: JSONContent): number[] {
	const order: number[] = [];
	const seen = new Set<number>();
	for (const b of linearizeDoc(doc)) {
		const m = MONTH_HEADER_RE.exec(b.text);
		if (m) {
			const month = parseInt(m[1], 10);
			if (!seen.has(month)) {
				seen.add(month);
				order.push(month);
			}
		}
	}
	return order;
}

export function parseHistoryYearNote(doc: JSONContent, year: number): HistoryEntry[] {
	const out: HistoryEntry[] = [];
	for (const month of detectMonthOrder(doc)) {
		for (const line of extractMonthListItems(doc, month)) {
			const parsed = parseHistoryDayLine(line, year, month);
			if (parsed) out.push({ year, month, day: parsed.day, label: parsed.label });
		}
	}
	return out;
}

export function extractHistoryYearLinks(xml: string): { year: number; title: string }[] {
	const out: { year: number; title: string }[] = [];
	for (const target of extractLinkTargets(xml)) {
		const m = YEAR_LINK_RE.exec(target.trim());
		if (m) out.push({ year: parseInt(m[1], 10), title: target.trim() });
	}
	return out.sort((a, b) => b.year - a.year);
}

export function parseDateTitle(title: string): { year: number; month: number; day: number } | null {
	const m = DATE_TITLE_RE.exec(title.trim());
	if (!m) return null;
	const year = parseInt(m[1], 10);
	const month = parseInt(m[2], 10);
	const day = parseInt(m[3], 10);
	if (!isValidDay(year, month, day)) return null;
	return { year, month, day };
}

export function isDateTitle(title: string): boolean {
	return parseDateTitle(title) !== null;
}

export function recordsForDate(
	chain: HistoryChain,
	year: number,
	month: number,
	day: number
): HistoryEntry[] {
	const key = `${pad(month)}-${pad(day)}`;
	return (chain.byMonthDay.get(key) ?? [])
		.filter((e) => e.year < year)
		.sort((a, b) => b.year - a.year);
}

// --- IDB 로더 (모듈 캐시 + noteListCache 무효화 구독) ---
let cache: Promise<HistoryChain> | null = null;
let invalidateInstalled = false;

function installInvalidation(): void {
	if (invalidateInstalled) return;
	invalidateInstalled = true;
	onInvalidate(() => {
		cache = null;
	});
}

async function buildChain(): Promise<HistoryChain> {
	const entries: HistoryEntry[] = [];
	const hub = await getNote(SEND_TARGET_GUID);
	if (hub) {
		const links = extractHistoryYearLinks(hub.xmlContent);
		const resolved = await Promise.all(
			links.map((l) => findNoteByTitle(l.title).then((n) => ({ l, n })))
		);
		for (const { l, n } of resolved) {
			if (!n) continue;
			try {
				const doc = deserializeContent(n.xmlContent);
				entries.push(...parseHistoryYearNote(doc, l.year));
			} catch {
				/* corrupt note — skip */
			}
		}
	}
	const byMonthDay = new Map<string, HistoryEntry[]>();
	for (const e of entries) {
		const key = `${pad(e.month)}-${pad(e.day)}`;
		const bucket = byMonthDay.get(key);
		if (bucket) bucket.push(e);
		else byMonthDay.set(key, [e]);
	}
	return { entries, byMonthDay };
}

export function loadHistoryChain(): Promise<HistoryChain> {
	installInvalidation();
	if (!cache) cache = buildChain();
	return cache;
}
