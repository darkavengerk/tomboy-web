import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

import {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner,
	getDefinitionPreviewText
} from '$lib/editor/footnote/footnotes.js';

let currentEditor: Editor | null = null;
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeDoc(blocks: JSONContent[]): PMNode {
	currentEditor = new Editor({
		extensions: [StarterKit],
		content: { type: 'doc', content: blocks }
	});
	return currentEditor.state.doc;
}

const P = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : []
});

describe('findFootnoteMatches', () => {
	it('finds a reference in a body paragraph', () => {
		const doc = makeDoc([P('제목'), P('진술하였다:[^7] 끝')]);
		const matches = findFootnoteMatches(doc);
		expect(matches).toHaveLength(1);
		expect(matches[0].label).toBe('7');
		expect(matches[0].isDefinitionMarker).toBe(false);
		expect(doc.textBetween(matches[0].from, matches[0].to)).toBe('[^7]');
	});

	it('ignores malformed markers', () => {
		const doc = makeDoc([P('제목'), P('[^] [^ x] [^abc 끝')]);
		expect(findFootnoteMatches(doc)).toHaveLength(0);
	});

	it('marks a paragraph-leading [^N] as a definition marker', () => {
		const doc = makeDoc([P('제목'), P('[^7] 설명 내용')]);
		const matches = findFootnoteMatches(doc);
		expect(matches).toHaveLength(1);
		expect(matches[0].isDefinitionMarker).toBe(true);
	});

	it('treats a definition marker after leading whitespace as a definition', () => {
		const doc = makeDoc([P('제목'), P('   [^7] 설명')]);
		expect(findFootnoteMatches(doc)[0].isDefinitionMarker).toBe(true);
	});

	it('treats a mid-paragraph [^N] as a reference', () => {
		const doc = makeDoc([P('제목'), P('앞 글자 [^7]')]);
		expect(findFootnoteMatches(doc)[0].isDefinitionMarker).toBe(false);
	});

	it('excludes the title (block index 0)', () => {
		const doc = makeDoc([P('[^7] 제목'), P('본문')]);
		expect(findFootnoteMatches(doc)).toHaveLength(0);
	});

	it('treats a [^N] inside a list item as a reference', () => {
		const doc = makeDoc([
			P('제목'),
			{
				type: 'bulletList',
				content: [{ type: 'listItem', content: [P('[^7] 항목')] }]
			}
		]);
		const matches = findFootnoteMatches(doc);
		expect(matches).toHaveLength(1);
		expect(matches[0].label).toBe('7');
		expect(matches[0].isDefinitionMarker).toBe(false);
		expect(doc.textBetween(matches[0].from, matches[0].to)).toBe('[^7]');
	});

	it('returns multiple matches in document order', () => {
		const doc = makeDoc([
			P('제목'),
			P('가[^7] 나[^8]'),
			P('[^7] 설명7')
		]);
		const matches = findFootnoteMatches(doc);
		expect(matches.map((m) => m.label)).toEqual(['7', '8', '7']);
		expect(matches[2].isDefinitionMarker).toBe(true);
	});
});

describe('findFootnoteAt', () => {
	it('returns the match containing a position, else null', () => {
		const doc = makeDoc([P('제목'), P('가[^7]')]);
		const matches = findFootnoteMatches(doc);
		expect(findFootnoteAt(matches, matches[0].from + 2)).toBe(matches[0]);
		expect(findFootnoteAt(matches, 1)).toBeNull();
	});

	it('excludes the boundary positions (just before [ and just after ])', () => {
		const doc = makeDoc([P('제목'), P('가[^7]')]);
		const matches = findFootnoteMatches(doc);
		expect(findFootnoteAt(matches, matches[0].from)).toBeNull();
		expect(findFootnoteAt(matches, matches[0].to)).toBeNull();
	});

	it('includes a position just inside the closing bracket', () => {
		const doc = makeDoc([P('제목'), P('가[^7]')]);
		const matches = findFootnoteMatches(doc);
		expect(findFootnoteAt(matches, matches[0].to - 1)).toBe(matches[0]);
	});
});

describe('findFootnotePartner', () => {
	function setup() {
		const doc = makeDoc([
			P('제목'),
			P('본문 [^7] 그리고 [^9]'),
			P('[^7] 라벨7 설명')
		]);
		return findFootnoteMatches(doc);
	}

	it('reference → nearest following definition marker of same label', () => {
		const matches = setup();
		const ref = matches.find((m) => m.label === '7' && !m.isDefinitionMarker)!;
		const partner = findFootnotePartner(matches, ref);
		expect(partner?.isDefinitionMarker).toBe(true);
		expect(partner?.label).toBe('7');
	});

	it('definition marker → nearest preceding reference of same label', () => {
		const matches = setup();
		const def = matches.find((m) => m.isDefinitionMarker)!;
		const partner = findFootnotePartner(matches, def);
		expect(partner?.isDefinitionMarker).toBe(false);
		expect(partner?.label).toBe('7');
	});

	it('returns null when no partner exists', () => {
		const matches = setup();
		const ref9 = matches.find((m) => m.label === '9')!;
		expect(findFootnotePartner(matches, ref9)).toBeNull();
	});

	it('pairs repeated labels by proximity across documents', () => {
		// 한 노트에 두 문서. 둘 다 [^1] 을 쓰지만 위치로 짝이 갈린다.
		const doc = makeDoc([
			P('제목'),
			P('문서A 본문 [^1] 끝'),
			P('[^1] 문서A 각주1'),
			P('문서B 본문 [^1] 끝'),
			P('[^1] 문서B 각주1')
		]);
		const matches = findFootnoteMatches(doc);
		const refs = matches.filter((m) => !m.isDefinitionMarker);
		const defs = matches.filter((m) => m.isDefinitionMarker);
		expect(refs).toHaveLength(2);
		expect(defs).toHaveLength(2);
		const [refA, refB] = refs;
		const [defA, defB] = defs;
		// 참조 → 자신 뒤의 첫 설명 (이전 문서 설명이 아니라).
		expect(findFootnotePartner(matches, refA)).toBe(defA);
		expect(findFootnotePartner(matches, refB)).toBe(defB);
		// 설명 → 자신 앞의 마지막 참조.
		expect(findFootnotePartner(matches, defA)).toBe(refA);
		expect(findFootnotePartner(matches, defB)).toBe(refB);
	});
});

describe('getDefinitionPreviewText', () => {
	it('설명 마커 단락에서 선행 [^label] 와 공백을 제거한다', () => {
		const doc = makeDoc([P('제목'), P('[^7] 설명 내용')]);
		const def = findFootnoteMatches(doc).find((m) => m.isDefinitionMarker)!;
		expect(getDefinitionPreviewText(doc, def)).toBe('설명 내용');
	});

	it('선행 공백이 있는 설명도 마커를 제거한다', () => {
		const doc = makeDoc([P('제목'), P('   [^7] 띄어쓴 설명')]);
		const def = findFootnoteMatches(doc).find((m) => m.isDefinitionMarker)!;
		expect(getDefinitionPreviewText(doc, def)).toBe('띄어쓴 설명');
	});

	it('120자를 넘으면 말줄임표를 붙인다', () => {
		const long = '가'.repeat(200);
		const doc = makeDoc([P('제목'), P(`[^7] ${long}`)]);
		const def = findFootnoteMatches(doc).find((m) => m.isDefinitionMarker)!;
		const out = getDefinitionPreviewText(doc, def);
		expect(out.endsWith('…')).toBe(true);
		expect(out.length).toBe(121); // 120자 + …
	});

	it('짧은 설명은 그대로 반환한다', () => {
		const doc = makeDoc([P('제목'), P('[^7] 짧음')]);
		const def = findFootnoteMatches(doc).find((m) => m.isDefinitionMarker)!;
		expect(getDefinitionPreviewText(doc, def)).toBe('짧음');
	});
});
