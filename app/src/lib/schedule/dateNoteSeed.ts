import type { JSONContent } from '@tiptap/core';
import { parseScheduleNote, type ParsedScheduleEntry } from './parseSchedule.js';
import { getScheduleNoteGuid } from '$lib/core/schedule.js';
import { getNote, findNoteByTitle } from '$lib/storage/noteStore.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { isChecklistHeaderText } from '$lib/editor/checklist/regions.js';

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

// 주의: 체크리스트 영역 그룹핑(헤더 + 그 직후 연속 bulletList)은 네 곳
// 에서 각각 구현된다 — editor/checklist/regions.ts 의 findChecklistRegions
// (라이브 PM 노드), noteContentArchiver.ts 의 applyChecklistMarkersOnParse
// (역직렬화 후 처리)와 serializeContent 의 inChecklistRegion 추적(직렬화),
// 그리고 아래 extractUncheckedFromDoc(시드 빌드 시 JSON). 그룹핑 규칙을
// 바꾸면 네 곳을 함께 고쳐야 한다. (헤더 텍스트 자체는 regions.ts 의
// isChecklistHeaderText 가 single source.)

/** Paragraph block 의 plain text 가 체크리스트 헤더 토큰으로 시작하는지. */
function isChecklistHeader(p: JSONContent): boolean {
	if (p.type !== 'paragraph') return false;
	const text = (p.content ?? [])
		.map((n) => (n.type === 'text' && typeof n.text === 'string' ? n.text : ''))
		.join('');
	return isChecklistHeaderText(text);
}

/**
 * listItem 트리에서 미체크 가지만 추출.
 *
 * 반환:
 * - `null` → 자기/자식 모두 체크라 버린다
 * - 길이 1+ 배열 → 결과로 (자기 보존) 또는 (자식들 끌어올림) 의 listItem 들
 */
function extractUncheckedFromListItem(li: JSONContent): JSONContent[] | null {
	if (li.type !== 'listItem') return null;
	const checked = li.attrs?.checked === true;

	// 자식 bulletList 들에서 미체크 listItem 들을 재귀로 모음.
	const carriedChildItems: JSONContent[] = [];
	const filteredChildLists: JSONContent[] = [];
	const nonListChildren: JSONContent[] = []; // paragraph 등 자식의 자식 외 블록
	for (const child of li.content ?? []) {
		if (child.type === 'bulletList') {
			const kept: JSONContent[] = [];
			for (const sub of child.content ?? []) {
				const res = extractUncheckedFromListItem(sub);
				if (res) {
					if (checked) {
						// 자기가 체크면 자식의 살아남은 미체크 항목을 끌어올린다.
						carriedChildItems.push(...res);
					} else {
						// 자기가 미체크면 자식들 살린 채 자식 list 안에 유지.
						kept.push(...res);
					}
				}
			}
			if (!checked && kept.length > 0) {
				filteredChildLists.push({ type: 'bulletList', content: kept });
			}
		} else {
			nonListChildren.push(child);
		}
	}

	if (checked) {
		// 자기 버리고 살아남은 자식 미체크들만 반환.
		return carriedChildItems.length > 0 ? carriedChildItems : null;
	}

	// 자기 미체크 → 자기 보존. 자식 list 들은 필터링된 결과로 교체.
	const newContent: JSONContent[] = [...nonListChildren, ...filteredChildLists];
	return [{ ...li, attrs: { ...(li.attrs ?? {}), checked: false }, content: newContent }];
}

/**
 * doc 안의 모든 「체크리스트:」 영역에서 미체크 가지를 추출하여 평탄화한
 * listItem 배열로 반환한다. 영역 = 헤더 paragraph + 그 직후 연속 bulletList.
 * 영역이 없거나 모두 체크되어 있으면 [].
 */
export function extractUncheckedFromDoc(doc: JSONContent): JSONContent[] {
	const blocks = doc.content ?? [];
	const out: JSONContent[] = [];
	let i = 1; // blocks[0] 은 제목 단락 — title-skip 불변식 (findChecklistRegions / applyChecklistMarkersOnParse 와 동일)
	while (i < blocks.length) {
		const b = blocks[i];
		if (!isChecklistHeader(b)) {
			i++;
			continue;
		}
		// 헤더 직후 오는 연속 bulletList 들이 영역.
		let j = i + 1;
		while (j < blocks.length && blocks[j].type === 'bulletList') {
			const list = blocks[j];
			for (const li of list.content ?? []) {
				const res = extractUncheckedFromListItem(li);
				if (res) out.push(...res);
			}
			j++;
		}
		i = j;
	}
	return out;
}

/** `yyyy-mm-dd` 포맷터 (생성된 `Date` 의 로컬 필드 기준). */
function formatDateTitle(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * listItem attrs 를 `checked` 만 남기도록 정규화 — IDB 라운드트립으로
 * 붙은 부가 attrs(예: `tomboyTrailingNewline`)를 제거한다. 캐리오버
 * 항목은 새 노트로 들어가는데, 원본 노트의 직렬화 힌트가 따라오면
 * 새 노트의 XML 에 의미 없는 round-trip 잔여가 새겨지므로.
 */
function normalizeListItem(li: JSONContent): JSONContent {
	return {
		...li,
		attrs: { checked: li.attrs?.checked === true },
		content: (li.content ?? []).map((child) => {
			if (child.type === 'bulletList') {
				return {
					...child,
					content: (child.content ?? []).map(normalizeListItem)
				};
			}
			return child;
		})
	};
}

/**
 * 오늘 (year, month, day) 기준 캘린더상 정확히 1일 전 노트에서
 * 미체크 항목을 추출한다.
 *
 * 실패 모드 (모두 [] 반환):
 *  - 어제 제목의 노트가 IDB 에 없거나 soft-delete 됨 (findNoteByTitle
 *    이 `!n.deleted` 필터링을 이미 한다)
 *  - 그 노트에 체크리스트 영역이 없거나 다 체크됨
 *  - deserialize 실패 (xmlContent 손상 등)
 *
 * 어떤 경우에도 throw 하지 않는다 — 일일노트 생성을 막아서는 안 된다.
 */
export async function extractUncheckedFromYesterdayNote(
	year: number,
	month: number,
	day: number
): Promise<JSONContent[]> {
	try {
		const yesterday = new Date(year, month - 1, day - 1);
		const title = formatDateTitle(yesterday);
		const note = await findNoteByTitle(title);
		if (!note) return [];
		const doc = deserializeContent(note.xmlContent);
		return extractUncheckedFromDoc(doc).map(normalizeListItem);
	} catch (err) {
		console.warn('[dateNoteSeed] yesterday carryover failed', err);
		return [];
	}
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
