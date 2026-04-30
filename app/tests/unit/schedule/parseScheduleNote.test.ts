import { describe, it, expect } from 'vitest';
import { parseScheduleNote } from '$lib/schedule/parseSchedule.js';
import type { JSONContent } from '@tiptap/core';

const April25 = new Date(2026, 3, 25);

function p(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function li(text: string): JSONContent {
	return { type: 'listItem', content: [p(text)] };
}
function ul(...items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}
function doc(...blocks: JSONContent[]): JSONContent {
	return { type: 'doc', content: blocks };
}

describe('parseScheduleNote (integration)', () => {
	it('user-provided example: 4월 with 4 valid items + 1 ignored "노트 만드는 달"', () => {
		const d = doc(
			p('일정'),
			p('4월'),
			ul(
				li('노트 열심히 만드는 달'),
				li('15(금) 등산 7시'),
				li('16(토) 빨래'),
				li('16(토) 친구 만나기 6시 반 집앞'),
				li('17(일) 쓰레기 버리기 7시 20분')
			)
		);
		const result = parseScheduleNote(d, April25);
		expect(result).toHaveLength(4);

		expect(result[0]).toMatchObject({
			year: 2026,
			month: 4,
			day: 15,
			time: { h: 19, m: 0 },
			label: '등산',
			rawLine: '15(금) 등산 7시'
		});
		expect(result[1]).toMatchObject({
			year: 2026,
			month: 4,
			day: 16,
			time: null,
			label: '빨래',
			rawLine: '16(토) 빨래'
		});
		expect(result[2]).toMatchObject({
			year: 2026,
			month: 4,
			day: 16,
			time: { h: 18, m: 30 },
			label: '친구 만나기 집앞',
			rawLine: '16(토) 친구 만나기 6시 반 집앞'
		});
		expect(result[3]).toMatchObject({
			year: 2026,
			month: 4,
			day: 17,
			time: { h: 19, m: 20 },
			label: '쓰레기 버리기',
			rawLine: '17(일) 쓰레기 버리기 7시 20분'
		});
	});

	it('ignores items in past-month sections', () => {
		// 3월 is the previous month; only 4월 (current) + any 5월 (next) are processed.
		const d = doc(
			p('3월'),
			ul(li('1(일) 옛 일정 7시')),
			p('4월'),
			ul(li('15(금) 등산 7시'))
		);
		const result = parseScheduleNote(d, April25);
		expect(result).toHaveLength(1);
		expect(result[0].day).toBe(15);
	});

	it('also processes the next month section so summaries land before the boundary', () => {
		const d = doc(
			p('4월'),
			ul(li('15(금) 등산 7시')),
			p('5월'),
			ul(li('1(금) 휴가'), li('3 운동 8시'))
		);
		const result = parseScheduleNote(d, April25);
		expect(result).toHaveLength(3);
		expect(result.map((r) => ({ year: r.year, month: r.month, day: r.day }))).toEqual([
			{ year: 2026, month: 4, day: 15 },
			{ year: 2026, month: 5, day: 1 },
			{ year: 2026, month: 5, day: 3 }
		]);
	});

	it('returns next-month items even when no current-month section exists', () => {
		// User has only started filling next month; treat those as upcoming.
		const d = doc(p('5월'), ul(li('1 휴가')));
		const result = parseScheduleNote(d, April25);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ year: 2026, month: 5, day: 1, label: '휴가' });
	});

	it('returns [] when neither current nor next month section exists', () => {
		const d = doc(p('7월'), ul(li('1 휴가')));
		expect(parseScheduleNote(d, April25)).toEqual([]);
	});

	it('December → January rolls the year over for the next-month section', () => {
		const dec15_2026 = new Date(2026, 11, 15);
		const d = doc(
			p('12월'),
			ul(li('25(금) 크리스마스 7시')),
			p('1월'),
			ul(li('1(금) 새해'))
		);
		const result = parseScheduleNote(d, dec15_2026);
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ year: 2026, month: 12, day: 25 });
		expect(result[1]).toMatchObject({ year: 2027, month: 1, day: 1 });
	});

	it('uses now.getFullYear() for the year field', () => {
		const d = doc(p('4월'), ul(li('15 등산 7시')));
		const may2030_april25 = new Date(2030, 3, 25);
		const result = parseScheduleNote(d, may2030_april25);
		expect(result[0].year).toBe(2030);
	});
});
