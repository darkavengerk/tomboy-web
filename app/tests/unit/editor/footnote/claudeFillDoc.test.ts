import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';
import {
	locateDefinition,
	buildFootnoteContext,
	definitionsMatchingTrigger
} from '$lib/editor/footnote/claudeFill.js';

let editor: Editor | null = null;
afterEach(() => {
	editor?.destroy();
	editor = null;
});

function makeEditor(content: unknown): Editor {
	const e = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem,
			...TomboyFootnote
		],
		content: content as never
	});
	editor = e;
	return e;
}

function docWithFootnote(defText: string) {
	return {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
			{
				type: 'paragraph',
				content: [
					{ type: 'text', text: '앞 문장 ' },
					{ type: 'footnoteMarker', attrs: { label: '1' } },
					{ type: 'text', text: ' 뒤 문장' }
				]
			},
			{
				type: 'paragraph',
				content: [
					{ type: 'footnoteMarker', attrs: { label: '1' } },
					{ type: 'text', text: defText }
				]
			}
		]
	};
}

describe('locateDefinition', () => {
	it('라벨로 정의 단락의 마커 뒤 텍스트 위치를 찾는다', () => {
		const e = makeEditor(docWithFootnote('설명해줘 @claude '));
		const loc = locateDefinition(e.state.doc, '1');
		expect(loc).not.toBeNull();
		expect(loc!.text).toBe('설명해줘 @claude ');
		expect(loc!.textFrom).toBe(loc!.markerPos + 1);
		expect(loc!.textTo).toBeGreaterThan(loc!.textFrom);
	});
	it('정의가 없는 라벨 → null', () => {
		const e = makeEditor(docWithFootnote('설명'));
		expect(locateDefinition(e.state.doc, '없음')).toBeNull();
	});
});

describe('buildFootnoteContext', () => {
	it('제목~참조 마커 직전까지, 마커 이후·정의는 제외', () => {
		const e = makeEditor(docWithFootnote('설명해줘 @claude '));
		const ctx = buildFootnoteContext(e.state.doc, '1');
		expect(ctx).toContain('제목');
		expect(ctx).toContain('앞 문장');
		expect(ctx).not.toContain('뒤 문장');
		expect(ctx).not.toContain('설명해줘');
	});
	it('짝 참조 마커가 없으면 첫 정의 직전까지 폴백', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: '본문만 있음' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: '설명해줘 @claude ' }
					]
				}
			]
		});
		const ctx = buildFootnoteContext(e.state.doc, '1');
		expect(ctx).toContain('본문만 있음');
		expect(ctx).not.toContain('설명해줘');
	});
});

describe('definitionsMatchingTrigger', () => {
	it('정의 칸 @claude 끝만 잡고 instruction을 추출', () => {
		const e = makeEditor(docWithFootnote('설명해줘 @claude '));
		const map = definitionsMatchingTrigger(e.state.doc);
		expect(map.get('1')).toBe('설명해줘');
	});
	it('본문 중간 ref 마커 옆 @claude 는 정의가 아니므로 무시', () => {
		const e2 = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '본문 ' },
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' @claude ' }
					]
				}
			]
		});
		expect(definitionsMatchingTrigger(e2.state.doc).has('1')).toBe(false);
	});
	it('트리거 없는 정의는 제외', () => {
		const e = makeEditor(docWithFootnote('이미 채워진 설명'));
		expect(definitionsMatchingTrigger(e.state.doc).size).toBe(0);
	});
});
