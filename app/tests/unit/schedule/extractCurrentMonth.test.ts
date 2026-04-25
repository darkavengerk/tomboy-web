import { describe, it, expect } from 'vitest';
import { extractCurrentMonthListItems } from '$lib/schedule/parseSchedule.js';
import type { JSONContent } from '@tiptap/core';

const April25 = new Date(2026, 3, 25); // 2026-04-25

function p(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function li(text: string, ...nested: JSONContent[]): JSONContent {
	const content: JSONContent[] = [p(text)];
	if (nested.length > 0) content.push({ type: 'bulletList', content: nested });
	return { type: 'listItem', content };
}

function bulletList(...items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}

function doc(...blocks: JSONContent[]): JSONContent {
	return { type: 'doc', content: blocks };
}

describe('extractCurrentMonthListItems', () => {
	describe('flat shape: paragraph header + sibling bulletList', () => {
		it('returns items under the current month header', () => {
			const d = doc(
				p('일정'),
				p('4월'),
				bulletList(
					li('노트 열심히 만드는 달'),
					li('15(금) 등산 7시'),
					li('16(토) 빨래')
				)
			);
			expect(extractCurrentMonthListItems(d, April25)).toEqual([
				'노트 열심히 만드는 달',
				'15(금) 등산 7시',
				'16(토) 빨래'
			]);
		});

		it('skips a different month section', () => {
			const d = doc(
				p('3월'),
				bulletList(li('1(월) 옛 일정')),
				p('4월'),
				bulletList(li('15(금) 등산 7시'))
			);
			expect(extractCurrentMonthListItems(d, April25)).toEqual([
				'15(금) 등산 7시'
			]);
		});

		it('stops at next month header (4월 then 5월)', () => {
			const d = doc(
				p('4월'),
				bulletList(li('15(금) 등산 7시')),
				p('5월'),
				bulletList(li('1 휴가'))
			);
			expect(extractCurrentMonthListItems(d, April25)).toEqual([
				'15(금) 등산 7시'
			]);
		});
	});

	describe('nested shape: month is a listItem with nested list', () => {
		it('returns nested items', () => {
			const d = doc(
				p('일정'),
				bulletList(
					li('4월', li('15(금) 등산 7시'), li('16(토) 빨래')),
					li('5월', li('1 휴가'))
				)
			);
			expect(extractCurrentMonthListItems(d, April25)).toEqual([
				'15(금) 등산 7시',
				'16(토) 빨래'
			]);
		});
	});

	describe('empty / missing cases', () => {
		it('returns [] when no month section matches', () => {
			const d = doc(p('일정'), p('3월'), bulletList(li('1 옛 일정')));
			expect(extractCurrentMonthListItems(d, April25)).toEqual([]);
		});

		it('returns [] for empty doc', () => {
			expect(extractCurrentMonthListItems({ type: 'doc', content: [] }, April25)).toEqual(
				[]
			);
		});

		it('returns [] when current month section has no list', () => {
			const d = doc(p('4월'), p('아무것도 없음'));
			expect(extractCurrentMonthListItems(d, April25)).toEqual([]);
		});
	});

	describe('marks are flattened into plain text', () => {
		it('strips bold/italic marks from item text', () => {
			const d = doc(
				p('4월'),
				bulletList({
					type: 'listItem',
					content: [
						{
							type: 'paragraph',
							content: [
								{ type: 'text', text: '15(금) ' },
								{ type: 'text', text: '등산', marks: [{ type: 'bold' }] },
								{ type: 'text', text: ' 7시' }
							]
						}
					]
				})
			);
			expect(extractCurrentMonthListItems(d, April25)).toEqual([
				'15(금) 등산 7시'
			]);
		});
	});
});
