import { describe, it, expect, afterEach } from 'vitest';
import { Editor, type Content } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';

let editor: Editor | null = null;
afterEach(() => {
	editor?.destroy();
	editor = null;
});

function makeEditor(content: Content): Editor {
	const e = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false, paragraph: false, listItem: false }),
			TomboyParagraph,
			TomboyListItem,
			...TomboyFootnote
		],
		content
	});
	editor = e;
	return e;
}

describe('footnoteMarker schema', () => {
	it('schema 에 footnoteMarker 노드 타입이 등록됨', () => {
		const e = makeEditor({ type: 'doc', content: [{ type: 'paragraph' }] });
		const t = e.schema.nodes.footnoteMarker;
		expect(t).toBeDefined();
		expect(t.isAtom).toBe(true);
		expect(t.isInline).toBe(true);
		expect(t.spec.selectable).toBe(true);
		expect(t.spec.attrs?.label?.default).toBe('');
	});

	it('노드 생성 시 label attr 가 보존됨', () => {
		const e = makeEditor({ type: 'doc', content: [{ type: 'paragraph' }] });
		const node = e.schema.nodes.footnoteMarker.create({ label: '7' });
		expect(node.attrs.label).toBe('7');
	});

	it('JSON 에서 노드를 포함한 doc 가 그대로 라운드트립', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '본문 ' },
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' 끝' }
					]
				}
			]
		});
		const out = e.getJSON();
		const inlines = (out.content?.[1] as any)?.content ?? [];
		expect(inlines[1]).toMatchObject({ type: 'footnoteMarker', attrs: { label: '1' } });
	});

	it('toDOM 출력 — span.tomboy-fn-marker', () => {
		const e = makeEditor({ type: 'doc', content: [{ type: 'paragraph' }] });
		const node = e.schema.nodes.footnoteMarker.create({ label: '3' });
		const out = node.type.spec.toDOM!(node) as [string, Record<string, string>, string];
		expect(out[0]).toBe('span');
		expect(out[1].class).toBe('tomboy-fn-marker');
		expect(out[1]['data-label']).toBe('3');
		expect(out[2]).toBe('3');
	});

	it('NodeView 가 DOM 에 마커를 렌더', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '본문 ' },
						{ type: 'footnoteMarker', attrs: { label: '2' } }
					]
				}
			]
		});
		const html = e.view.dom.innerHTML;
		expect(html).toContain('tomboy-fn-ref');
		expect(html).toMatch(/>2<\/sup>|>2<\/span>/);
	});
});

describe('footnoteMarker NodeView — ref/def 위치 기반', () => {
	function html(e: Editor): string {
		return e.view.dom.innerHTML;
	}

	it('단락 첫 inline 이면 tomboy-fn-def', () => {
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
		expect(html(e)).toContain('tomboy-fn-def');
		expect(html(e)).not.toContain('tomboy-fn-ref');
	});

	it('단락 중간이면 tomboy-fn-ref', () => {
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
		expect(html(e)).toContain('tomboy-fn-ref');
		expect(html(e)).not.toContain('tomboy-fn-def');
	});

	it('리스트 항목 안의 첫 inline 이어도 항상 ref', () => {
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
		expect(html(e)).toContain('tomboy-fn-ref');
		expect(html(e)).not.toContain('tomboy-fn-def');
	});

	it('제목 단락의 마커는 ref', () => {
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
		expect(html(e)).toContain('tomboy-fn-ref');
	});

	it('선행 공백만 있으면 def 인정', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '   ' },
						{ type: 'footnoteMarker', attrs: { label: '1' } },
						{ type: 'text', text: ' 정의' }
					]
				}
			]
		});
		expect(html(e)).toContain('tomboy-fn-def');
	});

	it('앞에 텍스트 삽입 시 def → ref 갱신', () => {
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
		expect(html(e)).toContain('tomboy-fn-def');
		// 두 번째 단락의 맨 앞에 텍스트 삽입.
		let para1Start = 0;
		e.state.doc.forEach((_n, offset, idx) => {
			if (idx === 1) para1Start = offset;
		});
		e.view.dispatch(e.state.tr.insertText('앞쪽 ', para1Start + 1));
		expect(html(e)).toContain('tomboy-fn-ref');
		expect(html(e)).not.toContain('tomboy-fn-def');
	});
});
