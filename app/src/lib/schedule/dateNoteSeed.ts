import type { JSONContent } from '@tiptap/core';
import { parseScheduleNote, type ParsedScheduleEntry } from './parseSchedule.js';
import { getScheduleNoteGuid } from '$lib/core/schedule.js';
import { getNote } from '$lib/storage/noteStore.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';

// Mirrors the day-prefix regex in parseSchedule.ts so labels are extracted
// with identical semantics, just keeping the time text intact.
const DAY_PREFIX_RE = /^\s*(\d{1,2})(?:\s*\([^)]*\))?\s*(.*)$/;

export function extractScheduleLabelsForDate(
	entries: ParsedScheduleEntry[],
	year: number,
	month: number,
	day: number
): string[] {
	const out: string[] = [];
	for (const e of entries) {
		if (e.year !== year || e.month !== month || e.day !== day) continue;
		const m = DAY_PREFIX_RE.exec(e.rawLine);
		if (!m) continue;
		const label = m[2].trim();
		if (label.length === 0) continue;
		out.push(label);
	}
	return out;
}

/**
 * 시드 체크리스트 블록을 만든다. 일정 라벨이 먼저, 캐리오버 항목이 그
 * 다음에 배치된다. 둘 다 비면 [] (시드 자체 생략).
 *
 * 헤더 텍스트는 `체크리스트:` — 이건 editor/checklist/regions.ts 의
 * isChecklistHeaderText 가 인식하는 토큰이고, ProseMirror 플러그인이
 * 영역 안 listItem 을 체크박스로 렌더링하는 트리거다. 동일 규칙이
 * noteContentArchiver.ts 의 applyChecklistMarkersOnParse 에도 있다.
 */
export function buildChecklistBlocks(
	scheduleLabels: string[],
	carryoverItems: JSONContent[]
): JSONContent[] {
	if (scheduleLabels.length === 0 && carryoverItems.length === 0) return [];
	const scheduleItems: JSONContent[] = scheduleLabels.map((label) => ({
		type: 'listItem',
		attrs: { checked: false },
		content: [{ type: 'paragraph', content: [{ type: 'text', text: label }] }]
	}));
	return [
		{ type: 'paragraph', content: [{ type: 'text', text: '체크리스트:' }] },
		{
			type: 'bulletList',
			content: [...scheduleItems, ...carryoverItems]
		}
	];
}

/**
 * Look up the configured schedule note, parse it, and return the TipTap
 * JSON blocks to seed into a new date note for the given (year, month, day).
 *
 * Returns [] when:
 *  - no schedule note is configured
 *  - the schedule note doesn't exist (deleted)
 *  - the schedule note has no entries for that date
 *
 * The function is best-effort: parser/IDB errors are swallowed and produce
 * []. The caller treats [] as "no seeding needed".
 */
export async function buildDateNoteScheduleSeed(
	year: number,
	month: number,
	day: number
): Promise<JSONContent[]> {
	try {
		const guid = await getScheduleNoteGuid();
		if (!guid) return [];
		const note = await getNote(guid);
		if (!note || note.deleted) return [];
		const doc = deserializeContent(note.xmlContent);
		const now = new Date(year, month - 1, day);
		const entries = parseScheduleNote(doc, now);
		const labels = extractScheduleLabelsForDate(entries, year, month, day);
		return buildChecklistBlocks(labels, []);
	} catch (err) {
		console.warn('[dateNoteSeed] failed', err);
		return [];
	}
}
