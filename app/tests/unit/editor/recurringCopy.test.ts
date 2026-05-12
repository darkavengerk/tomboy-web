import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import type { JSONContent } from '@tiptap/core';
import {
	buildNextMonthLiJson,
	containsRecurringMarker,
	findContainingMonth,
	nextMonthOf,
	planNextMonthInsert
} from '$lib/editor/sendListItem/recurringCopy.js';

let currentEditor: Editor | null = null;

function makeEditor(doc: JSONContent): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
			TomboyParagraph,
			TomboyListItem
		],
		content: doc
	});
	currentEditor = editor;
	return editor;
}

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function para(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function li(text: string): JSONContent {
	return { type: 'listItem', content: [para(text)] };
}

function bullet(items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}

/** Find the absolute position of the listItem whose first-paragraph text matches `match`. */
function findLiPos(editor: Editor, match: string): number {
	let pos = -1;
	editor.state.doc.descendants((node, p) => {
		if (pos >= 0) return false;
		if (node.type.name !== 'listItem') return true;
		const text = node.firstChild?.textContent ?? '';
		if (text === match) {
			pos = p;
			return false;
		}
		return true;
	});
	if (pos < 0) throw new Error(`listItem not found: ${match}`);
	return pos;
}

describe('containsRecurringMarker', () => {
	it('returns true when the line has a `*`', () => {
		expect(containsRecurringMarker('15(금) * 카드값 확인')).toBe(true);
		expect(containsRecurringMarker('*월급 입금 확인')).toBe(true);
		expect(containsRecurringMarker('1 * 2 * 3')).toBe(true);
	});

	it('returns false when there is no `*`', () => {
		expect(containsRecurringMarker('15(금) 등산 7시')).toBe(false);
		expect(containsRecurringMarker('')).toBe(false);
	});
});

describe('nextMonthOf', () => {
	it('increments the month within the same year', () => {
		expect(nextMonthOf(1)).toEqual({ month: 2, yearOffset: 0 });
		expect(nextMonthOf(11)).toEqual({ month: 12, yearOffset: 0 });
	});

	it('rolls December over to January with a year offset', () => {
		expect(nextMonthOf(12)).toEqual({ month: 1, yearOffset: 1 });
	});
});

describe('findContainingMonth (flat shape)', () => {
	it('returns the most recent month header before the li', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				para('5월'),
				bullet([li('1(금) 등산 7시'), li('15(월) * 카드값 확인')]),
				para('6월'),
				bullet([li('1(월) 친구 만나기')])
			]
		});
		const liPos = findLiPos(editor, '15(월) * 카드값 확인');
		expect(findContainingMonth(editor.state.doc, liPos)).toBe(5);
		const juneLi = findLiPos(editor, '1(월) 친구 만나기');
		expect(findContainingMonth(editor.state.doc, juneLi)).toBe(6);
	});

	it('returns null when no preceding month header exists', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [bullet([li('1(금) something')])]
		});
		const liPos = findLiPos(editor, '1(금) something');
		expect(findContainingMonth(editor.state.doc, liPos)).toBeNull();
	});
});

describe('planNextMonthInsert', () => {
	it('appends to the existing next-month bullet list', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				para('5월'),
				bullet([li('15(월) * 카드값 확인')]),
				para('6월'),
				bullet([li('1(월) 친구 만나기')])
			]
		});
		const plan = planNextMonthInsert(editor.state.doc, 6);
		expect(plan.kind).toBe('append-to-list');
	});

	it('creates a new bullet list when the next-month header has none', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				para('5월'),
				bullet([li('15(월) * 카드값 확인')]),
				para('6월')
			]
		});
		const plan = planNextMonthInsert(editor.state.doc, 6);
		expect(plan.kind).toBe('new-list-after-header');
	});

	it('falls back to appending a new section at doc end when no header exists', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [para('5월'), bullet([li('15(월) * 카드값 확인')])]
		});
		const plan = planNextMonthInsert(editor.state.doc, 6);
		expect(plan.kind).toBe('new-section-at-end');
		expect(plan.insertPos).toBe(editor.state.doc.content.size);
	});
});

describe('buildNextMonthLiJson', () => {
	it('rewrites the day-prefix weekday for the new month and keeps `*`', () => {
		// 5월 15일 2026 = 금요일, 6월 15일 2026 = 월요일
		const src = li('15(금) * 카드값 확인');
		const out = buildNextMonthLiJson(src, 2026, 6);
		const firstParaText = (
			out.content?.[0]?.content?.[0] as { text?: string } | undefined
		)?.text;
		expect(firstParaText).toBe('15(월) * 카드값 확인');
	});

	it('leaves text unchanged when the prefix is unrecognised', () => {
		const src = li('카드값 확인 *');
		const out = buildNextMonthLiJson(src, 2026, 6);
		const firstParaText = (
			out.content?.[0]?.content?.[0] as { text?: string } | undefined
		)?.text;
		expect(firstParaText).toBe('카드값 확인 *');
	});

	it('does not mutate the input JSON', () => {
		const src = li('15(금) * 카드값 확인');
		const before = JSON.stringify(src);
		buildNextMonthLiJson(src, 2026, 6);
		expect(JSON.stringify(src)).toBe(before);
	});
});
