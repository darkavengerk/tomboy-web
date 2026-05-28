import { describe, it, expect } from 'vitest';
import {
	extractScheduleLabelsForDate,
	buildChecklistBlocks,
	extractUncheckedFromDoc
} from '$lib/schedule/dateNoteSeed.js';
import type { ParsedScheduleEntry } from '$lib/schedule/parseSchedule.js';
import type { JSONContent } from '@tiptap/core';

function p(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function liChecked(text: string, checked: boolean): JSONContent {
	return { type: 'listItem', attrs: { checked }, content: [p(text)] };
}
function ul(...items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}
function liNested(text: string, checked: boolean, ...children: JSONContent[]): JSONContent {
	return {
		type: 'listItem',
		attrs: { checked },
		content: [p(text), ...children]
	};
}
function doc(...blocks: JSONContent[]): JSONContent {
	return { type: 'doc', content: blocks };
}

function entry(overrides: Partial<ParsedScheduleEntry> = {}): ParsedScheduleEntry {
	return {
		year: 2026,
		month: 4,
		day: 15,
		time: { h: 19, m: 0 },
		label: '독서',
		rawLine: '15(월) 독서 7시',
		...overrides
	};
}

describe('extractScheduleLabelsForDate', () => {
	it('returns [] when entries is empty', () => {
		expect(extractScheduleLabelsForDate([], 2026, 4, 15)).toEqual([]);
	});

	it('returns [] when no entries match the date', () => {
		const entries = [
			entry({ day: 14, rawLine: '14(일) 독서' }),
			entry({ day: 16, rawLine: '16(화) 빨래' })
		];
		expect(extractScheduleLabelsForDate(entries, 2026, 4, 15)).toEqual([]);
	});

	it('single match: strips day prefix, preserves time text', () => {
		const entries = [entry({ rawLine: '15(월) 독서모임 7시' })];
		expect(extractScheduleLabelsForDate(entries, 2026, 4, 15)).toEqual([
			'독서모임 7시'
		]);
	});

	it('multiple matches preserve input order', () => {
		const entries = [
			entry({ day: 15, rawLine: '15(월) 독서' }),
			entry({ day: 15, rawLine: '15(월) 독서모임 7시' }),
			entry({ day: 16, rawLine: '16(화) 빨래' }),
			entry({ day: 15, rawLine: '15(월) 산책 8시' })
		];
		expect(extractScheduleLabelsForDate(entries, 2026, 4, 15)).toEqual([
			'독서',
			'독서모임 7시',
			'산책 8시'
		]);
	});

	it('entry without weekday parens: "15 빨래" → "빨래"', () => {
		const entries = [entry({ rawLine: '15 빨래' })];
		expect(extractScheduleLabelsForDate(entries, 2026, 4, 15)).toEqual(['빨래']);
	});

	it('leading whitespace in rawLine: "  15(월)  독서" → "독서"', () => {
		const entries = [entry({ rawLine: '  15(월)  독서' })];
		expect(extractScheduleLabelsForDate(entries, 2026, 4, 15)).toEqual(['독서']);
	});

	it('wrong day does not match', () => {
		const entries = [entry({ day: 14, rawLine: '14(일) 독서' })];
		expect(extractScheduleLabelsForDate(entries, 2026, 4, 15)).toEqual([]);
	});

	it('wrong month does not match', () => {
		const entries = [entry({ month: 5, rawLine: '15(목) 독서' })];
		expect(extractScheduleLabelsForDate(entries, 2026, 4, 15)).toEqual([]);
	});

	it('wrong year does not match', () => {
		const entries = [entry({ year: 2025, rawLine: '15(화) 독서' })];
		expect(extractScheduleLabelsForDate(entries, 2026, 4, 15)).toEqual([]);
	});

	it('day-only entry (no time): label preserved as-is', () => {
		const entries = [entry({ time: null, rawLine: '15(월) 빨래' })];
		expect(extractScheduleLabelsForDate(entries, 2026, 4, 15)).toEqual(['빨래']);
	});

	it('label with parens after day-prefix: "15(월) 독서 (자정)" → "독서 (자정)"', () => {
		const entries = [entry({ rawLine: '15(월) 독서 (자정)' })];
		expect(extractScheduleLabelsForDate(entries, 2026, 4, 15)).toEqual([
			'독서 (자정)'
		]);
	});
});

describe('buildChecklistBlocks', () => {
	it('empty schedule + empty carryover → []', () => {
		expect(buildChecklistBlocks([], [])).toEqual([]);
	});

	it('one schedule label → [paragraph("체크리스트:"), bulletList(listItem(checked:false, label))]', () => {
		const blocks = buildChecklistBlocks(['독서모임 7시'], []);
		expect(blocks).toEqual([
			p('체크리스트:'),
			ul(liChecked('독서모임 7시', false))
		]);
	});

	it('multiple schedule labels preserve order, all checked:false', () => {
		const blocks = buildChecklistBlocks(['독서', '독서모임 7시', '산책 8시'], []);
		expect(blocks).toEqual([
			p('체크리스트:'),
			ul(
				liChecked('독서', false),
				liChecked('독서모임 7시', false),
				liChecked('산책 8시', false)
			)
		]);
	});

	it('carryover only → header + carryover items (checked forced false)', () => {
		const carryover: JSONContent[] = [
			{ type: 'listItem', attrs: { checked: false }, content: [p('어제 미완')] }
		];
		expect(buildChecklistBlocks([], carryover)).toEqual([
			p('체크리스트:'),
			ul(liChecked('어제 미완', false))
		]);
	});

	it('schedule + carryover → schedule first, carryover after', () => {
		const carryover: JSONContent[] = [
			{ type: 'listItem', attrs: { checked: false }, content: [p('어제 미완')] }
		];
		expect(buildChecklistBlocks(['오늘 일정'], carryover)).toEqual([
			p('체크리스트:'),
			ul(liChecked('오늘 일정', false), liChecked('어제 미완', false))
		]);
	});

	it('dedup: carryover top-level text equals schedule label → carryover skipped', () => {
		const carryover: JSONContent[] = [
			{ type: 'listItem', attrs: { checked: false }, content: [p('회의')] }
		];
		expect(buildChecklistBlocks(['회의'], carryover)).toEqual([
			p('체크리스트:'),
			ul(liChecked('회의', false))
		]);
	});

	it('dedup compares trimmed text only', () => {
		const carryover: JSONContent[] = [
			{ type: 'listItem', attrs: { checked: false }, content: [p('  회의  ')] }
		];
		expect(buildChecklistBlocks(['회의'], carryover)).toEqual([
			p('체크리스트:'),
			ul(liChecked('회의', false))
		]);
	});

	it('dedup skips carryover with nested children too (entire subtree dropped)', () => {
		const carryover: JSONContent[] = [
			{
				type: 'listItem',
				attrs: { checked: false },
				content: [
					p('회의'),
					{
						type: 'bulletList',
						content: [
							{ type: 'listItem', attrs: { checked: false }, content: [p('자식 미완')] }
						]
					}
				]
			}
		];
		expect(buildChecklistBlocks(['회의'], carryover)).toEqual([
			p('체크리스트:'),
			ul(liChecked('회의', false))
		]);
	});

	it('carryover with checked:true at top level still gets forced to false', () => {
		const carryover: JSONContent[] = [
			{ type: 'listItem', attrs: { checked: true }, content: [p('항목')] }
		];
		expect(buildChecklistBlocks([], carryover)).toEqual([
			p('체크리스트:'),
			ul(liChecked('항목', false))
		]);
	});
});

describe('extractUncheckedFromDoc', () => {
	it('empty doc → []', () => {
		expect(extractUncheckedFromDoc(doc())).toEqual([]);
	});

	it('skips title block (index 0) even if it looks like a header', () => {
		// blocks[0] is treated as title and never scanned as a checklist header,
		// matching findChecklistRegions / applyChecklistMarkersOnParse behavior.
		const d = doc(
			p('체크리스트:'),           // would-be header at index 0 — ignored
			ul(liChecked('절대 안 뽑힘', false))
		);
		expect(extractUncheckedFromDoc(d)).toEqual([]);
	});

	it('doc without 체크리스트 header → []', () => {
		const d = doc(p('제목'), p('본문'), ul(liChecked('할 일', false)));
		expect(extractUncheckedFromDoc(d)).toEqual([]);
	});

	it('header + single unchecked → [that listItem]', () => {
		const d = doc(
			p('제목'),
			p('체크리스트:'),
			ul(liChecked('할 일', false))
		);
		expect(extractUncheckedFromDoc(d)).toEqual([liChecked('할 일', false)]);
	});

	it('header + mix of checked/unchecked → unchecked only', () => {
		const d = doc(
			p('제목'),
			p('체크리스트:'),
			ul(
				liChecked('완료', true),
				liChecked('미완 1', false),
				liChecked('미완 2', false)
			)
		);
		expect(extractUncheckedFromDoc(d)).toEqual([
			liChecked('미완 1', false),
			liChecked('미완 2', false)
		]);
	});

	it('parent checked / child unchecked → child lifted to top', () => {
		const d = doc(
			p('제목'),
			p('체크리스트:'),
			ul(
				liNested('부모완료', true, ul(liChecked('자식미완', false)))
			)
		);
		expect(extractUncheckedFromDoc(d)).toEqual([liChecked('자식미완', false)]);
	});

	it('parent unchecked / child partially checked → parent preserved, only unchecked children kept', () => {
		const d = doc(
			p('제목'),
			p('체크리스트:'),
			ul(
				liNested(
					'부모미완',
					false,
					ul(
						liChecked('자식완료', true),
						liChecked('자식미완', false)
					)
				)
			)
		);
		expect(extractUncheckedFromDoc(d)).toEqual([
			liNested('부모미완', false, ul(liChecked('자식미완', false)))
		]);
	});

	it('parent unchecked / all children checked → parent preserved, nested list removed', () => {
		const d = doc(
			p('제목'),
			p('체크리스트:'),
			ul(
				liNested(
					'부모미완',
					false,
					ul(liChecked('자식완료1', true), liChecked('자식완료2', true))
				)
			)
		);
		expect(extractUncheckedFromDoc(d)).toEqual([liChecked('부모미완', false)]);
	});

	it('two checklist regions → concatenated in document order', () => {
		const d = doc(
			p('제목'),
			p('체크리스트:'),
			ul(liChecked('A1', false)),
			p('중간 본문'),
			p('체크리스트:'),
			ul(liChecked('B1', false), liChecked('B2', true))
		);
		expect(extractUncheckedFromDoc(d)).toEqual([
			liChecked('A1', false),
			liChecked('B1', false)
		]);
	});

	it('header followed by paragraph (no bulletList) → that header empty, later region still works', () => {
		const d = doc(
			p('체크리스트:'),
			p('직후가 리스트가 아님'),
			p('체크리스트:'),
			ul(liChecked('정상', false))
		);
		expect(extractUncheckedFromDoc(d)).toEqual([liChecked('정상', false)]);
	});

	it('header + two consecutive bulletLists → both treated as the same region', () => {
		const d = doc(
			p('제목'),
			p('체크리스트:'),
			ul(liChecked('A', false)),
			ul(liChecked('B', false))
		);
		expect(extractUncheckedFromDoc(d)).toEqual([
			liChecked('A', false),
			liChecked('B', false)
		]);
	});

	it('grandchild lifted through two checked ancestors', () => {
		const d = doc(
			p('제목'),
			p('체크리스트:'),
			ul(
				liNested(
					'조부완료',
					true,
					ul(
						liNested(
							'부완료',
							true,
							ul(liChecked('손미완', false))
						)
					)
				)
			)
		);
		expect(extractUncheckedFromDoc(d)).toEqual([liChecked('손미완', false)]);
	});
});
