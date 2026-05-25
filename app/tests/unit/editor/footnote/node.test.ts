import { describe, it, expect, afterEach } from 'vitest';
import { Editor, type Content } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import { Slice, Fragment } from '@tiptap/pm/model';
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

describe('input rule — 타이핑한 [^N] 을 노드로', () => {
	// 입력 룰은 PM 의 `handleTextInput` 프롭으로 발화 — 테스트에서는
	// `view.someProp('handleTextInput')` 로 직접 호출해 DOM 텍스트 입력을
	// 시뮬레이션한다. `state.tr.insertText` 직접 dispatch 는 우회하지 않음.
	function typeText(e: Editor, text: string) {
		for (const ch of text) {
			const { from, to } = e.state.selection;
			const handler = e.view.someProp('handleTextInput') as
				| ((view: any, from: number, to: number, text: string) => boolean)
				| undefined;
			const handled = handler ? handler(e.view, from, to, ch) : false;
			if (!handled) {
				e.view.dispatch(e.state.tr.insertText(ch, from, to));
			}
		}
	}

	it('본문 단락에서 매치', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		// 두 번째 단락 안쪽으로 커서.
		const para1Start = e.state.doc.resolve(0).nodeAfter!.nodeSize + 1;
		e.view.dispatch(
			e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(para1Start + 1)))
		);
		typeText(e, '[^7]');
		const para1 = e.state.doc.child(1);
		expect(para1.firstChild?.type.name).toBe('footnoteMarker');
		expect(para1.firstChild?.attrs.label).toBe('7');
	});

	it('제목 단락에서는 변환 안 됨', () => {
		const e = makeEditor({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: '제목 ' }] }]
		});
		// 제목 끝으로 커서.
		e.view.dispatch(
			e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(4)))
		);
		typeText(e, '[^7]');
		const para0 = e.state.doc.child(0);
		expect(para0.textContent).toBe('제목 [^7]');
		// footnoteMarker 노드 없음.
		let hasNode = false;
		para0.descendants((n) => {
			if (n.type.name === 'footnoteMarker') hasNode = true;
		});
		expect(hasNode).toBe(false);
	});
});

describe('paste transform — plain text 의 [^N] 을 노드로', () => {
	it('plain text 페이스트 — text + 노드 + text', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});

		// transformPasted 를 직접 호출 (paste 이벤트 시뮬레이션 어려움).
		const slice = new Slice(
			Fragment.from(e.state.schema.text('hello [^9] world')),
			0,
			0
		);
		const transformPasted = e.view.someProp('transformPasted') as
			| ((slice: Slice) => Slice)
			| undefined;
		expect(transformPasted).toBeDefined();
		const transformed = transformPasted!(slice);
		expect(transformed.content.childCount).toBe(3);
		const first = transformed.content.child(0);
		const second = transformed.content.child(1);
		const third = transformed.content.child(2);
		expect(first.type.name).toBe('text');
		expect(first.text).toBe('hello ');
		expect(second.type.name).toBe('footnoteMarker');
		expect(second.attrs.label).toBe('9');
		expect(third.type.name).toBe('text');
		expect(third.text).toBe(' world');
	});

	it('paste 중첩 fragment 도 재귀 처리', () => {
		const e = makeEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: '제목' }] },
				{ type: 'paragraph' }
			]
		});
		// 두 단락이 포함된 slice — 각각의 텍스트가 변환 대상.
		const para1 = e.state.schema.nodes.paragraph.create(
			null,
			e.state.schema.text('first [^1]')
		);
		const para2 = e.state.schema.nodes.paragraph.create(
			null,
			e.state.schema.text('and [^2] more')
		);
		const slice = new Slice(Fragment.fromArray([para1, para2]), 0, 0);

		const transformPasted = e.view.someProp('transformPasted') as
			| ((slice: Slice) => Slice)
			| undefined;
		const transformed = transformPasted!(slice);
		expect(transformed.content.childCount).toBe(2);
		const p1 = transformed.content.child(0);
		const p2 = transformed.content.child(1);
		// p1: 'first ' + marker(1)
		expect(p1.childCount).toBe(2);
		expect(p1.child(1).type.name).toBe('footnoteMarker');
		expect(p1.child(1).attrs.label).toBe('1');
		// p2: 'and ' + marker(2) + ' more'
		expect(p2.childCount).toBe(3);
		expect(p2.child(1).type.name).toBe('footnoteMarker');
		expect(p2.child(1).attrs.label).toBe('2');
	});
});
