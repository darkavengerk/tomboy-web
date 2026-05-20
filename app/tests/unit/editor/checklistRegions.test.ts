import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import {
	isChecklistHeaderText,
	findChecklistRegions,
	findChecklistItems,
	findChecklistItemAt
} from '$lib/editor/checklist/regions.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(doc: JSONContent): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem
		],
		content: doc
	});
	currentEditor = editor;
	return editor;
}

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});
const LI = (text: string, checked = false): JSONContent => ({
	type: 'listItem',
	attrs: { checked },
	content: [P(text)]
});
const UL = (...items: JSONContent[]): JSONContent => ({
	type: 'bulletList',
	content: items
});

describe('isChecklistHeaderText', () => {
	it('accepts 체크리스트: with and without trailing description', () => {
		expect(isChecklistHeaderText('체크리스트:')).toBe(true);
		expect(isChecklistHeaderText('  체크리스트: 장보기 ')).toBe(true);
		expect(isChecklistHeaderText('체크리스트:2026 목표')).toBe(true);
	});
	it('rejects missing colon and unrelated headers', () => {
		expect(isChecklistHeaderText('체크리스트')).toBe(false);
		expect(isChecklistHeaderText('체크리스트입니다')).toBe(false);
		expect(isChecklistHeaderText('TODO')).toBe(false);
		expect(isChecklistHeaderText('할일')).toBe(false);
	});
});

describe('findChecklistRegions', () => {
	it('returns empty when there is no header', () => {
		const e = makeEditor({ type: 'doc', content: [P('제목'), P('본문')] });
		expect(findChecklistRegions(e.state.doc)).toHaveLength(0);
	});
	it('finds a 체크리스트: header followed by a list', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트: 장보기'), UL(LI('우유'), LI('빵'))]
		});
		const regions = findChecklistRegions(e.state.doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].lists).toHaveLength(1);
	});
	it('merges consecutive lists into one region', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), UL(LI('a')), UL(LI('b'))]
		});
		expect(findChecklistRegions(e.state.doc)[0].lists).toHaveLength(2);
	});
	it('rejects a header with no following list', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), P('그냥 글')]
		});
		expect(findChecklistRegions(e.state.doc)).toHaveLength(0);
	});
	it('never treats the title paragraph as a header', () => {
		const e = makeEditor({ type: 'doc', content: [P('체크리스트:'), UL(LI('a'))] });
		expect(findChecklistRegions(e.state.doc)).toHaveLength(0);
	});
});

describe('findChecklistItems', () => {
	it('collects depth-1 items with their checked state', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				P('제목'),
				P('체크리스트:'),
				UL(LI('우유', false), LI('빵', true))
			]
		});
		const items = findChecklistItems(findChecklistRegions(e.state.doc));
		expect(items).toHaveLength(2);
		expect(items.map((it) => it.checked)).toEqual([false, true]);
		expect(items.map((it) => it.liNode.firstChild!.textContent)).toEqual([
			'우유',
			'빵'
		]);
	});
	it('collects nested items at any depth', () => {
		const nested: JSONContent = {
			type: 'listItem',
			attrs: { checked: false },
			content: [P('상위'), UL(LI('하위1'), LI('하위2', true))]
		};
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), UL(nested)]
		});
		const items = findChecklistItems(findChecklistRegions(e.state.doc));
		// 상위 + 하위1 + 하위2 = 3
		expect(items).toHaveLength(3);
		expect(items.some((it) => it.checked)).toBe(true);
	});
	it('findChecklistItemAt returns the item at a liPos, null otherwise', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), UL(LI('우유'))]
		});
		const items = findChecklistItems(findChecklistRegions(e.state.doc));
		expect(findChecklistItemAt(items, items[0].liPos)).toBe(items[0]);
		expect(findChecklistItemAt(items, 0)).toBeNull();
	});
});

describe('TomboyListItem checked attribute', () => {
	it('survives setContent → getJSON', () => {
		const e = makeEditor({
			type: 'doc',
			content: [P('제목'), P('체크리스트:'), UL(LI('우유', true))]
		});
		const json = e.getJSON();
		const li = json.content![2].content![0] as JSONContent;
		expect(li.attrs!.checked).toBe(true);
	});
});
