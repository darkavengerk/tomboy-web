import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import {
	parseEventDayLine,
	parseEventNote,
	eventsForDate,
	type EventChain
} from '$lib/desktop/calendar/eventEntries.js';

/** Build a flat paragraph doc from raw text lines (empty string = blank para). */
function paraDoc(lines: string[]): JSONContent {
	return {
		type: 'doc',
		content: lines.map((t) => ({
			type: 'paragraph',
			content: t.length ? [{ type: 'text', text: t }] : []
		}))
	};
}

describe('parseEventDayLine', () => {
	it('parses weekday-paren form', () => {
		expect(parseEventDayLine('29(수) 호주에 계약서 보냄', 2020, 1)).toEqual({
			day: 29,
			label: '호주에 계약서 보냄'
		});
	});
	it('parses new bare-day form (no weekday)', () => {
		expect(parseEventDayLine('5 자다 깨서 잠듦', 2026, 4)).toEqual({
			day: 5,
			label: '자다 깨서 잠듦'
		});
	});
	it('keeps URLs and parens inside the label', () => {
		expect(parseEventDayLine('29(수) https://www.ereaderiq.com/ 가격 추적', 2020, 1)).toEqual({
			day: 29,
			label: 'https://www.ereaderiq.com/ 가격 추적'
		});
	});
	it('rejects invalid calendar days', () => {
		expect(parseEventDayLine('30 x', 2020, 2)).toBeNull(); // no Feb 30
	});
	it('rejects a bare number with no label', () => {
		expect(parseEventDayLine('5', 2026, 4)).toBeNull();
	});
});

describe('parseEventNote', () => {
	it('tracks year + month headers across a single multi-year note', () => {
		const doc = paraDoc([
			'2007-04-06 오후 10:28',
			'톰보이 사용 시작',
			'',
			'2020',
			'1월',
			'29(수) 호주에 계약서 보냄',
			'2월',
			'10(월) 기생충 오스카 4관왕',
			'',
			'2021',
			'1월',
			'11(월) 상섭이 경상대 첫 출근',
			'2026',
			'4월',
			'5 자다 깨서 잠듦',
			'7월',
			'23 영화 호프를 봤다'
		]);
		const entries = parseEventNote(doc);
		// special leading absolute-date line, label from the NEXT line
		expect(entries).toContainEqual({ year: 2007, month: 4, day: 6, label: '톰보이 사용 시작' });
		expect(entries).toContainEqual({ year: 2020, month: 1, day: 29, label: '호주에 계약서 보냄' });
		expect(entries).toContainEqual({ year: 2020, month: 2, day: 10, label: '기생충 오스카 4관왕' });
		expect(entries).toContainEqual({ year: 2021, month: 1, day: 11, label: '상섭이 경상대 첫 출근' });
		expect(entries).toContainEqual({ year: 2026, month: 4, day: 5, label: '자다 깨서 잠듦' });
		expect(entries).toContainEqual({ year: 2026, month: 7, day: 23, label: '영화 호프를 봤다' });
	});

	it('does not leak a stray day line before any month header into a wrong month', () => {
		const doc = paraDoc(['2020', '15 월 없는 줄', '3월', '4 진짜 3월']);
		const entries = parseEventNote(doc);
		// the `15 …` line has no active month (year reset month to null) → dropped
		expect(entries).toEqual([{ year: 2020, month: 3, day: 4, label: '진짜 3월' }]);
	});

	it('ignores dash separators and blank lines', () => {
		const doc = paraDoc([
			'2022',
			'1월',
			'2(일) 애플와치 사용 시작',
			'-----------------------------',
			'2023',
			'1월',
			'2(월) 한해 정리'
		]);
		const entries = parseEventNote(doc);
		expect(entries).toHaveLength(2);
		expect(entries).toContainEqual({ year: 2022, month: 1, day: 2, label: '애플와치 사용 시작' });
		expect(entries).toContainEqual({ year: 2023, month: 1, day: 2, label: '한해 정리' });
	});

	it('collects multiple entries on the same day', () => {
		const doc = paraDoc(['2020', '1월', '29(수) 첫번째', '29(수) 두번째']);
		const entries = parseEventNote(doc);
		expect(entries).toHaveLength(2);
		expect(entries.map((e) => e.label)).toEqual(['첫번째', '두번째']);
	});
});

describe('eventsForDate (anniversary — year <= target, descending)', () => {
	const chain: EventChain = {
		entries: [],
		byMonthDay: new Map([
			[
				'02-10',
				[
					{ year: 2020, month: 2, day: 10, label: '기생충 오스카' },
					{ year: 2026, month: 2, day: 10, label: '올해 것' }
				]
			]
		])
	};
	it('includes the current year (unlike history)', () => {
		expect(eventsForDate(chain, 2026, 2, 10)).toEqual([
			{ year: 2026, month: 2, day: 10, label: '올해 것' },
			{ year: 2020, month: 2, day: 10, label: '기생충 오스카' }
		]);
	});
	it('excludes future years', () => {
		expect(eventsForDate(chain, 2021, 2, 10)).toEqual([
			{ year: 2020, month: 2, day: 10, label: '기생충 오스카' }
		]);
	});
	it('empty for a day with no bucket', () => {
		expect(eventsForDate(chain, 2026, 1, 1)).toEqual([]);
	});
});
