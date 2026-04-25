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

	it('ignores items in non-current-month sections', () => {
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

	it('returns [] when no current-month section exists', () => {
		const d = doc(p('5월'), ul(li('1 휴가')));
		expect(parseScheduleNote(d, April25)).toEqual([]);
	});

	it('uses now.getFullYear() for the year field', () => {
		const d = doc(p('4월'), ul(li('15 등산 7시')));
		const may2030_april25 = new Date(2030, 3, 25);
		const result = parseScheduleNote(d, may2030_april25);
		expect(result[0].year).toBe(2030);
	});
});
