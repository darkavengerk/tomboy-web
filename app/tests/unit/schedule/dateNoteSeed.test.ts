import { describe, it, expect } from 'vitest';
import {
	extractScheduleLabelsForDate,
	buildTodoBlocks
} from '$lib/schedule/dateNoteSeed.js';
import type { ParsedScheduleEntry } from '$lib/schedule/parseSchedule.js';
import type { JSONContent } from '@tiptap/core';

function p(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function li(text: string): JSONContent {
	return { type: 'listItem', content: [p(text)] };
}
function ul(...items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
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

describe('buildTodoBlocks', () => {
	it('empty array → []', () => {
		expect(buildTodoBlocks([])).toEqual([]);
	});

	it('one label → [paragraph("TODO:"), bulletList(listItem(paragraph(label)))]', () => {
		const blocks = buildTodoBlocks(['독서모임 7시']);
		expect(blocks).toEqual([p('TODO:'), ul(li('독서모임 7시'))]);
	});

	it('multiple labels preserve order in bullet list', () => {
		const blocks = buildTodoBlocks(['독서', '독서모임 7시', '산책 8시']);
		expect(blocks).toEqual([
			p('TODO:'),
			ul(li('독서'), li('독서모임 7시'), li('산책 8시'))
		]);
	});
});
