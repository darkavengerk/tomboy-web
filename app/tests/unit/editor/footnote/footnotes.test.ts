import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';
import {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner
} from '$lib/editor/footnote/footnotes.js';

let editor: Editor | null = null;
afterEach(() => {
	editor?.destroy();
	editor = null;
});

function makeEditor(content: unknown): Editor {
	const e = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
			TomboyParagraph,
			TomboyListItem,
			...TomboyFootnote
		],
		content: content as never
	});
	editor = e;
	return e;
}

describe('findFootnoteMatches — 노드 walk', () => {
	it('빈 doc → 빈 결과', () => {
		const e = makeEditor({ type: 'doc', content: [{ type: 'paragraph' }] });
		expect(findFootnoteMatches(e.state.doc)).toEqual([]);
	});

	it('본문 중간 ref 매치', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '본문 ' },
						{ type: 'footnoteMarker', attrs: { label: '1' } }
					]
				}
			]
		});
		const matches = findFootnoteMatches(e.state.doc);
		expect(matches.length).toBe(1);
		expect(matches[0].label).toBe('1');
		expect(matches[0].isDefinitionMarker).toBe(false);
		expect(matches[0].to - matches[0].from).toBe(1);
	});

	it('정의 마커 식별', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' 정의' }
					]
				}
			]
		});
		const matches = findFootnoteMatches(e.state.doc);
		expect(matches[0].isDefinitionMarker).toBe(true);
	});

	it('리스트 안의 마커는 def 안 됨', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							content: [
								{
									type: 'paragraph',
									content: [
										{ type: 'footnoteMarker', attrs: { label: '1' } }
									]
								}
							]
						}
					]
				}
			]
		});
		const matches = findFootnoteMatches(e.state.doc);
		expect(matches.length).toBe(1);
		expect(matches[0].isDefinitionMarker).toBe(false);
	});

	it('제목 단락 마커는 제외', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' 제목' }
					]
				}
			]
		});
		expect(findFootnoteMatches(e.state.doc)).toEqual([]);
	});

	it('findFootnoteAt — 정확히 from 위치', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [{ type: 'footnoteMarker', attrs: { label: '1' } }]
				}
			]
		});
		const matches = findFootnoteMatches(e.state.doc);
		expect(findFootnoteAt(matches, matches[0].from)).toBe(matches[0]);
		expect(findFootnoteAt(matches, matches[0].from - 1)).toBe(null);
		expect(findFootnoteAt(matches, matches[0].from + 1)).toBe(null);
	});

	it('findFootnotePartner — ref ↔ def', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '본문 ' },
						{ type: 'footnoteMarker', attrs: { label: '1' } }
					]
				},
				{
					type: 'paragraph',
					content: [
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' 정의' }
					]
				}
			]
		});
		const matches = findFootnoteMatches(e.state.doc);
		const ref = matches.find((m) => !m.isDefinitionMarker)!;
		const def = matches.find((m) => m.isDefinitionMarker)!;
		expect(findFootnotePartner(matches, ref)).toBe(def);
		expect(findFootnotePartner(matches, def)).toBe(ref);
	});
});
