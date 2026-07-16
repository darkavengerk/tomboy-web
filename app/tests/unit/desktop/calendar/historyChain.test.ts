import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import {
	parseHistoryDayLine,
	parseHistoryYearNote,
	extractHistoryYearLinks,
	recordsForDate,
	parseDateTitle,
	isDateTitle,
	type HistoryChain
} from '$lib/desktop/calendar/historyChain.js';

// helper: build a `N월` + bulletList doc
function monthDoc(sections: Array<{ month: string; items: string[] }>): JSONContent {
	const content: JSONContent[] = [];
	for (const s of sections) {
		content.push({ type: 'paragraph', content: [{ type: 'text', text: s.month }] });
		content.push({
			type: 'bulletList',
			content: s.items.map((t) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
			}))
		});
	}
	return { type: 'doc', content };
}

describe('parseHistoryDayLine', () => {
	it('parses prev-year `일` form', () => {
		expect(parseHistoryDayLine('9일(월) 물주기', 2019, 12)).toEqual({ day: 9, label: '물주기' });
	});
	it('parses current-year form without 일', () => {
		expect(parseHistoryDayLine('3(토) 트리하우스', 2026, 1)).toEqual({ day: 3, label: '트리하우스' });
	});
	it('tolerates repeat markers and weekday extras', () => {
		expect(parseHistoryDayLine('9*(토) 클로드 결제일', 2026, 5)).toEqual({ day: 9, label: '클로드 결제일' });
		expect(parseHistoryDayLine('25(월*) 엄마집', 2026, 5)).toEqual({ day: 25, label: '엄마집' });
		expect(parseHistoryDayLine('9일(수, 한글날) 비자', 2019, 10)).toEqual({ day: 9, label: '비자' });
	});
	it('parses a range line using the leading day', () => {
		expect(parseHistoryDayLine('10일(수) - 15일(월) 보웬 방문', 2019, 7)).toEqual({
			day: 10,
			label: '- 15일(월) 보웬 방문'
		});
	});
	it('rejects invalid calendar days', () => {
		expect(parseHistoryDayLine('30일(월) x', 2019, 2)).toBeNull(); // no Feb 30
	});
	it('rejects empty labels', () => {
		expect(parseHistoryDayLine('9일(월)', 2019, 12)).toBeNull();
	});
});

describe('parseHistoryYearNote', () => {
	it('collects every month regardless of order', () => {
		const doc = monthDoc([
			{ month: '12월', items: ['9일(월) 물주기'] },
			{ month: '11월', items: ['9일(토) 한국 도착'] }
		]);
		const entries = parseHistoryYearNote(doc, 2019);
		expect(entries).toHaveLength(2);
		expect(entries).toContainEqual({ year: 2019, month: 12, day: 9, label: '물주기' });
		expect(entries).toContainEqual({ year: 2019, month: 11, day: 9, label: '한국 도착' });
	});
});

describe('extractHistoryYearLinks', () => {
	it('picks only `YYYY - 히스토리 기록` links, descending', () => {
		const xml =
			'<note-content>히스토리 기록' +
			'<link:internal>2024 - 히스토리 기록</link:internal>' +
			'<link:internal>2025 - 히스토리 기록</link:internal>' +
			'<link:internal>2026년</link:internal>' +
			'<link:internal>오리지널스</link:internal></note-content>';
		expect(extractHistoryYearLinks(xml)).toEqual([
			{ year: 2025, title: '2025 - 히스토리 기록' },
			{ year: 2024, title: '2024 - 히스토리 기록' }
		]);
	});
});

describe('recordsForDate', () => {
	it('keeps years < target, descending', () => {
		const chain: HistoryChain = {
			entries: [],
			byMonthDay: new Map([
				[
					'07-16',
					[
						{ year: 2019, month: 7, day: 16, label: '재동이 한국 방문' },
						{ year: 2024, month: 7, day: 16, label: '독서모임' },
						{ year: 2026, month: 7, day: 16, label: '올해 것' }
					]
				]
			])
		};
		expect(recordsForDate(chain, 2026, 7, 16)).toEqual([
			{ year: 2024, month: 7, day: 16, label: '독서모임' },
			{ year: 2019, month: 7, day: 16, label: '재동이 한국 방문' }
		]);
	});
	it('empty for a day with no bucket', () => {
		expect(recordsForDate({ entries: [], byMonthDay: new Map() }, 2026, 1, 1)).toEqual([]);
	});
});

describe('parseDateTitle / isDateTitle', () => {
	it('parses valid date titles', () => {
		expect(parseDateTitle('2026-07-16')).toEqual({ year: 2026, month: 7, day: 16 });
		expect(isDateTitle('2026-07-16')).toBe(true);
	});
	it('rejects non-date / invalid', () => {
		expect(parseDateTitle('2026-13-01')).toBeNull();
		expect(isDateTitle('히스토리 기록')).toBe(false);
	});
});
