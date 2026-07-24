/**
 * 사건·사고·기념 이벤트 노트 파서/로더.
 *
 * 히스토리 기록과 달리 **단일 노트 하나에 모든 연도**가 들어있다
 * (GUID = EVENT_NOTE_GUID). 본문은 연도 헤더(`2020`) → 월 헤더(`1월`) →
 * 일자 줄(`29(수) …` 또는 신형식 `5 …`)의 상태머신 형식이며, 맨 앞
 * 특수 줄(`2007-04-06 오후 10:28` + 다음 줄 라벨)도 흡수한다.
 *
 * 달력 셀·날짜 노트 푸터·임시 오버레이가 "이 날의 기념 기록"을 이걸로
 * 얻는다. 기념일 방식이라 대상 연도 **이하**(과거+올해) 전부를 보여준다.
 */
import type { JSONContent } from '@tiptap/core';
import { getNote } from '$lib/storage/noteStore.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { linearizeDoc } from '$lib/schedule/parseSchedule.js';
import { onInvalidate } from '$lib/stores/noteListCache.js';

/** 사건·사고·기념 이벤트 노트 GUID (모든 연도가 이 한 노트에 있음). */
export const EVENT_NOTE_GUID = '31a4c37d-b5a1-4df8-a8c3-c98c3487cfb3';

export interface EventEntry {
	year: number;
	month: number; // 1-based
	day: number;
	label: string;
}

export interface EventChain {
	entries: EventEntry[];
	/** key = `${MM}-${DD}` (zero-padded). */
	byMonthDay: Map<string, EventEntry[]>;
}

const YEAR_RE = /^(\d{4})$/;
const MONTH_RE = /^(\d{1,2})월$/;
// 일자 줄: <일>[(요일/마커)] <공백> <라벨>. 라벨 필수(공백으로 구분).
const DAY_RE = /^(\d{1,2})(?:\s*\([^)]*\))?\s+(.+)$/;
// 맨 앞 특수 절대날짜 줄. 캡처: 연-월-일, 나머지(시각/라벨).
const FULL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(.*))?$/;
// 시각 토큰 제거용(절대날짜 줄의 나머지에서 시각만 발라내기). 콜론형
// `오후 10:28` 과 한글형 `오전 9시 30분`/`10시 반` 둘 다 흡수.
const TIME_STRIP_RE = /(오전|오후)?\s*\d{1,2}\s*(?::\s*\d{2}|시(?:\s*(?:반|\d{1,2}\s*분))?)/g;

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

function isValidDay(year: number, month: number, day: number): boolean {
	if (day < 1 || day > 31) return false;
	const d = new Date(year, month - 1, day);
	return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

/**
 * 연도/월 헤더 사이의 일자 줄을 파싱. 상태(현재 연도·월) 없이는 일자만으로
 * 날짜를 못 만드므로 외부에서 상태를 넘겨준다.
 */
export function parseEventDayLine(
	text: string,
	year: number,
	month: number
): { day: number; label: string } | null {
	const m = DAY_RE.exec(text);
	if (!m) return null;
	const day = parseInt(m[1], 10);
	if (!isValidDay(year, month, day)) return null;
	const label = m[2].trim();
	if (label.length === 0) return null;
	return { day, label };
}

/**
 * 단일 이벤트 노트 도큐먼트를 훑어 모든 연도의 이벤트를 뽑는다. 연도 헤더
 * (`2020`)로 현재 연도를, 월 헤더(`1월`)로 현재 월을 갱신하고, 그 아래
 * 일자 줄을 수집한다. 맨 앞 절대날짜 줄(`2007-04-06 …`)은 다음 줄을 라벨로.
 */
export function parseEventNote(doc: JSONContent): EventEntry[] {
	const out: EventEntry[] = [];
	let curYear: number | null = null;
	let curMonth: number | null = null;
	// 절대날짜 줄이 라벨 없이 나왔을 때, 다음 비어있지 않은 줄을 라벨로 소비.
	let pending: { year: number; month: number; day: number } | null = null;

	for (const block of linearizeDoc(doc)) {
		const text = block.text.trim();
		if (text.length === 0) continue;

		const fd = FULL_DATE_RE.exec(text);
		const ym = YEAR_RE.exec(text);
		const mm = MONTH_RE.exec(text);
		const isHeader = !!(fd || ym || mm);

		if (pending) {
			if (isHeader) {
				// 절대날짜 줄에 라벨이 안 붙었고 다음이 헤더 → 라벨 없이 폐기.
				pending = null;
			} else {
				out.push({ ...pending, label: text });
				pending = null;
				continue;
			}
		}

		if (fd) {
			const y = parseInt(fd[1], 10);
			const mo = parseInt(fd[2], 10);
			const d = parseInt(fd[3], 10);
			if (isValidDay(y, mo, d)) {
				curYear = y;
				curMonth = mo;
				const rest = (fd[4] ?? '').replace(TIME_STRIP_RE, '').trim();
				if (rest.length > 0) out.push({ year: y, month: mo, day: d, label: rest });
				else pending = { year: y, month: mo, day: d };
			}
			continue;
		}
		if (ym) {
			curYear = parseInt(ym[1], 10);
			curMonth = null; // 연도 바뀌면 월 재시작
			continue;
		}
		if (mm) {
			curMonth = parseInt(mm[1], 10);
			continue;
		}
		if (curYear !== null && curMonth !== null) {
			const parsed = parseEventDayLine(text, curYear, curMonth);
			if (parsed) out.push({ year: curYear, month: curMonth, day: parsed.day, label: parsed.label });
		}
	}
	return out;
}

function buildByMonthDay(entries: EventEntry[]): Map<string, EventEntry[]> {
	const byMonthDay = new Map<string, EventEntry[]>();
	for (const e of entries) {
		const key = `${pad(e.month)}-${pad(e.day)}`;
		const bucket = byMonthDay.get(key);
		if (bucket) bucket.push(e);
		else byMonthDay.set(key, [e]);
	}
	return byMonthDay;
}

/**
 * 기념일 방식 조회 — 그 월-일에 해당하는 이벤트 중 대상 연도 **이하**
 * (과거 + 올해) 전부를 연도 내림차순으로. 히스토리(연도<대상, strict)와
 * 달리 올해 이벤트도 포함한다.
 */
export function eventsForDate(
	chain: EventChain,
	year: number,
	month: number,
	day: number
): EventEntry[] {
	const key = `${pad(month)}-${pad(day)}`;
	return (chain.byMonthDay.get(key) ?? [])
		.filter((e) => e.year <= year)
		.sort((a, b) => b.year - a.year);
}

// --- IDB 로더 (모듈 캐시 + noteListCache 무효화 구독) ---
let cache: Promise<EventChain> | null = null;
let invalidateInstalled = false;

function installInvalidation(): void {
	if (invalidateInstalled) return;
	invalidateInstalled = true;
	onInvalidate(() => {
		cache = null;
	});
}

async function buildChain(): Promise<EventChain> {
	let entries: EventEntry[] = [];
	const note = await getNote(EVENT_NOTE_GUID);
	if (note) {
		try {
			entries = parseEventNote(deserializeContent(note.xmlContent));
		} catch {
			/* corrupt note — skip */
		}
	}
	return { entries, byMonthDay: buildByMonthDay(entries) };
}

export function loadEventChain(): Promise<EventChain> {
	installInvalidation();
	if (!cache) cache = buildChain();
	return cache;
}
